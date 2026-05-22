# blaster

Browser-only Nostr fan-out app for moving events between relays without re-signing them. Two modes:

- **Forward (Broadcast, 1 → many)** — subscribe to one source relay with a user-defined filter, dedupe, then re-broadcast each event to every healthy relay discovered via NIP-66.
- **Reverse (Funnel, many → 1)** — open the same filter against every discovered relay at once, dedupe across them, then send the collected events to one destination relay.

Events are forwarded **byte-for-byte**, so the original signature survives. The app never asks for a private key.

No backend, no service worker. Settings, the discovered relay table, and the NIP-11 cache all live in IndexedDB. The `dist/` folder is fully static and runs from `file://`.

See `PLAN.md` for the design and `IMPLEMENTATION.md` for the file-by-file spec.

## Requirements

- Node.js 20+
- npm 9+
- A modern evergreen browser (ES2022)

## Install

```sh
npm install
```

## Develop

```sh
npm run dev
```

Vite serves the app at <http://localhost:5173>. Hot-reloads on save.

## Build

```sh
npm run build
```

Type-checks with `tsc --noEmit`, then bundles to `dist/`. The output is a single static `index.html` + assets — open it directly or serve it from any host.

```sh
npm run preview
```

Serves `dist/` on <http://localhost:5173> for spot-checking the production build.

## Test

Unit tests (Vitest, jsdom):

```sh
npm test
```

End-to-end smoke (Playwright — installs browsers on first run):

```sh
npx playwright install
npm run test:e2e
```

The e2e suite is a smoke test only. The full two-relay byte-equivalence flow described in `IMPLEMENTATION.md` §21 requires `nostr-rs-relay` containers.

## Lint / format

```sh
npm run lint
npm run format
```

## Using the app

The page has three panels (Filter, Preview, Broadcast). The Broadcast panel hosts the mode toggle, the source/destination relay input, and the phase buttons.

### Workflow

Each session walks through four phases — `idle → collecting → ready → broadcasting → idle`:

1. **idle** — pick a mode, enter the source or destination relay, edit the filter.
2. **collecting** — click **Start preview**. Events stream in (deduped, newest-first) until you click **Stop preview**.
3. **ready** — the subscription is closed but the preview is retained. Click **Resume preview** to collect more, or…
4. **broadcasting** — click **Start broadcasting** / **Start funneling**, confirm the modal (which shows the validated filter and either the healthy-target count or the destination), and the snapshot is sent. On full success the preview clears; on partial failure it's retained so you can retry without re-collecting.

### Modes

- **Forward (1 → many).** Subscribe to a **source relay** with your filter. On broadcast, each deduped event is fanned out to every healthy, probe-viable relay in the registry. Replaceable (kinds 0, 3, 10000–19999) and addressable (30000–39999) events for the same `pubkey` are serialised in `created_at` order so relays don't drop them as stale. Other kinds fan out in parallel.
- **Reverse (many → 1).** Subscribe to a **destination relay's** worth of work in reverse: open the filter as a one-shot REQ against every discovered relay at once (capped at ~128 concurrent), dedupe across them, then funnel the collected events to the configured destination relay. Useful for pulling, say, a specific author's history scattered across many relays into one home.

### Filter

JSON, validated client-side. Must include at least one of `authors`, `kinds`, `since`, or `until`, plus a numeric `limit` ≤ `maxFilterLimit` (default 500). `authors`/`ids` are 64-char lowercase hex; `kinds` are integers in `[0, 39999]`.

### Discovery and probing

Two background loops run continuously regardless of phase:

- **Discovery** subscribes to your NIP-66 monitor seeds (defaults shown as placeholder suggestions — the field starts empty until you accept them) for kind 30166 events and upserts every advertised `clearnet` relay into the registry.
- **Prober** pre-flights each newly discovered relay: a cheap one-shot REQ over an ephemeral WebSocket, with a NIP-11 short-circuit for `auth_required` / `payment_required`. Only relays that respond cleanly are marked `viable=true` and become broadcast targets. This keeps the fan-out target set sane when monitors advertise thousands of relays, most of which aren't browser-writable.

The Broadcast panel exposes counters for `discovered · healthy · dead · probing · to probe · events sent · relays reached · dropped`, plus a per-relay table with state, queue depth, OK/fail counts and the last rejection reason.

### Byte-exact forwarding

The wire string for each EVENT is captured directly from the source relay's `MessageEvent.data` (via a hand-rolled JSON scanner in `core/relayConn.ts`) and forwarded verbatim — never `JSON.stringify`'d. This is the central correctness invariant; tampering with it would invalidate signatures.

## Resetting state

Settings persist in IndexedDB under the `blaster` database. To reset:

- **Forget all relays** in the Broadcast panel wipes the discovered relay table and NIP-11 cache (source/destination relays and filter remain).
- For a full wipe, clear the site's IndexedDB via your browser's devtools, or open the app from a private window.

A debug console mirrored at the bottom of the page captures `NOTICE`s, reconnect/backoff activity, and per-relay rejection reasons.
