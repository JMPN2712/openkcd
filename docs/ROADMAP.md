# Roadmap

The milestones come in order. Every feature ships with a **Potato** preset,
because the low-end target is an AMD Vega 7 laptop with 16 GB RAM.

## Done so far (foundations)

These came before the milestones were set. They are the base for all of them.

- **Game data access.**
  - Reads every `.pak` in place from the installed game, via the File System
    Access API; nothing is copied.
  - Case-insensitive VFS with patch layering.
- **Textures.** Split DDS assembly, and BC1–BC7 decoding on the GPU and the
  CPU.
- **Models and characters.**
  - Static and skinned models (.cgf/.cga/.skin/.chr), materials, and a
    WebGPU renderer.
  - Every NPC soul and clothing preset is assembled from the game database.
- **Animation data.**
  - All 8,233 `.caf` clips and 5,155 `.dba` databases decode.
  - Skinned playback and mannequin fragment lookup.
- **World.**
  - Rataje's terrain, cover colours, water, and static objects and
    vegetation, streamed around the camera.
  - Editor layers are filtered.
- **Navigation.** The navmesh decodes. Routes use A* plus a funnel, with
  NPC collision avoidance.
- **Game logic.**
  - Behaviour trees: all 4,911 parse, and an interpreter runs NPC work
    routines against a smart-object world.
  - Lua 5.1 (WebAssembly) boots the game's `main.lua`.
  - Daily schedules place NPCs at work, at home, at meals and in bed.

## 1. Walking simulator (done, 2026-10-20)

Walk through Rataje (then the whole map) as Henry, in first person, at
playable frame rates on the Potato preset.

- [x] Research how KCD stores animations, skeletons and character
      controllers (`docs/ANIMATION.md`).
- [x] Player character controller: capsule, ground following, slopes,
      steps, collision with buildings and terrain.
  - [x] Capsule on the terrain with the script values (0.3 m radius, 50°
        climb, 49° slide, gravity 13 m/s², inertia 11, 1 m jump), code-driven
        movement at the clip speeds, spawning in Rataje's market
        (`player.ts`, `playerSession.ts`, `scripts/test-player.ts`).
  - [x] Collision with buildings and objects (`collision.ts`,
        `scripts/test-collision.ts`): physics proxies first, then
        physicalised render meshes, then simplified visible meshes where a
        model has no physics data (`docs/PHYSICS.md` lists the source by
        object type). Doors don't block yet.
- [x] First-person camera on Henry's skeleton (head bone), with body
      awareness: the eye at the `camera` bone, pitch −70° to +80° (−35° to
      +45° sprinting), the full body drawn with the head and hair hidden, a
      1 cm near plane (reversed-Z depth). The eye pivots about the neck with
      the pitch, standing in for the game's look IK.
- [x] Locomotion: idle, walk, run and turn blending from the game's
      locomotion clips (`locomotion.ts`): the Mannequin fragments pick the
      `.bspace`/`.comb` spaces (walk, run, sprint, backward), blended by
      speed, travel angle and turn rate, with start and stop clips and 0.2 s
      crossfades. Planted feet slide 4–15% of the speed (`test-player.ts`).
      Turning on the spot (`1d_relaxed_idle_bigturns_nw`) is not used yet.
- [x] Physics proxies for collision (from the models' physics meshes):
      MeshPhysicsData boxes, spheres, cylinders, capsules and meshes decoded
      (`physics.ts`, `docs/PHYSICS.md`).
- [x] Third-person camera as a toggle (V; wheel zooms 1–8 m); its arm is
      cast against the world so walls and the ground pull it in. Free-fly
      stays as a debug toggle (F; T puts Henry under the fly camera).
- [x] Terrain detail: the 26 surface types' detail textures blended per
      heightmap sample over the colour map (normal maps still to do).
- [x] Sun shadows: cascaded shadow maps for objects, NPCs and Henry
      (`shadow.ts`, `shadowPass.ts`); off on Potato. The terrain receives but
      doesn't cast yet.
- [x] Normal maps for objects and characters: the meshes' tangent frames
      and the materials' `_ddn`/`_ddna` maps (BC5 with signed contents, see
      `docs/RECON.md`). Off on Potato. Terrain normal maps not done yet.
- [x] Whole-world streaming, plus LOD. The open world is one level
      (`rataje`, 4 × 4 km; `rataje_dlc4` is A Woman's Lot's variant).
  - Streaming:
    - objects stream around the player;
    - unused models and textures are dropped after a few rebuilds;
    - every town's uber-LOD (94 instances) draws beyond the streamed radius;
    - the map's edge stops the player.
  - `scripts/test-streaming.ts`, two laps through six towns: memory levels
    off at about 1 GiB on Potato and 1.7 GiB on Medium (3.4 GiB without
    trimming).
- [x] Time of day and sky: the level's time-of-day profile (sun colour and
      intensity, fog/sky colours, stars, moonlight) drives the light, the
      fog and a sky dome with sun, moon and stars (`tod.ts`, `sky.ts`). The
      sun follows an astronomical path fitted to the profile's sunrise and
      sunset. Clouds, shadows and weather changes are not done yet.
- [x] Performance presets: Potato / Low / Medium / High.
  - [x] Presets defined and selectable in the world view; headless benchmark
        (`scripts/bench-presets.ts`, results in `docs/PERFORMANCE.md`).
  - [x] Market CPU cost cut: indirect draws in per-item render bundles, a
        garbage-free LOD pass, distant NPCs re-posed less often (Medium 29 →
        111 fps on an RTX 5070 Ti; Potato 62 → 84 fps on a 2-CU integrated
        Radeon).
  - Potato in the market runs at 70–84 fps on a 2-CU integrated Radeon
        (headless), weaker than the Vega 7 target. **Not yet measured on the
        Vega 7 laptop itself.**

### Follow-ups from milestone 1

- [ ] Measure Potato on the Vega 7 laptop in Chrome.
- [ ] Terrain normal maps; terrain casting shadows (hills at dusk).
- [ ] Turning on the spot (`1d_relaxed_idle_bigturns_nw`), look IK.
- [ ] Doors that open (they don't block the player yet).
- [ ] Research notes needed: the player's base speeds; the stop clips' foot
      choice; NPC messaging (merchants and guards wait for customers) and
      home item slots (eaters find no bowl).
- [x] Grass and ground plants: the merged-mesh sectors (25.4 million
      instances), streamed around the camera with a radius per preset.
- [x] Lighting: shaded sides were navy (pure sky-blue ambient). The sky term
      is partly white-balanced, and the bounce from below comes from the
      sunlit ground.
- [x] Streaming: buildings no longer blink out at each rebuild.
- [x] Roads (octree type 11, 14,710 meshes) and `%DECAL` strips and
      puddles, blended into the ground; vertex colours.
- [ ] Octree decals (type 7); road normal maps (the 8-byte-per-vertex block
      is probably tangents).
- [ ] Terrain tone: the ground looks brighter and yellower than in the game
      next to the road pieces; check the colour-map gain.
- [ ] Far vegetation (forests beyond the streamed radius are terrain colour
      only); clouds; weather profiles.
- [ ] Water: the volumes are flat tinted polygons with a glint (no
      reflections, waves, depth fade or shoreline blending); the most visible
      issues found walking the whole map.
  - [x] Models with Water, Waterfall and Glass materials (dam overflows,
        weirs, mill races, tubs, buckets, windows) are drawn blended after
        the opaque scene; they had rendered as opaque glitchy surfaces.
  - [ ] Flowing (scrolling) waterfalls, foam, depth fade at the banks.

## 2. Installer converter and slim format (current)

- [ ] Read the GOG offline installer (setup `.exe` + `.bin` files) in the
      browser.
  - [x] Installer reader (`inno.ts`, `docs/INSTALLER.md`): setup headers
        (LZMA), GOG's 10 MiB zlib file parts, slices and installers that keep
        their data in the `.exe`; the base game and all 10 DLC installers,
        checked against `~/kcd1` and the installers' MD5s
        (`scripts/test-inno.ts`).
  - [x] Pick or drop the installer folder in the page, with a progress view
        (`install.ts`, `installView.ts`). The paks are copied into OPFS as
        they are, resuming after an interruption; **Open installed copy**
        runs the engine from there. Base game and all DLC: 166 paks.
        Headless Chrome test: `scripts/test-install-browser.ts`.
  - [x] Installable as a web app, so Chrome grants persistent storage and
        doesn't evict the copy when the disk runs low.
  - [x] Choose what goes in: one voice language, and the HD textures, HD
        voice and HD sound packs off by default (85.7 → 52.5 GiB).
  - [x] Repack without the files later patches replace (`repack.ts`):
        14.2 GiB of the default 52.5 GiB, in 48 paks. Checked by
        `scripts/test-repack.ts`.
  - [ ] Cutscene videos (about 15 GiB) installed on demand, or transcoded.
- [ ] One streaming pass into a slim package in OPFS:
  - compressed textures (GPU formats), compressed meshes, and Opus audio;
  - region chunks plus an index.
- [ ] Afterwards the original install or installer can be deleted.
- [ ] Installed-folder mode stays as an alternative.
- [ ] No game data is ever hosted or distributed by the project.

## 3. Public GitHub release

- [ ] Choose a license.
- [x] Clean-room rebuilds of code first written with decompiler output in view: collision
      avoidance (`crowd.ts`) and the navmesh decoder (`navmesh.ts`, `tools/navmesh.py`), now
      written from research notes (2026-10-19).
- [ ] Final clean-room and history audit (no game data, no decompiled code,
      no branding).
- [ ] Make the `openkcd` repo public, with build and run docs and a
      compatibility list.

## 4. Living world (partly done)

- [x] Behaviour-tree interpreter, smart objects, work routines.
- [x] Daily schedules, collision avoidance.
- [ ] Route search matching the game's.
- [ ] Remaining world-side nodes:
  - helpers, messaging between NPCs, semaphores, teleport;
  - smart-object init behaviours.
- [ ] Meal, leisure and sleep routines.
- [ ] Dialogue barks.

## 5. Diet planning

A config that disables boring fetch and errand side quests and optional
content, without deleting anything.

- [ ] Map the quest graph (flowgraphs, quest dependencies).
- [ ] Classify optional content. Multi-part questlines stay whole, and
      nothing the main quest depends on is ever cut.

## 6. Core gameplay

- [ ] Combat.
- [ ] Inventory.
- [ ] Saves.
- [ ] Horses.
- [ ] Dialogue and quests.
- [ ] The RPG layer.

## 7. Diet playthrough

- [ ] Play the main story start to finish with diet mode on.
