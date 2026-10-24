# The compact web format (milestone 2): design

Status (2026-10-23):

- **Phases 1 and 2 are built:** the converter in Node and in the browser, and the world view
  loading from a package in OPFS.
- **Phases 3–4 are planned:** characters, animations and audio; then building straight from the
  installer, with the part-by-part mode for low storage.

Measurements are under "Phase 1: measured" and "Phase 2: in the browser" below.

## Goal

Loading speed first (decided with the player, 2026-10-23). Cutscene videos are left out for now
(added later, on demand). Two package variants:

- **Full:** textures at full resolution (what the install has; High loads up to 2048 px).
- **Potato:** textures capped at the Potato preset's largest size (512 px), for the Vega 7
  laptop. Everything else is the same.

**The end goal** is a package that needs no original files at all (world, characters, animations,
audio), built in the browser straight from the GOG offline installer in one streaming pass. See
phase 4.

**Measured today** (Chrome, High, market):

- From opening the world view until the market is complete: 53 s from `~/kcd1`.
- The main thread is busy the whole time. Pak reads still cost a Blob slice per entry (about
  6 s), and a load reads tens of thousands of entries.
- Every model is parsed (`.cgf`, `.mtl`) and its vertices re-encoded for the renderer.
- Texture headers and mips are assembled from split DDS parts.

## What the format is

A package in OPFS next to the installed copy (`game/`), built from it in one pass:

```
slim/
  manifest.json      format version, what it was built from (pak names and sizes), when
  index.bin          every asset: path hash -> (file, offset, size, kind)
  tiles/X_Y.bin      region chunks: the assets first needed in that 256 m tile
  textures/NNN.bin   texture mips above the first-load size, in packs of about 64 MiB
```

### Region chunks

- Each model, material and small texture the level places goes into exactly one tile: the
  tile of its nearest instance to the level's centre of mass.
- Within a tile, assets are ordered by how close their instances are.
- **Streaming reads whole tiles:** one slice of a few MiB per tile entering the radius, instead
  of thousands of entry reads.
- About 20–30 tiles are in range on High.

### Assets, already in the engine's form

- **Models:** the renderer's vertex layout (64 bytes a vertex), indices, subsets, node
  transforms, bounds, collision proxies and the material path.
  - Loading is one view into the tile's bytes. No parsing, no `uploadMesh` encoding: the bytes
    go straight to `writeBuffer`.
- **Materials:** the parsed `.mtl` as compact JSON.
- **Textures:**
  - The DDS header, plus the mips up to the preset's first-load size (128–512 px), inline in
    the tile.
  - Larger mips go in texture packs, smallest first, so the texture pool can grow a texture
    with one read.
- **Compression:** deflate per asset where it helps (it saves about 32% on BC texture data),
  inflated on the read workers.

## Converter

- **Runs in the browser after installing** (or from a picked game folder), on the read workers.
  It uses the engine's own parsers (`cgf.ts`, `mtl.ts`, `dds.ts`).
- **Resumable:** tile by tile, with progress in the install view.
- **A Node version** (`scripts/build-slim.ts`) builds the same package from `~/kcd1` for the
  tests and benchmarks.
- **The original copy can be deleted afterwards:**
  - The level needs the package only for world streaming.
  - Characters, animations, audio and scripts are still read from the paks in this first
    version, so the paks they live in are kept until later phases convert them too.

## Engine side

- A `SlimSource` that `buildWorldScene` asks for models by path, before the VFS.
  - It returns `LoadedModel`s whose meshes the renderer uploads as they are.
  - Missing assets fall back to the paks, so a partial package still works.
- The texture pool reads mips from texture packs.
- Collision uses the stored proxies.

## Phases (each measured before the next)

1. **Node converter and loader:** Rataje's world assets into tiles. Benchmark: headless
   `bench-streaming.ts` and startup, slim against paks. Expected: the scene build (5 s cold
   headless) and the reads drop the most.
2. **In the browser:** the converter after the install, and the engine using the package.
   Measured with `profile-browser.ts --load-profile`.
3. **Then:** characters and NPC clothing, animations (`.caf`/`.dba`, 7.5 GiB), audio (Opus via
   WebCodecs, optional), cutscenes on demand.
4. **Straight from the installer, no original files:**
   - The converter reads the GOG offline installer in one streaming pass (`inno.ts`) and writes
     the package directly, with no intermediate copy of the paks in OPFS.
   - The package then holds everything the engine reads: the world, characters, animations,
     audio, scripts and tables.
   - **Pak entries are read in stream order** from their local headers (no central directory
     needed); per-asset results are staged in OPFS and assembled into tiles at the end.
   - **Low-storage, part-by-part mode (a key requirement:** the Vega 7 laptop it is for has
     little free storage; set by the player, 2026-10-23**):** the installer's layout allows it.
     - Measured on the base game's 15 `.bin` slices: 6,095 of 6,098 file parts are stored in
       slice order, almost every pak's data is contiguous (118 runs for 102 paks), and only 14 parts
       cross into the next slice.
     - So the pass can finish slice N while keeping only the part that runs into N+1, and the
       player can download or keep one slice at a time and delete it once it has been read.
     - The converter saves its position after each slice, so it resumes in a later session.

## Phase 1: measured (2026-10-23)

Code: `web/src/slim.ts` (format and reader), `web/scripts/build-slim.ts` (converter),
`web/scripts/test-slim.ts` (checks), `--slim DIR` in `bench-streaming.ts` and `render-player.ts`.
Packages are built outside the repository (`~/.cache/openkcd-slim/`).

### Sizes (Rataje's world: 16,196 models with LODs, 5,575 textures)

| Package | Models | Textures inline | Texture packs | Total | Build (Node) |
|---|---:|---:|---:|---:|---:|
| Full | 2.75 GiB | 0.31 GiB | 2.22 GiB | **5.28 GiB** | 36 s |
| Potato (textures ≤ 512 px) | 2.75 GiB | 0.31 GiB | 0.62 GiB | **3.68 GiB** | 30 s |

- **Common chunk:** 649 MiB in 11 pieces (1,624 models placed in more than 6 tiles, and the
  textures they use).
- **Tile chunks:** 372 pieces, median 1.6 MiB, at most 64 MiB (Rattay's castle tile is 4 of them).
- **Geometry was stored uncompressed** in this first build: compressed since (below).
- **15 textures fail to convert:** the same ones that fail from the paks (missing DDS parts).

### Tile size: 256 m

Reads per area for six positions across the map (radius 700 m, about 2,300–3,300 models needed
each), by placement rule:

| Tiles | Common chunk | Chunks read | Extra single reads | Models read but not needed |
|---|---|---:|---:|---:|
| 256 m | none | 33–37 | 1,190–1,480 | 200–420 |
| 256 m | models in more than 6 tiles | 33–37 | 170–310 | 200–415 |
| 512 m | models in more than 6 tiles | 10–14 | 190–340 | 360–930 |

256 m with a common chunk: about as few single reads as 512 m, with half the wasted bytes.

### Large textures: inline up to 256 px, the rest in per-tile packs

From the market, first scene:

| | Inline ≤ 256 px | Inline ≤ 512 px |
|---|---:|---:|
| High: reads (pieces + single + pack) | 53 + 1,180 + 2,153 = 3,386 | 51 + 1,883 + 119 = 2,053 |
| High: bytes read | 1,884 MiB | 1,870 MiB |
| High: scene build | 2.28 s | 2.31 s |
| Potato: reads | 24 + 731 + 152 = 907 | 21 + 1,610 + 0 = 1,631 |

- **Why 256:** 512 inline saves High about 1,300 reads for the same time. Potato, Low and Medium
  would read pieces swollen with 512 px levels they never use (their first loads are 128–256 px).
- **Why per-tile packs:** one stream ordered by first use gives the same number of reads (each
  texture's large levels are one read either way). Per-tile packs keep a tile's data together
  and the conversion resumable tile by tile.

### Loading from the package (headless, High, from the market, cold)

| | Paks | Package |
|---|---:|---:|
| Scene build | 4.83 s | **2.36 s** |
| Memory (rss) | 3.4 GiB | 3.0 GiB |
| `render-player.ts` world load (250 m) | 5.1 s | 2.7 s |

- **Steps after that** cost the same either way (0.1–0.2 s; the models are mostly loaded already).
- **Renders are pixel-identical,** and `test-slim.ts` matches 306 models and 187 textures against
  the paks.
- **How a load reads:**
  - `SlimPackage.prefetch` reads whole the pieces holding at least a quarter of their bytes in
    models still needed (or 64 such models, except in the common chunk), two at a time.
  - It decodes what is needed from each piece as it arrives, so no piece stays in memory.
  - Everything else is read entry by entry.

### Compressed geometry (format 2)

Model entries are compressed losslessly: each mesh's vertex streams and indices encoded with
meshoptimizer (`meshoptimizer` 1.3.0, MIT; the decoder is 29 KB), then the entry deflated.

On a 125 MiB sample of model entries (size against raw):

| | deflate | zstd | meshopt | meshopt + deflate | meshopt + zstd |
|---|---:|---:|---:|---:|---:|
| Size | 41% | 36% | 48% | **37%** | 36% |

- **meshopt + deflate**, because Chrome 156's `DecompressionStream` inflates gzip and deflate
  but not zstd or brotli. zstd would mean a WASM decoder for one percentage point.
- **Decoding speed (Node):** meshopt decodes at about 2.7 GB/s of output; zlib inflates at about
  400 MB/s of input.
- **meshoptimizer's index codec rotates triangles:** (a, b, c) may come back as (b, c, a), with
  the same winding. Renders are pixel-identical; `test-slim.ts` compares triangles up to rotation.
- Lossy meshopt filters (quantised positions, octahedral normals) would shrink it further. They
  are not used.

| Package | Models | Textures inline | Texture packs | **Total** | Before |
|---|---:|---:|---:|---:|---:|
| Full | 1.03 GiB | 0.31 GiB | 2.22 GiB | **3.56 GiB** | 5.28 GiB |
| Potato | 1.03 GiB | 0.31 GiB | 0.62 GiB | **1.96 GiB** | 3.68 GiB |

- **The common chunk** is now 358 MiB (649 before). The median tile piece is 0.4 MiB.
- **Cost:** in Node, with inflating (zlib) and decoding on the one thread, the cold scene build at
  the market takes 4.68 s compressed against 2.36 s uncompressed (1.25 s inflating, 1.54 s
  decoding). Phase 2 runs read, inflate and decode on the browser's read workers, off the main
  thread; whether that wins it back is measured there, in Chrome.

## Phase 2: in the browser (2026-10-23)

### What runs where

- **Building** (`slimView.ts`, the sidebar's "Compact package" view):
  - It builds from the opened game (the installed copy, or a picked folder) into OPFS:
    `slim-full/` and `slim-potato/`. `index.json` is written last, so an interrupted build isn't
    used.
  - The core is shared with Node (`slimBuild.ts`). Deflating uses `CompressionStream`.
  - The meshoptimizer encoder is loaded only when building.
- **Loading:** the world view opens a built package (the Potato preset prefers the Potato
  variant).
  - The read workers read, inflate and decode the pieces and entries it needs (meshoptimizer
    decoder in the worker), and transfer the arrays to the main thread.
  - Models it doesn't hold, characters, terrain and everything else still come from the paks.
- **Shared level loading:** `levelData.ts` loads the level once for both the world view and the
  builder.

### Measured in Chrome

Chrome 156 on the RTX 5070 Ti (`profile-browser.ts`; `--build-slim=…` builds through the page,
and `PROFILE_DIR` keeps the profile and its OPFS between runs). Opened from `~/kcd1` through the
folder input; that copy has the HD texture paks, which the world view uses.

| | Full | Potato |
|---|---:|---:|
| Build in the page | 227 s | 83 s |
| Package (HD textures in the source) | 8.36 GiB | 2.20 GiB |
| Package (no HD paks, the default install; Node build) | 3.56 GiB | 1.96 GiB |

| Opening the world view, until… | Paks | Package |
|---|---:|---:|
| High: the world is complete | 21 s | **12 s** |
| High: the NPCs are complete | 58 s | 46 s |
| Potato: the world is complete | 12 s | **8 s** |

- **Frame cap while loading:** both now cap frames at about 15 fps while the world loads
  (`LOADING_FRAME`). Drawing the growing scene at full speed took about half the main thread.
  Before the cap, High measured 96 s (paks) and 68 s (package) until the NPCs were complete.
- **Next cost: the NPCs.** About 35 s on High after the world is complete, assembled from the
  paks (characters, clothing, textures). Characters go into the package in phase 3.

## Not decided yet

- **Old packages:** whether a format change rebuilds them, or whether the engine reads older
  versions.
