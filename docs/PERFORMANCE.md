# Performance

## Quality presets (`web/src/quality.ts`)

| Preset | Render scale | MSAA | Streaming radius | View distance × | LOD distance × | Terrain full detail | NPCs | Texture size |
|---|---|---|---|---|---|---|---|---|
| Potato | 0.5 | off | 200 m | 0.45 | 0.5 | 100 m | 8 | 128 |
| Low | 0.75 | off | 300 m | 0.65 | 0.7 | 160 m | 16 | 256 |
| Medium | 1 | 4× | 500 m | 1 | 1 | 250 m | 40 | 256 |
| High | 1 | 4× | 700 m | 1.4 | 1.3 | 350 m | 60 | 512 |

**Shadows and terrain detail by preset:**

| Preset | Sun shadows | Terrain detail |
|---|---|---|
| Potato | off | 256 px, fades at 25–80 m |
| Low | 1 cascade, 1024², to 40 m | 256 px, fades at 35–120 m |
| Medium | 2 cascades, 2048², to 20 / 120 m | 512 px, fades at 40–160 m |
| High | 2 cascades, 3072², to 25 / 160 m | 512 px, fades at 60–220 m |

The world view has a preset menu (saved per browser) and an fps counter in
its HUD.

## Measured frame rates (2026-10-20, after the draw and CPU work below)

From `scripts/bench-presets.ts`.

**Setup:**
- Headless Dawn, 1920×1080 output scaled by the preset.
- **Market:** Henry runs in first person through Rataje's market at noon,
  with NPCs, collision and the sky.
- **Fields:** a run north across the fields towards the town.
- **Timing:** each frame from the start of its CPU work until the GPU has
  finished, so CPU and GPU time add up. A browser overlaps them, so these are
  pessimistic. Nothing is presented to a screen.

| GPU | Preset | Market fps (p95 frame) | Fields fps (p95 frame) | Market before |
|---|---|---|---|---|
| RTX 5070 Ti | Potato | 325 (4.1 ms) | 1,104 (1.0 ms) | 136 |
| RTX 5070 Ti | Low | 198 (7.0 ms) | 840 (1.4 ms) | 81 |
| RTX 5070 Ti | Medium | 111 (12.1 ms) | 404 (4.1 ms) | 29 |
| RTX 5070 Ti | High | 75 (16.2 ms) | 242 (6.8 ms) | 32 |
| Radeon iGPU (Ryzen 9 9900X, 2 CU RDNA2) | Potato | 84 (14.8 ms) | 338 (4.6 ms) | 62 |
| Radeon iGPU | Low | 52 (22.5 ms) | 195 (7.3 ms) | 39 |
| Radeon iGPU | Medium | 24 (40.8 ms) | 64 (18.6 ms) | 19 |
| Radeon iGPU | High | 21 (48.7 ms) | 28 (33.5 ms) | 15 |

**The integrated Radeon is not the Vega 7 target.** It has 2 compute units
against the Vega 7's 7. It is a pessimistic stand-in for the low-end laptop,
not a measurement of it.

In Chromium on the dev machine, High in the market ran at about 40 fps before
these changes; the headless figure then was 32.

## Where a market frame goes

Medium, RTX 5070 Ti. The benchmark prints this split per run.

| Phase | Before | After |
|---|---|---|
| Recording draws (2,500 non-empty, 10,000 registered) | 12.3 ms | 3.4 ms |
| LOD selection and instance upload | 6.1 ms | 1.2 ms |
| NPC crowd and animation (40 NPCs) | 5.9 ms | 2.6–3.4 ms |
| GPU | 4.2 ms | 1.4–2.1 ms |

What changed:

1. **Indirect draws in render bundles** (`ModelRenderer`, when the device has
   `indirect-first-instance`).
   - Each item (a model at one LOD) is recorded once into a bundle of
     `drawIndexedIndirect` calls.
   - Per frame:
     - every visible instance is packed into one buffer;
     - every draw's instance count and first instance go into one argument
       buffer;
     - only the bundles of items with instances run.
   - Renders are pixel-identical to the per-call path, which stays as the
     fallback.
2. **LOD selection** copies instance matrices by hand. A `subarray` per
   instance kept the garbage collector busy.
3. **NPC poses** update every frame within 25 m, every 2nd frame to 50 m, and
   every 4th beyond. NPCs still move every frame.

## Shadows (2026-10-20)

Sun shadows (`shadow.ts`, `shadowPass.ts`):

- **Cascades:** cascaded maps, snapped to texels.
- **Casters:** they get their own LOD pass against each cascade's light
  frustum:
  - half the LOD distance;
  - limited to the shadow distance;
  - none smaller than 0.25 m in the near cascade, or 1 m in the far one.
- **Drawing:** each ModelRenderer gains a depth-only view per cascade
  (alpha-tested leaves), with its own render bundles.
- **Far cascade:** redrawn every second frame.
- **First person:** Henry's head is left out of the camera view but kept in
  the shadow passes.
- **Receivers:** models and terrain use 3×3 PCF.

Cost in the market, fps without → with shadows:

| GPU | Low | Medium | High |
|---|---|---|---|
| RTX 5070 Ti | 198 → 129 | 111 → 61 | 75 → 49 |
| Radeon iGPU | 52 → 31 | 24 → 12 | 21 → 8 |

On weak GPUs shadows are the most expensive feature; Potato keeps them off.

**Comparing runs.** Absolute figures vary between sessions by up to 25%
(machine load, clocks; a browser running the game at the same time). The
same code measured 61 fps in one session and 47 in a later one. Compare
changes only by A/B in the same session. Normal maps measured this way cost
nothing visible: 47 fps with them and without, Medium, market.

## Next

- **The iGPU in the market is now GPU-bound:** 3M triangles even on Potato.
  - Shorter LOD distances on Potato and Low.
  - Small-object culling by screen size.
  - Proper impostors for far vegetation.
- **NPC animation is the largest CPU cost left:** bone evaluation and
  palette upload per NPC.
- **Measure on the real Vega 7 laptop,** in Chrome (Vulkan on).

## Grass (merged-mesh sectors)

Headless, `scripts/bench-presets.ts` (`NO_GRASS=1` for the comparison):

| GPU | Preset | Scene | Without grass | With grass |
|---|---|---|---:|---:|
| RTX 5070 Ti | Medium | fields | 241 fps | 224 fps |
| RTX 5070 Ti | Medium | market | 52 fps | 53 fps |
| Integrated Radeon (2 CU) | Potato | fields | 272 fps | 218 fps |
| Integrated Radeon (2 CU) | Potato | market | 65 fps | 67 fps |

Alpha to coverage on alpha-tested materials (with MSAA) costs about 5%
(Medium market 55 → 52 fps).
