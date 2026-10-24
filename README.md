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

## Status

Early development. What works today, inside an installed-folder viewer:

- Browsing every pak, texture, model and character.
- **Walking the whole map as Henry**, in first or third person:
  - the game's locomotion animations;
  - collision from the models' physics proxies;
  - day and night from the level's time of day;
  - sun shadows, normal maps and terrain detail;
  - four quality presets, from Potato to High.
- NPCs placed by their daily schedules, running their work routines from the
  game's behaviour trees.

There is no combat, dialogue or quest system yet. See
[docs/ROADMAP.md](docs/ROADMAP.md). The current milestone is **1: walking
simulator**. The game data will later be converted once, in the browser, from
the GOG offline installer into a compact local package (OPFS).

## Browser requirements

- A Chromium-based browser (Chrome, Edge, Chromium) with **WebGPU** and the
  **File System Access API**. Firefox and Safari are not supported yet.
- **On Linux, turn on Vulkan:** open `chrome://flags/#enable-vulkan`, set it
  to *Enabled* and relaunch (or start Chrome with
  `--enable-features=Vulkan`). Without it, Chrome on Linux (156) finds no
  WebGPU adapter. `--enable-unsafe-webgpu` alone only gives the CPU
  fallback (SwiftShader), which is far too slow. Check that the page's GPU
  line names your real GPU.
- A GPU with BC texture compression. Integrated GPUs such as AMD Vega 7 are
  a target; a "Potato" preset is planned for every feature.
- 16 GB RAM recommended.

## License

None yet. A license will be chosen before the repository goes public. Until
then, all rights are reserved by the contributors.

## Repository layout

- `docs/RECON.md`: Phase 1 survey of the install (binaries, middleware, pak format quirks).
- `docs/CHARACTERS.md`: how NPCs are assembled from the database, .cdf files and clothing materials.
- `docs/ANIMATION.md`: animation clip format, quaternion decoding, skinning.
- `docs/LEVELS.md`: level files and the compiled terrain heightmap.
- `docs/PERFORMANCE.md`: quality presets and measured frame rates.
- `docs/PHYSICS.md`: physics geometry in models (MeshPhysicsData), what the player collides with.
- `docs/GAMELOGIC.md`: where gameplay logic lives (behaviour trees, quests, Lua, WHGame.dll structure) and a porting plan.
- `tools/`: read-only Python recon scripts (`pe_info.py`, `pak_survey.py`, `pak_report.py`, `pakread.py`, `rtti_survey.py`, `navmesh.py`).
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
node scripts/test-install-browser.ts ~/Downloads/kingdom_come_deliverance   # headless Chrome: install into OPFS through the page, check the copy, open it
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
node scripts/test-npcs.ts                        # NPC placements from objects_mission0.xml, matched to souls
node scripts/test-schedule.ts                    # where every NPC is at six times of day (schedules, beds, areas)
node scripts/test-navmesh.ts                     # Rataje navmesh: routes stay on the mesh
node scripts/test-bt.ts                          # parse all 4,911 behaviour trees and their expressions, resolve includes
node scripts/test-btrun.ts                       # behaviour-tree interpreter: node semantics + a real game tree
node scripts/test-btworld.ts                     # Rataje's tailor at work: area behaviour → work spot → table's use behaviour → move + animation (trace)
node scripts/test-lua.ts                         # Lua 5.1 (WebAssembly): semantics, tree data round trip, boot Scripts/main.lua
node scripts/bench-npcs.ts                       # CPU benchmark: NPC loading and per-frame cost in Rataje's market (--decode: CPU texture decoding)
node scripts/render-world.ts /tmp/w --at-npc rat_baker --npc-dist 6 --npcs --clock 12:00   # world with NPCs placed by their schedules, framed on one
node scripts/render-world.ts /tmp/w --at-entity SO_tailorsTable_40ee6671 --npc-dist 3 --npcs --clock 10:00 --ai 30   # NPCs at work run by their behaviour trees
node scripts/test-player.ts                      # player controller on Rataje: ground following, climb limit, jump, fall, speeds; Henry's clips
node scripts/test-collision.ts                   # collision sources by object type around the market, random runs: no penetration, no falling through
node --expose-gc scripts/test-streaming.ts       # two laps through the map's towns: scene rebuild times, memory levels off with cache trimming
node scripts/test-sky.ts                         # time-of-day profiles, sunrise/sunset, the sun's path, light levels over the day
node scripts/bench-presets.ts --gpu both         # frame rates per quality preset (Potato/Low/Medium/High), market and fields, each GPU Dawn finds (NO_POOL=1: without texture streaming)
node scripts/bench-streaming.ts --back           # what a streaming step costs: scene build, geometry upload (in slices), the renderer rebuild and the frame after, kept geometry memory
node scripts/profile-browser.ts --trace          # the world view in headless Chrome on the real GPU (opens ~/kcd1 through the folder input): HUD fps, a CPU profile, and with --trace how busy Chrome's GPU process is
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
