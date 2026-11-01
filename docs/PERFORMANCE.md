# Performance

## Quality presets (`web/src/quality.ts`)

| Preset | Render scale | MSAA | Streaming radius | View distance × | LOD distance × | Terrain full detail | NPCs | Textures: first load → streamed up to | Texture memory |
|---|---|---|---|---|---|---|---|---|---|
| Potato | 0.5 | off | 200 m | 0.45 | 0.5 | 100 m | 8 | 128 → 512 | 256 MiB |
| Low | 0.75 | off | 300 m | 0.65 | 0.7 | 160 m | 16 | 256 → 1024 | 640 MiB |
| Medium | 1 (dynamic 0.5–1, upscaled) | off | 500 m | 1 | 1 | 250 m | 40 | 256 → 1024 | 1 GiB |
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

### The user's benchmark on the Mac (2026-10-31)

The ⏱ Benchmark button in the user's own Chrome 143.0.7499.170 on this Mac
(Apple M3 Pro, Metal; a 1512×982 screen at 2×), the hosted player, report
of 2026-10-31 18:11 UTC. The figures place it after #18 (geometry buffers
1,148 MiB on Potato) and before #22 (far trees still 1.76 ms), so without
far-tree culling and occlusion; the JS heap matches the time before #21's
animation fix. **These are Apple M3 Pro numbers.**

| Preset | Render size | Segment | fps | 1% low | CPU ms |
|---|---|---|---|---|---|
| Potato | 577×324 | flight | 108.2 | 15.5 | 1.69 |
| Potato | | walk | 117.7 | 39.7 | 2.18 |
| Potato | | all | 112.7 | 20.5 | 1.93 |
| Low | 866×486 | flight | 96.7 | 11.0 | 2.64 |
| Low | | walk | 76.3 | 9.7 | 4.44 |
| Low | | all | 86.9 | 10.4 | 3.40 |
| Medium | 1154×648, 4× MSAA | flight | 80.8 | 8.8 | 4.07 |
| Medium | | walk | 51.9 | 10.6 | 7.37 |
| Medium | | all | 67.0 | 9.4 | 5.29 |
| High | 1154×648, 4× MSAA | flight | 47.1 | 3.2 | 7.36 |
| High | | walk | 35.3 | 3.1 | 10.98 |
| High | | all | 41.4 | 3.2 | 8.85 |

GPU ms per pass, whole run:

| Preset | GPU ms | sky+terrain | roads+decals | objects | grass | far trees | characters | blended+water | shadow 0 | shadow 1 |
|---|---|---|---|---|---|---|---|---|---|---|
| Potato | 6.30 | 0.35 | 0.35 | 2.34 | 1.00 | 1.76 | 0.34 | 0.17 | – | – |
| Low | 9.50 | 0.69 | 0.59 | 3.33 | 1.41 | 1.86 | 0.46 | 0.25 | 0.91 | – |
| Medium | 18.69 | 1.26 | 1.54 | 6.37 | 2.44 | 2.53 | 1.57 | 1.22 | 1.15 | 0.61 |
| High | 24.78 | 2.18 | 2.36 | 9.25 | 2.36 | 2.52 | 1.68 | 1.16 | 2.17 | 1.09 |

Memory at the end of each preset:

| Preset | JS heap (peak) | GPU (peak) | buffers | textures (pool) | render targets | loaded in |
|---|---|---|---|---|---|---|
| Potato | 6,734 MiB (6,818) | 1,440 MiB (1,440) | 1,148 MiB | 268 MiB (169) | 24 MiB | 12 s |
| Low | 7,144 MiB (7,285) | 1,868 MiB (1,879) | 1,171 MiB | 664 MiB (565) | 33 MiB | 17 s |
| Medium | 7,519 MiB (7,626) | 2,401 MiB (2,401) | 1,363 MiB | 960 MiB (835) | 78 MiB | 24 s |
| High | 8,198 MiB (8,319) | 3,525 MiB (3,525) | 1,565 MiB | 1,841 MiB (1,717) | 118 MiB | 29 s |

Against the headless runs on the same machine:

- **Render sizes are smaller.** The canvas is the window's size in CSS
  pixels (1154×648 for the full presets) without the 2× device pixel
  ratio; headless renders 1920×1080. Compare frame rates only between runs
  in the same window.
- **Potato and Low are capped by the display.** In a visible window Chrome
  waits for the display's refresh (about 120 Hz on this MacBook Pro), so
  Potato's 108–118 fps is a ceiling, not a GPU limit (6.3 ms of GPU). The
  headless runs turn vsync off.
- **The JS heap is higher here** (6.7–8.2 GiB against 3.8–5.9 headless):
  the presets run one after another in one page and the figure includes
  uncollected garbage; the headless memory report shows the real part
  (3.9 GiB on Potato after a forced collection, before #21).
- **1% lows of 3–11 fps** on every preset but Potato's walk: the stalls #19
  works on. Medium's walk spends 7.4 ms of CPU against 4.1 ms in the flight;
  a profile puts most of the walk's main thread in `writeBuffer` waiting
  for the GPU (HANDOFF.md).
- **Far trees** cost 1.76–2.53 ms here, before #22's culling.

### Is the JS heap real? (2026-10-31, M3 Pro, headless)

`profile-browser.ts --memory` (after loading, or with `--bench` after the
run) reports the page's heap, then after a forced collection, V8's own split
and each Chrome process's footprint; `--snapshot=FILE` saves a heap snapshot
and `scripts/heap-buffers.ts FILE` sums its array buffers by retaining path.

**It is real, and almost all array buffers:** Potato right after loading,
1.5 GiB (V8 objects 271 MiB, array buffers 1,256 MiB); after the benchmark,
3.9 GiB that a forced collection does not free (V8 objects 667 MiB, array
buffers 3,333 MiB). The renderer process's footprint was 5.0 GB, the GPU
process's 0.7 GB.

**What held the array buffers after the Potato benchmark** (2,980 MiB of
buffers of 4 KiB or more):

| Holder | MiB |
|---|---|
| NPC animation databases (`AnimLibrary`: every male `.dba`, read to index the aliases and kept) | 713 |
| world models' CPU mesh copies (world caches: tangents 384, positions 300, normals 300, indices 272, UVs 197, colours 18) | 1,471 |
| Henry's animation database (`PlayerAvatar.clips`) | 117 |
| navmesh | 91 |
| terrain (cover mosaics, heights, surface) | 91 |
| other | about 200 |

**Fixed:** `AnimLibrary` indexes the aliases from databases it doesn't keep,
keeps the 8 last used (clips are decoded into arrays of their own) and
caches the clips it resolves. Array buffers after the Potato benchmark:
2,980 → 2,162 MiB.

**Tried and dropped:** keeping world meshes' GPU geometry while they are
cached and dropping the CPU copies' normals, tangents, UVs and colours. The
CPU memory barely fell (the arrays stay reachable) while the kept geometry
tripled (637 → 1,970 MiB in `bench-streaming.ts --back`), which on these
machines is the same RAM.

**Next for memory:** Henry's database (117 MiB) holds every clip of his.

### World meshes' CPU copies dropped once uploaded (2026-10-31, M3 Pro)

The world caches kept every model of the last four scene builds whole, CPU
vertex data included, so a model could be uploaded again when it came back
into range: 1.6 GiB of buffers on Potato after the benchmark (tangents 433,
normals 337, positions 337, indices 272, UVs 222, colours 22). Now the
world renderer drops a mesh's normals, tangents, UVs and colours once its
geometry is on the GPU (`releaseVertexData` in `renderer.ts`). Positions
and indices stay: collision builds its shapes from them when Henry comes
near. A model whose geometry the renderer then lets go can't be uploaded
again, so `trimWorldCaches` forgets it at once (`ModelRenderer.holds`), and
it loads anew if it comes back. Models never uploaded keep the four-build
rule. `test-release.ts` checks it.

Unlike the attempt above, nothing stays on the GPU longer. It worked this
time because the arrays are actually let go. Positions and indices that are
views into a larger buffer (a compact-package entry) are copied out.

**Memory after the in-app benchmark** (interleaved with main;
`profile-browser.ts --bench=this --memory`):

| Preset | | page heap after a forced collection | array buffers | world caches (typed arrays) | HUD "JS" after loading |
|---|---|---|---|---|---|
| Potato | before | 3,017 MiB | 2,518 MiB | 772 MiB | |
| Potato | after | 2,310 MiB | 1,802 MiB | 396 MiB | |
| Medium | before | 4,019 MiB | 3,449 MiB | 1,101 MiB | 2,910 MiB |
| Medium | after | 2,893 MiB | 2,328 MiB | 594 MiB | 1,819 MiB |

Frame rates are unchanged: Potato 259.6 → 263.7 fps (1% low 27.0 → 28.3),
Medium 86.3 → 85.5 (10.1 → 9.6). The cost is reloading what comes back.
In `bench-streaming.ts --preset potato --back`, two runs each, the cached
models' meshes fall from 624–757 MiB to 282–389 MiB. On the walk back,
scene builds take 0.26–0.48 s instead of 0.04 s; that work runs in the
background, in the frame's work budget. Rebuilds, uploads and the frames
after them are unchanged.

What is left of the world caches is mostly positions (320 MiB) and indices
(256 MiB) of the last four builds. Indices could be 16-bit for most meshes.

### Far trees culled by cell (2026-10-31, M3 Pro)

Every far-tree card (293k) was drawn every frame, wherever the camera
looked. They are now grouped in 128 m cells; a frame draws only the cells
inside the view frustum, and on Potato and Low only within 2,000 m and
3,000 m (`farTrees` in `quality.ts`; Medium and High uncapped). The in-app
benchmark, interleaved runs, far-tree GPU time:

| Preset | before | after |
|---|---|---|
| Potato | 1.18 ms | 0.55 ms |
| Low | 1.37 ms | 0.90 ms |
### Occlusion culling (2026-10-31, M3 Pro)

From the research note `interiors-visibility.md`: the original hides house
interiors and what stands behind buildings with a small CPU depth buffer of
the level's occluder shells (`occluder.ocm`, `docs/LEVELS.md`) plus the
previous frame's reprojected depth. `occlusion.ts` does the first half:

- each frame the shells in view within 150 m, and not small on screen
  (bounding radius under 2% of the distance), are rasterised into a 128×64
  buffer of 1 / view depth (near-plane clipped, one winding of each
  double-sided face);
- shells whose box (grown by 1 m) holds the eye are left out: standing in a
  house, a market stall or one of the 256 m terrain tiles, a shell covers
  the whole view from inside (the first version culled nearly everything in
  town for that reason);
- `selectLods` (the camera's selection only; shadows keep theirs) skips a
  cluster or instance whose bounding sphere's screen rectangle, plus a
  pixel, is everywhere behind a nearer occluder (8×8 tile minima first).

Not done yet: reprojecting the previous frame's depth, the note's other
source.

**Correctness.** `render-world.ts --occlusion` in six views (the market at
street level and from above, the tailor's house, the fields, Rattay from the
south): the culled renders match the unculled ones (at most 3 levels on
single pixels). In the market at street level 11,000 drawn instances drop to
527.

**Cost.** Rasterising takes 0.2–0.7 ms of CPU a frame on the M3 Pro (steady
state, six views). In Chrome at the market spawn on Medium: 12,927 instances
hidden, 917 drawn.

**In-app benchmark** on the M3 Pro, the market walk (the flight over fields
gains nothing), interleaved runs with and without (`?no-occlusion`) in one
build (another Chrome was busy on the machine):

| Preset | fps with / without | CPU ms with / without |
|---|---|---|
| Potato | 233 / 271 | 2.9 / 2.3 |
| Low | 152 / 168 | 3.8 / 3.3 |
| Medium | 101 / 64 | 7.6 / 11.9 |
| High | 76 / 57 | 10.3 / 12.9 |

At Potato's and Low's frame rates this machine is CPU-bound, so the
rasterising shows and the GPU saving doesn't; on Medium and High fewer draws
cut both. The preset setting `occlusion` is on for Low, Medium and High,
off for Potato (little is drawn within its 200 m). The Vega 7 is GPU-bound
from Low up, so Low should gain there: to measure on the laptop.

### The new Medium: no MSAA, dynamic resolution (2026-10-31, M3 Pro)

Medium drops 4× MSAA and draws the scene at a scale of the canvas between
0.5 and 1, chosen every half second from the GPU's frame time (target
14 ms: the span from the frame's first timestamp to its last), then
upscales it with a contrast-adaptive sharpening pass (`upscale.ts`). At
full scale it draws straight to the canvas (the upscale pass cost 2 ms
there for nothing). `?preset-with={"upscale":{"min":0.6,"max":0.6,…}}`
pins a scale; the HUD shows it (`scene ×0.60`), and the benchmark report
gives the average.

The in-app benchmark, Medium, interleaved runs:

| | fps | 1% low | CPU ms | GPU ms (sum of passes) | walk fps |
|---|---|---|---|---|---|
| before (4× MSAA, full resolution) | 77.8, 81.3 | 6.6, 8.1 | 9.6, 8.6 | 30.2, 30.3 | 73.9, 78.4 |
| after | 91.5, 92.4 | 10.5, 11.4 | 7.7, 7.6 | 20.2, 20.3 | 87.2, 84.3 |

The scale averaged 0.98 here: the M3 Pro holds 14 ms at full resolution
almost everywhere, so the gain on this machine is the MSAA. The report's GPU
column sums the passes, which overlap on this GPU, so it reads higher than
the frame's span. At a pinned 0.6 the market's opaque pass fell from 4.8 to
3.9 ms; the upscale pass costs about 1.3 ms at 1080p. Not yet measured on
the Vega 7, where the scaling should matter most. `bench-presets.ts`
(Dawn) draws Medium without MSAA now but doesn't scale.

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
