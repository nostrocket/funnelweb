import { RelayConn, type RelayConnOptions } from './relayConn';
import type { RelayUrl } from '../types';
import { debug } from '../log';

export interface RelayPoolOptions extends RelayConnOptions {
  maxConnections: number;
}

export class RelayPool {
  private map = new Map<RelayUrl, RelayConn>();
  private lru: RelayUrl[] = [];
  private pinned = new Set<RelayUrl>();
  private readonly connOpts: RelayConnOptions;
  private readonly maxConnections: number;

  constructor(opts: RelayPoolOptions) {
    const { maxConnections, ...rest } = opts;
    this.connOpts = rest;
    this.maxConnections = maxConnections;
  }

  pin(url: RelayUrl): void { this.pinned.add(url); this.touch(url); }
  unpin(url: RelayUrl): void { this.pinned.delete(url); }
  isPinned(url: RelayUrl): boolean { return this.pinned.has(url); }

  /**
   * Close + drop a connection only if it isn't pinned (pinning is used by
   * long-lived consumers like the source subscription and discovery). Returns
   * true if released. Used by the broadcaster's connect-publish-disconnect
   * worker to free conns after drain without killing reader subscriptions.
   */
  releaseIfNotPinned(url: RelayUrl): boolean {
    if (this.pinned.has(url)) return false;
    const c = this.map.get(url);
    if (!c) return false;
    c.close('released-after-drain');
    this.map.delete(url);
    const i = this.lru.indexOf(url);
    if (i >= 0) this.lru.splice(i, 1);
    return true;
  }

  get(url: RelayUrl): RelayConn {
    let c = this.map.get(url);
    if (c) { this.touch(url); return c; }
    this.evictIfNeeded();
    c = new RelayConn(url, this.connOpts);
    this.map.set(url, c);
    this.lru.push(url);
    return c;
  }

  has(url: RelayUrl): boolean { return this.map.has(url); }

  remove(url: RelayUrl): void {
    const c = this.map.get(url);
    if (!c) return;
    c.close('removed-from-pool');
    this.map.delete(url);
    const i = this.lru.indexOf(url);
    if (i >= 0) this.lru.splice(i, 1);
    this.pinned.delete(url);
  }

  snapshot(): { url: RelayUrl; stats: ReturnType<RelayConn['stats']> }[] {
    const out: { url: RelayUrl; stats: ReturnType<RelayConn['stats']> }[] = [];
    for (const [url, conn] of this.map) {
      out.push({ url, stats: conn.stats() });
    }
    return out;
  }

  destroy(): void {
    for (const c of this.map.values()) c.close('pool-destroyed');
    this.map.clear();
    this.lru.length = 0;
    this.pinned.clear();
  }

  private touch(url: RelayUrl): void {
    const i = this.lru.indexOf(url);
    if (i >= 0) this.lru.splice(i, 1);
    this.lru.push(url);
  }

  private evictIfNeeded(): void {
    if (this.maxConnections <= 0) return;
    while (this.map.size >= this.maxConnections) {
      let evictedUrl: RelayUrl | null = null;
      for (let i = 0; i < this.lru.length; i++) {
        const u = this.lru[i]!;
        if (this.pinned.has(u)) continue;
        const c = this.map.get(u);
        // Don't evict a connection that still has work in flight — eviction
        // would resolve those publishes as transient and bump the relay's
        // failure count for our own bookkeeping mistake.
        if (c && c.hasInflight()) continue;
        evictedUrl = u;
        this.lru.splice(i, 1);
        break;
      }
      // No idle non-pinned candidate found: allow a temporary overshoot
      // rather than killing in-flight publishes. The next get() retries.
      if (!evictedUrl) {
        debug('pool', `cap ${this.maxConnections} exceeded; no idle conn to evict (size=${this.map.size})`);
        return;
      }
      const conn = this.map.get(evictedUrl);
      if (conn) {
        conn.close('evicted-from-pool');
        this.map.delete(evictedUrl);
      }
      debug('pool', `evicted ${evictedUrl} (cap ${this.maxConnections})`);
    }
  }
}
