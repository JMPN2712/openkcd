# Handoff

Where the work stands, so any new session can pick it up. Updated after
every merged pull request. The plan is in [ROADMAP.md](ROADMAP.md); this
file is the short list of what is next, what waits for the user, and what
waits for a research session.

## Now (2026-11-13, back on the Linux PC)

Development is on the Linux PC again (RTX 5070 Ti, Ryzen 9 9900X; CLAUDE.md
"Hardware targets"). The move from the Mac is done: the checkout is on
`main`, `npm ci` is done, the headless suites pass, and headless Chrome
runs WebGPU on the RTX 5070 Ti through Vulkan (`profile-browser.ts
--preset=potato --bench=this`: 478 fps average, 1% low 77, at 960×540).
The NPC-messaging work that had been left uncommitted on this machine
since 2026-10-25 is merged (#40).

The session of 2026-11-14 ran on the MacBook Pro again (its checkout is
current with `main`; both machines work). Numbers from it are M3 Pro
numbers.

**The user's priorities (2026-11-13), in order:**

1. **The quest runtime**: quest nodes in the trees, Lua's quest API and
   shops, all through `QuestSystem`. Target: the opening of the main quest
   plays through with diet mode on.
2. **Combat** from `notes/combat-melee.md`, `combat-damage.md`,
   `combat-ai.md`. Target: a fight with a bandit that feels like the
   original.
3. **Streaming stalls** (the 1% lows), if still open.
4. **Open dialogue bugs** (camera framing, Henry's shots, leaving
   conversations, facial animation).

**Where priority 1 stands** (GAMELOGIC.md, "The quests' own trees"): every
quest tree diet mode keeps runs headless, and a new game plays up to the
errands of the opening quest: `q_master_main` → `q_skalitz` activated → the
cutscene automaton → the quest started → Henry's mother runs her quest
patch and asks for the first conversation, which plays through the
dialogue flow → Henry talks to his father → `buyCharcoal`, `getDebtMoney`,
`getCrossguard` and `collectBeer` start. Objectives that track items wait
for a stand-in inventory. `node scripts/test-quest-opening.ts`.

**Next steps for it, in order** (1 and 2 are done headless, 2026-11-14):

1. Done: quest patches (`AiWorld.startObjectBehaviour`, the daily cycle's
   `"patch"` target), `SmartAreaBehaviorTag`.
2. Done headless: `RequestDialog` / `DoDialog` and `DialogRequests`
   (`dialogRequests.ts`). **Left:** the world view's dialogue
   (`dialogueView.ts`) must take the waiting request
   (`requests.next(true)`), start that conversation with the requested
   topic, and call `begin` / `end`; `playerInDialog` should also be true in
   conversations the player starts.
3. **Start the quest trees in the world view** (`QuestBrains` in
   `levelView.ts`, with the layer entities from `profiles.ts` and a "New
   game" control). Today only the quest reads are wired there. Watch the
   memory: the layer files add 29,307 entities.
4. **Profiles to the scene:** show and hide a profile's layers when
   `EnableProfile` switches it (`WorldOptions.profile`), in place of
   `defaultHiddenLayers`' guess.
5. **Quest state the opening needs:** objective timers (`duration.ts` has
   the parser), rewards, and a real player inventory behind
   `QuestSystem.world.itemCount` (tracked assets are read through
   `QuestSystem.world`; call `recheck()` when the inventory, the player's
   place or who is alive changes). Place assets need `world.playerAt`.
6. **Shops** (`notes/economy.md`): buying the charcoal is an objective of
   the opening quest; then diet mode's shop grants.
7. Lua's remaining `QuestSystem` functions (`GetActiveObjectives`, …) and
   the calendar functions the scripts call (`forwardTime` fails today).

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

- **The Mac benchmark rerun** asked for on 2026-10-31 no longer applies as
  written. If the 1% lows still matter on this PC, run the ⏱ Benchmark in
  your own Chrome here (X11, Vulkan): the report's "GPU frames" line tells
  whether the lows are the GPU's slow frames.
- **Five quest trees end early** in the headless run (`q_plagueInMerhojed`,
  `q_night_rescue`, `q_huntPtacek`, `q_questItems`, `q_devilplay`;
  `q_millerDate` no longer does). Not a decision for you yet; being looked
  into.

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

**Next steps, in order** (1 and 2 are done, #41; see "Now" above for what
follows them):
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

- **Conversations asked for by trees** (dialogue.md gives `RequestDialog`'s
  fields only; `btWorld.ts`, `dialogRequests.ts`):
  1. What `RequestDialog` returns when the conversation can't start, and
     what `DoDialog` returns (we: success when the conversation ended,
     failure when it never started).
  2. The `dialogModule:onDialog` messages in `DialogMailbox` that
     `final/dialogUtils.xml#dialogInitiator_instant` reads after `DoDialog`
     (`reqId`, and which states): we send none.
  3. Who waits for whom: does a request with the player start at once
     (`bruteForceDialogOnPlayer`), or when the player is near or free?
- **`SmartAreaBehaviorTag`** (`smartArea`, `preferredBehaviors`,
  `forbiddenBehaviors`, `preferredBehaviorsOnly`, `stopAfterFirstFound`):
  we run the first preferred behaviour the area's template offers. How
  does the game choose, and what does it return?
- **Tracked assets** (quest-system.md, "Automatic completion"):
  1. The note gives `quest_asset.type` 1 = place, 3 = item; in the data
     type 1 assets are in `quest_item` and type 3 in `quest_place` (we go by
     the table that holds the asset). Please check the note.
  2. NPC assets: we count the NPC's deaths (the objectives are named
     "…IsDead", "kill…"). Is that the NPC event, and what is "a meeting"?
  3. Place assets (`isHenryThere`, count 1, never completed by a tree): we
     count the player being at the place's entity. What is the real test
     (inside the area, a distance), and when is it checked?
  4. Assets given by item category, soul class or faction: what counts?
- **Behaviour-tree nodes the quest trees use, implemented from the data
  with ASSUMPTIONs** (`btWorld.ts`, `btRuntime.ts`; bt-rules.md covers
  loops, locks and Wait only):
  1. `Switch` when no branch's condition holds and there is no
     `DefaultBranch`: success or failure? (We succeed when the conditions
     have `failOnCondition` false; `q_master_main`'s message loop would end
     otherwise.) And does a `ProcessMessage` return its handler's failure?
  2. Gates (`QuestObjectiveGate`, `ProfileLoadedGate`, `DistanceGate`,
     `DialogGate`, `DeadUnconsciousGate`, …): what `RunLogic` Halt and
     KeepRunning do when the gate closes under a running child, and what
     the gate returns when its child ends.
  3. `AreaPresence`: `ReportInitialState`, `Once`, `Atomic`, and whether
     someone already inside when the watch starts counts as entering.
  4. `DistanceGate` / `DistanceCondition`: `Low`, `High`, `OpenInMiddle`.
  5. Level profiles: when `ProfileLoadedGate` opens after `EnableProfile`
     (we open it at once), what `ProfileCanBeLoaded` checks, and what
     `HasNavigation` and the profile groups do.
  6. Messages to the player: the player's brain (`player.xml`) handles
     `instruction:request`, `player:preventCombatRequest`,
     `player:holsterWeapon`. We acknowledge them at once. Which of them
     change something the game needs?
  7. Nodes not implemented, reached by the quest trees at start-up:
     `NPCStateGate`, `ReadinessWait`, `FinishInitialization`,
     `SetGlobalVar`, `DisablePerception`, the graph filters `ExistPath`
     and `Gen2SoulIsAliveFilter`.
  8. `PlaySequence` (`cleanupScene`, `freezeGame`, `checkpoints`) and
     `PlayVideo`: what they return when skipped or missing.

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

- #40 (2026-11-13): NPC messaging (`mail.ts`): mailboxes and routing,
  area brains, garrison posts, a shop's merchant and customer. Written on
  2026-10-25 on the Linux PC, merged after the move back.
- #41 (2026-11-13): the quests' own trees (`questTrees.ts`), the trees'
  quest reads and gates, level profiles from the level data
  (`profiles.ts`), stand-ins for the cutscene automaton's nodes. A new
  game reaches the opening quest's first conversation headless
  (`test-quest-opening.ts`).
  Merged on 2026-11-14 after the browser check on the Mac
  (`profile-browser.ts --preset=potato --at=2524,546 --talk=rat_tailor
  --pick=3`: the conversation plays and ends, JS memory as on main).
- 2026-11-14: CLAUDE.md's commit trailer names the model running the
  session, not a fixed model.

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

