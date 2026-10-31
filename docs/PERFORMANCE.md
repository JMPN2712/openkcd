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

## The low-end target: measuring (2026-10-26)

**Report from the Vega 7 laptop** (16 GB shared with graphics, hosted player):
Potato a locked 60 fps, Low 40–60, Medium about 10 (at most 20), the HUD's
CPU time about 9 ms: the GPU is the limit. Goal: Medium at 60, less memory.

**Tools added:**
- `gpuTimer.ts`: GPU time per render pass from timestamp queries, in the HUD
  and in `bench-presets.ts`. With G (or while benchmarking) the opaque pass is
  split by what it draws: sky+terrain, roads+decals, objects, grass, far
  trees, characters. Splitting costs little (Low in Dawn: 32.5 ms in one
  pass, 34.3 split).
- `gpuMemory.ts`: GPU memory by kind (buffers, textures, render targets),
  counted from the device's create calls; `?gpu-mem` adds the creating
  function, and the typed arrays each part of the view holds.
- The ⏱ Benchmark button (`benchmark.ts`): a 78 s flight over Rataje (river,
  fields, back) then a walk through the market, per preset, from a fresh view
  each; fps (average, 1% low), CPU and GPU ms per pass, adapter and driver,
  render size, memory; copied to the clipboard.
  `profile-browser.ts --bench` runs it in headless Chrome.
- `bench-presets.ts --ablate low`: Medium with each setting set to Low's,
  one at a time; `--with JSON` changes settings. `?preset-with=JSON` does the
  same in the browser.
- `scripts/triangles.ts`: triangles per model, kind and LOD in a view.

**Chrome on the 2-CU integrated Radeon** (only the AMD Vulkan driver visible
to Chrome; with the NVIDIA one too, `force-low-power` lost the device sharing
the canvas between the GPUs), the in-app benchmark, 1920×1080 window:

| Preset | Render size | fps | 1% low | GPU ms | sky+terrain | roads+decals | objects | far trees | characters | shadows |
|---|---|---|---|---|---|---|---|---|---|---|
| Potato | 960×540 | 122 | 14.5 | 8.1 | 2.1 | 0.9 | 3.2 | 1.2 | 0.5 | – |
| Low | 1440×810 | 60 | 4.8 | 17.4 | 4.2 | 1.6 | 6.6 | 1.6 | 1.0 | 1.7 |
| Medium | 1920×1080, 4× MSAA | 13.3 | 1.4 | 70.3 | 10.7 | 4.4 | 37.7 | 2.0 | 2.6 | 10.1 |
| High | 1920×1080, 4× MSAA | 9.0 | 1.0 | 108.9 | 13.6 | 6.2 | 53.4 | 1.3 | 4.6 | 25.8 |

This matches the Vega 7 report closely (Low 40–60, Medium 10–20), so the
iGPU in Chrome stands in for the laptop. The HUD's CPU time is inflated when
the GPU is behind (`getCurrentTexture` waits): 68 ms on Medium here.

**Medium with one change, same run** (fps, GPU ms):

| Change | fps | GPU ms |
|---|---|---|
| none | 13.3 | 70 |
| MSAA off | 17.0 | 56 |
| render scale 0.75 | 17.0 | 54 |
| Low's shadows (1 cascade, 1024², 40 m) | 14.8 | 64 |
| Low's geometry (stream 300 m, view ×0.65, LOD ×0.7, 16 NPCs, terrain LOD 160 m) | 23.9 | 40 |
| Low's texture budget (640 MiB) | 12.9 | 74 |

Headless Dawn (`bench-presets.ts --ablate low`, market) agrees on the order
(geometry, then resolution and MSAA, then shadows; grass, terrain detail and
textures nothing) but sees a smaller gap (Medium 76 ms, Low 34 ms).

**Why Medium costs 4× Low:** the objects pass (38 ms against 6.6) is limited
by geometry and draw count more than by pixels: 7.7M object triangles in the
market view at Medium in 2,100 draws (`triangles.ts`: rocks, bushes and firs
at LOD 1–2 lead, a long tail after; props inside houses count too, such as a
45k-triangle bookshelf, a 21k shelf). Resolution and MSAA each take about a
fifth of the frame, the shadow cascades a seventh. No single setting
explains it: they multiply.

**1% lows** are poor on every preset (Potato 14.5 fps, Medium 1.4) during
the flight: streaming steps stall frames on this machine.

**Regression:** the 2-CU iGPU in Dawn ran Low at 52 fps on 2026-10-20 and
runs it at 22 now (the market scene gained roads and decals, interiors,
normal maps on Low, water). Not yet traced.

**Memory (same runs, end of each):**

| Preset | JS heap (peak) | GPU | of which geometry buffers | textures (pool) | render targets |
|---|---|---|---|---|---|
| Potato | 3.5 GiB (3.9) | 2.6 GiB | 2.3 GiB | 314 MiB (215) | 26 MiB |
| Low | 3.7 GiB (4.4) | 3.0 GiB | 2.3 GiB | 735 MiB (636) | 36 MiB |
| Medium | 3.8 GiB (3.8) | 3.6 GiB | 2.6 GiB | 987 MiB (863) | 119 MiB |
| High | 4.1 GiB (4.8) | 4.8 GiB | 2.6 GiB | 2.1 GiB (2.0) | 159 MiB |

- **Geometry:** each of the five model renderers has its own vertex and
  index stores growing in 128 MiB chunks (`GEOMETRY_CHUNK`), so even Potato
  holds 2.3 GiB; vertices are 64 bytes.
- **JS:** of Potato's 3.5 GiB, typed arrays reachable from the view are
  about 1.1 GiB: the model caches 773 MiB (the CPU copies of meshes kept
  after upload), the schedules and navmesh 101 MiB, terrain, cover and
  objects about 140 MiB. The sampled heap of JS objects is 0.55 GiB
  (animation databases, zip directories, behaviour trees, tables). The rest
  is garbage not yet collected and memory outside these roots.

## Apple M3 Pro baseline (2026-10-30)

**These are Apple M3 Pro GPU numbers** (14-core GPU, 24 GB unified memory,
macOS, Chrome 143 headless on Metal), from the development machine since
2026-10-30. They are **not** RTX 5070 Ti or Vega 7 numbers; compare changes
only against other runs on this machine. `profile-browser.ts --bench
--query=gpu-mem`, 1920×1080, the game read from `~/kcd1`:

| Preset | Render size | fps | 1% low | CPU ms | GPU ms | sky+terrain | roads+decals | objects | grass | far trees | characters | shadows |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Potato | 960×540 | 297.4 | 24.0 | 1.8 | 3.8 | 0.3 | 0.3 | 1.2 | 0.5 | 1.2 | 0.2 | – |
| Low | 1440×810 | 196.2 | 17.8 | 3.1 | 6.8 | 0.7 | 0.6 | 1.8 | 0.9 | 1.5 | 0.4 | 0.7 |
| Medium | 1920×1080, 4× MSAA | 80.5 | 7.6 | 8.2 | 24.1 | 1.7 | 2.3 | 7.2 | 3.1 | 3.3 | 2.3 | 2.1 |
| High | 1920×1080, 4× MSAA | 56.9 | 5.7 | 12.9 | 30.2 | 2.7 | 3.1 | 11.2 | 2.9 | 3.1 | 2.2 | 3.6 |

| Preset | JS heap (peak) | GPU | geometry buffers | textures (pool) | world caches (typed arrays) | loaded in |
|---|---|---|---|---|---|---|
| Potato | 5.1 GiB (5.3) | 2.6 GiB | 2.3 GiB | 326 MiB (226) | 765 MiB | 16 s |
| Low | 5.4 GiB (5.5) | 3.1 GiB | 2.4 GiB | 738 MiB (639) | 959 MiB | 21 s |
| Medium | 5.7 GiB (5.7) | 3.8 GiB | 2.5 GiB | 1.1 GiB (1023) | 1.1 GiB | 28 s |
| High | 5.9 GiB (6.0) | 5.1 GiB | 2.8 GiB | 2.1 GiB (2047) | 1.3 GiB | 38 s |

- The 1% lows (5.7–24 fps) are the streaming stalls seen on the 2-CU Radeon,
  on a far faster GPU: they are CPU-side.
- The JS heap is about 1.6 GiB above the 2026-10-26 Linux run on every
  preset (Chrome 143 here against 156 there; not yet traced).

### Geometry memory halved (2026-10-30, M3 Pro)

Two changes to the model renderers' vertex and index stores:

- **44-byte vertices instead of 64:** normals and tangents as 8-bit snorm
  (at most about 0.5° off) instead of float32; positions and UVs stay
  float32. Renders against the old layout: at most 0.005% of pixels off by
  more than 8 levels (`render-world.ts`, `render-model.ts`). Potato's world
  geometry in the market: 740 → 509 MiB of vertices.
- **Chunks grow from 4 MiB:** each store's next chunk is as large as what it
  already holds, up to 128 MiB. Before, every one of the ten stores (five
  renderers, vertices and indices) took a full 128 MiB chunk, even Henry's.

Same benchmark, before → after:

| Preset | fps | 1% low | GPU ms | GPU memory | of which buffers |
|---|---|---|---|---|---|
| Potato | 297.4 → 323.2 | 24.0 → 27.5 | 3.84 → 3.75 | 2671 → 1372 MiB | 2320 → 1020 MiB |
| Low | 196.2 → 210.7 | 17.8 → 19.9 | 6.77 → 6.36 | 3225 → 1937 MiB | 2451 → 1163 MiB |
| Medium | 80.5 → 84.1 | 7.6 → 8.7 | 24.07 → 22.71 | 3853 → 2612 MiB | 2587 → 1347 MiB |
| High | 56.9 → 58.6 | 5.7 → 6.1 | 30.21 → 28.62 | 5182 → 3830 MiB | 2852 → 1502 MiB |

On the Vega 7 (16 GB shared with graphics) this is about 1.3 GiB more RAM
for everything else on every preset. The world store still holds up to
twice what it uses after a few streaming steps (fragmentation: a chunk is
only given back when empty).

### One work budget per frame (2026-10-31, M3 Pro)

Streaming stalls came from background tasks that each kept to their own few
milliseconds but ran in the same gap between two frames: geometry uploads
(`prepare`), model parsing, animation databases, an NPC's hidden-skin test
(up to 100 ms at once). `frameBudget.ts` gives them one shared budget: work
waits in `workSlice()` until the frame has room (4 ms after loading; while
the world and first NPCs load, when frames are capped at 66 ms anyway, most
of a frame), resumed one piece at a time in arrival order.

`profile-browser.ts --preset=potato --fly=60 --spikes` (a 60 s flight north-west, two
runs each):

| | frames over 25 ms | p99 | worst | world complete |
|---|---|---|---|---|
| before | 140, 149 | 18.8, 18.0 ms | 135, 125 ms | 13, 14 s |
| after | 95, 94 | 17.7, 15.5 ms | 129, 91 ms | 11, 11 s |

The in-app benchmark, interleaved before/after runs at one preset (another
Chrome was busy on the machine, so compare within each row only):

| Preset | before: fps, 1% low | after: fps, 1% low |
|---|---|---|
| Potato | 184.0, 11.3; 183.4, 10.7 | 210.2, 13.3; 212.4, 13.0 |
| Medium | 79.3, 7.5 | 85.0, 10.2; 87.5, 8.5 |

The Node streaming benchmark's longest slice per step went from 4.4–5.2 ms
to 1.1–2.0 ms. Left in the long frames: garbage collection, `selectLods` on
the frame itself, reads inflated on the main thread, and native time the
profile doesn't attribute (GPU uploads).

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
| Full window (1920×1080; the rows above used the page's 740×416 canvas) | 105 | 8.5 ms |
| World instances as 4-byte indices into matrices uploaded once per streaming step | 119 | 7.4 ms |

- **The GPU process's cost was the number of buffers, not draws.** Halving the shadow draws barely
  moved it; `Queue::Submit` stayed at 55% of its time. Chrome's WebGPU checks every buffer a pass
  uses on each submit (turning off Dawn's lazy clearing, a diagnostic flag only, jumped to 95
  fps). One uniform buffer per draw and a vertex and index buffer per mesh were tens of thousands
  of buffers.
- **Palettes:** an NPC's clothing parts mostly share one bone list (4× less data); before, each
  of 500-odd parts uploaded its own palette every frame.
- **Shadow draws** on High in the market: near cascade 901 → 412 world draws, far 2,535 → 1,392,
  NPCs 777 → 643 per cascade (`bench-presets.ts` prints the draws per view).
- **Instance indices** (`ModelRenderer` with `instanceIndices`, the world renderer only):
  `selectLods` writes one index per visible instance instead of copying its 16 floats, and the
  vertex shader (`vsIndexed`) reads the matrix from a storage buffer. Grass (its fade scales the
  matrices), NPCs, Henry and the far field keep per-frame matrices. `MATRICES=1` turns it off in
  `bench-presets.ts` and `render-player.ts`.
- **Left (7.4 ms):** `selectLods` 19%, `flush` 12%, animation (`evaluateLayers`, `palette`) 13%,
  collision `ground` 6%. The GPU process is 92% busy.
- **The player's own Chrome** measured 75 fps with 8–9 ms of main thread after the buffer
  changes, while headless at 1920×1080 measured 105: a display refresh cap or a larger window.
- **Startup** (fixed below): the view streamed the free-fly start (2192, 1050) completely before
  Henry's spawn.
- **Streaming hitch** (fixed below): each streaming step rebuilt every model's GPU data.

## Streaming steps (2026-10-23)

A streaming step (every 210 m on High) rebuilt the world renderer from scratch: every vertex of
every model encoded and uploaded again (1.1 GB on High in Rattay, 6,391 meshes), and 11,000 draws'
uniforms, textures and bind groups. `scripts/bench-streaming.ts` (headless, High, steps of 210 m
south-west from the market):

| | Before | After |
|---|---:|---:|
| Renderer rebuild, one frame | 2,000–2,600 ms | 31–102 ms |
| Geometry of new models (in slices of at most 6–17 ms, while the scene builds) | (in the rebuild) | 220–540 ms |
| First frame after it | 15–70 ms | 9–28 ms |

- **Kept geometry** (`geometryStore.ts`): meshes keep their ranges of the shared vertex and index
  buffers across rebuilds; a rebuild frees the ones it no longer uses (first fit, merged free
  ranges). Walking 8 steps out and back, the stores hold 1,536 MiB throughout (in use: 1,288 MiB
  in Rattay, 162 MiB in the countryside): they don't grow, but only release a chunk once it is
  empty. Compacting them is a follow-up if GPU memory gets tight.
- **Kept draws** (`modelDraws`): items without a transform, layer or skinning (the world, grass)
  keep their draws, bind groups, pooled textures and uniforms (in persistent slots) with their
  model; a rebuild only gives back the models it left out.
- **`ModelRenderer.prepare(items)`**, called by the world view before `setModels`, uploads new
  meshes and builds their draws a few milliseconds at a time, yielding between slices.
- **Collision** bins the scene's clusters (64 m cells) instead of every instance; a 4 m cell
  finds its instances when it is first needed.
- **Black screen (fixed the same day):** kept draws that `prepare()` built ahead of a rebuild were
  not rebound when the texture pool replaced one of their textures; once the rebuild drew them,
  every submit failed ("Destroyed texture … used in a submit") and the view went black. The
  renderer now indexes kept draws by texture too (`keptByTexture`). `profile-browser.ts --fly=120`
  (free-fly across the map) reproduced it within 10 s and runs clean now. The world view shows
  WebGPU errors and a lost device in its HUD (they were silent).
- **Frame spikes while moving** (`profile-browser.ts --fly=40 --spikes`: free-fly at 60 m/s, a
  streaming step every 3.5 s, frames over 25 ms and what ran in them): 129 → 74 long frames in
  40 s, p99 32 → 26 ms. Roads and decals are merged per 512 m tile (whole tiles), so a tile's
  merged mesh is the same at every step and keeps its geometry; merged over the whole radius,
  every step rebuilt and uploaded all of them on the main thread (the worst spikes, up to 258 ms).
  Road decoding and vertex encoding no longer allocate per vertex; `prepare` yields between
  meshes, not only models. Headless steps: geometry 465 → 256 ms in slices of at most 4–8 ms,
  rebuild 44–73 ms. Left in the long frames: the frame after a rebuild records every visible
  item's bundles again, and small pak reads on the main thread.
- **Per-frame and slice work** (same session, later): `flush` fills indirect arguments only for
  the drawn items' draws (it filled all 12,000 in each of three views every frame: 93 → 40 ms
  across the flight's long frames); `selectLods` skips whole models by a bound around their
  clusters; `prepare` yields until after the next frame (with `setTimeout(0)` the browser ran
  every ready slice and read before the next frame), uploads a large mesh 32,768 vertices at a
  time, and `uvDensity` samples at most 4,096 triangles. Headless steps: slices at most about
  5 ms. In Chrome (flight test, other browsers running): about 65–75 frames over 25 ms in 40 s,
  p99 23–27 ms, median 4–5 ms; the remaining long frames are loading work (model parsing, small
  pak reads) and ordinary frames. Small pak reads on the read workers too were worse (92–100
  long frames against 67–73): they queue behind the large ones and loads arrive in bursts.
- **Startup:** the free-fly camera starts above Henry's spawn, so the first streamed scene is the
  market: in Chrome from `~/kcd1`, the market is complete after 64 s instead of 95–125 s.
- Chrome at the market afterwards: 132 fps, main thread 6.7 ms (from 119 fps and 7.4 ms).

## Loading (2026-10-23)

`profile-browser.ts --load-profile`: a CPU profile from opening the world view until the market
is complete (Chrome, High, from `~/kcd1` through the folder input). The main thread is busy all
the way (0.5 s idle in 80 s): about 36 s of it is the game running at full speed meanwhile
(rendering, NPCs), and about 14 s was reading pak entries.

- **One slice per entry:** `readEntry` read the 30-byte local header and the data in two Blob
  slices; a load reads tens of thousands of entries, and `Blob.slice` alone was 11.5 s. It now
  reads the header (with room for the name and an extra field) and the data in one, and feeds
  the bytes straight to the `DecompressionStream` (wrapping them in a Blob cost another 6 s).
- **Market complete: 74 → 53 s.**
- **NPCs wait for the world:** loading NPCs, their behaviour trees, crowd and animation start once
  the first streamed scene is complete (they took about half the main thread while it loaded).
  **Market complete: 53 → 38 s**; the NPCs then assemble over the next 10–20 s. The HUD says
  so meanwhile. `profile-browser.ts` now waits for the NPCs too before measuring.
- The rest of the read cost (a slice per entry, 6 s) is what the region chunks of the compact
  format (milestone 2) remove: one read per area instead of thousands.

## Instance clusters (2026-10-23)

Each model's instances are sorted along a Morton curve (8 m cells) when the scene is built, and
every run of 16 keeps a bounding sphere and its largest instance radius (`WorldModel.clusters`).
`selectLods` skips a whole run when it is out of reach or outside a frustum plane, and skips the
per-instance plane tests for a run inside every plane. The drawn set is unchanged (the market:
11,013 instances, same LODs). Medium, market, 107k instances in the scene: camera selection 0.92 →
0.68 ms, a shadow cascade's (120 m, radius ≥ 1 m) 0.60 → 0.32 ms.

The world view's HUD shows the main thread's time per frame next to the fps (`cpu … ms`): fps well
below 1000 / cpu means the GPU, not JavaScript, sets the frame rate.

## NPC daily cycles (2026-10-25)

`scripts/sim-daycycle.ts`, headless Node on the Ryzen 9 9900X (CPU only, no
rendering): Rataje's market, 15 game minutes across the tailor's 18:31 change
(Potato's 8 NPCs) and 10 minutes from 19:00 with 60 shown (High's limit, the
full market). Behaviour trees tick at 10 Hz, staggered.

| Per frame (30 fps) | Potato, 8 NPCs | High, 60 NPCs |
|---|---:|---:|
| Behaviour trees | 0.12–0.14 ms | 0.55 ms |
| Crowd (collision avoidance) | 0.03–0.04 ms | 0.31 ms |
| Placement and animation | 0.40 ms | 1.82 ms |

- **NPC check, every 0.5 s** (selection over all 952 NPCs' daily cycles,
  then `updateAi`): median 3.8 ms on Potato, 4.2 ms with 60 shown.
  `bench-npcs.ts` at 10:00 (40 NPCs): 3.0 ms against 2.4 ms before the
  daily cycle.
- **The first check after loading creates every NPC's cycle and routes:**
  about 0.5 s without the hobby data and 1.0–1.3 s with it. That is one
  stall, after the world has loaded. The same first selection took 1.5 s
  before this change (routes for walks long finished are no longer
  searched). Spreading it over frames is a candidate for the Vega 7.
- Free-time searches are cached per settlement and hobby; containment
  tests check bounding boxes first.

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
