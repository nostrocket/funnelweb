# Implementation Guide — `blaster`

A buildable, file-by-file specification of the browser-only Nostr fan-out app described in `PLAN.md`. Every module here is justified against `nostr-agent-rules.md` (referenced as **R#**) and the deeper context in `nostr-patterns.md`.

The guide is exhaustive enough that you can open the empty repo, follow it top-to-bottom, and end with a working static bundle. Function signatures are TypeScript and assume `strict: true`.

---

## 1. Stack

| Layer | Choice | Rationale |
|---|---|---|
| Build | **Vite 5** with `@vitejs/plugin-legacy` off | Single static bundle, dev server, no SSR. |
| Language | **TypeScript 5.5+**, `strict: true`, `noUncheckedIndexedAccess: true` | Catches the off-by-one and `undefined` bugs typical of message handlers. |
| Nostr crypto | **`nostr-tools` ^2.x** | `verifyEvent`, `nip19`, NIP-11 helpers (R3, R4). |
| IDB wrapper | **`idb` ^8.x** | Tiny promise wrapper, supports versioned schema upgrades. |
| Tests | **Vitest** + **jsdom**; **Playwright** for browser e2e | Matches the verification matrix in `PLAN.md`. |
| Lint/format | **eslint** + **prettier** with default configs | No bikeshedding. |
| Runtime targets | Modern evergreen browsers (ES2022); also runs from `file://` | No service worker, no module workers, no top-level imports of node-only modules. |

**No runtime dependencies on env vars or backends.** All operational input flows through the UI and is stored in IndexedDB.

### `package.json`

```jsonc
{
  "name": "blaster",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest",
    "test:e2e": "playwright test",
    "lint": "eslint src --max-warnings=0",
    "format": "prettier -w ."
  },
  "dependencies": {
    "idb": "^8.0.0",
    "nostr-tools": "^2.7.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.45.0",
    "@types/node": "^20.0.0",
    "eslint": "^9.0.0",
    "jsdom": "^24.0.0",
    "prettier": "^3.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0"
  }
}
```

### `tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true
  },
  "include": ["src", "vite.config.ts"]
}
```

### `vite.config.ts`

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',           // works under file:// and any sub-path
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: { output: { inlineDynamicImports: true } }
  },
  server: { port: 5173, strictPort: true }
});
```

### `index.html`

Single root with four panel containers. Style is loaded as a regular link so the bundle still works opened directly.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>blaster</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main id="app">
      <section id="panel-settings" class="panel"></section>
      <section id="panel-filter"   class="panel"></section>
      <section id="panel-preview"  class="panel"></section>
      <section id="panel-broadcast" class="panel"></section>
    </main>
    <pre id="debug-console" hidden></pre>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

---

## 2. Directory Layout

```
blaster/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── style.css
├── playwright.config.ts
├── src/
│   ├── main.ts
│   ├── store.ts
│   ├── types.ts
│   ├── log.ts
│   ├── core/
│   │   ├── relayUrl.ts
│   │   ├── relayConn.ts
│   │   ├── relayPool.ts
│   │   ├── relayRegistry.ts
│   │   ├── boundedQueue.ts
│   │   ├── dedupeLru.ts
│   │   ├── filterValidator.ts
│   │   ├── sourceSubscriber.ts
│   │   ├── discovery.ts
│   │   └── broadcaster.ts
│   ├── db/
│   │   ├── idb.ts
│   │   └── schema.ts
│   └── ui/
│       ├── settingsPanel.ts
│       ├── filterPanel.ts
│       ├── previewPanel.ts
│       ├── broadcastPanel.ts
│       └── components.ts
└── tests/
    ├── unit/
    │   ├── relayUrl.test.ts
    │   ├── boundedQueue.test.ts
    │   ├── dedupeLru.test.ts
    │   ├── filterValidator.test.ts
    │   ├── relayConn.okmatch.test.ts
    │   ├── broadcaster.order.test.ts
    │   └── sourceSubscriber.rawbytes.test.ts
    └── e2e/
        └── happy-path.spec.ts
```

---

## 3. Shared Types

### `src/types.ts`

Define every cross-cutting structure here so each module imports from one place.

```ts
import type { Event as NostrEvent, Filter as NostrFilter } from 'nostr-tools';

export type RelayUrl = string & { readonly __brand: 'RelayUrl' }; // normalised key

export interface Settings {
  sourceRelay: string;            // raw user input (kept as user typed)
  monitorSeeds: string[];         // raw user input list
  filterJson: string;             // user-edited JSON; validated separately
  armed: boolean;                 // never armed implicitly — UI-only toggle
  advanced: AdvancedSettings;
}

export interface AdvancedSettings {
  maxFilterLimit: number;         // R9; default 500
  dedupeSize: number;             // R21; default 10_000
  queueSizePerRelay: number;      // R20; default 1_000
  nip11TtlMs: number;             // R23; default 7 * 86400 * 1000
  persistDedupe: boolean;         // off by default
}

export interface RelayRow {
  url: RelayUrl;
  firstSeen: number;              // ms epoch
  lastSeen: number;
  lastOk: number | null;
  failCount: number;              // R15
  dead: boolean;                  // R15
  nip11Json: Nip11Doc | null;
  nip11FetchedAt: number | null;
}

export interface Nip11Doc {
  name?: string;
  limitation?: {
    max_message_length?: number;
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    auth_required?: boolean;
    payment_required?: boolean;
  };
}

export interface IngestedEvent {
  id: string;                     // hex event id, validated
  parsed: NostrEvent;             // parsed copy for UI/filtering
  raw: string;                    // original wire string  — R18
  receivedAt: number;             // ms epoch (client clock)
}

export type PublishOutcome =
  | { kind: 'ok' }
  | { kind: 'duplicate' }
  | { kind: 'permanent'; reason: string }
  | { kind: 'transient'; reason: string };

export type RelayMessage =
  | ['EVENT', string, NostrEvent]
  | ['EOSE', string]
  | ['OK', string, boolean, string]
  | ['NOTICE', string]
  | ['CLOSED', string, string]
  | ['AUTH', string];

export type ClientMessage =
  | ['REQ', string, ...NostrFilter[]]
  | ['CLOSE', string]
  | ['EVENT', NostrEvent]
  | ['AUTH', NostrEvent];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
```

`Settings` is **persisted verbatim** to IndexedDB so a reload restores the exact UI state. Normalisation happens at the consumer (`SourceSubscriber`, `Discovery`) — the form preserves what the user typed.

---

## 4. `src/log.ts` — single in-page logger

```ts
import type { LogLevel } from './types';

interface LogEntry { ts: number; level: LogLevel; tag: string; msg: string; }

const buffer: LogEntry[] = [];
const MAX = 2_000;
let mirrorEl: HTMLElement | null = null;

export function attachConsole(el: HTMLElement): void;
export function log(level: LogLevel, tag: string, msg: string, ...rest: unknown[]): void;
export function debug(tag: string, msg: string, ...rest: unknown[]): void;
export function info (tag: string, msg: string, ...rest: unknown[]): void;
export function warn (tag: string, msg: string, ...rest: unknown[]): void;
export function error(tag: string, msg: string, ...rest: unknown[]): void;
export function snapshot(): readonly LogEntry[];
```

NOTICE messages from relays go through `debug('relay', ...)` (R24). Errors never `throw` from message handlers (R24).

---

## 5. `src/store.ts` — minimal reactive store

A ~50-line store is enough at this scope. Every write is fire-and-forget persisted to IndexedDB.

```ts
type Listener<T> = (value: T, prev: T) => void;

export class Store<T extends object> {
  constructor(initial: T);
  get(): T;
  set(patch: Partial<T>): void;                       // shallow merge
  update(fn: (current: T) => T): void;
  subscribe(listener: Listener<T>): () => void;       // returns unsubscribe
  bindPersistence(save: (t: T) => Promise<void>, debounceMs?: number): void;
}
```

Implementation notes:
- `set` snapshots the previous value, applies the patch, runs listeners, and schedules a debounced persist (default 200 ms).
- Listeners run synchronously and **must not throw** — wrap each call in try/catch, log to `error()`.
- A single `Store<Settings>` is mounted in `main.ts` and shared with every panel.

---

## 6. `src/core/relayUrl.ts` — normalisation (R13)

The single source of truth for relay-URL identity.

```ts
import type { RelayUrl } from '../types';

/** Normalise + validate. Throws on bad scheme/host. */
export function normaliseRelayUrl(raw: string): RelayUrl;

/** Non-throwing variant — returns null if invalid. Use at UI boundaries. */
export function tryNormaliseRelayUrl(raw: string): RelayUrl | null;

/** True iff `raw` is already in canonical form. */
export function isCanonical(raw: string): boolean;
```

Rules applied in order:
1. `new URL(raw)` parses the string. Throw if it does.
2. Scheme must be `wss:` or `ws:`. Lowercase.
3. Hostname lowercased.
4. Strip default port: `:443` for `wss`, `:80` for `ws`.
5. Drop `search` and `hash`.
6. Drop trailing `/` on the pathname (but keep paths like `/v1`).
7. Reassemble as `${scheme}//${host}${path}`.

Tests in `tests/unit/relayUrl.test.ts` round-trip:
- `wss://Relay.Example.com:443/` → `wss://relay.example.com`
- `wss://relay.example.com` → `wss://relay.example.com`
- `wss://relay.example.com/` → `wss://relay.example.com`
- `wss://Relay.Example.com:443/v1/` → `wss://relay.example.com/v1`

---

## 7. `src/core/boundedQueue.ts` (R20)

```ts
export interface BoundedQueueStats { enqueued: number; dropped: number; size: number; }

export class BoundedQueue<T> {
  constructor(capacity: number);
  /** Returns true if pushed, false if dropped. Never blocks. */
  push(item: T): boolean;
  shift(): T | undefined;
  peek(): T | undefined;
  get length(): number;
  get capacity(): number;
  stats(): BoundedQueueStats;
  resize(newCapacity: number): void;                  // truncates from head
  clear(): void;
}
```

A simple ring buffer over an array. On overflow, drop the **incoming** item and bump `dropped` — NOT the oldest, because dropping the oldest violates FIFO semantics for replaceable-event ordering (R8).

---

## 8. `src/core/dedupeLru.ts` (R21)

```ts
export class DedupeLru {
  constructor(capacity: number);
  has(id: string): boolean;
  /** Returns true if newly inserted. */
  add(id: string): boolean;
  size(): number;
  clear(): void;
  resize(capacity: number): void;
}
```

Backed by a `Map<string, null>`; eviction by deleting the oldest insertion when `size >= capacity` (Map preserves insertion order). Optionally serialised to IDB if `Settings.advanced.persistDedupe`.

---

## 9. `src/core/filterValidator.ts` (R9)

```ts
import type { Filter as NostrFilter } from 'nostr-tools';

export interface ValidatedFilter { filter: NostrFilter; warnings: string[]; }

/** Throws `FilterValidationError` with a human-readable message on invalid input. */
export function validateFilterJson(json: string, maxLimit: number): ValidatedFilter;

export class FilterValidationError extends Error {
  constructor(message: string, public readonly path?: string);
}
```

Rules enforced:
- Parses JSON; rejects arrays and primitives — must be an object.
- Must have **at least one** of: `authors`, `kinds`, `since`, `until`.
- Must include `limit`; `limit` must be `>= 1` and `<= maxLimit`.
- `authors` and `ids`, if present, must be arrays of 64-char lowercase hex.
- `kinds` must be an array of integers in `[0, 39999]`.
- `since`/`until`: integers, in **seconds** (R1). If a value is `>= 10_000_000_000` warn "looks like milliseconds".
- Tag filters (`#e`, `#p`, etc.) accepted as-is but truncated to 256 entries each with a warning.

---

## 10. `src/db/schema.ts` and `src/db/idb.ts`

### Stores

| Store | Key | Indexes | Notes |
|---|---|---|---|
| `settings` | `'current'` (string) | none | Single row holding the entire `Settings` object. |
| `relays` | `url` | `lastOk`, `dead` | One row per normalised URL (`RelayRow`). |
| `nip11_cache` | `url` | `fetchedAt` | `{ url, fetchedAt, doc }`. |
| `dedupe` | `id` | `addedAt` | Optional, only when `persistDedupe`. Max 10_000 rows; oldest evicted on insert. |

### `src/db/idb.ts`

```ts
import type { IDBPDatabase } from 'idb';
import type { Settings, RelayRow, Nip11Doc } from '../types';

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
}

export async function openDB(): Promise<DB>;
```

Schema version 1; future migrations append a new version block in `openDB`. Throw if the browser blocks the open (private mode in some Safari builds) — `main.ts` catches that and renders a banner explaining the app needs IndexedDB.

---

## 11. `src/core/relayConn.ts` (R7, R13, R14, R15, R20, R24)

`RelayConn` owns one WebSocket per normalised URL — **forever**. Reused by both Discovery (1 sub), SourceSubscriber (when source happens to be in the registry), and Broadcaster (publishes only).

```ts
import type { Filter as NostrFilter } from 'nostr-tools';
import { BoundedQueue } from './boundedQueue';
import type { RelayUrl, PublishOutcome } from '../types';

export interface PublishHandle {
  promise: Promise<PublishOutcome>;
  cancel(): void;
}

export interface RelayConnOptions {
  queueCapacity: number;          // R20
  publishTimeoutMs: number;       // default 8_000
  maxFailures: number;            // R15; default 5
}

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'dead';

export interface SubscriptionHandle {
  id: string;
  close(): void;
  onEvent(cb: (raw: string, parsed: import('nostr-tools').Event) => void): void;
  onEose(cb: () => void): void;
  onClosed(cb: (reason: string) => void): void;
}

export class RelayConn {
  readonly url: RelayUrl;
  state: ConnState;
  failures: number;
  reconnectAttempt: number;

  constructor(url: RelayUrl, opts: RelayConnOptions);

  /** Start (or restart) the WebSocket. Idempotent. */
  open(): void;

  /** Sub IDs MUST be unique per connection (R11). */
  subscribe(filters: NostrFilter[], opts?: { oneShot?: boolean }): SubscriptionHandle;

  /** Returns a handle resolving when an OK arrives matching `eventId` (R7). */
  publish(rawWire: string, eventId: string): PublishHandle;

  /** Close gracefully (sends CLOSE for every active sub). */
  close(reason?: string): void;

  stats(): {
    state: ConnState;
    queueDepth: number;
    queueDropped: number;
    successCount: number;
    failureCount: number;
    lastReason: string | null;
  };
}
```

### Behaviour

1. **One WebSocket, ever.** `open()` no-ops while `state === 'open' | 'connecting'`. (R13)
2. **`activeSubs: Map<subId, NostrFilter[]>`** is replayed in `ws.onopen` (R14). One-shot subs are NOT replayed after their EOSE.
3. **`pendingPublishes: Map<eventId, { resolve, reject, timer }>`** — OK matched by event id (R7). On WebSocket close, every pending publish rejects with `transient: connection-closed`.
4. **`outQueue: BoundedQueue<string>`** holds the **raw wire string** for each EVENT to publish (R18). Drained by an inner `flush()` whenever the socket is open. Drops bump `queueDropped` (R20).
5. **Reconnect** on `onclose` (unless `state === 'dead'` or `close()` was called by us):
   ```ts
   const delay = Math.min(1_000 * 2 ** attempt, 60_000) + Math.random() * 500;
   ```
   (R14). After `failures >= maxFailures` set `state = 'dead'` and stop (R15) — RelayPool moves the row to `dead=true`.
6. **`NOTICE`** messages → `debug('relay', url, msg)` (R24). Never throw, never tear down a sub.
7. **`CLOSED`** for a one-shot sub is forwarded to its `onClosed` and the sub is removed from `activeSubs` (so it isn't replayed).
8. **AUTH** challenges are logged but not answered in v1 (R4 — no keys). Subscriptions that depend on AUTH will return zero events; that's acceptable for the broadcast use case.

### Wire send wrapper

```ts
function sendJson(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}
```

For publish, the **raw event string** is interpolated directly so that re-stringifying never happens (R18):

```ts
ws.send(`["EVENT",${rawEventJson}]`);
```

`rawEventJson` is the second element of the source `["EVENT", subid, evt]` array, sliced byte-exact from the original `MessageEvent.data` — see `sourceSubscriber.ts` §13.

---

## 12. `src/core/relayPool.ts` (R13)

```ts
import { RelayConn, type RelayConnOptions } from './relayConn';
import type { RelayUrl } from '../types';

export class RelayPool {
  constructor(opts: RelayConnOptions);

  /** Returns the (possibly newly-created) connection for `url`. Idempotent. */
  get(url: RelayUrl): RelayConn;

  /** True iff a connection exists (open or otherwise). */
  has(url: RelayUrl): boolean;

  /** Close + remove a single connection (no auto-reopen). */
  remove(url: RelayUrl): void;

  /** Snapshot of every connection's current state. */
  snapshot(): { url: RelayUrl; stats: ReturnType<RelayConn['stats']> }[];

  /** Close everything; called on Forget-all-relays and tab unload. */
  destroy(): void;
}
```

Internal storage is `Map<RelayUrl, RelayConn>`. Anything keyed elsewhere (registry, broadcaster) **must** funnel through `relayUrl.normaliseRelayUrl` first.

---

## 13. `src/core/sourceSubscriber.ts` (R3, R9, R11, R12, R18, R21, R22)

```ts
import type { Filter as NostrFilter } from 'nostr-tools';
import type { IngestedEvent, RelayUrl } from '../types';
import type { RelayPool } from './relayPool';
import type { DedupeLru } from './dedupeLru';

export interface SourceSubscriberDeps {
  pool: RelayPool;
  dedupe: DedupeLru;
  onEvent: (e: IngestedEvent) => void;            // PreviewBus + Broadcaster
  onLive: () => void;                              // EOSE boundary fires once per (re)open
  onError: (msg: string) => void;
}

export class SourceSubscriber {
  constructor(deps: SourceSubscriberDeps);

  /** Open a new REQ. Closes any existing one first. */
  start(sourceUrl: RelayUrl, filter: NostrFilter): void;

  /** Stop the active REQ; pool connection is preserved. */
  stop(): void;

  /** Replace filter without dropping the connection. */
  reconfigure(filter: NostrFilter): void;
}
```

### Critical correctness path: preserve raw bytes

The default JS pattern of `JSON.parse(data)` then `JSON.stringify(event)` will silently change the byte stream and break the signature on rebroadcast (R18). We capture the **original substring** for the event payload:

```ts
function extractRawEvent(messageData: string): { raw: string; parsed: NostrEvent } | null {
  // Relays send: ["EVENT","<subid>",{ ...event... }]
  // We need the substring corresponding to the {...} object, byte-exact.
  // Strategy: parse with JSON.parse to validate + grab the parsed event,
  // then walk the original string to find the matching substring boundaries.

  const arr = JSON.parse(messageData) as RelayMessage;
  if (!Array.isArray(arr) || arr[0] !== 'EVENT') return null;

  // Find the start of the event object in the raw string.
  // The JSON shape is fixed: ["EVENT", "<subid>", { ... } ] possibly with
  // whitespace. Locate the third top-level token.
  const start = findThirdTopLevelTokenStart(messageData);
  const end   = findMatchingBraceEnd(messageData, start);
  const raw   = messageData.slice(start, end + 1);

  return { raw, parsed: arr[2] };
}
```

`findThirdTopLevelTokenStart` and `findMatchingBraceEnd` are tiny scanners that respect JSON string-escape rules. They live in this file (private). Tests verify byte-equivalence by computing `sha256(canonical)` of the parsed event and comparing to `parsed.id` — if they differ we drop and log (this catches relay bugs).

### Lifecycle

```ts
private async onMessage(msgData: string): Promise<void> {
  const extracted = extractRawEvent(msgData);
  if (!extracted) return;
  const { raw, parsed } = extracted;

  if (!verifyEvent(parsed)) {                  // R3
    debug('source', `dropped invalid sig ${parsed.id}`);
    return;
  }
  if (!this.dedupe.add(parsed.id)) return;     // R21

  const ingested: IngestedEvent = { id: parsed.id, parsed, raw, receivedAt: Date.now() };

  if (this.live) this.deps.onEvent(ingested);
  else this.historyBuffer.push(ingested);
}

private onEose(): void {                       // R12
  this.live = true;
  this.historyBuffer.sort((a, b) => b.parsed.created_at - a.parsed.created_at); // R22
  for (const e of this.historyBuffer) this.deps.onEvent(e);
  this.historyBuffer = [];
  this.deps.onLive();
}
```

### Sub IDs (R11)

```ts
const subId = crypto.randomUUID().slice(0, 12);
```

`reconfigure` always: CLOSE old → mint new id → REQ. Never reuses an id.

---

## 14. `src/core/relayRegistry.ts` (R15, R23)

```ts
import type { DB } from '../db/idb';
import type { RelayUrl, RelayRow, Nip11Doc } from '../types';

export interface RelayRegistryOptions { nip11TtlMs: number; minHealthy: number; }

export class RelayRegistry {
  constructor(db: DB, opts: RelayRegistryOptions);

  /** Bootstrap from IDB into in-memory map; call on app start. */
  load(): Promise<void>;

  upsert(url: RelayUrl, observedAt: number): Promise<void>;
  markFailure(url: RelayUrl, reason: string): Promise<void>;
  markSuccess(url: RelayUrl, at: number): Promise<void>;

  /** Snapshot of healthy relays. R15 floor: returns top-3 by lastOk if fewer
   *  than minHealthy non-dead rows exist. */
  healthy(): RelayRow[];

  all(): RelayRow[];

  /** Lazy NIP-11 fetch with 7-day TTL (R23). Returns null if CORS blocks. */
  nip11(url: RelayUrl): Promise<Nip11Doc | null>;

  /** Subscribe to changes — UI re-renders the table on these events. */
  subscribe(cb: (rows: RelayRow[]) => void): () => void;

  forgetAll(): Promise<void>;
}
```

`markFailure` increments `failCount`; sets `dead=true` once `failCount >= 5` (R15). `markSuccess` resets `failCount` to 0.

`nip11(url)` swaps the `wss://` prefix for `https://` and fetches with header `Accept: application/nostr+json`. CORS failures are not errors — they're a normal v1 outcome; cache `null` with a shorter TTL (1 day) so we don't hammer the server.

---

## 15. `src/core/discovery.ts` (R3, R9, R11, R14, R16)

```ts
import type { RelayPool } from './relayPool';
import type { RelayRegistry } from './relayRegistry';

export interface DiscoveryOptions { sinceSecondsAgo: number; perRelayLimit: number; }

export class Discovery {
  constructor(pool: RelayPool, registry: RelayRegistry, opts: DiscoveryOptions);

  /** Replace the seed list. Closes/opens subscriptions as needed. */
  setSeeds(seeds: string[]): void;

  /** Tear down everything. */
  stop(): void;
}
```

Per seed:

1. Normalise the URL (drop on failure; warn).
2. Open the pooled connection.
3. **One-shot REQ**: `{ kinds: [30166], since: now - opts.sinceSecondsAgo, limit: opts.perRelayLimit }`. Default 24 h / 5 000 (R9).
4. **Live REQ** with a *separate* sub id, no `until`, `limit: 500`. Stays open for incremental updates.
5. For each EVENT:
   - `verifyEvent(parsed)` — drop on failure (R3).
   - Read `d` tag (relay URL).
   - Read `n` tag — accept only `clearnet` in v1.
   - `normaliseRelayUrl` — drop on failure.
   - `registry.upsert(url, parsed.created_at * 1000)`.
6. On EOSE for the one-shot: `CLOSE` it (R11). Keep the live REQ.

### Why a user-supplied seed list

Rule 16 in `nostr-agent-rules.md` is about NIP-65 markers; here we're using NIP-66 instead. The principle still applies: never silently bootstrap from a hardcoded relay at runtime. The Settings panel pre-fills suggestions in *placeholder* text only, so the user must explicitly accept them.

---

## 16. `src/core/broadcaster.ts` (R6, R7, R8, R20, R23)

```ts
import type { Event as NostrEvent } from 'nostr-tools';
import type { IngestedEvent } from '../types';
import type { RelayPool } from './relayPool';
import type { RelayRegistry } from './relayRegistry';

export type BroadcastEntry = {
  eventId: string;
  url: string;
  outcome: 'queued' | 'ok' | 'duplicate' | 'permanent' | 'transient';
  reason: string | null;
  ts: number;
};

export interface BroadcasterDeps {
  pool: RelayPool;
  registry: RelayRegistry;
  onLog: (entry: BroadcastEntry) => void;
  onCounter: (c: { discovered: number; healthy: number; dead: number; dropped: number; }) => void;
}

export class Broadcaster {
  constructor(deps: BroadcasterDeps);

  arm(): void;
  disarm(): void;
  isArmed(): boolean;

  /** Called by SourceSubscriber for every deduped event. */
  ingest(e: IngestedEvent): void;

  /** Cancel any pending per-pubkey work. */
  drain(): Promise<void>;
}
```

### Per-pubkey serial queue (R8)

Replaceable kinds (`0`, `3`, `10000–19999`) and addressable kinds (`30000–39999`) require strict per-pubkey ordering by `created_at` ascending. Cross-pubkey work parallelises freely.

```ts
private perAuthorChain = new Map<string, Promise<void>>();

private isOrdered(kind: number): boolean {
  return kind === 0 || kind === 3
      || (kind >= 10_000 && kind <= 19_999)
      || (kind >= 30_000 && kind <= 39_999);
}

private enqueueFanout(e: IngestedEvent): void {
  if (this.isOrdered(e.parsed.kind)) {
    const author = e.parsed.pubkey;
    const prev = this.perAuthorChain.get(author) ?? Promise.resolve();
    const next = prev.then(() => this.fanout(e)).catch(() => undefined);
    this.perAuthorChain.set(author, next);
  } else {
    void this.fanout(e);
  }
}
```

### Fan-out

```ts
private async fanout(e: IngestedEvent): Promise<void> {
  const targets = this.deps.registry.healthy();
  await Promise.allSettled(targets.map(t => this.publishOne(t.url, e)));
}

private async publishOne(url: RelayUrl, e: IngestedEvent): Promise<void> {
  const conn = this.deps.pool.get(url);

  // Honour per-relay NIP-11 max_message_length (R23)
  const info = await this.deps.registry.nip11(url);
  const cap = info?.limitation?.max_message_length;
  if (cap && e.raw.length + 16 > cap) {
    this.deps.onLog({ eventId: e.id, url, outcome: 'permanent',
      reason: `oversize:${e.raw.length}>${cap}`, ts: Date.now() });
    return;
  }

  const handle = conn.publish(e.raw, e.id);
  const outcome = await handle.promise;
  this.deps.onLog({ eventId: e.id, url, outcome: outcome.kind,
    reason: 'reason' in outcome ? outcome.reason : null, ts: Date.now() });
  if (outcome.kind === 'ok' || outcome.kind === 'duplicate') {
    await this.deps.registry.markSuccess(url, Date.now());
  } else if (outcome.kind === 'transient') {
    await this.deps.registry.markFailure(url, outcome.reason);
  }
}
```

### OK reason classification (R6)

Inside `RelayConn.handlePublishAck`:

```ts
function classify(accepted: boolean, reason: string): PublishOutcome {
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
```

Permanent outcomes are recorded but **not** retried (R6). Transient outcomes are recorded; the same event will be re-attempted on the next reconnect cycle if it's still in `outQueue`. We do not re-enqueue dropped events — relying on the next REQ to surface them again is acceptable in v1 (see `PLAN.md` "failure modes").

---

## 17. UI

`ui/components.ts` exports the shared widgets (button, text input, json input, modal, table). Every panel exports a single `mount(root: HTMLElement, store: Store<Settings>, deps): void` function so `main.ts` can wire them up.

### `ui/settingsPanel.ts`

```ts
export interface SettingsPanelDeps { onForgetAll: () => Promise<void>; }
export function mountSettingsPanel(root: HTMLElement, store: Store<Settings>, deps: SettingsPanelDeps): void;
```

Fields:
- Source relay URL — `<input type="url">` validated `wss://` or `ws://`.
- Monitor seeds — `<textarea>` (one URL per line). Placeholder shows defaults but the textarea starts empty (R16).
- Advanced (`<details>`): four numeric inputs + a checkbox for `persistDedupe`.
- Forget-all-relays — button → confirm modal → `deps.onForgetAll()`.

### `ui/filterPanel.ts`

```ts
export function mountFilterPanel(root: HTMLElement, store: Store<Settings>): void;
```

`<textarea>` containing `Settings.filterJson`. On blur → `validateFilterJson(json, advanced.maxFilterLimit)`. Validation errors render inline in red. Successful saves push back to the store; main.ts subscribes and calls `sourceSubscriber.reconfigure`.

### `ui/previewPanel.ts`

```ts
export interface PreviewPanelDeps {
  bus: { subscribe: (cb: (e: IngestedEvent) => void) => () => void };
}
export function mountPreviewPanel(root: HTMLElement, deps: PreviewPanelDeps): void;
```

Renders the most recent N=200 events sorted by `created_at` descending (R22). Each row shows: kind, npub-short (`getPublicKey → nip19.npubEncode`, sliced to 12 chars), relative time, content excerpt (160 chars max), and an expander revealing the **raw wire string** (so the user can copy-paste it). Counter at the top: `matched: N · unique: M · armed: yes/no`.

### `ui/broadcastPanel.ts`

```ts
export interface BroadcastPanelDeps {
  broadcaster: Broadcaster;
  registry: RelayRegistry;
  pool: RelayPool;
  store: Store<Settings>;
}
export function mountBroadcastPanel(root: HTMLElement, deps: BroadcastPanelDeps): void;
```

- Arm toggle. Click → confirmation modal showing the validated filter and current `registry.healthy().length`. Confirm → `deps.broadcaster.arm()` and write `Settings.armed = true`.
- Counters: `discovered · healthy · dead · dropped`. Dropped is the sum of every connection's `queueDropped`.
- Per-relay table: URL, success this session, failures, last reason, queue depth (live from `pool.snapshot()`). Updated on `registry.subscribe` + a 1 Hz timer for the queue depth.

### `ui/components.ts`

Tiny helpers (`createButton`, `createTextInput`, `createJsonTextarea`, `createModal`). No framework — they return `HTMLElement` and accept callbacks.

---

## 18. `src/main.ts` — bootstrap

```ts
async function main() {
  const dbg = document.getElementById('debug-console')!;
  attachConsole(dbg);

  let db: DB;
  try { db = await openDB(); }
  catch (e) { renderFatal('IndexedDB unavailable', e); return; }

  const persisted = await db.loadSettings();
  const initial: Settings = persisted ?? defaultSettings();
  const store = new Store<Settings>(initial);
  store.bindPersistence(s => db.saveSettings(s));

  const dedupe = new DedupeLru(initial.advanced.dedupeSize);
  const pool = new RelayPool({
    queueCapacity: initial.advanced.queueSizePerRelay,
    publishTimeoutMs: 8_000,
    maxFailures: 5
  });
  const registry = new RelayRegistry(db, {
    nip11TtlMs: initial.advanced.nip11TtlMs,
    minHealthy: 3
  });
  await registry.load();

  const previewBus = createBus<IngestedEvent>();
  const broadcaster = new Broadcaster({
    pool, registry,
    onLog: e => store.update(s => s),  // panels subscribe to broadcaster directly via getter
    onCounter: () => undefined
  });

  const source = new SourceSubscriber({
    pool, dedupe,
    onEvent: e => { previewBus.emit(e); if (broadcaster.isArmed()) broadcaster.ingest(e); },
    onLive: () => info('source', 'EOSE; live'),
    onError: msg => warn('source', msg)
  });

  const discovery = new Discovery(pool, registry, { sinceSecondsAgo: 86_400, perRelayLimit: 5_000 });

  // Wire UI
  mountSettingsPanel(byId('panel-settings'), store, {
    onForgetAll: async () => { await registry.forgetAll(); await db.deleteAllNip11(); }
  });
  mountFilterPanel(byId('panel-filter'), store);
  mountPreviewPanel(byId('panel-preview'), { bus: previewBus });
  mountBroadcastPanel(byId('panel-broadcast'), { broadcaster, registry, pool, store });

  // React to settings changes
  store.subscribe((next, prev) => {
    if (next.sourceRelay !== prev.sourceRelay || next.filterJson !== prev.filterJson) {
      try {
        const url = normaliseRelayUrl(next.sourceRelay);
        const { filter } = validateFilterJson(next.filterJson, next.advanced.maxFilterLimit);
        source.start(url, filter);
      } catch (e) { warn('source', String(e)); source.stop(); }
    }
    if (next.monitorSeeds.join('\n') !== prev.monitorSeeds.join('\n')) {
      discovery.setSeeds(next.monitorSeeds);
    }
    if (next.armed !== prev.armed) {
      next.armed ? broadcaster.arm() : broadcaster.disarm();
    }
  });

  // Kick off if settings are already valid
  store.update(s => ({ ...s }));   // forces a subscriber pass

  window.addEventListener('beforeunload', () => pool.destroy());
}

main();
```

`createBus<T>()` is a 6-line publish/subscribe utility — kept inline rather than its own file.

---

## 19. Persistence Lifecycle

| Trigger | Saved | Why |
|---|---|---|
| Settings field edit | `settings.current` (debounced 200 ms) | UI-driven config (R: app design). |
| Discovery upsert | `relays[url]` | Survives reload (R15 healthy floor needs history). |
| `markSuccess` / `markFailure` | `relays[url]` | Same. |
| NIP-11 fetch | `nip11_cache[url]` | 7-day TTL (R23). |
| Dedupe LRU `add` | `dedupe[id]` if `persistDedupe` | Optional, off by default. |

Reload restores **everything except** in-flight publishes. The next REQ on the source relay re-surfaces undelivered events; the dedupe LRU rebuilds in memory; broadcaster simply continues from there.

---

## 20. Rule-by-Rule Compliance Map

| Rule | File · function |
|---|---|
| R1 Unix seconds | `filterValidator.validateFilterJson` warns if `since`/`until` look like ms; UI helpers use `Math.floor(Date.now()/1000)`. |
| R2 No manual id/sig | We never construct events; broadcast forwards raw bytes. |
| R3 Verify signatures | `sourceSubscriber.onMessage`, `discovery.onEvent` both call `verifyEvent`. |
| R4 No keys in client | UI never asks for keys; `RelayConn` ignores AUTH challenges in v1. |
| R5 nsec/hex | N/A v1; if added later, `nip19.decode` at the boundary. |
| R6 Permanent vs transient | `relayConn.classify`. |
| R7 Match OK by id | `relayConn.pendingPublishes: Map<eventId, …>`. |
| R8 Replaceable order | `broadcaster.perAuthorChain`. |
| R9 Bounded REQ | `filterValidator`; `discovery` uses `since`+`limit`. |
| R10 Batch authors | Source filter is a single REQ; relays' NIP-11 caps respected via `registry.nip11`. |
| R11 Unique sub ids; CLOSE on EOSE | `crypto.randomUUID().slice(0,12)` per REQ; `subscribe({ oneShot: true })` auto-CLOSEs. |
| R12 EOSE boundary | `sourceSubscriber.onEose` flushes sorted history then flips `live`. |
| R13 One conn per URL + normalise | `relayPool.get` keyed on `normaliseRelayUrl`. |
| R14 Backoff + jitter; replay subs | `relayConn.scheduleReconnect`, `ws.onopen`. |
| R15 Cap retries; min pool 3 | `relayConn.maxFailures`; `relayRegistry.healthy` floor. |
| R16 Seed list, not hardcoded fallback | Settings textarea starts empty; placeholder shows suggestions only. |
| R17 Buffer sizes | N/A in browser; documented in `relayConn.ts`. |
| R18 Preserve raw bytes | `sourceSubscriber.extractRawEvent`; `relayConn.publish` interpolates raw. |
| R19 Fail closed | `verifyEvent`/validator failures → drop, never accept-on-error. |
| R20 Drop, don't block | `boundedQueue.push` non-blocking + counter. |
| R21 Bounded LRU dedupe | `dedupeLru`. |
| R22 Sort by created_at | `sourceSubscriber.onEose`, `previewPanel`. |
| R23 Cache NIP-11 | `relayRegistry.nip11`. |
| R24 NOTICE = info | `relayConn.handleNotice → debug('relay', …)`. |

---

## 21. Tests

### `tests/unit/relayUrl.test.ts`

```ts
test('canonicalises wss with default port', () => {
  expect(normaliseRelayUrl('wss://Relay.Example.com:443/'))
    .toBe('wss://relay.example.com');
});

test('rejects http', () => {
  expect(() => normaliseRelayUrl('https://relay.example.com')).toThrow();
});
```

### `tests/unit/boundedQueue.test.ts`

```ts
test('drops on overflow', () => {
  const q = new BoundedQueue<number>(2);
  expect(q.push(1)).toBe(true);
  expect(q.push(2)).toBe(true);
  expect(q.push(3)).toBe(false);
  expect(q.stats().dropped).toBe(1);
  expect(q.shift()).toBe(1);
});
```

### `tests/unit/dedupeLru.test.ts`

LRU eviction when capacity reached; `add` returns false on duplicate.

### `tests/unit/filterValidator.test.ts`

```ts
test('rejects unbounded filter', () => {
  expect(() => validateFilterJson('{"kinds":[1]}', 500)).toThrow(FilterValidationError);
});
test('accepts bounded filter', () => {
  const { filter } = validateFilterJson(
    '{"kinds":[1],"authors":["aa..00"],"limit":200}', 500);
  expect(filter.limit).toBe(200);
});
```

### `tests/unit/relayConn.okmatch.test.ts`

Stub a `WebSocket` (a tiny test double in the same file). Issue two `publish(rawA, idA)` and `publish(rawB, idB)` back-to-back; emit `["OK", idB, true, ""]` then `["OK", idA, true, ""]`. Both promises resolve to `'ok'` with the right id (R7).

### `tests/unit/broadcaster.order.test.ts`

Inject three replaceable events for one pubkey with `created_at` 3, 1, 2. Ensure the stub pool sees them published in order 1, 2, 3 (R8). Cross-author: events for pubkey A and pubkey B run concurrently.

### `tests/unit/sourceSubscriber.rawbytes.test.ts`

Construct a known event, sign it with `finalizeEvent`, then **shuffle** key order in the wire string (`{"sig":..., "id":..., "pubkey":..., …}` — non-canonical). Feed it through `extractRawEvent`. Confirm `verifyEvent(parsed)` is true **and** the captured `raw` substring is byte-equal to the shuffled segment of the wire string. This is the keystone test for R18.

### `tests/e2e/happy-path.spec.ts` (Playwright)

Use `nostr-rs-relay` containers (or `ephemeral-relay` from `nostr-tools` test utilities) to run two relays. Open the built site; configure source = relay A; manually call `registry.upsert(relayB)` via a debug hook exposed only when `import.meta.env.DEV`. Publish a kind-1 to A from a third client; assert relay B receives an event with byte-identical id+sig.

---

## 22. Build & Deploy

```
npm install
npm run dev          # localhost:5173
npm run build        # writes dist/
npm run preview      # serves dist/ for the e2e suite
```

The `dist/` folder is fully static. It can be opened directly (`file://dist/index.html`) and works without a server, modulo CORS on NIP-11 fetches — which we already treat as best-effort.

---

## 23. What v1 explicitly does NOT do

These are deliberate omissions; revisit only if a concrete need arises.

- No private-key handling, no NIP-07 signing, no event composition (R4).
- No NIP-42 AUTH responses (relays requiring AUTH simply return zero events).
- No service worker, no offline mode beyond what IDB gives for free.
- No multi-tab coordination — opening blaster in two tabs is allowed but each tab maintains its own pool. `BroadcastChannel` could be added later.
- No backwards-compat for older IDB schema versions; v1 is schema 1.
- No exponential drop strategy on the broadcast queue beyond simple capacity. If we observe sustained drops in the wild we can revisit.
