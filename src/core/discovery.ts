import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import type { RelayPool } from './relayPool';
import type { RelayRegistry } from './relayRegistry';
import type { SubscriptionHandle } from './relayConn';
import { tryNormaliseRelayUrl } from './relayUrl';
import type { RelayUrl } from '../types';
import { debug, warn } from '../log';

export interface DiscoveryOptions {
  sinceSecondsAgo: number;
  perRelayLimit: number;
}

interface SeedState {
  oneShot: SubscriptionHandle | null;
  live: SubscriptionHandle | null;
}

export class Discovery {
  private seeds = new Map<RelayUrl, SeedState>();
  private stopped = false;

  constructor(
    private pool: RelayPool,
    private registry: RelayRegistry,
    private opts: DiscoveryOptions
  ) {}

  setSeeds(rawSeeds: string[]): void {
    if (this.stopped) return;

    const next = new Map<RelayUrl, true>();
    for (const raw of rawSeeds) {
      const url = tryNormaliseRelayUrl(raw);
      if (!url) {
        if (raw.trim() !== '') warn('discovery', `invalid seed url: ${raw}`);
        continue;
      }
      next.set(url, true);
    }

    // Remove seeds no longer present.
    for (const [url, state] of this.seeds) {
      if (!next.has(url)) {
        if (state.oneShot) state.oneShot.close();
        if (state.live) state.live.close();
        this.pool.unpin(url);
        this.seeds.delete(url);
      }
    }

    // Add new seeds.
    const nowSec = Math.floor(Date.now() / 1000);
    for (const url of next.keys()) {
      if (this.seeds.has(url)) continue;
      this.pool.pin(url);
      const conn = this.pool.get(url);
      conn.open();

      const oneShot = conn.subscribe(
        [{ kinds: [30166], since: nowSec - this.opts.sinceSecondsAgo, limit: this.opts.perRelayLimit }],
        { oneShot: true }
      );
      oneShot.onEvent((_raw, evt) => this.handleEvent(evt));
      oneShot.onEose(() => debug('discovery', `${url} oneShot EOSE`));

      const live = conn.subscribe([{ kinds: [30166], limit: 500 }]);
      live.onEvent((_raw, evt) => this.handleEvent(evt));

      this.seeds.set(url, { oneShot, live });
    }
  }

  stop(): void {
    this.stopped = true;
    for (const [url, s] of this.seeds) {
      if (s.oneShot) s.oneShot.close();
      if (s.live) s.live.close();
      this.pool.unpin(url);
    }
    this.seeds.clear();
  }

  private handleEvent(evt: NostrEvent): void {
    let ok = false;
    try { ok = verifyEvent(evt); } catch {}
    if (!ok) { debug('discovery', `bad sig ${evt.id}`); return; }

    const dTag = evt.tags.find(t => t[0] === 'd')?.[1];
    if (!dTag) return;

    // n tag: only accept clearnet in v1. If absent, accept (some publishers skip it).
    const nTag = evt.tags.find(t => t[0] === 'n')?.[1];
    if (nTag && nTag !== 'clearnet') return;

    const url = tryNormaliseRelayUrl(dTag);
    if (!url) return;

    void this.registry.upsert(url, evt.created_at * 1_000);
  }
}
