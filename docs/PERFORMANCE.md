# Performance

## Quality presets (`web/src/quality.ts`)

| Preset | Render scale | MSAA | Streaming radius | View distance × | LOD distance × | Terrain full detail | NPCs | Texture size |
|---|---|---|---|---|---|---|---|---|
| Potato | 0.5 | off | 200 m | 0.45 | 0.5 | 100 m | 8 | 128 |
| Low | 0.75 | off | 300 m | 0.65 | 0.7 | 160 m | 16 | 256 |
| Medium | 1 | 4× | 500 m | 1 | 1 | 250 m | 40 | 256 |
| High | 1 | 4× | 700 m | 1.4 | 1.3 | 350 m | 60 | 512 |

The world view has a preset menu (saved per browser) and an fps counter in
its HUD.

## Measured frame rates (2026-10-19)

From `scripts/bench-presets.ts`.

**Setup:**
- Headless Dawn, 1920×1080 output scaled by the preset.
- **Market:** Henry runs in first person through Rataje's market at noon,
  with NPCs, collision and the sky.
- **Fields:** a run north across the fields towards the town.
- **Timing:** each frame from the start of its CPU work until the GPU has
  finished, so CPU and GPU time add up. A browser overlaps them, so these are
  pessimistic. Nothing is presented to a screen.

| GPU | Preset | Market fps (p95 frame) | Fields fps (p95 frame) | Market draw calls |
|---|---|---|---|---|
| RTX 5070 Ti | Potato | 136 (8.8 ms) | 669 (1.8 ms) | 1,366 |
| RTX 5070 Ti | Low | 81 (14.4 ms) | 412 (2.7 ms) | 1,874 |
| RTX 5070 Ti | Medium | 29 (38.5 ms) | 185 (5.8 ms) | 2,524 |
| RTX 5070 Ti | High | 32 (33.5 ms) | 107 (10.1 ms) | 3,084 |
| Radeon iGPU (Ryzen 9 9900X, 2 CU RDNA2) | Potato | 62 (19.8 ms) | 267 (4.5 ms) | |
| Radeon iGPU | Low | 39 (29.8 ms) | 157 (7.0 ms) | |
| Radeon iGPU | Medium | 19 (52.3 ms) | 53 (21.0 ms) | |
| Radeon iGPU | High | 15 (67.7 ms) | 25 (38.1 ms) | |

**Reading the results:**
- **The integrated Radeon is not the Vega 7 target.** It has 2 compute units
  against the Vega 7's 7. It is a pessimistic stand-in for the low-end
  laptop, not a measurement of it.
- **The town is CPU-bound.** On the RTX 5070 Ti, Medium and High run at the
  same rate in the market and High is not slower; the fields run 6× faster.
  The CPU profile's top per-frame cost is recording draws
  (`ModelRenderer.draw`), followed by LOD selection, instance uploads and NPC
  animation.
- **Next steps for the town:**
  - render bundles or instancing across subsets;
  - culling before upload;
  - NPC animation at a lower rate when far away.
- **Measure in Chromium** as well: real presentation, and CPU and GPU overlap.
