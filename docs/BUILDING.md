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

## Setting up a machine (one command)

```sh
git clone https://github.com/JMPN2712/openkcd.git
cd openkcd
tools/setup.sh          # asks for the game and installer folders; --yes takes the defaults
```

`tools/setup.sh` (macOS, Linux and WSL; safe to run again) checks Git and
Node (24+, see `web/.node-version`), enables the git hooks, sets this clone's commit
e-mail to your GitHub no-reply address (through `gh`, when signed in),
installs the packages, and writes this machine's paths to **`.openkcd.json`**
(gitignored):

```json
{ "gameRoot": "/path/to/game", "installers": "/path/to/gog", "chrome": "/path/to/chrome" }
```

Every script and harness reads it (`web/scripts/paths.ts`), so nothing in the
repository names a machine's folders. `OPENKCD_GAME_ROOT`,
`OPENKCD_INSTALLERS` and `CHROME` override it for one run, and `--root`
for one script. For Claude Code it also writes `CLAUDE.local.md` (this
machine's notes) and adds the clean-room folder's absolute path to
`.claude/settings.local.json`. Flags: `--game DIR`, `--installers DIR`,
`--research DIR`, `--chrome PATH`, `--no-npm`.

Then, on any machine:

```sh
tools/check.sh --quick  # type check and the fast tests (a minute)
tools/check.sh          # all headless tests and the clean-room audit (before a PR)
cd web && npm run dev   # dev server: http://localhost:5173/
```

## Build and run

By hand, without the setup script:

```sh
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
| `npm run check` | `tools/check.sh`: the type check, the headless tests and the audit |
| `npm run build` | type check, then a production build into `web/dist/` |
| `npx vite preview` | serve `web/dist/` locally (http://localhost:4173/) |
| `node scripts/<name>.ts` | the headless tests and tools; the README lists each one |

Most test scripts read an extracted copy of the game, by default from
`.openkcd.json`'s `gameRoot` (else `kcd1` in your home folder); pass `--root PATH` (or the path as the first argument,
as each script's usage line says) to use another. Headless renders use Dawn
through the `webgpu` npm package: Vulkan on Linux, Metal on macOS. The
headless Chrome harnesses (`profile-browser.ts`, `test-install-browser.ts`)
find Chrome in its usual place on Linux, macOS and Windows (`.openkcd.json`'s
`chrome` or `CHROME=` picks another binary) and pass the Linux flags below only on Linux.

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

Windows and macOS need no flags in current Chrome. On macOS WebGPU runs on
Metal: no Vulkan or `--ozone-platform` flags (tried on an Apple M3 Pro;
Windows is untested; see [COMPATIBILITY.md](COMPATIBILITY.md)).

## Deploying the hosted player

The production build is a static site of about 1 MB that anyone can host. The
official one is a Cloudflare Worker with static assets at
<https://openkcd.jmpn.workers.dev/>; [DEPLOY.md](DEPLOY.md) has its settings. The site never
contains game data: each player installs their own copy into their browser.
