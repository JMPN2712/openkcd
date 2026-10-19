# OpenKCD

Unofficial, open-source browser engine (WebAssembly + WebGPU) that runs
Kingdom Come: Deliverance 1 from the player's **own legally owned copy**. Not
affiliated with or endorsed by Warhorse Studios or PLAION. Local folder is
`~/kcd-web`; GitHub repo is `openkcd` (private until the public release).

## Hard rules

- **Game files are read-only.** Never modify, move or delete anything in
  `~/Downloads/kingdom_come_deliverance` (the GOG installer). Extracted game
  files live in `~/kcd1` and are read-only.
- **Never commit** game files, extracted assets, converted packages, renders
  of game content or large binaries. `.gitignore` plus `.githooks/pre-commit`
  enforce this. After cloning, run `git config core.hooksPath .githooks`.
- **Clean room.**
  - Decompiled output stays in `~/tools/ghidra-out` and is never committed
    to any repo.
  - Behaviour notes derived from decompiled code go in the private
    `openkcd-research` repo (local: `~/openkcd-research`), as plain language
    only.
  - Public code is written from those notes, the game's data files and
    open-source libraries (e.g. Recast/Detour, RVO2).
  - No decompiler names (`FUN_…`, addresses) in this repo.
- **CryEngine source** is reference only. Never copy code from it.
- **Branding.** Never use Warhorse's logos, artwork or branding.
- **Hosting.** We never host or distribute game data. Players supply their
  own game.
- **sudo.** If a step needs sudo, stop and give the user the exact command.
- **Pace.** Work in small steps, run what you build, and check in between
  phases.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Distribution model

- **Primary input:** the GOG offline installer (setup `.exe` + `.bin`). It is
  converted in the browser, in one streaming pass, into a slim web package in
  OPFS:
  - compressed textures and meshes;
  - Opus audio;
  - region chunks plus an index.

  The original installer can then be deleted.
- **Alternative:** installed-folder mode, which reads the paks directly. This
  is what works today, via the File System Access API.
- **Dropped:** no server or R2 streaming of game files.

## Milestones

See `docs/ROADMAP.md`. In order:

1. Walking simulator. **Current.**
2. Installer converter and slim format.
3. Public GitHub release.
4. Living world (NPC routines; partly done).
5. Diet planning.
6. Core gameplay.
7. Diet playthrough.

**Diet mode** is a config that disables boring fetch and errand side quests
and optional content without deleting anything. It keeps multi-part
questlines whole and never cuts anything the main quest depends on.

## Hardware targets

- **Dev machine:** Kubuntu, Ryzen 9 9900X, 64 GB RAM. Chromium needs
  `--ozone-platform=x11` for WebGPU.
- **Low end:** AMD Vega 7 laptop with 16 GB RAM. Every feature needs a
  **Potato** preset.

## Codebase (`web/`, Vite + TypeScript, no backend)

| Area | Files | State |
|---|---|---|
| Paks, VFS | `zip.ts`, `paks.ts`, `vfs.ts`, `tree.ts` | Reads all paks in place (Blob.slice) |
| Textures | `dds.ts`, `texture.ts`, `bcn.ts` | Split DDS assembly, BC1–7 (GPU and CPU) |
| Models, materials | `cgf.ts`, `mtl.ts`, `model.ts`, `renderer.ts` | .cgf/.cga/.skin/.chr, WebGPU renderer |
| Characters | `character.ts`, `skeleton.ts`, `characterView.ts`, `tables.ts` | Souls and clothing presets from the database |
| Animation | `anim.ts` (.caf), `dba.ts`, `clips.ts`, `pose.ts`, `mannequin.ts` | Clips decode and skin; no blending or locomotion controller yet |
| Terrain, levels | `terrain.ts`, `cover.ts`, `terrainRenderer.ts`, `waterRenderer.ts`, `levelObjects.ts`, `levelLayers.ts`, `world.ts`, `levelView.ts` | Rataje level: terrain, objects, vegetation, water, editor layers, streaming |
| Navigation | `navmesh.ts`, `crowd.ts` | Navmesh decode, A* plus funnel, collision avoidance |
| NPCs | `levelEntities.ts`, `schedule.ts`, `npcs.ts`, `npcAi.ts` | Placement, daily schedules, crowd |
| Game logic | `bt.ts`, `btRuntime.ts`, `btWorld.ts`, `luaHost.ts` (wasmoon Lua 5.1), `typeDefs.ts` | Behaviour-tree interpreter running work routines |

- **Docs:** `docs/RECON.md`, `LEVELS.md`, `CHARACTERS.md`, `ANIMATION.md`,
  `GAMELOGIC.md`, `ROADMAP.md`.
- **Tests:** headless scripts in `web/scripts/` run with
  `node scripts/<name>.ts` against `~/kcd1`. Headless WebGPU renders go
  through Dawn (`webgpu` npm). The README lists every script.
- **Checks before committing:** `cd web && npx tsc --noEmit`, plus the
  relevant test scripts.

## Local tools (not in the repo)

- **Ghidra 12.1.4** headless, with project `~/tools/ghidra-projects/kcd`
  (WHGame.dll). Scripts are in `~/tools/ghidra-scripts`.
- **Run:**

  ```
  JAVA_HOME=~/tools/jdk-21.0.12.1+1 ~/tools/ghidra_12.1.4_PUBLIC/support/analyzeHeadless ~/tools/ghidra-projects kcd -process WHGame.dll -noanalysis -readOnly -scriptPath ~/tools/ghidra-scripts -postScript X.java OUTDIR args
  ```
