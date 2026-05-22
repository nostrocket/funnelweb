import { verifyEvent, type Filter as NostrFilter, type Event as NostrEvent } from 'nostr-tools';
import type { IngestedEvent, RelayUrl } from '../types';
import type { RelayPool } from './relayPool';
import type { RelayRegistry } from './relayRegistry';
import type { DedupeLru } from './dedupeLru';
import type { SubscriptionHandle } from './relayConn';
import { debug, warn } from '../log';

export interface ReverseSubscriberOptions {
  maxConcurrent: number;
  idleTimeoutMs: number;
}

export interface ReverseSubscriberDeps {
  pool: RelayPool;
  registry: RelayRegistry;
  dedupe: DedupeLru;
  onEvent: (e: IngestedEvent) => void;
  onLive: () => void;
  onError: (msg: string) => void;
  options?: Partial<ReverseSubscriberOptions>;
}

interface ActiveEntry {
  sub: SubscriptionHandle;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Inverse of SourceSubscriber: subscribes the user's filter to many discovered
 * relays at once, dedupes by event id, and emits to a single sink. Designed
 * for one-pass historical scraping — each per-relay subscription is one-shot
 * (auto-CLOSE on EOSE, see RelayConn) and is also closed if no events arrive
 * within `idleTimeoutMs`. At most `maxConcurrent` connections are scraping at
 * any one time; the rest queue.
 *
 * The relay set is snapshotted from `registry.healthy()` at `start()` and not
 * refreshed mid-run — Discovery keeps populating the registry independently
 * for the next pass.
 */
export class ReverseSubscriber {
  private deps: ReverseSubscriberDeps;
  private opts: ReverseSubscriberOptions;
  private currentFilter: NostrFilter | null = null;
  private pending: RelayUrl[] = [];
  private active = new Map<RelayUrl, ActiveEntry>();
  private live = false;
  private running = false;

  constructor(deps: ReverseSubscriberDeps) {
    this.deps = deps;
    this.opts = {
      maxConcurrent: deps.options?.maxConcurrent ?? 128,
      idleTimeoutMs: deps.options?.idleTimeoutMs ?? 30_000
    };
  }

  start(filter: NostrFilter): void {
    this.stop();
    this.currentFilter = filter;
    this.live = false;
    this.running = true;
    const urls = this.deps.registry.healthy().map(r => r.url);
    if (urls.length === 0) {
      this.deps.onError('no healthy relays discovered yet');
      this.live = true;
      this.running = false;
      this.deps.onLive();
      return;
    }
    this.pending = urls.slice();
    debug('reverse', `start: ${this.pending.length} relays in queue, cap ${this.opts.maxConcurrent}`);
    this.pumpQueue();
  }

  stop(): void {
    this.running = false;
    for (const [url, entry] of this.active) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      try { entry.sub.close(); } catch (e) { debug('reverse', `${url} close threw`, (e as Error).message); }
    }
    this.active.clear();
    this.pending = [];
    this.currentFilter = null;
    this.live = false;
  }

  reconfigure(filter: NostrFilter): void {
    this.start(filter);
  }

  private pumpQueue(): void {
    if (!this.running || !this.currentFilter) return;
    while (this.active.size < this.opts.maxConcurrent && this.pending.length > 0) {
      const url = this.pending.shift()!;
      this.openOne(url, this.currentFilter);
    }
    if (this.active.size === 0 && this.pending.length === 0 && !this.live) {
      this.live = true;
      this.running = false;
      this.deps.onLive();
    }
  }

  private openOne(url: RelayUrl, filter: NostrFilter): void {
    const conn = this.deps.pool.get(url);
    let sub: SubscriptionHandle;
    try {
      conn.open();
      sub = conn.subscribe([filter], { oneShot: true });
    } catch (e) {
      debug('reverse', `${url} subscribe threw`, (e as Error).message);
      // Treat as instant close; advance to next.
      queueMicrotask(() => this.pumpQueue());
      return;
    }

    const entry: ActiveEntry = { sub, idleTimer: null };
    this.active.set(url, entry);

    sub.onEvent((raw, parsed) => this.handleEvent(url, raw, parsed));
    sub.onEose(() => this.closeAndAdvance(url, 'eose'));
    sub.onClosed((reason) => this.closeAndAdvance(url, `closed:${reason}`));

    entry.idleTimer = setTimeout(
      () => this.closeAndAdvance(url, 'idle-timeout'),
      this.opts.idleTimeoutMs
    );
  }

  private handleEvent(url: RelayUrl, raw: string, parsed: NostrEvent): void {
    const entry = this.active.get(url);
    if (!entry) return;

    let ok = false;
    try { ok = verifyEvent(parsed); }
    catch (e) { debug('reverse', `${url} verifyEvent threw`, (e as Error).message); }
    if (!ok) {
      debug('reverse', `${url} dropped invalid sig ${parsed.id}`);
      this.resetIdleTimer(url);
      return;
    }
    if (!this.deps.dedupe.add(parsed.id)) {
      this.resetIdleTimer(url);
      return;
    }

    const ingested: IngestedEvent = {
      id: parsed.id,
      parsed,
      raw,
      receivedAt: Date.now(),
      sourceRelay: url
    };
    try { this.deps.onEvent(ingested); }
    catch (e) { warn('reverse', `onEvent threw: ${(e as Error).message}`); }

    this.resetIdleTimer(url);
  }

  private resetIdleTimer(url: RelayUrl): void {
    const entry = this.active.get(url);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(
      () => this.closeAndAdvance(url, 'idle-timeout'),
      this.opts.idleTimeoutMs
    );
  }

  private closeAndAdvance(url: RelayUrl, reason: string): void {
    const entry = this.active.get(url);
    if (!entry) return;
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    try { entry.sub.close(); } catch {}
    this.active.delete(url);
    debug('reverse', `${url} closed (${reason}); active=${this.active.size} pending=${this.pending.length}`);
    this.pumpQueue();
  }
}
