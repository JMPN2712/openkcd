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
- **Priority: the Vega 7 performance work**, in this order:
  1. RAM: geometry stores (2.3 GiB even on Potato), CPU copies of meshes
     kept after upload (773 MiB).
  2. Streaming stalls (1% lows of 1.4–14.5 fps during the benchmark flight).
  3. Occlusion culling from `notes/interiors-visibility.md` (coverage
     buffer from reprojected depth plus `occluder.ocm`).
  4. Upscaling (render below the canvas size, upscale with sharpening).
  5. The new Medium: the console profile from `notes/graphics-settings.md`
     §6 and §10 (Medium groups, items at half view distance, 900p-like).
- **Then** the rest of milestone 4 (ROADMAP section 4).

## Waiting for me (the user)

- Nothing yet.

## Questions for a research session

- Nothing new yet. Open ones are listed in ROADMAP section 4 ("Research
  note needed").

## Log of merged pull requests

- (none since the move)
