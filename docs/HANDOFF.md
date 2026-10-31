# Handoff

Where the work stands, so any new session can pick it up. Updated after
every merged pull request. The plan is in [ROADMAP.md](ROADMAP.md); this
file is the short list of what is next, what waits for the user, and what
waits for a research session.

## Now (2026-10-30)

- **Development moved to a MacBook Pro (Apple M3 Pro, 24 GB).** Chrome on
  macOS runs WebGPU on Metal with no flags; the headless Chrome harnesses
  find it there (`web/scripts/chrome.ts`). Benchmarks from this machine are
  **M3 Pro numbers**, not the RTX 5070 Ti's or the Vega 7's
  ([PERFORMANCE.md](PERFORMANCE.md)).
- **Priority (the user's list of 2026-10-31):** 1. JS heap (find what holds
  it, cut it; per-category breakdown in the report); 2. 1% lows; 3. occlusion
  culling (a separate session: branch `occlusion`, worktree
  `~/kcd-web-occlusion`); 4. the new Medium: no MSAA, upscaling with dynamic
  resolution; 5. CPU in the walk segment; 6. far trees cheaper on low
  presets (done: culled by cell, Potato 1.18 → 0.55 ms). Earlier order, for reference:
  1. RAM. The JS heap is real (array buffers, not garbage): see
     PERFORMANCE.md "Is the JS heap real?". Animation databases no longer
     all kept (−818 MiB of buffers on Potato). Target from the user:
     Potato under 2 GiB for the tab, Medium under 3 GiB. Geometry stores halved (44-byte vertices, chunks grown from
     4 MiB: Potato GPU 2.6 → 1.3 GiB). Left: the world store's
     fragmentation (holds up to twice what it uses); the CPU copies of
     meshes in the world caches (765 MiB on Potato), kept for three
     rebuilds so models can be uploaded again (dropping them needs the GPU
     geometry kept as long, or reloading); the JS heap (5.1 GiB on Potato
     in Chrome 143 here).
  2. Streaming stalls. One work budget per frame (`frameBudget.ts`): long
     frames in a flight 140 → 95, loading 13 → 11 s. Left: garbage
     collection, `selectLods` per frame, main-thread inflates, GPU uploads.
     New background work should `await workSlice()` between pieces.
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

- **The Mac benchmark output (2026-10-31).** The message that asked to
  record it held the placeholder "[paste the benchmark output here]"
  instead of the report. Only the figures quoted with it are recorded in
  PERFORMANCE.md; paste the report (the ⏱ Benchmark button copies it) to
  record it in full.

## Questions for a research session

- **Durations without a unit** (bt-rules.md, Wait): 11 Waits write
  `"500"` or `"200"` beside the usual `"500ms"`. We read them as
  milliseconds, the parser's base unit (marked ASSUMPTION in
  `duration.ts`). Is that right? And when a Wait's duration comes from a
  variable holding a number, which unit applies?
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

## Findings not yet acted on

- **Walk CPU on Medium (priority 5):** a CPU profile in the market
  (`profile-browser.ts --preset=medium`) puts 44% of the main thread in
  `writeBuffer` under the characters' shadow pass (`drawShadow` →
  `uploadPalettes`). Palettes are already shared per NPC (about 640 KiB a
  frame for 40 NPCs), so this is most likely `writeBuffer` waiting for the
  GPU process while Medium is GPU-bound, like `getCurrentTexture`: the GPU
  items (occlusion, the new Medium) should cut it. Real CPU costs left:
  `selectLods` 12%, NPC animation 7%, behaviour trees 4–8%, crowd 4%,
  route searches 2%.
- **World models' CPU copies** (1.5 GiB on Potato after a flight): see
  PERFORMANCE.md "Is the JS heap real?" for what was tried.

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

