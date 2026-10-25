# Roadmap

The milestones come in order. Every feature ships with a **Potato** preset,
because the low-end target is an AMD Vega 7 laptop with 16 GB RAM.

## Where things stand (2026-10-24)

- **Milestone 2 is done.** The compact package (`docs/SLIM.md`) is built in
  the browser straight from the GOG installer, in place or part by part, and
  the engine runs from it alone. Part by part (two slices at a time) now
  peaks at 16.1 GiB of browser storage for Potato (was 37.2) and 29.5 GiB for
  Full; the packages end at 12.76 GiB (Potato) and 21.41 GiB (Full).
  Cutscene videos are left out and can be added later. Opus audio, converted
  animations and video transcoding moved to "Later" under milestone 2.
- **Milestone 3 (release) done** except the Vega 7 row in
  `docs/COMPATIBILITY.md`: GPL-3.0-or-later license; the clean-room audit
  done and the history rewritten; the release docs (BUILDING, PLAYING,
  COMPATIBILITY, DEPLOY) and the README's "Current status"; the hosted
  player live at <https://openkcd.jmpn.workers.dev/> (a Cloudflare Worker
  with static assets). Tried on the development machine (RTX 5070 Ti) and,
  in progress, an Apple M3 Pro. The repository stays private until the user
  makes it public. Changes now go through pull requests, with the
  clean-room audit (`tools/audit.sh`) and a build in the `checks` workflow.
- **Fixed (2026-10-25): the tailor's evening** (the user's report: at 18:30
  he walked into the back of the armourer's shop, rose to the floor above,
  stood in a corner, then slept hovering over a bed, turned wrong). Three
  causes, all from the data:
  - **Routes:** in-cell portals between navmesh layers and the off-mesh
    connections through doorways were ignored, so houses behind a door were
    unreachable and routes fell back to straight lines: 9.6% of Rataje's
    schedule walks, now 0.4%. He now leaves by the shop door, enters the
    house and climbs its stairs (`docs/LEVELS.md`).
  - **Home spots** at the area's height where only the floor below has a
    navmesh (he stood 3.4 m up in the air); now only on walkable floor at
    that height.
  - **Beds:** every sleeper used the bed pose, unaligned and stood on the
    bed's collision top. Now the bed's kind picks the lying clip (bench,
    ground, shelter, tent, bed), placed by the clip's `Align` bone at the
    bed's helper, at the helper's height: all 1,302 beds pass
    `scripts/test-beds.ts` (1,296 lay across before). `docs/GAMELOGIC.md`.
  - Found on the way: the game has no `kcd_female_database.adb`, which
    `mannequin.ts` loads for women, so women's work fragments probably
    never resolve. To check under step 5 (NPC animations).
- **Milestone 4 (living world) started:** the order is NPC routines end to
  end, interaction (doors, chests, beds), talking to NPCs, ambient audio,
  NPC animations; see section 4.
- **Fixed: furniture turned and moved in houses** (the user's "objects
  completely misarranged" report). A model's main root node transform is
  left out now (`docs/LEVELS.md`); beds had lain 90° across their bedding.
  `scripts/test-interiors.ts` guards it.
- **Not yet checked in the user's Chrome:** everything since the installer
  commit was verified headless only. Ask the user to walk around and report.
- **Performance and streaming (2026-10-23):** Chrome on High in the market
  went from 43 fps to about 130; streaming steps no longer stall (2.6 s →
  under 0.1 s, loading in slices of about 5 ms); the market loads in 53 s
  instead of 74 (from `~/kcd1`). Measured in real Chrome with
  `scripts/profile-browser.ts`; details in `docs/PERFORMANCE.md`.
- **Fixed in the same session:** water on its fog plane (the Rattay tannery
  had been flooded), the weir's water film, clothing layers poking through
  outer garments (`docs/CHARACTERS.md`), a black screen after a while (a
  stale texture in prepared draws).
- **Visual pass on the walking simulator (done this session):** grass
  (merged-mesh sectors), roads, octree decals, `%DECAL` blending and vertex
  colours, far-tree impostors, water ripples, ambient light rebalanced,
  foliage shading, alpha to coverage, sharper grass/leaf/decal textures.
  Formats and choices are in `docs/LEVELS.md`; costs in
  `docs/PERFORMANCE.md`.
- **NPC fixes:** NPCs stand on collision surfaces (not navmesh heights), the
  walk cycle follows the distance walked, hoods draw one state (down). See
  `docs/GAMELOGIC.md` and `docs/CHARACTERS.md`.
- **Water (2026-10-23, done):** wave maps from the volumes' materials,
  flowing downhill; see-through shallows, soft banks and foam from the scene
  depth (blended surfaces now draw in a second, depth-read-only pass). See
  `docs/LEVELS.md`. The unsigned-BC5 fix (`docs/RECON.md`) also cleaned up
  dogs, some beards and crowd riders.
- **Water heights (2026-10-23, fixed):** the surface is each volume's fog
  plane, not its outline's heights. The river by the Rattay tannery had
  floated 1.7 m up and flooded the tannery, and flow appeared in random
  patches. Rivers whose plane is flat no longer flow (only drift); a flow
  direction for them would need a research note or the river's neighbours.
- **Candidates next:** waterfalls; road/decal normal maps (the
  8-byte-per-vertex road block is probably tangents); far-tree culling per
  map cell for the Vega 7; NPCs in Rattay are mostly indoors at noon
  (schedules); hiding body parts under clothes (needs a research note on how
  the game maps `item/body_subpart` to the body mesh).
- **Texture streaming (2026-10-21, done this session):** one shared, streamed GPU texture per
  file (`texturePool.ts`): near objects get up to 512 (Potato) to 2048 px (High) within a memory
  budget per preset; reads inflate on worker threads (`readWorkers.ts`). See
  `docs/PERFORMANCE.md`. Next on the same track: sharper terrain detail layers, cheaper swaps,
  then the low-end work (small-object culling, far-tree culling per cell).
- **Debugging renders:** `node scripts/render-player.ts OUT --at x,y,yaw`
  with `--fly x,y,z,yaw,pitch` (z 0 = 2 m above ground; keep `--at` near the
  camera so the scene streams there, but not on it, or Henry blocks the
  view), `--npcs`, `--at-npc NAME`, `--grass R`, `--no-roads`,
  `--no-far-trees`, `HIDE=regex` to drop models, `--clock HH:MM`.

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
- [x] Texture streaming: textures sized by distance within a memory budget per preset, shared
      across renderers and rebuilds, reads on worker threads.
- [ ] Terrain detail layers sharper up close.
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
- [x] Octree decals (type 7).
- [ ] Road and decal normal maps (the 8-byte-per-vertex block
      is probably tangents).
- [ ] Terrain tone: the ground looks brighter and yellower than in the game
      next to the road pieces; check the colour-map gain.
- [x] Far trees: every tree beyond the streamed radius as an impostor card.
- [ ] Far vegetation (bushes) (forests beyond the streamed radius are terrain colour
      only); clouds; weather profiles.
- [ ] Water: the volumes are flat tinted polygons with a glint (no
      reflections, waves, depth fade or shoreline blending); the most visible
      issues found walking the whole map.
  - [x] Models with Water, Waterfall and Glass materials (dam overflows,
        weirs, mill races, tubs, buckets, windows) are drawn blended after
        the opaque scene; they had rendered as opaque glitchy surfaces.
  - [x] How opaque they are: the Waterfall shader's `AlphaBlendMul` (0.09
        on the thin film over the Rattay mill weir, which had drawn as a
        white sheet of waves) and, for Illum water sheets (`mat_water`), the
        material's `Opacity` (they had drawn opaque).
  - [x] Ripples (six small wave trains with drifting phase, fading with
        distance) and reflections: the banks' dark band near the horizon,
        then haze, then sky; sun glitter.
  - [ ] Flowing (scrolling) waterfalls, foam, depth fade at the banks.

## 2. Installer converter and slim format (done, 2026-10-24)

- [x] Read the GOG offline installer (setup `.exe` + `.bin` files) in the
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
  - [x] Cutscene videos (about 15 GiB) left out by default, installable on
        demand into the compact package's store (transcoding: later).
- [x] Compact package, phase 1 (`docs/SLIM.md`): Node converter and reader for
      Rataje's world in 256 m region chunks; full (5.28 GiB) and Potato (3.68
      GiB) packages; the cold scene build at the market 4.83 → 2.36 s headless.
- [x] Geometry compressed losslessly (meshoptimizer + deflate): Full 5.28 →
      3.56 GiB, Potato 3.68 → 1.96 GiB.
- [x] Phase 2: the converter in the browser (sidebar: Compact package), the
      engine reading the package from OPFS (read, inflate and decode on the
      read workers). Chrome, High: the world is complete in 12 s instead of
      21 (Potato: 8 instead of 12); the NPCs take another ~35 s from the paks.
- [x] Phase 3: characters into the package; a hook so every loader takes
      models and textures from it; textures compressed; a file store
      (everything else, repacked) so the engine runs from the package alone
      (pixel-identical renders). Full 21.7 GiB, Potato 13.1 GiB in all.
- [x] Phase 4: the package built straight from the GOG installer, needing no
      original files. The installer is read in place (GOG's 10 MiB parts
      inflate on their own), so nothing else is copied. In Chrome: Potato
      ready in 576 s, 12.8 GiB in browser storage. **Part by part** (the
      low-storage mode): installs what the slices present hold, names the
      next slice, lists the ones done with (safe to delete), resumes; then
      builds from that copy and deletes it pak by pak.
- [x] Part by part run to the end in Chrome, interrupted and resumed, Cancel
      through the whole build.
- [x] Low-storage peak (2026-10-24): each pak staged without the files a
      higher-ranked pak already seen replaces and (Potato) mips above 512 px,
      kept by size only; slices asked for last to first so the patches come
      first. Chrome, part by part: Potato peak 16.1 GiB (was 37.2), 12.76 GiB
      at the end; Full 29.5 GiB, 21.41 GiB at the end. Checked against the
      whole game by `scripts/test-part-compact.ts`.
- [ ] Try it on the Vega 7 laptop (memory: the in-place build keeps up to
      640 MiB of inflated parts). Needs the user.
- [x] Afterwards the original install or installer can be deleted.
- [x] Installed-folder mode stays as an alternative.
- [x] No game data is ever hosted or distributed by the project.

### Later (after the release)

- [ ] Opus audio (the store keeps Wwise/ogg as they are; a size saving).
- [ ] Converted animations (2.6 GiB of `.caf`/`.dba` in the store).
- [ ] Cutscene videos transcoded to a format browsers play (`.usm` today).

## 3. Public GitHub release (done, 2026-10-24, except the Vega 7 row)

The hosted player is public; the repository is still private, and the user
makes it public.

- [x] Choose a license: GPL-3.0-or-later (`LICENSE`; dependencies are MIT,
      BSD-3-Clause and Apache-2.0).
- [x] Clean-room rebuilds of code first written with decompiler output in view: collision
      avoidance (`crowd.ts`) and the navmesh decoder (`navmesh.ts`, `tools/navmesh.py`), now
      written from research notes (2026-10-19).
- [x] Final clean-room and history audit (no game data, no decompiled code,
      no branding), and the history rewritten (2026-10-24, backup bundles
      kept outside the repository):
  - [x] No game files, assets, renders or large binaries anywhere in the
        history; the only images are the original app icon.
  - [x] No decompiler output in any version of any file, apart from the
        rules that forbid it; no secrets.
  - [x] The decoders and docs from before the clean-room process now appear
        only in their clean-room form in every commit; commit messages that
        described the game's internals reworded.
  - [x] No class, namespace, export or source-path names read from the
        game's DLL in any version (`docs/GAMELOGIC.md`, `docs/RECON.md`;
        the RTTI survey script removed).
  - [x] Commit e-mail addresses are GitHub no-reply ones; `CLAUDE.md` has no
        home paths or user names (machine paths in the ignored
        `CLAUDE.local.md`).
  - [x] The GitHub repository recreated (2026-10-24; it had come up public
        and was made private before the first push), settings restored.
- [x] Docs for the release (2026-10-24): `docs/BUILDING.md` (from source),
      `docs/PLAYING.md` (requirements, the GOG installer, install modes and
      space, presets, controls, known issues), `docs/COMPATIBILITY.md`
      (tested and untested systems), a "Current status" section in the
      README.
- [x] Hosted player live at <https://openkcd.jmpn.workers.dev/>
      (2026-10-24): a Cloudflare Worker with static assets, built with
      `npm ci && npm run build` (`docs/DEPLOY.md`, `web/public/_headers`,
      `web/.node-version`). Players' installs are tied to this origin.
- [x] Pull requests with checks: `tools/audit.sh` (game files, sizes,
      decompiler-style names, home paths, commit and PR wording, no-reply
      e-mails) and a type check and build, in `.github/workflows/checks.yml`.
- [ ] Results from the Apple M3 Pro (being tried) in `docs/COMPATIBILITY.md`.
- [ ] Measure on the Vega 7 laptop and fill in its row in
      `docs/COMPATIBILITY.md` (the user).
- [ ] Make the `openkcd` repo public (the user).

## 4. Living world (in progress)

In this order, checking in with the user between steps. Each step reports
its cost on Potato with a full market.

- [x] Behaviour-tree interpreter, smart objects, work routines.
- [x] Daily schedules, collision avoidance.
- [ ] **1. NPC daily routines end to end:** the smart-object graph and the
      game's route search (GraphSearch); first the tailor's full day, then
      the rest of Rataje's market.
  - [x] Routes into houses: navmesh layer portals and doorway links
        (2026-10-25).
  - [x] Sleeping: lying clip by bed kind, aligned to the bed's helper
        (2026-10-25).
  - [ ] Research note needed: how the daily-cycle brain
        (`sb_daycycles.xml#root`) picks an activity's behaviour (mailboxes,
        priorities, keep/drop/overridable) and its activity nodes.
  - [ ] Remaining world-side nodes: helpers, messaging between NPCs,
        semaphores, teleport; smart-object init behaviours.
  - [ ] Meal, leisure and sleep routines.
- [ ] **2. Interaction:** doors (animated, with collision), chests, beds.
- [ ] **3. Talking to NPCs:** voice lines, subtitles, the dialogue camera
      and response choices from the game's dialogue data; no quest
      consequences yet.
- [ ] **4. Ambient audio:** footsteps per surface, town and nature
      ambience, NPC barks.
- [ ] **5. NPC animations:** walking, working, sitting.

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
