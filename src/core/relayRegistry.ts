import type { DB } from '../db/idb';
import type { RelayUrl, RelayRow, Nip11Doc } from '../types';
import { debug, warn, error } from '../log';

export interface RelayRegistryOptions {
  nip11TtlMs: number;
  /**
   * Floor on the result of `healthy()` even when fewer relays have passed the
   * viability probe. The floor pulls top-N by `lastOk` then `lastSeen` so a
   * cold-start UI is not stuck broadcasting to nothing while the probe pass
   * is still running.
   */
  minHealthy: number;
}

const NIP11_NULL_TTL_MS = 24 * 60 * 60 * 1_000;
const NIP11_FETCH_TIMEOUT_MS = 5_000;
const MAX_FAILURES = 5;

function normalizeRow(r: RelayRow): RelayRow {
  // Legacy rows from older builds may be missing the viability fields.
  return {
    ...r,
    viable: r.viable ?? null,
    viableReason: r.viableReason ?? null,
    lastProbedAt: r.lastProbedAt ?? null
  };
}

interface Listener { (rows: RelayRow[]): void }

export class RelayRegistry {
  private rows = new Map<RelayUrl, RelayRow>();
  private listeners = new Set<Listener>();
  private nip11Inflight = new Map<RelayUrl, Promise<Nip11Doc | null>>();
  private nip11NullCache = new Map<RelayUrl, number>();

  constructor(private db: DB, private opts: RelayRegistryOptions) {}

  async load(): Promise<void> {
    const rows = await this.db.allRelays();
    for (const r of rows) this.rows.set(r.url, normalizeRow(r));
    this.notify();
  }

  async upsert(url: RelayUrl, observedAt: number): Promise<void> {
    const existing = this.rows.get(url);
    const row: RelayRow = existing
      ? { ...existing, lastSeen: Math.max(existing.lastSeen, observedAt) }
      : {
          url,
          firstSeen: observedAt,
          lastSeen: observedAt,
          lastOk: null,
          failCount: 0,
          dead: false,
          nip11Json: null,
          nip11FetchedAt: null,
          viable: null,
          viableReason: null,
          lastProbedAt: null
        };
    this.rows.set(url, row);
    try { await this.db.upsertRelay(row); }
    catch (e) { error('registry', 'upsert failed', e); }
    this.notify();
  }

  async markViable(url: RelayUrl, viable: boolean, reason: string | null): Promise<void> {
    const row = this.rows.get(url);
    if (!row) return;
    row.viable = viable;
    row.viableReason = reason;
    row.lastProbedAt = Date.now();
    if (viable) row.dead = false;
    debug('registry', `${url} viable=${viable} (${reason ?? '-'})`);
    try { await this.db.upsertRelay(row); }
    catch (e) { error('registry', 'persist viable failed', e); }
    this.notify();
  }

  /** Rows with unknown viability (need probing). */
  unprobed(): RelayRow[] {
    return Array.from(this.rows.values()).filter(r => r.viable === null);
  }

  async markFailure(url: RelayUrl, reason: string): Promise<void> {
    const row = this.rows.get(url);
    if (!row) return;
    row.failCount += 1;
    if (row.failCount >= MAX_FAILURES) row.dead = true;
    debug('registry', `${url} failure (${reason}); count=${row.failCount} dead=${row.dead}`);
    try { await this.db.upsertRelay(row); }
    catch (e) { error('registry', 'persist failure failed', e); }
    this.notify();
  }

  async markSuccess(url: RelayUrl, at: number): Promise<void> {
    const row = this.rows.get(url);
    if (!row) return;
    row.failCount = 0;
    row.dead = false;
    row.lastOk = at;
    row.lastSeen = Math.max(row.lastSeen, at);
    try { await this.db.upsertRelay(row); }
    catch (e) { error('registry', 'persist success failed', e); }
    this.notify();
  }

  healthy(): RelayRow[] {
    const all = Array.from(this.rows.values());
    // Primary set: passed the viability probe and not currently dead.
    const live = all.filter(r => r.viable === true && !r.dead);
    if (live.length >= this.opts.minHealthy) return live;
    // Floor: while the probe pass is still running and we have nothing
    // confirmed-viable, fall back to top-N by `lastOk` then `lastSeen` so the
    // first events do not target an empty set. Skip rows already proven
    // non-viable; those are wasted work.
    const sorted = all
      .filter(r => r.viable !== false)
      .slice()
      .sort((a, b) => {
        const aOk = a.lastOk ?? 0;
        const bOk = b.lastOk ?? 0;
        if (aOk !== bOk) return bOk - aOk;
        return b.lastSeen - a.lastSeen;
      });
    return sorted.slice(0, this.opts.minHealthy);
  }

  all(): RelayRow[] { return Array.from(this.rows.values()); }

  /** Synchronous lookup of the in-memory NIP-11 cache (no network). */
  cachedNip11(url: RelayUrl): Nip11Doc | null {
    const row = this.rows.get(url);
    return row?.nip11Json ?? null;
  }

  async nip11(url: RelayUrl): Promise<Nip11Doc | null> {
    const inflight = this.nip11Inflight.get(url);
    if (inflight) return inflight;

    const row = this.rows.get(url);
    const now = Date.now();

    if (row?.nip11Json && row.nip11FetchedAt && now - row.nip11FetchedAt < this.opts.nip11TtlMs) {
      return row.nip11Json;
    }
    const nullAt = this.nip11NullCache.get(url);
    if (nullAt && now - nullAt < NIP11_NULL_TTL_MS) return null;

    // Try IDB cache before going to network.
    try {
      const cached = await this.db.getNip11(url);
      if (cached && now - cached.fetchedAt < this.opts.nip11TtlMs) {
        if (row) {
          row.nip11Json = cached.doc;
          row.nip11FetchedAt = cached.fetchedAt;
          this.rows.set(url, row);
          await this.db.upsertRelay(row).catch(() => undefined);
          this.notify();
        }
        return cached.doc;
      }
    } catch (e) { debug('registry', 'nip11 cache read failed', e); }

    const promise = this.fetchNip11(url);
    this.nip11Inflight.set(url, promise);
    try {
      return await promise;
    } finally {
      this.nip11Inflight.delete(url);
    }
  }

  private async fetchNip11(url: RelayUrl): Promise<Nip11Doc | null> {
    const httpUrl = url.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), NIP11_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(httpUrl, {
        headers: { Accept: 'application/nostr+json' },
        signal: ac.signal,
        // Force CORS-safe behaviour; if the relay does not allow it we will end up here.
      });
      if (!res.ok) {
        warn('registry', `${url} nip11 status ${res.status}`);
        this.nip11NullCache.set(url, Date.now());
        return null;
      }
      const doc = await res.json() as Nip11Doc;
      const now = Date.now();
      const row = this.rows.get(url);
      if (row) {
        row.nip11Json = doc;
        row.nip11FetchedAt = now;
        await this.db.upsertRelay(row).catch(() => undefined);
        this.rows.set(url, row);
        this.notify();
      }
      await this.db.putNip11(url, doc, now).catch(() => undefined);
      return doc;
    } catch (e) {
      debug('registry', `${url} nip11 fetch failed (cors/timeout?)`, (e as Error).message);
      this.nip11NullCache.set(url, Date.now());
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  subscribe(cb: (rows: RelayRow[]) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async forgetAll(): Promise<void> {
    this.rows.clear();
    this.nip11Inflight.clear();
    this.nip11NullCache.clear();
    try {
      await this.db.deleteAllRelays();
      await this.db.deleteAllNip11();
    } catch (e) { error('registry', 'forgetAll failed', e); }
    this.notify();
  }

  private notify(): void {
    const snap = Array.from(this.rows.values());
    for (const l of this.listeners) {
      try { l(snap); } catch (e) { error('registry', 'listener threw', e); }
    }
  }
}
