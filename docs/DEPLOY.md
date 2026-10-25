# Deploying the hosted player (Cloudflare Worker)

The hosted player is live at **<https://openkcd.jmpn.workers.dev/>**. It is
the production build of `web/`: a static site of about 1 MB (HTML,
JavaScript, one WebAssembly file for Lua, icons), served by a Cloudflare
Worker with static assets. It holds **no game data**. Each player installs
their own copy of the game into their own browser, and nothing is uploaded,
so the site serves only the app.

## Worker settings

| Setting | Value |
|---|---|
| Worker name | `openkcd` (so the address is `openkcd.<account>.workers.dev`) |
| Type | static assets only, no Worker script |
| Root directory | `web` |
| Build command | `npm ci && npm run build` |
| Assets directory | `dist` |
| Node.js version | from `web/.node-version` (24); or set `NODE_VERSION=24` |

`npm run build` type-checks and then builds; a type error fails the
deployment. npm may warn that the `webgpu` package's install script isn't
approved: that package is only for the headless tests, and the build doesn't
need it. Deploying by hand from a checkout:

```sh
cd web && npm ci && npm run build
npx wrangler deploy --name openkcd --assets dist --compatibility-date 2026-10-01
```

## Headers and routing

- `web/public/_headers` (copied into `dist/`, read by the Worker's static
  assets and not served itself): hashed files under `/assets/` are cached
  for a year; `index.html`, `/` and the manifest are revalidated, so a new
  deployment reaches players on their next load. Checked on the live site:
  `/` comes back `no-cache`, with `nosniff` and `no-referrer`.
- No cross-origin isolation headers (COOP/COEP) are needed: the app doesn't
  use `SharedArrayBuffer`.
- No redirects and no single-page fallback: the app is one page, and other
  paths are 404.
- HTTPS is required (WebGPU, the origin private file system and app install
  only work in a secure context). `*.workers.dev` and Cloudflare custom
  domains are HTTPS.

## Keep in mind

- **The address is now part of every player's install.** Each player's
  installed game lives in the browser storage of the site's origin
  (`openkcd.jmpn.workers.dev`). Moving the player to another domain means
  everyone converts their game again from the installer, so a move should be
  announced, and the old address kept up until players have moved.
- **Check what goes up:** `dist/` should hold only `index.html`, `assets/`,
  the icons, `manifest.webmanifest` and `_headers`. Never put game files or
  converted packages in `web/public/`; the pre-commit hook, `.gitignore` and
  the pull-request audit keep them out of the repository, and the build only
  takes what is there.

## Checked

- The production build is 10 files, under 1 MB; the largest is the main
  script (about 600 KB, 210 KB compressed), far below the 25 MiB limit on a
  static asset.
- It runs from `vite preview` in headless Chrome
  (`scripts/test-install-browser.ts` builds and serves it that way).
- Live on `openkcd.jmpn.workers.dev` since 2026-10-24; tried there on the
  development machine and on an Apple M3 Pro (see
  [COMPATIBILITY.md](COMPATIBILITY.md)).
