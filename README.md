# blaster

Browser-only Nostr fan-out app. Subscribes to a single source relay with a user-defined filter, deduplicates events, then re-broadcasts them byte-for-byte to every relay it has discovered via NIP-66.

No backend, no service worker, no key handling. Everything — settings, relay table, NIP-11 cache — lives in IndexedDB. The `dist/` folder is fully static and runs from `file://`.

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

The e2e suite is a smoke test only. The full two-relay byte-equivalence flow described in `IMPLEMENTATION.md` §21 requires `nostr-rs-relay` containers to be available.

## Lint / format

```sh
npm run lint
npm run format
```

## Using the app

1. **Settings panel** — paste a source relay (`wss://...`) and one or more NIP-66 monitor seeds (one URL per line). The seed list starts empty; the placeholder shows suggestions only.
2. **Filter panel** — edit the JSON filter. It must include at least one of `authors`, `kinds`, `since`, `until`, plus a `limit` (≤ `maxFilterLimit`, default 500).
3. **Preview panel** — events streaming from the source relay are deduped and shown most-recent-first. Expand a row to see the byte-exact wire string.
4. **Broadcast panel** — `Arm` opens a confirmation modal showing the validated filter and the current count of healthy targets. Once armed, every new deduped event is fanned out to every healthy relay, preserving raw bytes (so signatures survive). Per-pubkey ordering is enforced for replaceable / addressable kinds.

A debug console is mirrored at the bottom of the page (also available as `console` output for stack traces).

## Resetting state

Settings persist in IndexedDB under the `blaster` database. To reset everything:

- Use **Forget all relays** in the Settings panel to wipe the discovered relay table and NIP-11 cache (source relay + filter remain).
- For a full wipe, clear the site's IndexedDB via your browser's devtools, or open the app from a private window.
