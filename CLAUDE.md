# OpenKCD

Unofficial, open-source browser engine (WebAssembly + WebGPU) that runs
Kingdom Come: Deliverance 1 from the player's **own legally owned copy**. Not
affiliated with or endorsed by Warhorse Studios or PLAION. GitHub repo:
`openkcd`. Machine-specific paths (this checkout, the installer, the game
copy, the research repo) are in `CLAUDE.local.md`, which is not committed.

## Hard rules

- **Game files are read-only.** Never modify, move or delete anything in
  the GOG installer folder or the extracted game folder.
- **Never commit** game files, extracted assets, converted packages, renders
  of game content or large binaries. `.gitignore` plus `.githooks/pre-commit`
  enforce this. After cloning, run `git config core.hooksPath .githooks`.
- **Clean room: two kinds of session, never mixed.**
  - **Research sessions** run in the private research repo. They may read
    the local decompiler-output folder (never committed anywhere), and
    they write plain-language behaviour notes only, to the private
    `openkcd-research` repo. They don't write OpenKCD code.
  - **Implementation sessions** run in this repo. They **must not read the
    decompiler-output folder**, or run the decompiler. They work from
    the research repo's notes, the game's data files and
    open-source libraries (e.g. Recast/Detour, RVO2).
    `.claude/settings.json` denies the folder, and a Bash hook blocks
    commands that mention it.
  - **When a note is missing or unclear,** stop and ask for a research
    session. Never peek.
  - **In this repo:** no decompiler names (`FUN_…`, addresses).
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
  converted in the browser into a slim web package in OPFS:
  - compressed textures and meshes;
  - region chunks plus an index;
  - a file store of everything else (Opus audio later).

  The original installer can then be deleted.
- **Today:** two install modes from the installer. The paks can be copied
  into OPFS (repacked without replaced files). Or the compact package
  (`docs/SLIM.md`) can be built straight from the installer, read in place
  or part by part; it then runs the engine with no original files.
  Installed-folder mode (reading the paks of an installed game via the File
  System Access API) stays as the alternative.
- **Dropped:** no server or R2 streaming of game files.

## Milestones

See `docs/ROADMAP.md`. In order:

1. Walking simulator. Done (follow-ups listed in the roadmap).
2. Installer converter and slim format. Done (2026-10-24): the compact
   package is built from the installer, in place or part by part, and runs
   the engine alone (`docs/SLIM.md`). Later items are in the roadmap.
3. Public GitHub release. **In progress:** GPL-3.0-or-later; history
   audited and rewritten (2026-10-24). Ask before rewriting history; the
   user makes the repository public.
4. Living world (NPC routines; partly done).
5. Diet planning.
6. Core gameplay.
7. Diet playthrough.

**Diet mode** is a config that disables boring fetch and errand side quests
and optional content without deleting anything. It keeps multi-part
questlines whole and never cuts anything the main quest depends on.

## Hardware targets

- **Development machine:** Linux (KDE Plasma on Wayland), Ryzen 9 9900X,
  64 GB RAM, RTX 5070 Ti plus the CPU's integrated Radeon, Google Chrome.
  Chrome on Linux needs Vulkan turned on for WebGPU
  (`chrome://flags/#enable-vulkan`, or `--enable-features=Vulkan`) **and**
  `--ozone-platform=x11`: Chrome 156 on Wayland logs "not compatible with
  Vulkan" and glitches until reload.
- **Low end:** AMD Vega 7 laptop with 16 GB RAM. Every feature needs a
  **Potato** preset.

## Codebase (`web/`, Vite + TypeScript, no backend)

| Area | Files | State |
|---|---|---|
| Paks, VFS | `zip.ts`, `paks.ts`, `vfs.ts`, `tree.ts`, `readWorkers.ts` | Reads all paks in place (Blob.slice); large reads inflate on worker threads |
| Installer | `inno.ts`, `lzma.ts`, `install.ts`, `installView.ts`, `repack.ts`, `installerPak.ts` | Reads GOG's Inno Setup installers in place (base game and DLC), installs their paks into OPFS and repacks them without files later patches replace (52.5 → 38.2 GiB), part by part when slices are missing; paks can also be read straight from the installer |
| Compact package | `slim.ts`, `slimBuild.ts`, `slimStore.ts`, `slimView.ts`, `compactInstall.ts`, `levelData.ts` | Region chunks of converted models and textures plus a file store of everything else; built in the browser from the installer (Full or Potato); the engine runs from it alone |
| Textures | `dds.ts`, `texture.ts`, `bcn.ts`, `texturePool.ts` | Split DDS assembly, BC1–7 (GPU and CPU); streamed by distance within a budget per preset |
| Models, materials | `cgf.ts`, `mtl.ts`, `model.ts`, `renderer.ts` | .cgf/.cga/.skin/.chr, WebGPU renderer |
| Characters | `character.ts`, `skeleton.ts`, `characterView.ts`, `tables.ts` | Souls and clothing presets from the database |
| Animation | `anim.ts` (.caf), `dba.ts`, `clips.ts`, `pose.ts`, `mannequin.ts` | Clips decode and skin; no blending or locomotion controller yet |
| Terrain, levels | `terrain.ts`, `cover.ts`, `terrainRenderer.ts`, `waterRenderer.ts`, `levelObjects.ts`, `levelLayers.ts`, `world.ts`, `levelView.ts` | Rataje level: terrain, objects, vegetation, water (ripples), editor layers, streaming |
| Ground and far field | `mergedMeshes.ts` (grass), `roads.ts`, `decals.ts`, `farTrees.ts` | 25M grass/plant instances, 14,710 roads, 20,212 decals (blended in the ground pass), impostor cards for 293k distant trees |
| Navigation | `navmesh.ts`, `crowd.ts` | Navmesh decode, A* plus funnel, collision avoidance |
| NPCs | `levelEntities.ts`, `schedule.ts`, `npcs.ts`, `npcAi.ts` | Placement, daily schedules, crowd |
| Game logic | `bt.ts`, `btRuntime.ts`, `btWorld.ts`, `luaHost.ts` (wasmoon Lua 5.1), `typeDefs.ts` | Behaviour-tree interpreter running work routines |

- **Docs:** `docs/RECON.md`, `LEVELS.md`, `CHARACTERS.md`, `ANIMATION.md`,
  `GAMELOGIC.md`, `INSTALLER.md`, `SLIM.md`, `PERFORMANCE.md`, `ROADMAP.md`;
  for players and contributors `PLAYING.md`, `BUILDING.md`,
  `COMPATIBILITY.md`, `DEPLOY.md` (keep them current when behaviour, sizes
  or requirements change).
- **Tests:** headless scripts in `web/scripts/` run with
  `node scripts/<name>.ts` against the extracted game folder (`--root`).
  Headless WebGPU renders go
  through Dawn (`webgpu` npm). The README lists every script.
- **Checks before committing:** `cd web && npx tsc --noEmit`, plus the
  relevant test scripts.

## Research (private, not in this repo)

Reverse-engineering workflow, tools and behaviour notes live in the private
`openkcd-research` repo (see its `CLAUDE.md`).
Read the relevant note before implementing game behaviour.
