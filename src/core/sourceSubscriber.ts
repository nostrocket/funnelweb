import { verifyEvent, type Filter as NostrFilter, type Event as NostrEvent } from 'nostr-tools';
import type { IngestedEvent, RelayUrl } from '../types';
import type { RelayPool } from './relayPool';
import type { DedupeLru } from './dedupeLru';
import type { SubscriptionHandle } from './relayConn';
import { debug, warn } from '../log';

export interface SourceSubscriberDeps {
  pool: RelayPool;
  dedupe: DedupeLru;
  onEvent: (e: IngestedEvent) => void;
  onLive: () => void;
  onError: (msg: string) => void;
}

export class SourceSubscriber {
  private deps: SourceSubscriberDeps;
  private currentUrl: RelayUrl | null = null;
  private currentFilter: NostrFilter | null = null;
  private sub: SubscriptionHandle | null = null;
  private live = false;
  private historyBuffer: IngestedEvent[] = [];

  constructor(deps: SourceSubscriberDeps) {
    this.deps = deps;
  }

  start(sourceUrl: RelayUrl, filter: NostrFilter): void {
    this.stop();
    this.currentUrl = sourceUrl;
    this.currentFilter = filter;
    this.live = false;
    this.historyBuffer = [];

    this.deps.pool.pin(sourceUrl);
    const conn = this.deps.pool.get(sourceUrl);
    conn.open();
    const handle = conn.subscribe([filter]);
    handle.onEvent((raw, parsed) => this.handleEvent(raw, parsed));
    handle.onEose(() => this.handleEose());
    handle.onClosed((reason) => {
      warn('source', `${sourceUrl} closed: ${reason}`);
      this.deps.onError(reason);
    });
    this.sub = handle;
  }

  stop(): void {
    if (this.sub) { this.sub.close(); this.sub = null; }
    if (this.currentUrl) this.deps.pool.unpin(this.currentUrl);
    this.currentUrl = null;
    this.currentFilter = null;
    this.live = false;
    this.historyBuffer = [];
  }

  reconfigure(filter: NostrFilter): void {
    if (!this.currentUrl) {
      this.currentFilter = filter;
      return;
    }
    this.start(this.currentUrl, filter);
  }

  private handleEvent(raw: string, parsed: NostrEvent): void {
    let ok = false;
    try { ok = verifyEvent(parsed); }
    catch (e) { debug('source', 'verifyEvent threw', (e as Error).message); }
    if (!ok) {
      debug('source', `dropped invalid sig ${parsed.id}`);
      return;
    }
    if (!this.deps.dedupe.add(parsed.id)) return;

    const ingested: IngestedEvent = {
      id: parsed.id,
      parsed,
      raw,
      receivedAt: Date.now(),
      ...(this.currentUrl ? { sourceRelay: this.currentUrl } : {})
    };

    if (this.live) this.deps.onEvent(ingested);
    else this.historyBuffer.push(ingested);
  }

  private handleEose(): void {
    this.live = true;
    this.historyBuffer.sort((a, b) => b.parsed.created_at - a.parsed.created_at);
    for (const e of this.historyBuffer) this.deps.onEvent(e);
    this.historyBuffer = [];
    this.deps.onLive();
  }
}
