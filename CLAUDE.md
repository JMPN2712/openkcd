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
- **Clean room: two kinds of session, never mixed.**
  - **Research sessions** run in `~/openkcd-research`. They may read
    `~/tools/ghidra-out` (decompiled output, never committed anywhere), and
    they write plain-language behaviour notes only, to the private
    `openkcd-research` repo. They don't write OpenKCD code.
  - **Implementation sessions** run in `~/kcd-web` (this repo). They **must
    not read `~/tools/ghidra-out`**, or run the decompiler. They work from
    the notes in `~/openkcd-research/notes`, the game's data files and
    open-source libraries (e.g. Recast/Detour, RVO2).
    `.claude/settings.json` denies the path, and a Bash hook blocks commands
    that mention it.
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
  converted in the browser, in one streaming pass, into a slim web package in
  OPFS:
  - compressed textures and meshes;
  - Opus audio;
  - region chunks plus an index.

  The original installer can then be deleted.
- **Today:** the installer's paks are copied into OPFS as they are (no slim
  format yet), and the engine reads them from there. Installed-folder mode
  (reading the paks of an installed game via the File System Access API)
  stays as the alternative.
- **Dropped:** no server or R2 streaming of game files.

## Milestones

See `docs/ROADMAP.md`. In order:

1. Walking simulator. Done (follow-ups listed in the roadmap).
2. Installer converter and slim format. **Current.**
3. Public GitHub release.
4. Living world (NPC routines; partly done).
5. Diet planning.
6. Core gameplay.
7. Diet playthrough.

**Diet mode** is a config that disables boring fetch and errand side quests
and optional content without deleting anything. It keeps multi-part
questlines whole and never cuts anything the main quest depends on.

## Hardware targets

- **Dev machine:** Kubuntu (Wayland), Ryzen 9 9900X, 64 GB RAM, RTX 5070 Ti
  plus the CPU's integrated Radeon. The browser is Google Chrome; it needs
  Vulkan turned on for WebGPU (`chrome://flags/#enable-vulkan`, or
  `--enable-features=Vulkan`) **and** `--ozone-platform=x11`: Chrome 156 on
  Wayland logs "not compatible with Vulkan" and glitches until reload. The
  KDE menu entry (`~/.local/share/applications/google-chrome.desktop`) and
  the `chrome-webgpu` alias pass both.
- **Low end:** AMD Vega 7 laptop with 16 GB RAM. Every feature needs a
  **Potato** preset.

## Codebase (`web/`, Vite + TypeScript, no backend)

| Area | Files | State |
|---|---|---|
| Paks, VFS | `zip.ts`, `paks.ts`, `vfs.ts`, `tree.ts` | Reads all paks in place (Blob.slice) |
| Installer | `inno.ts`, `lzma.ts`, `install.ts`, `installView.ts`, `repack.ts` | Reads GOG's Inno Setup installers in place (base game and DLC), installs their paks into OPFS and repacks them without files later patches replace (52.5 → 38.2 GiB); the engine opens that copy |
| Textures | `dds.ts`, `texture.ts`, `bcn.ts` | Split DDS assembly, BC1–7 (GPU and CPU) |
| Models, materials | `cgf.ts`, `mtl.ts`, `model.ts`, `renderer.ts` | .cgf/.cga/.skin/.chr, WebGPU renderer |
| Characters | `character.ts`, `skeleton.ts`, `characterView.ts`, `tables.ts` | Souls and clothing presets from the database |
| Animation | `anim.ts` (.caf), `dba.ts`, `clips.ts`, `pose.ts`, `mannequin.ts` | Clips decode and skin; no blending or locomotion controller yet |
| Terrain, levels | `terrain.ts`, `cover.ts`, `terrainRenderer.ts`, `waterRenderer.ts`, `levelObjects.ts`, `levelLayers.ts`, `world.ts`, `levelView.ts` | Rataje level: terrain, objects, vegetation, water (ripples), editor layers, streaming |
| Ground and far field | `mergedMeshes.ts` (grass), `roads.ts`, `decals.ts`, `farTrees.ts` | 25M grass/plant instances, 14,710 roads, 20,212 decals (blended in the ground pass), impostor cards for 293k distant trees |
| Navigation | `navmesh.ts`, `crowd.ts` | Navmesh decode, A* plus funnel, collision avoidance |
| NPCs | `levelEntities.ts`, `schedule.ts`, `npcs.ts`, `npcAi.ts` | Placement, daily schedules, crowd |
| Game logic | `bt.ts`, `btRuntime.ts`, `btWorld.ts`, `luaHost.ts` (wasmoon Lua 5.1), `typeDefs.ts` | Behaviour-tree interpreter running work routines |

- **Docs:** `docs/RECON.md`, `LEVELS.md`, `CHARACTERS.md`, `ANIMATION.md`,
  `GAMELOGIC.md`, `INSTALLER.md`, `ROADMAP.md`.
- **Tests:** headless scripts in `web/scripts/` run with
  `node scripts/<name>.ts` against `~/kcd1`. Headless WebGPU renders go
  through Dawn (`webgpu` npm). The README lists every script.
- **Checks before committing:** `cd web && npx tsc --noEmit`, plus the
  relevant test scripts.

## Research (private, not in this repo)

Reverse-engineering workflow, tools and behaviour notes live in the private
`openkcd-research` repo (local: `~/openkcd-research`, see its `CLAUDE.md`).
Read the relevant note before implementing game behaviour.
