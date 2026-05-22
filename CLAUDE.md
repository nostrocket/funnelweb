# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev          # Vite dev server at http://localhost:5173 (HMR)
npm run build        # tsc --noEmit, then vite build → dist/ (single static bundle)
npm run preview      # serve dist/ on http://localhost:5173
npm test             # vitest (jsdom env, runs tests/unit/**/*.test.ts)
npm run test:e2e     # playwright (auto-starts `npm run preview`); first run: `npx playwright install`
npm run lint         # eslint src --max-warnings=0
npm run format       # prettier -w .
```

Run a single unit test: `npx vitest run tests/unit/broadcaster.order.test.ts` (or `npx vitest tests/unit/foo.test.ts -t "name pattern"`).

The e2e suite is a smoke test only. The full two-relay byte-equivalence check described in `IMPLEMENTATION.md` §21 needs `nostr-rs-relay` containers and is not part of `test:e2e`.

## Architecture

Browser-only Nostr fan-out. Subscribes to one source relay with a user-defined filter, deduplicates events, and re-broadcasts each one **byte-for-byte** to every relay discovered via NIP-66 (kind 30166). No backend, no service worker, no key handling — all state lives in IndexedDB. The `dist/` output runs from `file://`.

`src/main.ts` is the composition root. It wires modules into three concurrent loops:

1. **Discovery** (`core/discovery.ts`) — REQs `{ kinds: [30166] }` against each user-supplied monitor seed. For each verified event, reads the `d` tag (relay URL) and `n` tag (network — clearnet only in v1) and upserts into the registry. Each seed runs both a one-shot historical REQ (`since: now-24h, limit: 5000`) and a live REQ.
2. **Source subscription** (`core/sourceSubscriber.ts`) — REQs the operator's validated filter against the configured source relay. Verifies signatures, dedupes on event id, buffers pre-EOSE events and replays them sorted by `created_at` once live.
3. **Broadcast** (`core/broadcaster.ts`) — when armed, fans each deduped event to every `registry.healthy()` relay.

Data flows: `SourceSubscriber → PreviewBus + Broadcaster.ingest → RelayPool → N WebSockets`. `RelayRegistry` is updated by `Discovery` (upsert) and `Broadcaster` (markSuccess/markFailure).

### Byte-exact forwarding (the central correctness invariant)

Signatures must survive forwarding, so events are **never re-stringified**. `RelayConn.handleEvent` calls `extractEventRaw()` (a hand-rolled JSON scanner in `core/relayConn.ts`) to slice the byte-exact substring of the event object out of the relay's `["EVENT","<subid>",{...}]` envelope. That raw string flows through `IngestedEvent.raw` and is wrapped as `["EVENT",<raw>]` for publishing. `tests/unit/sourceSubscriber.rawbytes.test.ts` enforces this — do not replace the scanner with `JSON.stringify(event.parsed)`.

### Per-author ordering

Replaceable / addressable kinds (0, 3, 10000–19999, 30000–39999) must arrive at each relay in author-emitted order, otherwise relays drop the older one. `Broadcaster.enqueueFanout` chains these per `pubkey` via `perAuthorChain: Map<author, Promise>` so successive events for one author never run concurrently. Non-replaceable kinds fan out in parallel. `tests/unit/broadcaster.order.test.ts` covers this.

### Relay connection lifecycle (`core/relayConn.ts`)

One `RelayConn` per relay, owned by `RelayPool`. State machine: `idle → connecting → open → closed | dead`. On unexpected close: exponential backoff (cap 60 s + ~500 ms jitter); after `maxFailures` (5) the relay is marked `dead`. On reconnect, every still-active subscription is replayed (one-shots that already EOSE'd are dropped). `publish()` queues into a `BoundedQueue` if the socket isn't open and drains on `onOpen`; queue overflow resolves the publish as `transient: queue-overflow`.

`OK` reasons are classified by `classifyOk()`: `accepted=true` → `ok` (or `duplicate` if reason starts `duplicate:`); `accepted=false` with prefixes `blocked:`, `invalid:`, `pow:`, `restricted:`, `auth-required:` → `permanent` (do not bump relay failure count — it's the event's fault, not the relay's); everything else → `transient` (does bump). NIP-42 `AUTH` is logged and ignored in v1.

### Relay registry & NIP-11

`RelayRegistry` keeps an in-memory `Map<RelayUrl, RelayRow>` mirrored to IndexedDB. `healthy()` returns non-dead rows, but if fewer than `minHealthy` (3) are alive it falls back to the top-N by `lastOk` then `lastSeen` regardless of `dead`. `nip11(url)` is fetched lazily over HTTPS (CORS-permitting), in-flight calls are coalesced, both successful docs and failures are TTL-cached (success = `nip11TtlMs`, failure = 24 h). Per-relay `limitation.max_message_length` is enforced in `Broadcaster.publishOne` before publishing — oversize is logged as `permanent`.

### Filter validation (`core/filterValidator.ts`)

The UI's filter JSON must include at least one of `authors / kinds / since / until` plus a numeric `limit ≤ advanced.maxFilterLimit` (default 500). `authors` and `ids` must be 64-char lowercase hex; `kinds` are integers in `[0, 39999]`; `#tag` arrays are truncated to 256 entries with a warning. Unix-second values that exceed `1e10` produce a "looks like milliseconds" warning. `since`/`until` are not auto-defaulted.

### Relay URL normalisation (`core/relayUrl.ts`)

The canonical key in every `Map` and IDB row: lowercase host, no trailing `/`, default ports stripped (`:80` for `ws://`, `:443` for `wss://`), no query/fragment. Always normalise URLs at boundaries — `RelayUrl` is a branded `string` type (`types.ts`).

### State & UI

`Store<T>` (`store.ts`) is a tiny reactive container with debounced (200 ms) IDB persistence. `createBus<T>()` is a fan-out event channel used for preview events, broadcast log entries, and counters. UI panels under `src/ui/` are vanilla DOM (no framework); each `mount*` function takes its container element plus deps. Settings persist to the `settings` IDB store under the singleton key `current` (`db/schema.ts`).

### IndexedDB

Schema in `db/schema.ts` (v1): `settings` (singleton), `relays` (keyPath `url`), `nip11_cache` (keyPath `url`), `dedupe` (keyPath `id`, indexed by `addedAt`). Bumping `DB_VERSION` requires extending the `upgrade` callback in `db/idb.ts` — old versions of the bundle in other tabs are handled via `blocking()` (current tab closes its connection so the upgrader can proceed).

## Project conventions

- TypeScript is `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`. Type-only imports must use `import type`.
- The build is `tsc --noEmit && vite build` — TS only type-checks; Vite emits. `tsc -b` is **not** used (no project references).
- No framework. Don't add React/Vue/Svelte for new UI; use the existing `el()` helper in `src/ui/components.ts`.
- Never re-stringify a Nostr event you intend to forward. If you find yourself reaching for `JSON.stringify(parsed)`, use the `raw` field instead.
- Always `verifyEvent` before acting on incoming events (see `nostr-agent-rules.md` R3). Both `SourceSubscriber` and `Discovery` already do this — preserve it on any new ingestion path.
- The repo treats `nostr-agent-rules.md` as binding. New code is justified against rule numbers (e.g. `// R18: preserve raw bytes`); `IMPLEMENTATION.md` is the file-by-file spec keyed to those rules.
