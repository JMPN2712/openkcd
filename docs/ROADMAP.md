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
- **Fixed (2026-10-25): white cubes** (the user's report, Uzhitz's outhouse):
  editor-primitive brushes drawn without their material override. They now
  take it: black where the game's are black, invisible where they are
  invisible walls (still colliding). Other material overrides (texture swaps
  on 16,143 brushes) are not applied yet (`docs/LEVELS.md`).
- **Chests and beds (2026-10-25):** E opens a chest's lid with the game's
  animation and lists its contents (fixed items, and what its presets may
  add; how the game rolls presets needs a research note). E on a bed sleeps
  until 7:00. Step 2 is done apart from Henry's own animations; step 3
  (talking to NPCs) next.
- **Doors (2026-10-25), checked by the user:** E opens and closes doors with the game's clips,
  the leaves collide, and Henry can walk into houses: invisible horse-only
  blockers in doorways had stopped him (`docs/PHYSICS.md`). Chests and beds
  next.
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
  - Checked by the user in Chrome on the live site (2026-10-25): the tailor
    goes up to his room after his shift (18:31), stays there and sleeps
    properly.
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
        object type). Doors block and open since 2026-10-25 (`doors.ts`).
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
  - [x] Daily cycle from the research note `daily-cycle.md` (2026-10-25,
        `web/src/daycycle.ts`, `docs/GAMELOGIC.md`): the schedule store
        (base windows, patches by priority, skips until midnight,
        `daycycle:change` messages), activities resolved as the land's
        trees do, free time as weighted hobbies on the nearest area of the
        home's settlement. The old guess (free time standing at home) is
        gone. The tailor works until 18:31, finishes his step, and walks
        the town (benches 5–10 min, shops as a customer, walk points)
        until 23:15; his wife prays or walks. `scripts/test-daycycle.ts`,
        `scripts/sim-daycycle.ts`.
  - [x] World-side nodes for it: the timeChanged gate, InstantSemaphore,
        Teleport, TurnBody, GetHelper(s), RangeFilter/RangeSorter,
        behaviour states and max instances, reservations, smart-object
        brains' OnInit (benches).
  - [ ] Messaging between NPCs and areas (`ProcessMessage`): garrison
        guards get no post and hold their spot; shops' merchants and
        customers don't meet. Area brains (`CitySA_onUpdate`).
  - [x] Loops and locks from the research note `bt-rules.md`
        (2026-10-25): `Loop` fails on the first failing child (the guess
        had it run on); external locks start closed, semaphores free;
        semaphores and synchronize share one counted lock that admits in
        arrival order and in batches; Local is the hosting smart area or
        object instance.
  - [ ] Pub lunch (10% of men whose social class has `lunchInPub`):
        needs where that flag comes from.
  - [ ] Sleep through the home's `Sleeper` tree (beds are placed directly).
  - [ ] Home hobbies for non-residents (`hangingOut` in the nearest
        home): open point of the note.
- [x] **2. Interaction:** doors (animated, with collision), chests, beds.
  - [x] Doors (2026-10-25, `web/src/doors.ts`): E opens or closes the door
        Henry faces within its use distance, with the game's clip for its
        side and approach (`door_<r|l>_<f|b>_<o|c>_player`); the leaf moves
        in the streamed scene and collides; locked doors stay shut.
        `scripts/test-doors.ts`.
  - [x] Henry walks through doorways: the horse-only blockers in them
        (surface type `mat_horse_only`) no longer stop him; 277 in the
        market's 200 m.
  - [x] Doors in the editor layers shown at game start (2026-10-25): 121
        more, Skalitz's and Rattay castle's hall door among them. When a
        door opens towards Henry he steps out of its swing (until his own
        animation does it), and a swinging leaf no longer shoves him.
  - [ ] Other layered entities (furniture, NPCs, items in `layers/*.xml`).
  - [ ] Henry's hand animation for doors; NPCs opening the doors they pass
        through (their walk-through clips are in `doors.dba`); door sounds
        (step 4); keys and lockpicking (core gameplay).
  - [x] Chests (2026-10-25, `web/src/chests.ts`, `anm.ts`): E opens an
        unlocked chest's lid with its model's own `_open.anm` (10–20°, as
        the game's) and lists what it holds by name (`localization.ts`, the
        English text tables): its own items and what its presets can add.
        The lid is drawn apart from the body (`x.cga#lid:node`). Locked
        chests stay shut. `scripts/test-chests.ts`.
  - [ ] Research note needed: how an inventory's presets are rolled
        (`max_items`, priorities, `amount_random_add`), for real loot.
  - [ ] Taking items (with the inventory, core gameplay).
  - [x] Beds (2026-10-25, `web/src/beds.ts`): E sleeps until 7:00 in the
        bed Henry faces (not one an NPC sleeps in); he gets up at the bed's
        wake-up helper, or the nearest floor beside it; the HUD says when
        a bed isn't his. Sitting (a press on beds and benches in the game)
        and the hours dialogue wait for Henry's animations and the UI.
- [ ] **3. Talking to NPCs:** voice lines, subtitles, the dialogue camera
      and response choices from the game's dialogue data; no quest
      consequences yet.
  - [x] Dialogue data to sequences, voices and subtitles (2026-10-25,
        `web/src/dialogue.ts`, `voice.ts`, `dialoguePlayer.ts`,
        `dialogueView.ts`, `docs/GAMELOGIC.md`). A sequence plays with
        the NPCs near Henry as its cast, each line in its speaker's
        recorded voice with its English subtitle; started by id from a
        debug control. `scripts/test-dialogue.ts` plays the tailor's
        gossip 46319 end to end; checked in headless Chrome by the
        tailor's shop (all 6 lines voiced). Cost: about 1.5 s to load on
        first use, about 125 MiB kept.
  - [x] Dialogue camera rig (2026-10-25, `web/src/dialogueCamera.ts`):
        the camera skeleton on Henry is posed by its blendspace from where
        the partner stands (angle, distance, height). The four shots
        (`master`, `medium`, `close_shot`, `close_up`) frame the partner
        as the game's do. `scripts/test-dialogue-camera.ts`; renders with
        `render-player.ts --dialogue-shot`. In the view a debug picker
        chooses the shot.
  - [ ] Which shot each line uses, and when it cuts: needs a research
        note. So do the mood/posture clips added on top and the lens.
  - [x] Conversation starts and choice lists from `notes/dialogue.md`
        (2026-10-25, `web/src/dialogueFlow.ts`, `dialogueCondition.ts`):
        E talks to the NPC Henry faces; greetings, the topic menu in the
        game's order, timed choices, follow-ups and (Back), flags that end
        the conversation, the farewell bark; entry conditions and sequence
        scripts. The tailor walkthrough passes headless and in Chrome
        (`scripts/test-dialogue-flow.ts`, `profile-browser.ts --talk`).
  - [ ] The price panel (flag 2, haggling and bribes): a placeholder.
  - [ ] Shop, repair and trainer screens their sequences open.
  - [ ] Research note needed: role matching's strict mode (where it
        applies), and how a dialogue interrupts the NPC's daily cycle.
  - [ ] Command lines: moods and `ADLG_*` fragments (with step 5).
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
