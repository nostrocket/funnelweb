import { openDB as openIDB, type IDBPDatabase } from 'idb';
import type { Settings, RelayRow, Nip11Doc } from '../types';
import {
  DB_NAME, DB_VERSION,
  STORE_SETTINGS, STORE_RELAYS, STORE_NIP11, STORE_DEDUPE, STORE_HISTORY,
  SETTINGS_KEY,
  HISTORY_LIMIT,
  type HistoryKind
} from './schema';

export interface HistoryEntry { value: string; lastUsed: number; }

export interface DB {
  loadSettings(): Promise<Settings | null>;
  saveSettings(s: Settings): Promise<void>;

  upsertRelay(row: RelayRow): Promise<void>;
  getRelay(url: string): Promise<RelayRow | undefined>;
  allRelays(): Promise<RelayRow[]>;
  deleteAllRelays(): Promise<void>;

  putNip11(url: string, doc: Nip11Doc, fetchedAt: number): Promise<void>;
  getNip11(url: string): Promise<{ doc: Nip11Doc; fetchedAt: number } | undefined>;
  deleteAllNip11(): Promise<void>;

  rememberSeenId(id: string, addedAt: number): Promise<void>;
  loadSeenIds(limit: number): Promise<string[]>;
  pruneSeenIds(maxRows: number): Promise<void>;

  rememberHistory(kind: HistoryKind, value: string): Promise<void>;
  loadHistory(kind: HistoryKind): Promise<HistoryEntry[]>;

  close(): void;
}

interface NipRow { url: string; doc: Nip11Doc; fetchedAt: number; }
interface DedupeRow { id: string; addedAt: number; }
interface HistoryRow { kind: HistoryKind; value: string; lastUsed: number; }

export async function openDB(): Promise<DB> {
  const db: IDBPDatabase = await openIDB(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore(STORE_SETTINGS);
        const relays = database.createObjectStore(STORE_RELAYS, { keyPath: 'url' });
        relays.createIndex('lastOk', 'lastOk');
        relays.createIndex('dead', 'dead');
        const nip = database.createObjectStore(STORE_NIP11, { keyPath: 'url' });
        nip.createIndex('fetchedAt', 'fetchedAt');
        const dedupe = database.createObjectStore(STORE_DEDUPE, { keyPath: 'id' });
        dedupe.createIndex('addedAt', 'addedAt');
      }
      if (oldVersion < 2) {
        const history = database.createObjectStore(STORE_HISTORY, { keyPath: ['kind', 'value'] });
        history.createIndex('kind_lastUsed', ['kind', 'lastUsed']);
      }
    },
    blocked() { /* another tab is upgrading; will retry */ },
    blocking() { db.close(); }
  });

  return {
    async loadSettings() {
      const row = await db.get(STORE_SETTINGS, SETTINGS_KEY);
      return (row ?? null) as Settings | null;
    },
    async saveSettings(s) {
      await db.put(STORE_SETTINGS, s, SETTINGS_KEY);
    },

    async upsertRelay(row) {
      await db.put(STORE_RELAYS, row);
    },
    async getRelay(url) {
      return (await db.get(STORE_RELAYS, url)) as RelayRow | undefined;
    },
    async allRelays() {
      return (await db.getAll(STORE_RELAYS)) as RelayRow[];
    },
    async deleteAllRelays() {
      await db.clear(STORE_RELAYS);
    },

    async putNip11(url, doc, fetchedAt) {
      const row: NipRow = { url, doc, fetchedAt };
      await db.put(STORE_NIP11, row);
    },
    async getNip11(url) {
      const row = await db.get(STORE_NIP11, url) as NipRow | undefined;
      if (!row) return undefined;
      return { doc: row.doc, fetchedAt: row.fetchedAt };
    },
    async deleteAllNip11() {
      await db.clear(STORE_NIP11);
    },

    async rememberSeenId(id, addedAt) {
      const row: DedupeRow = { id, addedAt };
      await db.put(STORE_DEDUPE, row);
    },
    async loadSeenIds(limit) {
      const tx = db.transaction(STORE_DEDUPE, 'readonly');
      const idx = tx.store.index('addedAt');
      const ids: string[] = [];
      let cursor = await idx.openCursor(null, 'prev');
      while (cursor && ids.length < limit) {
        const v = cursor.value as DedupeRow;
        ids.push(v.id);
        cursor = await cursor.continue();
      }
      await tx.done;
      return ids;
    },
    async pruneSeenIds(maxRows) {
      const count = await db.count(STORE_DEDUPE);
      if (count <= maxRows) return;
      const toDelete = count - maxRows;
      const tx = db.transaction(STORE_DEDUPE, 'readwrite');
      const idx = tx.store.index('addedAt');
      let cursor = await idx.openCursor(null, 'next');
      let deleted = 0;
      while (cursor && deleted < toDelete) {
        await cursor.delete();
        deleted++;
        cursor = await cursor.continue();
      }
      await tx.done;
    },

    async rememberHistory(kind, value) {
      const v = value.trim();
      if (!v) return;
      const row: HistoryRow = { kind, value: v, lastUsed: Date.now() };
      await db.put(STORE_HISTORY, row);
      const tx = db.transaction(STORE_HISTORY, 'readwrite');
      const idx = tx.store.index('kind_lastUsed');
      const range = IDBKeyRange.bound([kind, -Infinity], [kind, Infinity]);
      const count = await idx.count(range);
      if (count > HISTORY_LIMIT) {
        let cursor = await idx.openCursor(range, 'next');
        let toDelete = count - HISTORY_LIMIT;
        while (cursor && toDelete > 0) {
          await cursor.delete();
          toDelete--;
          cursor = await cursor.continue();
        }
      }
      await tx.done;
    },
    async loadHistory(kind) {
      const tx = db.transaction(STORE_HISTORY, 'readonly');
      const idx = tx.store.index('kind_lastUsed');
      const range = IDBKeyRange.bound([kind, -Infinity], [kind, Infinity]);
      const out: HistoryEntry[] = [];
      let cursor = await idx.openCursor(range, 'prev');
      while (cursor) {
        const v = cursor.value as HistoryRow;
        out.push({ value: v.value, lastUsed: v.lastUsed });
        cursor = await cursor.continue();
      }
      await tx.done;
      return out;
    },

    close() { db.close(); }
  };
}
