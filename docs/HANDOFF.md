# Handoff

Where the work stands, so any new session can pick it up. Updated after
every merged pull request. The plan is in [ROADMAP.md](ROADMAP.md); this
file is the short list of what is next, what waits for the user, and what
waits for a research session.

## Moving machines (2026-11-13)

Development is moving off the MacBook Pro. **Everything is on GitHub:**
main is at `5d6333c`, there are no open PRs, and no branch, stash or
worktree holds unpushed commits (checked in this checkout, its three
worktrees and `openkcd-research`).

**Set up the new machine:**

1. Clone `openkcd`, run `git config core.hooksPath .githooks`, set the
   repo-local `user.email` to the GitHub no-reply address the history uses,
   then `cd web && npm ci`.
2. Write `CLAUDE.local.md` again (it is not committed). It names this
   checkout, the game root (an installed copy, read-only), the GOG
   installers, the research repo and the decompiler-output folder.
   Repeat that folder's absolute path as a deny in
   `.claude/settings.local.json`, as on the Mac.
3. Clone `openkcd-research` beside it. The decompiler output never leaves
   the research side; regenerate it there if needed.
4. Check the harnesses find Chrome (`web/scripts/chrome.ts`; `CHROME=`
   overrides). On Linux, see CLAUDE.md for the Vulkan and X11 flags.
5. Smoke test: `npx tsc --noEmit`, `node scripts/test-release.ts`,
   `node scripts/test-dialogue-camera.ts`, then a
   `profile-browser.ts --preset=potato --bench=this` run. Label the new
   machine's numbers in PERFORMANCE.md.

**Not in git, on purpose:** the dialogue framing screenshots for #34 are
renders of game content. Remake them with
`profile-browser.ts --dialogue=ID --shot=… --screenshot=PREFIX` or
`test-dialogue-camera.ts` if wanted; never commit them.

**Next steps, in order:**

1. The user's benchmark rerun (below, "Waiting for me"). If the GPU
   frames line shows the slowest 1% at 2–3× the median with every pass
   slower, the lows are the GPU's clocks; otherwise profile the CPU side
   with `--headed --spikes`.
2. Memory (priority 1): Potato's heap after the benchmark is about
   1.8 GiB since #37, plus about 1.4 GiB on the GPU, so the tab is still
   over the 2 GiB target. Next: the world store's fragmentation, then
   16-bit indices and Henry's animation database (117 MiB).
3. Walk CPU (priority 5): see "Findings not yet acted on".
4. The rest of milestone 4. Facial animation and lip sync, and the
   dialogue camera's open points, wait for the research questions below.
5. The Vega 7 row in COMPATIBILITY.md: nothing since #24 is measured
   there.

## Now (2026-10-30)

- **Development moved to a MacBook Pro (Apple M3 Pro, 24 GB).** Chrome on
  macOS runs WebGPU on Metal with no flags; the headless Chrome harnesses
  find it there (`web/scripts/chrome.ts`). Benchmarks from this machine are
  **M3 Pro numbers**, not the RTX 5070 Ti's or the Vega 7's
  ([PERFORMANCE.md](PERFORMANCE.md)).
- **Priority (the user's list of 2026-10-31):** 1. JS heap (find what holds
  it, cut it; per-category breakdown in the report); 2. 1% lows; 3. occlusion
  culling (done, #24); 4. the new Medium: no MSAA, upscaling with dynamic
  resolution (done: Medium 79 → 92 fps, 1% low 7 → 11); 5. CPU in the walk segment; 6. far trees cheaper on low
  presets (done: culled by cell, Potato 1.18 → 0.55 ms). Earlier order, for reference:
  1. RAM. The JS heap is real (array buffers, not garbage): see
     PERFORMANCE.md "Is the JS heap real?". Animation databases no longer
     all kept (−818 MiB of buffers on Potato). Target from the user:
     Potato under 2 GiB for the tab, Medium under 3 GiB. Geometry stores halved (44-byte vertices, chunks grown from
     4 MiB: Potato GPU 2.6 → 1.3 GiB). Left: the world store's
     fragmentation (holds up to twice what it uses); the world caches'
     positions and indices (CPU vertex data is now dropped once uploaded:
     Potato's heap after the benchmark 3.0 → 2.3 GiB, Medium's 4.0 →
     2.9 GiB). Still over the targets: Potato's tab is about 2.3 GiB of
     heap plus 1.4 GiB on the GPU.
  2. Streaming stalls. One work budget per frame (`frameBudget.ts`): long
     frames in a flight 140 → 95, loading 13 → 11 s. New background work
     should `await workSlice()` between pieces. **Measured (#31,
     PERFORMANCE.md "What the 1% lows are made of"):** in a visible window
     Potato's 1% low is 31–35 fps on the M3 Pro, its long frames idle on
     the CPU with every GPU pass slower in them; headless lows are
     artifacts of unthrottled frames. Frame pacing and finer slicing were
     tried and dropped. Next: the user's own benchmark (it now reports the
     GPU's slowest frames), and the Vega 7, where lows may be CPU-bound.
  3. Occlusion culling. The occluder shells (`occluder.ocm`) in a 128×64
     CPU buffer each frame (`occlusion.ts`, preset setting `occlusion`,
     `?no-occlusion`): Medium in the market 64 → 101 fps on the M3 Pro.
     Left: the previous frame's reprojected depth (the note's other
     source), terrain occlusion, and measuring Low/Potato on the Vega 7.
  4. Upscaling (render below the canvas size, upscale with sharpening).
  5. The new Medium: the console profile from `notes/graphics-settings.md`
     §6 and §10 (Medium groups, items at half view distance, 900p-like).
- **Then** the rest of milestone 4 (ROADMAP section 4).

## Waiting for me (the user)

- **Run the ⏱ Benchmark again in your Chrome** (same 1154×648 window): the
  report now has a "GPU frames" line per preset, which tells whether your
  1% lows are the GPU's slow frames, as they are headed here.

## Diet mode (milestone 5)

**State (after #30, #33 and #36).** The spec is the "Final decisions"
section of the research repo's `notes/diet-analysis.md`.
- **What diet mode is.** An overlay on the quest state (`web/src/quests.ts`,
  `diet.ts`, `dietConfig.ts`) that cuts 39 side quests, with the Simon
  route of `q_recruiters` rewired away.
- **The setting.** "Diet mode" in the world view's toolbar, on by default
  and read live.
- **What the overlay covers.** Dialogue, behaviour-tree `SetQuest` and
  `SetQuestObjective` nodes, and Lua's `QuestSystem`. They all change one
  `QuestSystem`, so a cut quest refuses to start and reads as cancelled
  everywhere.
- **The tests.** `node scripts/test-diet.ts` runs the spec's five
  reachability checks, the overlay's unit tests, and the tree and Lua
  checks.
  - The start scan reads only what is under a tree's `Root`: the research
    notes confirm that `ForestContainer` groups never run.
  - Check 4's static walk can't follow four quests even with diet off:
    `q_returnToSkalitz`, `q_pribBattle`, `q_revenge` and `q_tutorials`.
    They are reported, not failed.

**Next steps, in order:**
1. **Run the quests' own trees.** Each quest with a `smart_object` is an
   NPC-like smart object whose trees live in `Libs/AI/quests/<file>.xml`,
   with an always-active subbrain and the `QuestMailbox` messages
   `onQuest`/`onObjective` (research `notes/quest-system.md`, "The quest's
   tree").
   - Create one AI-world entity per quest and send it the quest events
     `QuestSystem` emits.
   - Skip quests the overlay cuts (`DietMode.treeRuns`), so what only
     their trees spawn stays unspawned.
2. **Trees' quest reads, in `btWorld.ts`:** `QuestObjectiveCondition`
   (if/else on a predicate), `GetQuest` (a predicate into a variable) and
   `QuestObjectiveGate`. The gate is a passive barrier that passes while the
   objective is in a given state, re-evaluates on each change of that
   quest, and has `NegateTo`. Answer them through `QuestSystem.call` so
   cut quests read as cancelled. Today they fall through to the
   interpreter's default.
3. **Shop grants, once a shop system exists.** Stock
   `DietMode.shopGrants(shop)`: the agility book at 139 `aus_scribe`, the
   saddle at 130 `neu_stables`, the trappings at 128 `aus_stables`, and
   the Queen of Sheba's sword at 80 `sas_shop_swordsmith_new`. Item ids
   are in `dietConfig.ts`.
4. **A browser playthrough with diet mode on.** Start in Rataje, talk to
   the givers of cut quests (their offers should be hidden) and to kept
   ones, and toggle the setting off and on. Nobody has tried the toggle by
   hand yet; only the headless tests have run. This leads into
   milestone 7.
5. **Quest save and load.** `QuestSystem.save` and `load` exist but nothing
   calls them.

## Questions for a research session

- **Durations without a unit** (bt-rules.md, Wait): 11 Waits write
  `"500"` or `"200"` beside the usual `"500ms"`. We read them as
  milliseconds, the parser's base unit (marked ASSUMPTION in
  `duration.ts`). Is that right? And when a Wait's duration comes from a
  variable holding a number, which unit applies?
- **Dialogue camera** (dialogue.md; `dialogueCamera.ts`, `ShotPlanner`):
  1. The camera-cut command (`v_dialogue_commands` type 2) and a
     response's `camera_mode`: which shot is each camera type 1–4? We read
     1 `master`, 2 `medium`, 3 `close_shot`, 4 `close_up`. Is the cut's
     `who` the role framed or the role the rig sits on?
  2. How does the game cut on the ~84,600 lines that name no shot (which
     shot per line, on whom, when it changes)? We frame each speaker over
     the listener's shoulder with our own rule (medium, close shot on a
     change of speaker, close-up when one goes on).
  3. Type-5 cuts name a camera placed in the level (`char_param`, e.g.
     `cam_dlc14_judge_henry1`): which entity holds it, and how is it
     found? And what does `topic.custom_camera` do?
  4. The lens (field of view) of dialogue shots, and when the mood clips
     (`ad_cam_base_stand_calm_add`, …) are added.
- **Facial animation and lip sync:** each recorded line has a facial clip
  of the same name (`animations/humans/facials/<folder>_<voice>.dba`)
  animating 60 `*_blendWeightVertex` bones; head skins carry morph targets
  (`CompiledMorphTargets`, chunk 0x2002) and aren't skinned to those bones.
  Needed: the morph-target chunk's layout, how a bone's rotation (or
  position) becomes a morph weight, which bone drives which morph, and the
  playback rules (start with the voice line? blend in and out? what the
  face does between lines and for lines without a clip; eye blinks and
  the `ADLG_*` mood animations). See ANIMATION.md, "Not done yet".
- **Leaving a conversation:** besides "(End dialog)", flags 1 and 8 and
  "(Back)", can the player leave by a key mid-line or at a follow-up menu
  (Esc, walking away)? We allow Backspace/Esc only for those options.
- **Soul tags in conditions:** `HasSoulTag(...)` reads 0, so the townsfolk
  answers gated by `soulNumber_<n>_of_3` (e.g. topic 26691 after "What
  kind of governor is Sir Hanush?") never play and the talk falls through
  to the farewell. Where does a soul's tag set come from (a table, or
  assigned at spawn)?
- Open ones from before are listed in ROADMAP section 4 ("Research note
  needed").

## Known gaps in the tests

- `test-cgf` exits 1 on the 31 old-format character files `docs/RECON.md`
  lists as unsupported (`CryTek` header, older node chunk); everything else
  in it passes.
- `render-player.ts` renders are not pixel-repeatable (streaming timing);
  `render-world.ts` and `render-model.ts` are, so compare those before and
  after a rendering change.

## Log of merged pull requests

- #17 (2026-10-30): development on macOS: Chrome per platform in the
  headless harnesses, installer tests take either DLC layout, `test-lua`
  without extra files, `render-player --at x,y` without a yaw, the M3 Pro
  baseline in PERFORMANCE.md.
- #18 (2026-10-30): geometry memory halved (44-byte vertices, stores that
  grow from 4 MiB): Potato GPU 2.6 → 1.3 GiB on the M3 Pro.
- #19 (2026-10-31): one work budget per frame for background tasks
  (`frameBudget.ts`): long frames in a flight 140 → 95, loading 13 → 11 s.
- #20 (2026-10-31): clocks from the research notes (dialogue cooldowns in
  play time, Wait durations; see "Clocks checked" below).
- #21 (2026-10-31): the JS heap is real; animation databases no longer all
  kept (−818 MiB); `--memory`, `--snapshot`, `heap-buffers.ts`.
- #22 (2026-10-31): far trees drawn by cell inside the view, within a
  distance per preset (Potato 1.18 → 0.55 ms).
- #24 (2026-10-31): occlusion culling by the level's occluder shells
  (`occlusion.ts`, a 128×64 CPU buffer; on for Low/Medium/High): Medium in
  the market 64 → 101 fps on the M3 Pro; renders unchanged.

- #25 (2026-10-31): the user's Mac benchmark recorded in full.
- #26 (2026-10-31): the new Medium: no MSAA, the scene at a dynamic
  0.5–1× scale upscaled with sharpening (`upscale.ts`): Medium 79 → 92 fps,
  1% low 7 → 11 on the M3 Pro (scale stayed near 1 there).
- #28 (2026-10-31): the world renderer drops meshes' CPU normals,
  tangents, UVs and colours once uploaded; the caches reload models whose
  geometry left the GPU. Heap after the benchmark: Potato 3.0 → 2.3 GiB,
  Medium 4.0 → 2.9 GiB; frame rates unchanged (`test-release.ts`).

- #31 (2026-10-31): spike profiles of the benchmark run
  (`profile-browser.ts --bench=this --spikes`, `--headed`, `SPIKES_OUT`,
  `TRACE_OUT`) and a line for the GPU's slowest 1% of frames in the
  report; the 1% low findings in PERFORMANCE.md. Landed as 1d42c3e (the
  PR was closed, not marked merged: main had moved).
- #34 (2026-11-01): dialogue fixes from play in Rataje. The dialogue
  camera runs in every conversation and frames each speaker, Henry too,
  over the listener's shoulder (`ShotPlanner`: camera cuts and camera
  modes from the data, our rule otherwise); Henry turns to the NPC, the
  NPC stands and faces him; Backspace/Esc picks "(End dialog)" or
  "(Back)", the mouse and a click pick replies, a failing step ends the
  conversation. Tests: `test-dialogue-camera.ts`, new
  `test-dialogue-browser.ts`. Facial animation and lip sync wait for a
  research note (questions above).

- #37 (2026-11-01): replaced views no longer stay in memory, and reopening
  the world view keeps its objects (a bug live since #28: every object gone
  after reopening the view or going between Low and Medium). Potato
  benchmark's JS heap 3,133 → 1,801 MiB. `profile-browser.ts --reopen`.

- #30 (2026-10-31): diet mode: the quest state (`quests.ts`), the diet
  overlay and its setting, `test-diet.ts`.
- #33 (2026-10-31): diet checks scan only tree Roots and skip
  `ForestContainer` nodes, which never run.
- #36 (2026-11-11): behaviour-tree `SetQuest` and `SetQuestObjective`
  nodes and Lua's `QuestSystem` change the quest state through the
  overlay. The world view waits for the quest tables before starting the
  trees.

## Findings not yet acted on

- **The user's Mac benchmark (2026-10-31)** is in PERFORMANCE.md. It ran
  before far-tree culling, occlusion and the animation-memory fix, in a
  1154×648 window with vsync (Potato is capped by the display). Re-run it
  in the same window to compare.

- **Walk CPU on Medium (priority 5):** a CPU profile in the market
  (`profile-browser.ts --preset=medium`) puts 44% of the main thread in
  `writeBuffer` under the characters' shadow pass (`drawShadow` →
  `uploadPalettes`). Palettes are already shared per NPC (about 640 KiB a
  frame for 40 NPCs), so this is most likely `writeBuffer` waiting for the
  GPU process while Medium is GPU-bound, like `getCurrentTexture`: the GPU
  items (occlusion, the new Medium) should cut it. Real CPU costs left:
  `selectLods` 12%, NPC animation 7%, behaviour trees 4–8%, crowd 4%,
  route searches 2%.
- **World caches' positions and indices** (kept for collision and four
  builds): 16-bit indices would save about 64 MiB in a Potato scene, 85 on
  Medium, perhaps 140 after a flight (measured; PERFORMANCE.md), so low
  priority. Henry's animation database is 117 MiB.

## Clocks checked against the research notes (2026-10-31)

dialogue.md, bt-rules.md and quest-system.md (the calendar's clocks):

- **Dialogue cooldowns** (`timeout`) ran on world time (15×), so 300 s
  passed in 20 real seconds. Now play time (`simSeconds`: real time at
  game speed, stopped while paused). Timed topic menus count play time
  too (they counted real frames, also while paused).
- **Behaviour-tree Wait:** `infinite` and `oo` waited 0 s (now forever,
  like `-1`); a `#WT`/`#GT` suffix made the duration 0 (parsing now stops
  at `#`); a number without a unit was seconds (now milliseconds, see the
  research question above). Variation was already added only; GameTime
  1× and WorldTime 15× were already right.
- **Quest timers:** no quest code yet. `web/src/duration.ts` has the
  parser and `timerClock()` (`#WT` world, `#GT` or none play) ready for
  it, with tests.
- **Line types 2 and 4** were already skipped at playback; now tested.
- Tests: `test-btrun.ts` (Wait forms, units, variation, clocks, timer
  strings), `test-dialogue-flow.ts` (cooldowns in play seconds, line
  types).

