# Spec — "blaster": Browser-only Nostr fan-out app

## Context

A **single-page static web app** that pulls Nostr events matching a user-defined filter from a single source relay, discovers the live relay set via NIP-66 monitor events, and broadcasts each matched event to every healthy discovered relay. All inputs — source relay URL, monitor seeds, filter, advanced tuning — are entered in the UI. There is no backend, no environment variables, and no server-held secrets. The app can be hosted on any static file host or opened from `file://`.

This frame matters for several rules in `nostr-agent-rules.md`: Rule 4 (no keys in client) is honoured by never asking for a private key — broadcast preserves the original event signature byte-for-byte; Rule 18 (preserve raw bytes) becomes the central correctness invariant since the browser is now the forwarder; and the absence of a server means dedupe / registry / NIP-11 cache live in IndexedDB.

**Working directory:** `/Users/g/git/blaster` is empty apart from `nostr-agent-rules.md` and `nostr-patterns.md`. Everything below is new code.

---

## Stack

- **Vite + TypeScript**, output is a static bundle (single `index.html` + JS + CSS).
- **`nostr-tools`** for `verifyEvent`, NIP-19 decode, NIP-11 fetch helpers.
- **`idb`** (tiny IndexedDB wrapper) for persisted state across reloads.
- **No framework.** A ~50-line reactive store + small render functions are enough at this scope.
- **No build-time config.** Every operational input comes from the UI and is persisted to IndexedDB.

---

## Architecture

```
 ┌─────────────────────────── browser tab ───────────────────────────┐
 │                                                                   │
 │   UI panels                                                       │
 │   ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐  │
 │   │ Settings     │ │ Filter+      │ │ Broadcast control +      │  │
 │   │ (source URL, │ │ Preview      │ │ relay registry table     │  │
 │   │  monitor     │ └──────────────┘ └──────────────────────────┘  │
 │   │  seeds,      │                                                │
 │   │  advanced)   │                                                │
 │   └──────────────┘                                                │
 │            │                                                      │
 │            ▼                                                      │
 │   Core (in-tab modules)                                           │
 │     SourceSubscriber ─REQ─▶ source relay ──▶ verify ──┐           │
 │     PreviewBus ◀── matched (raw bytes) ◀── DedupeLRU ◀┘           │
 │     Broadcaster (when armed) ──▶ RelayPool ──▶ N WebSockets       │
 │     Discovery ─REQ kind 30166─▶ monitor seeds ──▶ RelayRegistry   │
 │                                                                   │
 │   Persistence (IndexedDB)                                         │
 │     settings · relays · nip11_cache · dedupe (optional)           │
 └───────────────────────────────────────────────────────────────────┘
```

Three async loops run in the page:
1. **Discovery** — subscribes to user-supplied monitor seeds for kind 30166 events, populates the registry.
2. **Source subscription** — REQ on the configured source relay using the operator's filter.
3. **Broadcast** — when armed, fans the deduped raw-byte stream out to every healthy registry relay.

---

## Components

### 1. `relayUrl.ts` — normalisation

Lowercases host, strips trailing `/`, removes default ports (`:80` for `ws://`, `:443` for `wss://`), drops query/fragment, validates the scheme. The returned string is the canonical key used in every `Map` and IndexedDB row. **(Rule 13.)**

### 2. `discovery.ts` — NIP-66 monitor consumer

- Reads the user's monitor seed list from settings. The Settings panel ships with sensible **defaults shown as placeholder suggestions** (e.g. `wss://relay.nostr.watch`, `wss://history.nostr.watch`) but the field starts empty until the user accepts them — the UI never silently submits a seed list. **(Rule 16 — explicit seed list, no hardcoded fallback at runtime.)**
- One REQ per monitor relay, **bounded**: `{ kinds: [30166], since: now - 24h, limit: 5000 }`. **(Rule 9.)**
- For each event:
  1. `verifyEvent` — drop on failure. **(Rule 3.)**
  2. Read the `d` tag → relay URL. Read `n` tag for network; only accept `clearnet` in v1.
  3. `relayUrl.normalise` → upsert into `RelayRegistry`.
- One-shot REQs are CLOSEd on EOSE; a separate live REQ remains open for incremental updates with a fresh sub id. **(Rules 11, 12.)**
- Reconnect with exponential backoff capped at 60 s + `Math.random() * 500ms` jitter; replay every active REQ on reconnect. **(Rule 14.)**

### 3. `relayRegistry.ts` (IndexedDB store `relays`)

Row shape: `{ url, firstSeen, lastSeen, lastOk, failCount, dead, nip11Json, nip11FetchedAt }`. Methods:
- `upsert(url, observedAt)`.
- `markFailure(url)` — increments `failCount`; sets `dead=true` at 5. **(Rule 15.)**
- `markSuccess(url)` — clears `failCount`, sets `lastOk`.
- `healthy()` — non-dead rows; if fewer than 3, returns the top 3 by `lastOk` regardless of dead flag. **(Rule 15.)**
- `nip11(url)` — returns cached doc; lazy-fetches `application/nostr+json` over HTTPS on first connect (CORS permitting), caches with 7-day TTL. **(Rule 23.)**

### 4. `relayPool.ts` / `relayConn.ts`

`Map<normalisedUrl, RelayConn>`. **One `WebSocket` per URL, ever.** Each `RelayConn` owns:
- The `WebSocket`.
- `activeSubs: Map<subId, Filter[]>` — replayed on reconnect. **(Rule 14.)**
- `pendingPublishes: Map<eventId, { resolve, timeoutHandle }>` — OK responses are matched to the publish by event id, not arrival order. **(Rule 7.)**
- `outQueue: BoundedQueue<string>` — the **original wire string** for each event, sized from settings (default 1000). Enqueue is non-blocking; on overflow it drops + bumps a counter. **(Rules 18, 20.)**
- Backoff state. **(Rules 14, 15.)**
- `NOTICE` messages are logged to the in-page debug console; never thrown, never tear down a sub. **(Rule 24.)**

### 5. `sourceSubscriber.ts`

- One `WebSocket` to the user-configured source relay.
- One bounded REQ from the operator's filter, **client-side validated** to require at least one of `authors`, `kinds`, `since`/`until`, plus an explicit `limit` ≤ the configured `MAX_FILTER_LIMIT` (default 500). **(Rule 9.)**
- For each EVENT message:
  1. **Hold the original `MessageEvent.data` string verbatim.** Parse a copy only for verification + UI display. **(Rule 18.)**
  2. `verifyEvent(parsed)` — drop on failure. **(Rule 3.)**
  3. Look up the event id in `DedupeLRU` (size from settings, default 10 000); skip if seen. **(Rule 21.)**
  4. Push `{ id, parsed, raw }` onto `PreviewBus` and, if armed, into the broadcast queue.
- On EOSE: flips `live=true` and flushes the historical buffer to the UI sorted by `created_at` descending. **(Rules 12, 22.)**
- Filter changes ⇒ CLOSE the old REQ, generate a fresh sub id (`crypto.randomUUID().slice(0,12)`), open a new one. **(Rule 11.)**

### 6. `broadcaster.ts`

Two states: **disarmed** (default) and **armed**. The user toggles via the UI; arming requires a confirmation dialog showing the active filter and discovered-relay count.

When armed, for each event leaving the source:
- If `kind` ∈ replaceable (0, 3, 10000–19999) **or** addressable (30000–39999): the event is enqueued onto a per-`pubkey` serial queue and emitted **oldest-first by `created_at`**. Cross-pubkey work runs in parallel; intra-pubkey work is strictly serial. **(Rule 8.)**
- For each healthy relay: `relayConn.enqueuePublish(rawWireString, eventId)`.
- `RelayConn.handleOk(id, accepted, reason)`:
  - `accepted=true` → `markSuccess`.
  - reason starts with `duplicate:` → success (already there).
  - reason starts with `blocked:` / `invalid:` / `pow:` / `restricted:` / `auth-required:` → **permanent**; record per-relay rejection, do not retry this event. **(Rule 6.)**
  - Anything else (network/timeout) → transient; requeue with capped retries.
- Per-relay NIP-11 `max_filters` / `max_message_length` cap the publish window. **(Rule 23.)**
- A bounded in-memory broadcast log feeds the UI history panel.

### 7. UI

Single page, four panels, all values persisted to IndexedDB on edit:

**A. Settings.**
- Source relay URL (text input, validated `wss://` or `ws://`).
- NIP-66 monitor seeds (one URL per line; placeholder suggests known watchers).
- Advanced (collapsed): `MAX_FILTER_LIMIT`, `DEDUPE_SIZE`, `QUEUE_SIZE_PER_RELAY`, NIP-11 TTL.
- "Forget all relays" button (clears the registry + NIP-11 cache).

**B. Filter editor.** JSON text area with inline validator (Rule 9: must include `authors`, `kinds`, or `since`/`until` plus `limit`). Save → `SourceSubscriber` reopens.

**C. Preview stream.** Live list from `PreviewBus`, newest first by `created_at`. Each row: kind, short npub, relative time, content excerpt, raw-JSON expander. Counter: `matched: N · unique: M · armed: yes/no`. **(Rule 22.)**

**D. Broadcast control + relay table.**
- Arm toggle (modal confirmation).
- Counters: `discovered · healthy · dead · dropped`.
- Per-relay rows: URL, success/fail counts this session, last reason, queue depth.

**Keys.** The app **never asks for a private key** in v1 — events are forwarded with their original signatures intact (Rule 18 makes this exact). If a future version composes new events, signing will go through `window.nostr` (NIP-07) only. **(Rule 4.)**

### 8. Persistence (IndexedDB schema)

- `settings` (single row, keyed `'current'`): the entire UI form state.
- `relays`: one row per normalised URL.
- `nip11_cache`: keyed by URL, with `fetchedAt`.
- `dedupe`: optional persisted ring of recent event ids (only if user opts in via Advanced — default off, in-memory only).

---

## Rule-by-rule trace

| Rule | Where it's honoured |
|---|---|
| 1. Unix seconds | `since`/`until` defaults via `Math.floor(Date.now()/1000)`. |
| 2. No manual id/sig | We never construct events; we forward raw wire strings. |
| 3. Verify signatures | `verifyEvent` at every ingest in `SourceSubscriber` and `Discovery`. |
| 4. No keys in client | UI never collects keys; original sigs are forwarded. |
| 5. nsec/hex | N/A in v1. |
| 6. Permanent vs transient | `RelayConn.handleOk` reason-prefix table. |
| 7. Match OK by id | `pendingPublishes: Map<eventId, …>`. |
| 8. Replaceable order | Per-pubkey serial queue inside `Broadcaster`. |
| 9. Bounded REQ | UI validator + server-side check before opening REQ. |
| 10. Batch authors | Single REQ with `authors: [...]`, capped per relay's NIP-11 `max_filters`. |
| 11. Unique sub ids; close after EOSE | `crypto.randomUUID().slice(0,12)` per REQ; one-shots get CLOSE on EOSE. |
| 12. EOSE boundary | `SourceSubscriber.live` flag flushes sorted history. |
| 13. One conn per URL + normalise | `relayUrl.normalise` is the only key into `RelayPool`. |
| 14. Backoff + jitter; replay subs | `RelayConn` reconnect path. |
| 15. Cap retries; min pool 3 | `RelayRegistry.healthy()` floor logic. |
| 16. NIP-65 markers | N/A in v1; **NIP-66 is the discovery mechanism here**. Seed list is user-supplied, never hardcoded at runtime. |
| 17. Buffer sizes | N/A in browser — `WebSocket` has no scanner cap; oversized frames are handled by the runtime. Keep this in mind if we ever ship a Node companion. |
| 18. Preserve raw bytes | `outQueue` carries the original `MessageEvent.data` string; the parsed object is for display + verification only and is never re-stringified for the wire. |
| 19. Fail closed | Verification or filter validation throws → reject; never accept-on-error. |
| 20. Drop, don't block | `BoundedQueue` non-blocking enqueue with drop counter. |
| 21. Bounded LRU dedupe | `DedupeLRU` size from settings, default 10 000. |
| 22. Sort by created_at | Preview list and EOSE flush. |
| 23. Cache NIP-11 | `RelayRegistry.nip11(url)` 7-day TTL. |
| 24. NOTICE = info | Logged at debug only. |

---

## Critical files (to be created)

```
blaster/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/
│   ├── main.ts                 # bootstrap, wires modules to UI
│   ├── store.ts                # tiny reactive store; persists to IDB
│   ├── core/
│   │   ├── relayUrl.ts
│   │   ├── relayPool.ts
│   │   ├── relayConn.ts
│   │   ├── boundedQueue.ts
│   │   ├── dedupeLru.ts
│   │   ├── sourceSubscriber.ts
│   │   ├── discovery.ts
│   │   ├── broadcaster.ts
│   │   └── filterValidator.ts
│   ├── db/
│   │   └── idb.ts              # IndexedDB schema + helpers
│   └── ui/
│       ├── settingsPanel.ts
│       ├── filterPanel.ts
│       ├── previewPanel.ts
│       └── broadcastPanel.ts
└── style.css
```

---

## Verification

**Unit (vitest, jsdom):**
- `relayUrl.normalise` round-trips for `wss://Relay.Example.com:443/`, `wss://relay.example.com`, `wss://relay.example.com/` → identical key.
- `BoundedQueue` overflow drops + counts.
- `filterValidator` rejects `{ kinds: [1] }` and accepts `{ kinds: [1], authors: [...], limit: 200 }`.
- OK-matching: two concurrent simulated publishes resolve to their own ids even when OKs arrive reversed.
- `Broadcaster` emits replaceable events for one pubkey strictly in `created_at` ascending order.
- `SourceSubscriber` forwards the **exact original wire string**, byte-for-byte (test with a JSON containing non-canonical key order and an event id computed against that exact string).

**Integration (against a local `nostr-rs-relay` container, hit from a real browser via Playwright):**
- Run two relays. In the UI, set source = relay A, manually inject relay B into the registry. Publish a kind 1 to A from a separate client. Confirm: UI preview shows it; on Arm, relay B receives the event with byte-identical id+sig.

**End-to-end (manual smoke):**
- Open the static site (`vite preview` or any static host).
- Settings: source = `wss://relay.damus.io`, monitor seeds = `wss://relay.nostr.watch`.
- Filter = `{ kinds: [1], authors: [<test_pubkey>], since: now-1h, limit: 50 }`.
- Wait for Discovery to populate ≥ 50 relays. Confirm preview stream. Arm broadcast. Watch the relay table fill with OKs. Spot-check three relays with another client.

**Failure modes to exercise:**
- Source relay drops mid-session → `SourceSubscriber` reconnects with backoff, replays REQ; preview resumes; LRU prevents duplicate UI entries.
- A discovered relay returns `blocked:` → row shows permanent rejection, no retry.
- Network partition to 5 of 50 broadcast targets → 45 succeed; the 5 retry with backoff, eventually drop out of `healthy()`; if `healthy()` would fall below 3, the top-3 floor kicks in.
- A monitor relay sends a forged kind 30166 with a bad sig → discovery drops it (Rule 3); the relay it claimed to vouch for is not added.
- Reload the tab mid-broadcast → settings + registry restored from IndexedDB; in-flight publishes are lost (acceptable in v1; the next REQ pulls them from the source again, dedupe LRU rebuilds).
