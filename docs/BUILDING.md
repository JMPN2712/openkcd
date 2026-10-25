# Building and running from source

OpenKCD is a static web app (Vite + TypeScript, no backend) in `web/`. It
needs your own copy of Kingdom Come: Deliverance to show anything; the
repository contains no game data.

## Requirements

- **Node.js 24 or newer** (the test scripts run TypeScript directly with
  Node's type stripping). Developed with Node 24.22.
- **npm** (comes with Node).
- **A Chromium-based browser with WebGPU**: Google Chrome, Chromium or Edge.
  See [Linux: Chrome flags](#linux-chrome-flags) below.
- For the test scripts: your game, either the **GOG offline installer**
  (setup `.exe` and `.bin` files) or an **extracted copy** of it (the folder
  with `Data/` and `bin/`; `innoextract --gog` makes one).

## Contributing changes

Work on a branch and open a pull request; `main` only takes merged PRs. Before
opening one, run the clean-room audit over your commits:

```sh
tools/audit.sh origin/main
```

It checks the changed files (no game file types, nothing over 1 MB, no
binaries over 100 KB, no decompiler-style names, no home paths), and the
commit messages and e-mail addresses. The `checks` workflow runs it again on
every pull request, with the PR's title and description, and builds the app.

## Build and run

```sh
git clone https://github.com/JMPN2712/openkcd.git
cd openkcd
git config core.hooksPath .githooks   # the pre-commit checks (no game data, no decompiler output)
cd web
npm ci
npm run dev                           # dev server: http://localhost:5173/
```

Open the address in Chrome, then either pick or drop the GOG installer folder
(install into the browser), or pick an extracted game folder (read in place).
[PLAYING.md](PLAYING.md) describes the flow.

Other commands, from `web/`:

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit`; run before every commit |
| `npm run build` | type check, then a production build into `web/dist/` |
| `npx vite preview` | serve `web/dist/` locally (http://localhost:4173/) |
| `node scripts/<name>.ts` | the headless tests and tools; the README lists each one |

Most test scripts read an extracted copy of the game, by default from `kcd1`
in your home folder; pass `--root PATH` (or the path as the first argument,
as each script's usage line says) to use another. Headless renders use Dawn
through the `webgpu` npm package, so they need a working Vulkan driver.

## Linux: Chrome flags

Chrome on Linux (156) finds no WebGPU adapter unless Vulkan is turned on:

- Open `chrome://flags/#enable-vulkan`, set it to *Enabled*, and relaunch;
  or start Chrome with `--enable-features=Vulkan`.
- **On Wayland, also pass `--ozone-platform=x11`.** Otherwise Chrome logs
  "not compatible with Vulkan" and the view glitches until a reload.
- `--enable-unsafe-webgpu` on its own only gives the CPU fallback
  (SwiftShader), far too slow to use.
- Check the GPU line on the start page: it should name your real GPU.

For example:

```sh
google-chrome --enable-features=Vulkan --ozone-platform=x11 http://localhost:5173/
```

Windows and macOS need no flags in current Chrome (macOS on an M3 Pro is
being tried; Windows is untested; see [COMPATIBILITY.md](COMPATIBILITY.md)).

## Deploying the hosted player

The production build is a static site of about 1 MB that anyone can host. The
official one is a Cloudflare Worker with static assets at
<https://openkcd.jmpn.workers.dev/>; [DEPLOY.md](DEPLOY.md) has its settings. The site never
contains game data: each player installs their own copy into their browser.
