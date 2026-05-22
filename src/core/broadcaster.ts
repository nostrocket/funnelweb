import type { IngestedEvent, PublishOutcome, RelayUrl } from '../types';
import type { RelayPool } from './relayPool';
import type { RelayRegistry } from './relayRegistry';
import type { RelayConn } from './relayConn';
import { debug } from '../log';

export function looksLikeRateLimit(text: string): boolean {
  const t = text.toLowerCase();
  if (t.startsWith('rate-limited:')) return true;
  return /\brate[- ]?limit/.test(t) || /\btoo many\b/.test(t) || /\bslow down\b/.test(t);
}

export type BroadcastOutcomeKind = 'queued' | 'ok' | 'duplicate' | 'permanent' | 'transient';

export interface BroadcastEntry {
  eventId: string;
  url: string;
  outcome: BroadcastOutcomeKind;
  reason: string | null;
  ts: number;
}

export interface BroadcastCounters {
  discovered: number;
  healthy: number;
  dead: number;
  dropped: number;
  delivered: number;
}

/**
 * Per-call summary of how many publish attempts produced each outcome kind.
 * `oversize` covers events skipped pre-publish for exceeding a relay's
 * NIP-11 `max_message_length`. `transient + permanent + oversize` is the
 * caller's "anything failed?" signal.
 */
export interface BatchResult {
  ok: number;
  duplicate: number;
  transient: number;
  permanent: number;
  oversize: number;
}

export interface BroadcasterOptions {
  /**
   * How many relays we have an open connection to at any one time.
   *
   * Each relay is processed connect → drain queue serially → disconnect, so
   * this is the cap on simultaneous WebSockets the broadcaster opens. The
   * remaining viable relays sit in `perRelayQueue` until a worker slot frees.
   */
  maxConcurrentRelays: number;
  /**
   * In reverse mode (`broadcastBatchToOne`), the maximum number of publishes
   * we will have in flight to the single destination at once. Must stay well
   * below the per-relay outQueue capacity so we never overflow our own queue
   * just by dispatching, and small enough that the synchronous spike of
   * `publishOne` calls + `onLog` callbacks doesn't stall the main thread.
   */
  singleTargetConcurrency: number;
}

export interface BroadcasterDeps {
  pool: RelayPool;
  registry: RelayRegistry;
  options?: Partial<BroadcasterOptions>;
  onLog: (entry: BroadcastEntry) => void;
  onCounter: (c: BroadcastCounters) => void;
  /**
   * Surfaced when the destination relay signals possible rate-limiting during
   * a single-target funnel (reverse mode). Fires at most once per
   * `broadcastBatchToOne` call so the user gets one notification, not a
   * stream. Triggered by NOTICE messages or transient OK reasons that match
   * `looksLikeRateLimit`.
   */
  onWarning?: (msg: string) => void;
}

/**
 * Per-relay FIFO queue + per-relay worker.
 *
 * Triggered by `broadcastBatch(events)`: enqueues each event against every
 * `registry.healthy()` target, then resolves once every per-relay worker has
 * drained. There is no event-driven fanout — events flow through this class
 * exactly when the user asks. The per-relay worker pool itself is unchanged:
 * one worker per relay, capped globally by `maxConcurrentRelays` (browser
 * resource ceiling), with FIFO order at each relay so replaceable kinds (R8)
 * arrive in ingest order without a separate per-author chain.
 */
export class Broadcaster {
  private perRelayQueue = new Map<RelayUrl, IngestedEvent[]>();
  private workers = new Map<RelayUrl, Promise<void>>();
  private waiting: RelayUrl[] = [];
  private deliveredTo = new Set<RelayUrl>();
  private opts: BroadcasterOptions;
  // Aggregator updated by `publishOne` for the active batch call. Both
  // `broadcastBatch` and `broadcastBatchToOne` set this for the lifetime of
  // their await and reset it in `finally`. Only one batch is ever in flight
  // (the phase machine in main.ts gates this), so a single field suffices.
  private currentBatch: BatchResult | null = null;

  constructor(private deps: BroadcasterDeps) {
    this.opts = {
      maxConcurrentRelays: deps.options?.maxConcurrentRelays ?? 64,
      singleTargetConcurrency: deps.options?.singleTargetConcurrency ?? 32
    };
    deps.registry.subscribe(() => this.publishCounters());
  }

  /**
   * Fan out a snapshot of events. Resolves when every per-relay queue has
   * drained. Callers are responsible for ensuring no source REQ is open
   * concurrently — broadcasting and source subscription are mutually
   * exclusive states in the application.
   */
  async broadcastBatch(events: IngestedEvent[]): Promise<BatchResult> {
    const result: BatchResult = { ok: 0, duplicate: 0, transient: 0, permanent: 0, oversize: 0 };
    if (events.length === 0) return result;
    this.currentBatch = result;
    try {
      const targets = this.deps.registry.healthy();
      for (const e of events) {
        for (const t of targets) {
          this.enqueueFor(t.url, e);
        }
      }
      this.publishCounters();
      await this.drain();
    } finally {
      this.currentBatch = null;
    }
    return result;
  }

  /**
   * Funnel a snapshot of events to a single destination relay. Used by reverse
   * mode where the destination is operator-supplied rather than the registry's
   * healthy set.
   *
   * Dispatch is bounded by `singleTargetConcurrency` so we never overflow our
   * own per-relay outQueue (cap = `queueSizePerRelay`) just by enqueuing.
   * Workers pull from the input array in index order, so first-N events are
   * always the first to reach the relay; relay-side ack order is independent.
   * Replaceable-kind correctness (R8) relies on the relay honouring
   * `created_at` rather than receive order, which NIP-01 mandates.
   *
   * The relay may still rate-limit us once we are at the wire. NOTICE messages
   * and transient OK reasons matching `looksLikeRateLimit` are surfaced once
   * per call to `onWarning` so the operator can decide whether to slow down or
   * split the batch.
   */
  async broadcastBatchToOne(url: RelayUrl, events: IngestedEvent[]): Promise<BatchResult> {
    const result: BatchResult = { ok: 0, duplicate: 0, transient: 0, permanent: 0, oversize: 0 };
    if (events.length === 0) return result;
    this.currentBatch = result;
    const conn = this.deps.pool.get(url);

    let warned = false;
    const fireWarning = (source: string, text: string): void => {
      if (warned) return;
      warned = true;
      this.deps.onWarning?.(
        `${url} appears to be rate-limiting (${source}): ${text}. If many events fail, slow down or split the batch.`
      );
    };
    const unsubNotice = conn.onNotice(text => {
      if (looksLikeRateLimit(text)) fireWarning('NOTICE', text);
    });

    this.publishCounters();
    try {
      const conc = Math.min(this.opts.singleTargetConcurrency, events.length);
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < events.length) {
          const idx = cursor++;
          const e = events[idx]!;
          const outcome = await this.publishOne(conn, url, e);
          if (outcome && outcome.kind === 'transient' && looksLikeRateLimit(outcome.reason)) {
            fireWarning('OK', outcome.reason);
          }
        }
      };
      await Promise.all(Array.from({ length: conc }, () => worker()));
    } finally {
      unsubNotice();
      this.deps.pool.releaseIfNotPinned(url);
      this.currentBatch = null;
    }
    return result;
  }

  async drain(): Promise<void> {
    while (this.workers.size > 0 || this.waiting.length > 0) {
      const ws = Array.from(this.workers.values());
      if (ws.length > 0) await Promise.allSettled(ws);
      // Workers may have queued more relays as they finished.
    }
  }

  private enqueueFor(url: RelayUrl, e: IngestedEvent): void {
    let q = this.perRelayQueue.get(url);
    if (!q) { q = []; this.perRelayQueue.set(url, q); }
    q.push(e);
    if (this.workers.has(url)) return;
    if (this.workers.size < this.opts.maxConcurrentRelays) {
      this.startWorker(url);
    } else if (!this.waiting.includes(url)) {
      this.waiting.push(url);
    }
  }

  private startWorker(url: RelayUrl): void {
    const p = this.runWorker(url).catch(() => undefined);
    this.workers.set(url, p);
    void p.finally(() => {
      // Re-check: enqueueFor may have appended an event after the worker
      // exited its drain loop but before this finally fires (it would have
      // bailed seeing `workers.has(url)` still true). If so, restart on the
      // same slot rather than leaving the tail event stranded.
      const tail = this.perRelayQueue.get(url);
      if (tail && tail.length > 0) {
        this.startWorker(url); // replaces the entry in `workers`
        return;
      }
      this.workers.delete(url);
      // Promote the next waiting relay into a worker slot.
      while (this.waiting.length > 0 && this.workers.size < this.opts.maxConcurrentRelays) {
        const nextUrl = this.waiting.shift()!;
        const q = this.perRelayQueue.get(nextUrl);
        if (!q || q.length === 0) continue;
        this.startWorker(nextUrl);
      }
    });
  }

  private async runWorker(url: RelayUrl): Promise<void> {
    const conn = this.deps.pool.get(url);
    try {
      while (true) {
        const q = this.perRelayQueue.get(url);
        if (!q || q.length === 0) break;
        const e = q.shift()!;
        if (q.length === 0) this.perRelayQueue.delete(url);
        await this.publishOne(conn, url, e);
      }
    } finally {
      // Ephemeral: close after drain so we don't sit on idle connections,
      // but only if the relay isn't pinned by another consumer (source
      // subscription, discovery seed) — closing a pinned conn would tear
      // down their REQs.
      this.deps.pool.releaseIfNotPinned(url);
    }
  }

  private async publishOne(conn: RelayConn, url: RelayUrl, e: IngestedEvent): Promise<PublishOutcome | null> {
    // Honour per-relay NIP-11 max_message_length (R23). Use cached doc only —
    // an awaited fetch here would serialise into the worker's hot path for
    // every first-touched relay (5s CORS timeout per).
    const info = this.deps.registry.cachedNip11(url);
    const cap = info?.limitation?.max_message_length;
    if (cap && e.raw.length + 16 > cap) {
      this.deps.onLog({
        eventId: e.id, url, outcome: 'permanent',
        reason: `oversize:${e.raw.length}>${cap}`, ts: Date.now()
      });
      if (this.currentBatch) this.currentBatch.oversize++;
      return null;
    }

    this.deps.onLog({ eventId: e.id, url, outcome: 'queued', reason: null, ts: Date.now() });

    let outcome: PublishOutcome;
    try {
      const handle = conn.publish(e.raw, e.id);
      outcome = await handle.promise;
    } catch (err) {
      outcome = { kind: 'transient' as const, reason: (err as Error).message };
    }

    const entry: BroadcastEntry = {
      eventId: e.id,
      url,
      outcome: outcome.kind,
      reason: 'reason' in outcome ? outcome.reason : null,
      ts: Date.now()
    };
    this.deps.onLog(entry);

    if (this.currentBatch) {
      if (outcome.kind === 'ok') this.currentBatch.ok++;
      else if (outcome.kind === 'duplicate') this.currentBatch.duplicate++;
      else if (outcome.kind === 'transient') this.currentBatch.transient++;
      else if (outcome.kind === 'permanent') this.currentBatch.permanent++;
    }

    if (outcome.kind === 'ok' || outcome.kind === 'duplicate') {
      void this.deps.registry.markSuccess(url, Date.now());
      if (!this.deliveredTo.has(url)) {
        this.deliveredTo.add(url);
        this.publishCounters();
      }
    } else if (outcome.kind === 'transient') {
      void this.deps.registry.markFailure(url, outcome.reason);
    } else if (outcome.kind === 'permanent') {
      // Permanent rejection: the relay told us our event will never be
      // accepted. For auth/restricted/blocked this is a property of the
      // relay (it doesn't accept arbitrary writes from us), so demote it to
      // non-viable so future events skip it. Other permanents (`invalid:`,
      // `pow:`) are about the event itself; leave viability untouched.
      const reason = outcome.reason;
      if (reason.startsWith('auth-required:') ||
          reason.startsWith('restricted:') ||
          reason.startsWith('blocked:')) {
        void this.deps.registry.markViable(url, false, reason);
      }
    }
    debug('broadcast', `${e.id.slice(0, 8)} → ${url} ${outcome.kind}`);
    return outcome;
  }

  publishCounters(): void {
    const all = this.deps.registry.all();
    const dead = all.filter(r => r.dead).length;
    const healthy = this.deps.registry.healthy().length;
    let dropped = 0;
    for (const { stats } of this.deps.pool.snapshot()) dropped += stats.queueDropped;
    this.deps.onCounter({
      discovered: all.length,
      healthy,
      dead,
      dropped,
      delivered: this.deliveredTo.size
    });
  }
}
