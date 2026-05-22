import { matchFilter, type Filter as NostrFilter } from 'nostr-tools';
import type { IngestedEvent, RelayUrl } from '../types';
import { warn } from '../log';

type Listener = () => void;

const UNKNOWN_RELAY = '(unknown)' as RelayUrl;

export class PreviewStore {
  private events: IngestedEvent[] = [];
  // Per-id guard so duplicate deliveries (same id, possibly from multiple
  // relays) collapse to one buffer entry. Grows unbounded together with
  // `events`; the panel handles display via incremental rendering.
  private seen = new Set<string>();
  private matched = 0;
  private unique = 0;
  private listeners = new Set<Listener>();
  private filter: NostrFilter | null = null;
  // Distinct source relays that have delivered at least one filter-matching
  // event. Primarily a reverse-mode visibility signal: shows breadth of the
  // scrape ("got data from N relays") vs the single-source forward case.
  private contributors = new Set<RelayUrl>();
  // Per-relay count of events that arrived in-band but didn't match the active
  // filter. The relay-id dedupe LRU runs upstream in the subscriber, so a given
  // off-filter event id is only credited to whichever relay delivered it first
  // — this is a lower bound on non-compliance, not an exact tally.
  private mismatches = new Map<RelayUrl, number>();

  add(e: IngestedEvent): void {
    if (this.filter && !matchFilter(this.filter, e.parsed)) {
      const key = e.sourceRelay ?? UNKNOWN_RELAY;
      const prev = this.mismatches.get(key) ?? 0;
      if (prev === 0) {
        warn('preview', `${key} sent off-filter event ${e.id}; dropping client-side`);
      }
      this.mismatches.set(key, prev + 1);
      this.emit();
      return;
    }
    this.matched++;
    if (e.sourceRelay) this.contributors.add(e.sourceRelay);
    if (this.seen.has(e.id)) {
      this.emit();
      return;
    }
    this.seen.add(e.id);
    this.unique++;
    this.events.push(e);
    this.emit();
  }

  setFilter(filter: NostrFilter): void {
    this.applyFilter(filter);
  }

  applyFilter(filter: NostrFilter): void {
    this.filter = filter;
    const survivors = this.events.filter(e => matchFilter(filter, e.parsed));
    this.events = survivors;
    this.seen = new Set(survivors.map(e => e.id));
    this.matched = survivors.length;
    this.unique = survivors.length;
    this.contributors = new Set(
      survivors.map(e => e.sourceRelay).filter((u): u is RelayUrl => !!u)
    );
    this.mismatches.clear();
    this.emit();
  }

  clear(): void {
    if (
      this.events.length === 0 &&
      this.matched === 0 &&
      this.unique === 0 &&
      this.mismatches.size === 0 &&
      this.contributors.size === 0
    ) return;
    this.events = [];
    this.seen.clear();
    this.matched = 0;
    this.unique = 0;
    this.contributors.clear();
    this.mismatches.clear();
    this.emit();
  }

  snapshot(): IngestedEvent[] {
    return this.events.slice();
  }

  size(): number {
    return this.events.length;
  }

  matchedCount(): number {
    return this.matched;
  }

  uniqueCount(): number {
    return this.unique;
  }

  contributorCount(): number {
    return this.contributors.size;
  }

  mismatchByRelay(): ReadonlyMap<RelayUrl, number> {
    return this.mismatches;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private emit(): void {
    for (const l of this.listeners) {
      try { l(); } catch { /* swallow — view layer */ }
    }
  }
}
