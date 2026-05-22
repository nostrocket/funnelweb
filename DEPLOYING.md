# Deploying blaster to GitHub Pages

The build output is a fully static `index.html` + JS + CSS bundle with no runtime config and no server requirement, so GitHub Pages serves it as-is. Because `vite.config.ts` sets `base: './'`, the bundle uses relative asset paths and works at any subpath — including the default `https://<user>.github.io/<repo>/` URL — without any per-deploy configuration.

There are two ways to deploy. The GitHub Actions flow is the recommended one; the manual `gh-pages` branch flow is documented for completeness.

## Option 1 — GitHub Actions (recommended)

1. In the repository on GitHub, open **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.

2. Add the workflow below at `.github/workflows/deploy.yml`:

   ```yaml
   name: Deploy to GitHub Pages

   on:
     push:
       branches: [main]
     workflow_dispatch:

   permissions:
     contents: read
     pages: write
     id-token: write

   concurrency:
     group: pages
     cancel-in-progress: true

   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 20
             cache: npm
         - run: npm ci
         - run: npm run lint
         - run: npm test -- --run
         - run: npm run build
         - uses: actions/configure-pages@v5
         - uses: actions/upload-pages-artifact@v3
           with:
             path: dist

     deploy:
       needs: build
       runs-on: ubuntu-latest
       environment:
         name: github-pages
         url: ${{ steps.deployment.outputs.page_url }}
       steps:
         - id: deployment
           uses: actions/deploy-pages@v4
   ```

3. Commit and push to `main`. The workflow runs `lint → test → build`, uploads `dist/` as the Pages artifact, and deploys. The deployed URL appears in the run summary and in **Settings → Pages**.

End-to-end tests (`npm run test:e2e`) are not included in the workflow — they require Playwright browser downloads and are smoke-only. Run them locally before pushing if you've touched the UI.

## Option 2 — manual `gh-pages` branch

For one-off deploys without CI:

```sh
npm run build
npx gh-pages -d dist
```

Then in **Settings → Pages**, set **Source** to **Deploy from a branch**, branch `gh-pages`, folder `/ (root)`. Subsequent deploys just re-run the two commands.

## Custom domain

To serve from your own domain (e.g. `blaster.example.com`):

1. In **Settings → Pages**, enter the custom domain. GitHub will write a `CNAME` file into the deployed site.
2. To keep the `CNAME` across rebuilds, add `public/CNAME` to the repo containing just your domain on one line — Vite copies `public/` verbatim into `dist/`.
3. Point a DNS `CNAME` record at `<user>.github.io`.

No code changes are needed: relative asset paths work at the root just as they do under `/<repo>/`.

## Notes and caveats

- **IndexedDB origin scoping.** Settings and the relay table are keyed to the origin. Moving the site between origins (e.g. `<user>.github.io/blaster/` → `blaster.example.com`) starts users with an empty database.
- **WebSocket connectivity.** GitHub Pages is HTTPS-only, so the page can only connect to `wss://` relays — `ws://` will be blocked as mixed content. The relay-URL input already enforces both schemes, but only `wss://` will actually work in production.
- **NIP-11 CORS.** Lazy NIP-11 fetches happen from the browser over HTTPS and require the relay to permit cross-origin requests. Failures are TTL-cached and don't block broadcasting; the prober has a NIP-11 short-circuit for `auth_required` / `payment_required` but otherwise falls back to its WebSocket probe.
- **No server-side `_redirects` / SPA fallback needed.** The app is a single page; there are no client-side routes that would need a fallback to `index.html`.
- **`file://` still works.** If you'd rather not deploy at all, the same `dist/` opens directly from disk — relative paths mean a double-click on `dist/index.html` runs the app.
