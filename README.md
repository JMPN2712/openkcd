# OpenKCD

**AI Disclaimer** -- This project so far is entirely vibe coded, please keep this in mind  

An unofficial, open-source engine that runs **Kingdom Come: Deliverance** (2018)
in your browser, from **your own copy of the game**, using WebGPU and WebAssembly.

> **Disclaimer.** OpenKCD is a fan project. It is **not affiliated with,
> endorsed by or connected to Warhorse Studios or PLAION**. "Kingdom Come:
> Deliverance" is a trademark of its owners. OpenKCD **contains no game data**
> (no models, textures, audio, scripts or other assets) and never distributes
> any. To use it you need a **legally owned copy** of the game (currently the
> PC version from GOG). Like OpenMW or OpenRCT2, it is a reimplementation of
> the engine that reads the original game's files on your machine.

## Current status

Early development; the walking-simulator and installer milestones are done.

**Works today:**

- **The world:** the whole map of the base game, streamed as you move, with
  terrain, buildings, interiors, vegetation, grass, roads, water, a day and
  night cycle, sun shadows and distant trees.
- **Walking it as Henry**, in first or third person, with the game's
  locomotion animations and collision.
- **NPCs** placed by their daily schedules, walking the navmesh and running
  their work routines from the game's behaviour trees.
- **The installer:** your GOG offline installer is converted in the browser,
  in one go or part by part when disk space is short.
- **Packages:** a compact package (Full 21.4 GiB, Potato 12.8 GiB) runs the
  game without the original files; four quality presets, Potato to High.

**Not yet:** talking to NPCs, quests, combat, inventory, horses and saves;
NPCs don't react to Henry, cutscenes don't play. Doors open (E), but
locked ones need keys that don't exist yet. Chests open and show what
they hold; nothing can be taken yet. Henry can sleep in beds until morning.

**Play it at <https://openkcd.jmpn.workers.dev/>** with your GOG installer:
see [docs/PLAYING.md](docs/PLAYING.md). What has been tested is in
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md), building from source in
[docs/BUILDING.md](docs/BUILDING.md), and the plan in
[docs/ROADMAP.md](docs/ROADMAP.md).

## Browser requirements

- A Chromium-based browser (Chrome, Edge, Chromium) with **WebGPU** and the
  **File System Access API**. Firefox and Safari are not supported yet.
- **On Linux, turn on Vulkan:** open `chrome://flags/#enable-vulkan`, set it
  to *Enabled* and relaunch (or start Chrome with
  `--enable-features=Vulkan`); on Wayland also start it with
  `--ozone-platform=x11`. Without Vulkan, Chrome on Linux (156) finds no
  WebGPU adapter. `--enable-unsafe-webgpu` alone only gives the CPU
  fallback (SwiftShader), which is far too slow. Check that the page's GPU
  line names your real GPU.
- A GPU with BC texture compression. Integrated GPUs such as AMD Vega 7 are
  the target of the Potato preset.
- 16 GB RAM recommended.

## License

OpenKCD is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version (GPL-3.0-or-later): see `LICENSE`. The license covers this project's code and
documents only. Kingdom Come: Deliverance and its data belong to their owners;
OpenKCD contains none of it, and players use their own copy of the game.

## Repository layout

- `docs/PLAYING.md`: for players: requirements, the GOG installer, install modes and space, presets, controls, known issues.
- `docs/BUILDING.md`: building and running from source.
- `docs/COMPATIBILITY.md`: browsers, systems and GPUs tried so far.
- `docs/DEPLOY.md`: hosting the player (a Cloudflare Worker with static assets).
- `docs/RECON.md`: Phase 1 survey of the install (binaries, middleware, pak format quirks).
- `docs/CHARACTERS.md`: how NPCs are assembled from the database, .cdf files and clothing materials.
- `docs/ANIMATION.md`: animation clip format, quaternion decoding, skinning.
- `docs/LEVELS.md`: level files and the compiled terrain heightmap.
- `docs/PERFORMANCE.md`: quality presets and measured frame rates.
- `docs/PHYSICS.md`: physics geometry in models (MeshPhysicsData), what the player collides with.
- `docs/GAMELOGIC.md`: where gameplay logic lives (behaviour trees, quests, Lua, WHGame.dll structure) and a porting plan.
- `tools/`: read-only Python recon scripts (`pe_info.py`, `pak_survey.py`, `pak_report.py`, `pakread.py`, `navmesh.py`).
- `docs/ROADMAP.md`: milestones and status.
- `web/`: the engine (Vite + TypeScript, no backend). Runtime dependency: `wasmoon-lua5.1` (Lua 5.1 VM in WebAssembly).

## Running it locally

You need Node.js 24+ and your own installed copy of Kingdom Come: Deliverance
(PC). Game files are read locally through `Blob.slice()`; nothing is uploaded or copied.

```sh
cd web
npm install
npm run dev        # then open http://localhost:5173/ in Chrome
npm run test:pak   # Node smoke test against ~/kcd1 (or pass a game root)
node scripts/test-inno.ts                        # read the GOG installers (base + DLC) in place: file lists, sampled files vs ~/kcd1 and MD5s (--full: every file, ~4 min)
node scripts/test-install.ts ~/Downloads/kingdom_come_deliverance/DLC /tmp/inst --only=band_of_bastards   # install flow into a folder, compare with ~/kcd1, rerun skips, repack
node scripts/test-install-browser.ts ~/Downloads/kingdom_come_deliverance   # headless Chrome: install into OPFS through the page, check the copy, open it (--compact=potato|full: the compact package straight from the installer, then open it with no game files; --part=2: part by part, two slices at a time, deleting each one the page is done with; --interrupt: Cancel while the store is written, then carry on)
node scripts/test-part-install.ts ~/Downloads/kingdom_come_deliverance      # installing part by part: with only some .bin slices, stop at the next one, list the slices done with, resume (in memory)
node scripts/test-part-compact.ts ~/Downloads/kingdom_come_deliverance     # the compact install's part-by-part staging (two slices at a time, last to first): the store planned from it equals the whole game's, textures pick the same versions (--full: without the Potato cap)
node scripts/test-installer-pak.ts ~/Downloads/kingdom_come_deliverance     # paks read in place from the installer: central directories and entries vs ~/kcd1, a repack plan from the installer alone
node scripts/test-repack.ts                      # leave out replaced files: repack the default install into a scratch folder, read it back, check the engine picks the same files (with and without HD)
node scripts/test-textures.ts /tmp/tex && python3 -I scripts/compare_pillow.py /tmp/tex   # texture layout + decoder check
node scripts/test-cgf.ts                         # parse every model, check indices/bounds/normals
node scripts/test-characters.ts                  # resolve every NPC soul/preset from the database, load a sample
node scripts/test-anim.ts                        # parse all 8,233 .caf clips (~2 min)
node scripts/test-dba.ts                         # decode all 5,155 .dba animation databases (~1.5 min)
node scripts/test-terrain.ts /tmp/rataje.png      # decode the Rataje heightmap, check seams, write a hillshade
node scripts/render-terrain.ts /tmp/t "1500,1800,0,30,-8"   # headless 3D terrain views (x,y,z|0=ground,yaw,pitch)
node scripts/test-level-objects.ts               # parse Rataje's object octree (brushes, vegetation), check against terrain
node scripts/render-world.ts /tmp/w "2192,1050,0,90,-3"   # headless terrain + objects around a point
node scripts/render-world.ts /tmp/w "2560,560,0,20,0" --occlusion   # also world_N_occ.png with occlusion culling: it should match _lod pixel for pixel (OCC=128x64,150,0.02 tries other buffer sizes, distances, minimum sizes)
node scripts/test-npcs.ts                        # NPC placements from objects_mission0.xml, matched to souls
node scripts/test-schedule.ts                    # where every NPC is at six times of day (schedules, beds, areas)
node scripts/test-navmesh.ts                     # Rataje navmesh: routes stay on the mesh
node scripts/test-bt.ts                          # parse all 4,911 behaviour trees and their expressions, resolve includes
node scripts/test-btrun.ts                       # behaviour-tree interpreter: node semantics + a real game tree
node scripts/test-btworld.ts                     # Rataje's tailor at work: area behaviour → work spot → table's use behaviour → move + animation (trace)
SEED=1 node scripts/test-btworld.ts ~/kcd1 rat_tailor cityWalk sa_rat_city   # his free time: benches, shops, walk points (DEBUG=n: running nodes)
node scripts/test-daycycle.ts                    # daily cycle: schedule store rules, patches, the tailor's day, hobby draws and areas in Rataje
node scripts/sim-daycycle.ts --clock 18:27 --minutes 15   # the market across an activity change: trees start/wind down/end, per-frame cost (--max 60, --list)
node scripts/test-diet.ts                        # diet mode: the overlay (a cut quest reads as cancelled, off restores it), the five reachability checks, grants
node scripts/test-dialogue-flow.ts               # conversations: the tailor walkthrough (greeting, menu order, trade ends it, farewell), timed topic 6807, every condition parses
node scripts/test-lua.ts                         # Lua 5.1 (WebAssembly): semantics, tree data round trip, boot Scripts/main.lua
node scripts/bench-npcs.ts                       # CPU benchmark: NPC loading and per-frame cost in Rataje's market (--decode: CPU texture decoding)
node scripts/render-world.ts /tmp/w --at-npc rat_baker --npc-dist 6 --npcs --clock 12:00   # world with NPCs placed by their schedules, framed on one
node scripts/render-world.ts /tmp/w --at-entity SO_tailorsTable_40ee6671 --npc-dist 3 --npcs --clock 10:00 --ai 30   # NPCs at work run by their behaviour trees
node scripts/test-player.ts                      # player controller on Rataje: ground following, climb limit, jump, fall, speeds; Henry's clips
node scripts/test-collision.ts                   # collision sources by object type around the market, random runs: no penetration, no falling through
node scripts/test-chests.ts                      # chest lids open with their .anm (10–20°), and a chest near the tailor's lists its contents by name
node scripts/test-doors.ts                       # doors near the tailor's house swing on their hinges; E opens and closes his door; the leaf blocks only when shut
node scripts/test-dialogue.ts                    # dialogue tables → sequences; the tailor and a townsman cast in a recorded gossip, every line with its subtitle and recording, played to the end
node scripts/test-dialogue-camera.ts             # dialogue camera rig: the blendspace grid, every shot looks towards the partner at any angle, distance and height, smooth between
node scripts/render-player.ts /tmp/p --npcs --at-npc rat_tailor --npc-dist 1.4 --clock 10:00 --at 2522,545 --walk 0.5: --dialogue-shot close_up   # Henry facing the tailor, seen through a dialogue camera shot
node scripts/test-beds.ts                        # every bed in Rataje: the sleeper lies along it, over it, at its height (--no-align: the old poses); Henry wakes beside it on the floor
node scripts/test-interiors.ts                   # interior placement: sampled beds line up with the bedding brushed on them; every model in their scenes matches its LODs
node --expose-gc scripts/test-streaming.ts       # two laps through the map's towns: scene rebuild times, memory levels off with cache trimming
node scripts/test-sky.ts                         # time-of-day profiles, sunrise/sunset, the sun's path, light levels over the day
node scripts/bench-presets.ts --gpu both         # frame rates per quality preset (Potato/Low/Medium/High), market and fields, each GPU Dawn finds (NO_POOL=1: without texture streaming)
node scripts/bench-presets.ts --gpu low-power --scenes market --split --ablate low   # GPU ms per pass (timestamp queries); Medium with each setting set to Low's, one at a time (--with '{"msaa":1}' changes settings)
node scripts/triangles.ts --preset medium        # where a frame's triangles come from: per model, kind and LOD, at the market (no GPU)
CHROME_FLAGS=--use-webgpu-power-preference=force-low-power node scripts/profile-browser.ts --preset=potato --bench --query=gpu-mem   # the in-app benchmark (every preset) in headless Chrome on the integrated GPU; gpu-mem adds memory by holder (--heap: a sampled JS heap profile)
node scripts/build-slim.ts OUT_DIR [--potato] [--store]   # the compact package (docs/SLIM.md), built from ~/kcd1 into OUT_DIR outside the repo; --store: with the file store (run with render-player --root OUT_DIR/store --slim OUT_DIR)
node scripts/test-slim.ts PACKAGE_DIR            # the package's codec, and a sample of its models and textures against the paks
node scripts/bench-streaming.ts --back           # what a streaming step costs: scene build, geometry upload (in slices), the renderer rebuild and the frame after, kept geometry memory, the cached models' CPU mesh data (--keep-vertex-data: without releasing it)
node scripts/test-release.ts                     # the world renderer drops meshes' CPU vertex data once uploaded; the caches reload what leaves the scene, and it streams in again
node scripts/profile-browser.ts --at=2522,545 --dialogue=46319   # the same, Henry by the tailor's shop: plays the gossip there and prints its subtitles as Chrome shows them
node scripts/profile-browser.ts --preset=potato --at=2524,546 --talk=rat_tailor --pick=3   # a conversation with the tailor in Chrome: subtitles, each menu, the options pressed
node scripts/profile-browser.ts --trace          # the world view in headless Chrome on the real GPU (opens ~/kcd1 through the folder input): HUD fps, a CPU profile, and with --trace how busy Chrome's GPU process is
node scripts/profile-browser.ts --preset=potato --bench=this --memory --snapshot=/tmp/p.heapsnapshot   # is the JS heap real: the page's heap, after a forced collection, V8's split, each Chrome process's footprint; a heap snapshot
node --max-old-space-size=16000 scripts/heap-buffers.ts /tmp/p.heapsnapshot   # what retains the array buffers: bytes by retaining path
node scripts/test-texture-pool.ts                # texture streaming: grow, shrink under a budget (read back from the GPU), reads on worker threads
node scripts/render-player.ts /tmp/p --walk "1:;2:w;1.5:w+shift;1:"   # headless walk as Henry with scripted input, a frame per segment (--textures 1024,1024 or --no-pool)
node scripts/render-model.ts /tmp/r soul:henry --anim <clip.caf | db.dba#anim.caf> --frames 0,20,40   # animated headless renders
node scripts/render-model.ts /tmp/renders objects/vehicles/cart/cart_01.cga   # headless WebGPU render to PNG (Dawn)
```

Click **Open KCD folder** and pick the game root (the folder containing `Data` and `bin`).
Or click **Install from GOG installer** (or drop the installer folder on the page): the game's
`.pak` archives are copied out of GOG's offline installer (setup `.exe` + `.bin` files, DLC
installers in the same folder or a `DLC` subfolder) into the browser's private storage, and
**Open installed copy** opens them from there on later visits. The installer can be deleted
afterwards.
Click a `.dds*` file for the texture viewer, a `.cgf/.cga/.skin` for the WebGPU model viewer, a `.cdf`
for a character, **Characters (game database)** to browse every NPC soul and clothing preset, or
**World: Rataje** to fly over the level (terrain, buildings and vegetation, streamed around the camera).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: never commit game files,
extracted assets or decompiled code.
