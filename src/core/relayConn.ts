import type { Filter as NostrFilter, Event as NostrEvent } from 'nostr-tools';
import { BoundedQueue } from './boundedQueue';
import type { RelayUrl, PublishOutcome, ClientMessage } from '../types';
import { debug, warn, error } from '../log';

export interface PublishHandle {
  promise: Promise<PublishOutcome>;
  cancel(): void;
}

export interface RelayConnOptions {
  queueCapacity: number;
  publishTimeoutMs: number;
  maxFailures: number;
}

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'dead';

export interface SubscriptionHandle {
  id: string;
  close(): void;
  onEvent(cb: (raw: string, parsed: NostrEvent) => void): void;
  onEose(cb: () => void): void;
  onClosed(cb: (reason: string) => void): void;
}

interface SubInternal {
  id: string;
  filters: NostrFilter[];
  oneShot: boolean;
  closedByUs: boolean;
  eosed: boolean;
  onEvent: ((raw: string, parsed: NostrEvent) => void) | null;
  onEose: (() => void) | null;
  onClosed: ((reason: string) => void) | null;
}

interface PendingPub {
  rawWire: string;          // the full `["EVENT",{...}]` wire string
  eventId: string;
  resolve: (o: PublishOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  sent: boolean;
}

export type WebSocketFactory = (url: string) => WebSocket;

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url);

export class RelayConn {
  readonly url: RelayUrl;
  state: ConnState = 'idle';
  failures = 0;
  reconnectAttempt = 0;

  private readonly opts: RelayConnOptions;
  private readonly factory: WebSocketFactory;
  private ws: WebSocket | null = null;
  private activeSubs = new Map<string, SubInternal>();
  private pendingPublishes = new Map<string, PendingPub>();
  private outQueue: BoundedQueue<PendingPub>;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private successCount = 0;
  private failureCount = 0;
  private lastReason: string | null = null;
  private noticeListeners = new Set<(text: string) => void>();

  constructor(url: RelayUrl, opts: RelayConnOptions, factory: WebSocketFactory = defaultFactory) {
    this.url = url;
    this.opts = opts;
    this.factory = factory;
    this.outQueue = new BoundedQueue<PendingPub>(opts.queueCapacity);
  }

  open(): void {
    if (this.state === 'open' || this.state === 'connecting' || this.state === 'dead') return;
    this.closedByUs = false;
    this.state = 'connecting';
    let ws: WebSocket;
    try {
      ws = this.factory(this.url);
    } catch (e) {
      error('relay', `${this.url} ws ctor failed`, e);
      this.scheduleReconnect((e as Error).message);
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.onOpen();
    ws.onmessage = (ev) => this.onMessage(typeof ev.data === 'string' ? ev.data : '');
    ws.onerror = () => { /* error event has no useful detail in browsers; await close */ };
    ws.onclose = (ev) => this.onClose(ev.reason || `code:${ev.code}`);
  }

  subscribe(filters: NostrFilter[], opts?: { oneShot?: boolean }): SubscriptionHandle {
    const id = mintSubId();
    const sub: SubInternal = {
      id,
      filters,
      oneShot: opts?.oneShot === true,
      closedByUs: false,
      eosed: false,
      onEvent: null,
      onEose: null,
      onClosed: null
    };
    this.activeSubs.set(id, sub);

    if (this.state === 'idle' || this.state === 'closed') this.open();
    if (this.state === 'open') this.sendReq(sub);

    const handle: SubscriptionHandle = {
      id,
      close: () => this.closeSub(id),
      onEvent: (cb) => { sub.onEvent = cb; },
      onEose: (cb) => { sub.onEose = cb; },
      onClosed: (cb) => { sub.onClosed = cb; }
    };
    return handle;
  }

  publish(rawEventJson: string, eventId: string): PublishHandle {
    // rawEventJson is the byte-exact event object, e.g. `{"id":"...",...}`
    const wire = `["EVENT",${rawEventJson}]`;
    let resolve!: (o: PublishOutcome) => void;
    const promise = new Promise<PublishOutcome>((r) => { resolve = r; });

    const pending: PendingPub = {
      rawWire: wire,
      eventId,
      resolve,
      timer: null,
      sent: false
    };

    if (this.pendingPublishes.has(eventId)) {
      // Already in flight — coalesce by rejecting the new one as transient.
      pending.resolve({ kind: 'transient', reason: 'duplicate-publish-call' });
      return { promise, cancel: () => undefined };
    }

    // Dead conn cannot be reopened by open() (it short-circuits), and queued
    // pendings would otherwise sit forever waiting for an onOpen that never
    // fires. Resolve immediately so the broadcaster can move on.
    if (this.state === 'dead') {
      pending.resolve({ kind: 'transient', reason: 'conn-dead' });
      return { promise, cancel: () => undefined };
    }

    this.pendingPublishes.set(eventId, pending);

    if (this.state === 'idle' || this.state === 'closed') this.open();

    if (this.state === 'open' && this.ws) {
      this.dispatchPublish(pending);
    } else {
      const queued = this.outQueue.push(pending);
      if (!queued) {
        this.pendingPublishes.delete(eventId);
        pending.resolve({ kind: 'transient', reason: 'queue-overflow' });
      }
    }

    return {
      promise,
      cancel: () => {
        const p = this.pendingPublishes.get(eventId);
        if (!p) return;
        if (p.timer) clearTimeout(p.timer);
        this.pendingPublishes.delete(eventId);
        p.resolve({ kind: 'transient', reason: 'cancelled' });
      }
    };
  }

  close(reason?: string): void {
    this.closedByUs = true;
    this.lastReason = reason ?? 'closed-by-us';
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try {
        for (const sub of this.activeSubs.values()) {
          if (this.ws.readyState === WebSocket.OPEN && !sub.closedByUs) {
            this.sendJson(['CLOSE', sub.id]);
          }
        }
        this.ws.close();
      } catch {}
    }
    this.activeSubs.clear();
    this.failPendingPublishes('connection-closed-by-us');
    this.state = 'closed';
  }

  stats() {
    return {
      state: this.state,
      queueDepth: this.outQueue.length,
      queueDropped: this.outQueue.stats().dropped,
      successCount: this.successCount,
      failureCount: this.failureCount,
      lastReason: this.lastReason
    };
  }

  hasInflight(): boolean {
    return this.pendingPublishes.size > 0 || this.outQueue.length > 0;
  }

  onNotice(cb: (text: string) => void): () => void {
    this.noticeListeners.add(cb);
    return () => { this.noticeListeners.delete(cb); };
  }

  // --- internal ---

  private onOpen(): void {
    this.state = 'open';
    this.reconnectAttempt = 0;
    debug('relay', `${this.url} open`);

    // Replay every (still-living) subscription. One-shots that already EOSE'd are gone.
    for (const sub of this.activeSubs.values()) {
      if (!sub.closedByUs) this.sendReq(sub);
    }
    // Drain queued publishes.
    this.flushOutQueue();
  }

  private onClose(reason: string): void {
    debug('relay', `${this.url} close: ${reason}`);
    this.lastReason = reason;
    this.ws = null;
    this.failPendingPublishes(`connection-closed: ${reason}`);
    if (this.closedByUs) {
      this.state = 'closed';
      return;
    }
    this.failures++;
    this.failureCount++;
    if (this.failures >= this.opts.maxFailures) {
      this.state = 'dead';
      // Items still in outQueue would never drain (no onOpen will fire).
      // failPendingPublishes already resolved their pending entries above, but
      // the queue still holds the (now-zombie) references — drop them.
      this.outQueue.clear();
      warn('relay', `${this.url} marked dead after ${this.failures} failures`);
      return;
    }
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.state === 'dead' || this.closedByUs) return;
    this.state = 'closed';
    const attempt = this.reconnectAttempt++;
    const base = Math.min(1_000 * Math.pow(2, attempt), 60_000);
    const delay = base + Math.random() * 500;
    debug('relay', `${this.url} reconnect in ${Math.round(delay)}ms (${reason})`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private onMessage(data: string): void {
    if (!data) return;
    let msg: unknown;
    try { msg = JSON.parse(data); }
    catch (e) { debug('relay', `${this.url} bad JSON`, (e as Error).message); return; }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return;

    try {
      switch (msg[0]) {
        case 'EVENT':       this.handleEvent(data, msg as ['EVENT', string, NostrEvent]); break;
        case 'EOSE':        this.handleEose(msg as ['EOSE', string]); break;
        case 'OK':          this.handleOk(msg as ['OK', string, boolean, string]); break;
        case 'NOTICE':      this.handleNotice(msg as ['NOTICE', string]); break;
        case 'CLOSED':      this.handleClosed(msg as ['CLOSED', string, string]); break;
        case 'AUTH':        debug('relay', `${this.url} AUTH challenge ignored (v1)`); break;
        default:            debug('relay', `${this.url} unknown msg type: ${msg[0]}`);
      }
    } catch (e) {
      // R24: never throw out of a message handler.
      error('relay', `${this.url} handler threw`, e);
    }
  }

  private handleEvent(rawData: string, msg: ['EVENT', string, NostrEvent]): void {
    const subId = msg[1];
    const sub = this.activeSubs.get(subId);
    if (!sub || !sub.onEvent) return;
    // Extract the byte-exact substring for the event object so the caller can
    // forward it without re-stringifying (R18).
    const raw = extractEventRaw(rawData);
    if (raw == null) {
      debug('relay', `${this.url} could not slice raw event`);
      return;
    }
    sub.onEvent(raw, msg[2]);
  }

  private handleEose(msg: ['EOSE', string]): void {
    const sub = this.activeSubs.get(msg[1]);
    if (!sub) return;
    sub.eosed = true;
    if (sub.onEose) sub.onEose();
    if (sub.oneShot) {
      // CLOSE and remove (don't replay on reconnect).
      try { this.sendJson(['CLOSE', sub.id]); } catch {}
      sub.closedByUs = true;
      this.activeSubs.delete(sub.id);
    }
  }

  private handleOk(msg: ['OK', string, boolean, string]): void {
    const [, eventId, accepted, reason] = msg;
    const pending = this.pendingPublishes.get(eventId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingPublishes.delete(eventId);
    const outcome = classifyOk(accepted, reason ?? '');
    if (outcome.kind === 'ok' || outcome.kind === 'duplicate') this.successCount++;
    pending.resolve(outcome);
  }

  private handleNotice(msg: ['NOTICE', string]): void {
    const text = String(msg[1] ?? '');
    debug('relay', `${this.url} NOTICE: ${text}`);
    for (const cb of this.noticeListeners) {
      try { cb(text); } catch (e) { error('relay', `${this.url} notice cb threw`, e); }
    }
  }

  private handleClosed(msg: ['CLOSED', string, string]): void {
    const [, subId, reason] = msg;
    const sub = this.activeSubs.get(subId);
    if (!sub) return;
    if (sub.onClosed) sub.onClosed(reason);
    this.activeSubs.delete(subId);
  }

  private closeSub(id: string): void {
    const sub = this.activeSubs.get(id);
    if (!sub) return;
    sub.closedByUs = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.sendJson(['CLOSE', id]); } catch {}
    }
    this.activeSubs.delete(id);
  }

  private sendReq(sub: SubInternal): void {
    try {
      this.sendJson(['REQ', sub.id, ...sub.filters]);
    } catch (e) {
      error('relay', `${this.url} sendReq failed`, e);
    }
  }

  private sendJson(msg: ClientMessage): void {
    if (!this.ws) throw new Error('no ws');
    this.ws.send(JSON.stringify(msg));
  }

  private dispatchPublish(p: PendingPub): void {
    if (!this.ws) return;
    try {
      this.ws.send(p.rawWire);
      p.sent = true;
      p.timer = setTimeout(() => {
        if (this.pendingPublishes.delete(p.eventId)) {
          p.resolve({ kind: 'transient', reason: 'publish-timeout' });
        }
      }, this.opts.publishTimeoutMs);
    } catch (e) {
      this.pendingPublishes.delete(p.eventId);
      p.resolve({ kind: 'transient', reason: `send-failed: ${(e as Error).message}` });
    }
  }

  private flushOutQueue(): void {
    while (this.state === 'open' && this.ws && this.outQueue.length > 0) {
      const p = this.outQueue.shift();
      if (!p) break;
      // Only dispatch if still in pendingPublishes (might have been cancelled).
      if (!this.pendingPublishes.has(p.eventId)) continue;
      this.dispatchPublish(p);
    }
  }

  private failPendingPublishes(reason: string): void {
    for (const [, p] of this.pendingPublishes) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ kind: 'transient', reason });
    }
    this.pendingPublishes.clear();
  }
}

function mintSubId(): string {
  // 12 chars is plenty unique within one connection.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

export function classifyOk(accepted: boolean, reason: string): PublishOutcome {
  if (accepted) {
    if (reason.startsWith('duplicate:')) return { kind: 'duplicate' };
    return { kind: 'ok' };
  }
  if (reason.startsWith('duplicate:')) return { kind: 'duplicate' };
  for (const p of ['blocked:', 'invalid:', 'pow:', 'restricted:', 'auth-required:']) {
    if (reason.startsWith(p)) return { kind: 'permanent', reason };
  }
  return { kind: 'transient', reason };
}

/**
 * Slice the byte-exact substring for the event object inside a relay-sent
 * `["EVENT","<subid>",{...}]` envelope. Returns null on parse trouble.
 *
 * The two scanners walk the original string respecting JSON string-escape
 * rules and never re-stringify the parsed object — so signatures survive.
 */
export function extractEventRaw(data: string): string | null {
  // Walk past whitespace, then '['.
  let i = skipWs(data, 0);
  if (data[i] !== '[') return null;
  i = skipWs(data, i + 1);
  // First element: "EVENT"
  const first = scanJsonValue(data, i);
  if (!first) return null;
  i = skipWs(data, first.end);
  if (data[i] !== ',') return null;
  i = skipWs(data, i + 1);
  // Second element: subid string
  const second = scanJsonValue(data, i);
  if (!second) return null;
  i = skipWs(data, second.end);
  if (data[i] !== ',') return null;
  i = skipWs(data, i + 1);
  // Third element: event object — the chunk we want.
  const third = scanJsonValue(data, i);
  if (!third) return null;
  return data.slice(third.start, third.end);
}

function skipWs(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) { i++; continue; }
    break;
  }
  return i;
}

interface Span { start: number; end: number; }

function scanJsonValue(s: string, start: number): Span | null {
  start = skipWs(s, start);
  if (start >= s.length) return null;
  const c = s[start];
  if (c === '"') return scanString(s, start);
  if (c === '{') return scanBalanced(s, start, '{', '}');
  if (c === '[') return scanBalanced(s, start, '[', ']');
  // number / true / false / null
  let i = start;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ',' || ch === ']' || ch === '}' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
    i++;
  }
  if (i === start) return null;
  return { start, end: i };
}

function scanString(s: string, start: number): Span | null {
  if (s[start] !== '"') return null;
  let i = start + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"') return { start, end: i + 1 };
    i++;
  }
  return null;
}

function scanBalanced(s: string, start: number, open: string, close: string): Span | null {
  if (s[start] !== open) return null;
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      const sp = scanString(s, i);
      if (!sp) return null;
      i = sp.end;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
    i++;
  }
  return null;
}
