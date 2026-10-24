# Deploying the hosted player (Cloudflare Pages)

The hosted player is the production build of `web/`: a static site of about
1 MB (HTML, JavaScript, one WebAssembly file for Lua, icons). It holds **no
game data**. Each player installs their own copy of the game into their own
browser, and nothing is uploaded, so the site serves only the app.

## Pages project settings

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | None (or Vite) |
| Root directory | `web` |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |
| Node.js version | from `web/.node-version` (24); or set `NODE_VERSION=24` |

`npm run build` type-checks and then builds; a type error fails the
deployment. npm may warn that the `webgpu` package's install script
isn't approved: that package is only for the headless tests, and the build
doesn't need it. Without the Git integration, the same build can be uploaded by
hand:

```sh
cd web && npm ci && npm run build
npx wrangler pages deploy dist --project-name openkcd
```

## Headers and routing

- `web/public/_headers` (copied into `dist/`): hashed files under `/assets/`
  are cached for a year; `index.html`, `/` and the manifest are revalidated,
  so a new deployment reaches players on their next load.
- No cross-origin isolation headers (COOP/COEP) are needed: the app doesn't
  use `SharedArrayBuffer`.
- No redirects: the app is one page.
- HTTPS is required (WebGPU, the origin private file system and app install
  only work in a secure context). `*.pages.dev` and Cloudflare custom domains
  are HTTPS.

## Before the first public deployment

- **Choose the final domain first.** Each player's installed game lives in
  the browser storage of the site's origin. Moving the player to another
  domain later means everyone converts their game again from the installer.
- **Deployments are public even while the repository is private.** Any
  `*.pages.dev` deployment, previews included, can be opened by anyone who
  has its address. Put it behind Cloudflare Access, or wait for the public
  release.
- **Check what goes up:** `dist/` should hold only `index.html`, `assets/`,
  the icons, `manifest.webmanifest` and `_headers`. Never put game files or
  converted packages in `web/public/`; the pre-commit hook and `.gitignore`
  keep them out of the repository, and the build only takes what is there.

## Checked

- The production build is 10 files, under 1 MB; the largest is the main
  script (about 600 KB, 210 KB compressed), far below Pages' 25 MiB file
  limit.
- It runs from `vite preview` in headless Chrome
  (`scripts/test-install-browser.ts` builds and serves it that way).
- Not yet deployed to Cloudflare itself.
