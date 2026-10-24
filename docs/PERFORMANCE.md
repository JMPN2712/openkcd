# Performance

## Quality presets (`web/src/quality.ts`)

| Preset | Render scale | MSAA | Streaming radius | View distance × | LOD distance × | Terrain full detail | NPCs | Textures: first load → streamed up to | Texture memory |
|---|---|---|---|---|---|---|---|---|---|
| Potato | 0.5 | off | 200 m | 0.45 | 0.5 | 100 m | 8 | 128 → 512 | 256 MiB |
| Low | 0.75 | off | 300 m | 0.65 | 0.7 | 160 m | 16 | 256 → 1024 | 640 MiB |
| Medium | 1 | 4× | 500 m | 1 | 1 | 250 m | 40 | 256 → 1024 | 1 GiB |
| High | 1 | 4× | 700 m | 1.4 | 1.3 | 350 m | 60 | 512 → 2048 | 2 GiB |

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

## Texture streaming (2026-10-21)

Before this, every object texture was capped at the preset's size (128 px on Potato, 256 on
Medium, 512 on High), whatever its distance: close-up walls and barrels were smeared. Each
streaming rebuild also uploaded every texture again (each `ModelRenderer.setModels` made its own
copies, 418 MiB in the market on Medium).

`web/src/texturePool.ts` now holds one GPU texture per texture file, shared by the object, grass,
NPC, player and far-field renderers and kept across rebuilds:

- **First load small.** Models load their textures at the preset's first size, as before.
- **Requests.** Every 8th frame each renderer works out, for each visible draw, the distance to
  the nearest instance's bounding sphere. The texture size it asks for is screen pixels per metre
  ÷ UV units per metre: the mesh's UV density, measured once per subset.
  Sizes round to the nearest power of two.
- **Growing.** Only the new top mips are read (with the header the first load opened); the lower
  ones are copied on the GPU.
- **Shrinking.** Only under memory pressure, and only textures held at 4× or more what they need,
  each in one GPU copy. Unused textures are evicted first.
- **Budget.** Loads reserve their bytes when they start. Without that, eight loads at a time each
  fit the budget on their own, most were thrown away when they finished, and the market kept
  loading forever.
- **Applying.** Finished loads go in at the start of a frame, about four times a second together.
  The renderers rebuild the bind groups of the draws using a replaced texture and re-record those
  items' bundles before anything is drawn.
- **CPU copies dropped.** Once a texture is on the GPU, the cached chain's data is freed (about
  400 MB at Medium). A texture evicted and then used again (a preset change brings the model
  cache back without texture data) starts as a 1×1 stand-in. Stand-ins load up to 64 at a time;
  at the normal rate, thousands of them took over 9 s.
- **Off the main thread.** Pak reads of 32 KB or more (models and textures) inflate on worker
  threads (`readWorkers.ts`): 1 to 4 in the browser, one per spare core.

**Measured** (RTX 5070 Ti, headless; the textures settle before the run, which then keeps
streaming as Henry runs):

| Preset | Scene | Without the pool | With it | Textures held |
|---|---|---:|---:|---|
| Medium | fields | 184–204 fps | 164 fps | 514 at 1024, 831 MiB of 1 GiB, no shrinks |
| Medium | market | 48–56 fps | 41 fps | 505 at 1024, 801 MiB of 1 GiB, no shrinks |
| Medium with a 2048 cap (dropped) | market | 56 fps | 43 fps | at its 1 GiB budget, shrinking as it ran |
| High | fields | 114 fps | 114 fps | 140 at 2048, 438 at 1024 |
| High | market | 41 fps | 36 fps | 1.6 of 2 GiB |
| Potato | market | 225–277 fps | 207–256 fps | 139 of 256 MiB, 376 at 512 |

- **Settling:** textures settle within 0.3–1.1 s of arriving somewhere.
- **The remaining cost is streaming activity,** not the pool. With the pool settled and no
  loads, Medium in the market ran at 55 fps against 48–52 without it. Each swap re-records the
  bundles of every item using that texture.
- **Medium's cap is 1024 px,** down from 2048: at 2048 it sat at its budget in the market and
  churned as Henry ran.
- `NO_POOL=1 node scripts/bench-presets.ts` compares; `scripts/test-texture-pool.ts` checks
  growing, shrinking (read back from the GPU) and the worker reads.

## Chrome: what limits the frame (2026-10-23)

Measured in Chrome itself (`scripts/profile-browser.ts`: headless Chrome on the RTX 5070 Ti,
High, Henry at the market spawn after streaming has settled; `--trace` adds Chrome's own trace).
Headless Dawn (`bench-presets.ts`) misses most of this: in Chrome every WebGPU call is serialised
to the GPU process, which decodes it and records Vulkan commands on its own main thread.

Both threads were saturated: the page's main thread at 99%, the GPU process's at 94%. The page's
`writeBuffer` calls were mostly waiting for the GPU process.

| Step | fps | page main thread per frame |
|---|---:|---:|
| Start (the user measured 43 fps and 22 ms here) | 50–56 | 16 ms |
| Behaviour trees ticked at 10 Hz, staggered (`npcAi.ts`) | 62 | 14.4 ms |
| NPC parts with the same bones share one palette; changed palettes go up in runs | 71 | 12.5 ms |
| Shadow views merge each mesh's opaque sub-meshes; the far cascade every 4th frame | 73 | 11.8 ms |
| One uniform buffer per renderer instead of one per draw | 88 | 9.9 ms |
| Mesh vertices and indices packed into shared 128 MiB buffers | 96 | 8.8 ms |

- **The GPU process's cost was the number of buffers, not draws.** Halving the shadow draws barely
  moved it; `Queue::Submit` stayed at 55% of its time. Chrome's WebGPU checks every buffer a pass
  uses on each submit (turning off Dawn's lazy clearing, a diagnostic flag only, jumped to 95
  fps). One uniform buffer per draw and a vertex and index buffer per mesh were tens of thousands
  of buffers.
- **Palettes:** an NPC's clothing parts mostly share one bone list (4× less data); before, each
  of 500-odd parts uploaded its own palette every frame.
- **Shadow draws** on High in the market: near cascade 901 → 412 world draws, far 2,535 → 1,392,
  NPCs 777 → 643 per cascade (`bench-presets.ts` prints the draws per view).
- **Left (8.8 ms):** `selectLods` 19%, `flush` 10% (instance packing), animation (`evaluateLayers`,
  `palette`) 14%, collision `ground` 5%. The GPU process is 87% busy.
- **Startup:** the view streams the free-fly start (2192, 1050) completely before Henry's spawn,
  about 100 s before the market is complete (headless, from `~/kcd1`).
- **Streaming hitch:** each streaming step rebuilds every model's GPU data (`setModels`, about
  2.7 s of main thread for 3,573 models).

## Instance clusters (2026-10-23)

Each model's instances are sorted along a Morton curve (8 m cells) when the scene is built, and
every run of 16 keeps a bounding sphere and its largest instance radius (`WorldModel.clusters`).
`selectLods` skips a whole run when it is out of reach or outside a frustum plane, and skips the
per-instance plane tests for a run inside every plane. The drawn set is unchanged (the market:
11,013 instances, same LODs). Medium, market, 107k instances in the scene: camera selection 0.92 →
0.68 ms, a shadow cascade's (120 m, radius ≥ 1 m) 0.60 → 0.32 ms.

The world view's HUD shows the main thread's time per frame next to the fps (`cpu … ms`): fps well
below 1000 / cpu means the GPU, not JavaScript, sets the frame rate.

## Next

- **Terrain detail layers** are still 256–512 px and blurry up close (the ground under Henry's
  feet); they aren't streamed.
- **Swap cost:** shared textures make one swap re-record hundreds of bundles; grouping draws by
  texture, or a texture array per format, would cut it.

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

## Roads, decals and far trees

Headless, 120 frames:

| GPU | Preset | Fields | Market |
|---|---|---:|---:|
| RTX 5070 Ti | Medium | 201 fps | 50 fps |
| RTX 5070 Ti | Potato | 759 fps | 268 fps |
| Integrated Radeon (2 CU) | Potato | 148 fps | 55 fps |
| Integrated Radeon (2 CU) | Medium | 24 fps | 10 fps |

Far trees cost 1.7 ms on the integrated Radeon (Potato fields: 200 fps
without, 148 with): 293k cards go through the vertex shader every frame.
Culling them per map cell would cut that if the Vega 7 needs it.
