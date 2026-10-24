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
- **The NPCs were mostly waiting for frames:** once the world was complete, the frame cap ended
  and assembly competed with full-speed rendering. The cap now lasts until the first NPCs are
  assembled. High: NPCs complete at **18 s** from the package (46 before), 23 s from the paks
  (58 before).

## Phase 3: characters, and no original files (2026-10-23)

### What the package holds now

- **Character parts:** the database's souls and clothing presets use 665 (skin, material) pairs.
  Their models and textures (including those of the materials given instead of a model's own)
  go in a `chars` chunk, read entry by entry as NPCs come.
- **One hook for every loader:**
  - `setAssetPackage` (`model.ts`): `loadModelParts` and `loadMipChain` take models and textures
    from the package first, for the world, characters, props, the far field and the terrain's
    detail layers.
  - The detail layers ask for RGBA, so packaged BC data is decoded on the CPU for them.
  - A part's override material is read from the store.
- **Texture data is compressed too:** texture entries are deflated, and each large mip in the
  packs on its own (the pool inflates the ones it grows into). Format 3.
- **The file store** (`slimStore.ts`): every other file the engine reads, repacked into paks with
  the original paths (the installer's `repackedPak`), so the paks' reader, asset index and read
  workers open them unchanged. It covers animations, tables, scripts, level files, materials,
  skeletons, audio and textures the package doesn't hold.
  - **Left out:** files later patches replace; what the package holds converted; videos; voice in
    other languages; HD paks.
  - **Potato store:** split mip parts above 512 px are left out too. The texture reader starts at
    the largest complete level.
- **Package-only:** a game root that is only the store, plus the package, runs everything. Renders
  of the market (world, 40 NPCs, Henry) and the fields are pixel-identical to the paks
  (`render-player.ts --root DIR/store --slim DIR`).

### Sizes (from `~/kcd1` without HD)

| | Package | File store | **Total** |
|---|---:|---:|---:|
| Full | 6.25 GiB (models 1.14, texture packs 4.79) | 15.46 GiB | **21.7 GiB** |
| Potato | 2.11 GiB (models 1.14, texture packs 0.66) | 10.98 GiB | **13.1 GiB** |

(These stores still held the other languages' voice patches, 0.34 GiB, since fixed: the
installer-built Potato store is 10.64 GiB in 78 paks.)

For comparison, the default install is 38.2 GiB, or about 23 GiB without its videos.

- **The store holds** textures the package doesn't (5.3 GiB in Full), English voice (3.4 GiB),
  grass sectors and voxel lighting (`.dat`, 1.8 GiB), animations (2.6 GiB) and the rest
  (2.3 GiB).
- **Texture compression** took the Full package from 9.16 to 6.25 GiB. Node deflates at level 9
  (a 600 s build); the browser's `CompressionStream` uses its default level.

## Phase 4: straight from the installer (2026-10-23)

Start page → pick or drop the installer folder → **Install: compact package, Full or Potato**
(`compactInstall.ts`). Only the package and its store are kept; the start page then offers
**Open compact package**.

### How it reads the installer

- **In place, with no copy.** GOG stores every file as zlib parts of 10 MiB, each inflatable on
  its own (`docs/INSTALLER.md`). So `installerPak.ts` serves a pak straight from the `.bin`
  files: a read inflates only the parts it covers (a 64-part cache, about 640 MiB, shared by all
  paks). The pak readers only use `size`, `slice()`, `arrayBuffer()` and `stream()`, so the
  whole build (level data, asset index, repack plan, package, store) runs on these unchanged,
  just without the read workers.
- **Checked** against `~/kcd1`: every pak's central directory, and 1,546 sampled entries, are
  identical (`scripts/test-installer-pak.ts`). The repack plan from the installer alone takes
  77 s: of the 37.4 GiB of wanted paks (one voice language, no videos), 23.2 GiB are not
  replaced by later patches.
- **Why not the planned single streaming pass.** Building needs random access across paks (a
  later patch can replace any file of an earlier pak, and models and textures are gathered per
  region). Random access by part gives the same "no intermediate copy" result with the existing
  reader, without a second, stream-order parser.

### Part by part (the low-storage mode, 2026-10-24)

When some `.bin` slices are not in the folder, each stop converts what the slices present allow,
names the next slice, and lists the ones done with (which may be deleted). Picking the folder
again with the next slice continues.

- **What made the old peak (37.2 GiB): every wanted pak staged whole.** Of those 37.4 GiB,
  14.2 GiB are files later patches replace, and most of the 12.4 GiB of textures are mips above
  512 px that a Potato package never holds.
- **Now each pak is staged without what the package will never need** (`compactInstall.ts`):
  the files a higher-ranked pak already seen replaces (the repack's rules, `planRepack` limited
  to the new paks' files), and for Potato the split mips above 512 px under every version of
  their texture's header seen so far. Those mips stay listed by size only, as phantom entries
  (`PakSource.phantoms`), so choosing a texture version gives what the whole pak would; they are
  never read. Paks staged earlier are rewritten without what a pak added later replaces (from
  16 MiB of it), so another slice order costs time, not storage.
- **The slices are asked for last to first, base game then DLC.** The patches are in the base
  game's last slices, so they come first and little is staged that a patch then replaces
  (0.08 GiB in a simulation of this order, 5.5 GiB in installer order). Start with the last two.
- **Then the package is built from the staging copy** and the store written pak by pak, each
  staged pak deleted once its store copy is written (an interruption carries on from the saved
  store plan, below).
- **Checked against the whole game** (`scripts/test-part-compact.ts`, in Node from the real
  installer, two slices at a time): the file store planned from the staging copy keeps exactly
  the entries planned from the whole game, and 3,039 sampled textures pick the same header
  version and mips. Staging peaks at 13.98 GiB (Potato), 14 stops.
- **Why not convert each file into the package as it arrives.** Region chunks need the whole
  world first (where every model is placed, the level paks being in slice 6, and which textures
  its materials use), and a texture's version can depend on files in later slices. What can't
  be discarded on arrival is what the package or store will hold.

### Storage (base game and DLC, measured in Chrome)

| | Installer files on disk | Browser storage, peak | Browser storage, at the end |
|---|---:|---:|---:|
| Potato, in place (every slice present) | all (56 GiB of `.bin` files for the base game) | 12.8 GiB | **12.76 GiB** |
| Potato, part by part | about 2 slices at a time (8.6 GiB) | **16.1 GiB** (was 37.2) | **12.76 GiB** |
| Full, part by part | about 2 slices at a time | **29.5 GiB** | **21.41 GiB** |

- **Potato, part by part** (`test-install-browser.ts --compact=potato --part=2`): 646 s in all,
  14 stops, the slices deleted as the page said. The peak comes while the package is built
  beside the staged copy (13.98 + 2.11 GiB). The package and store are those of the in-place
  build: 16,661 models, 7,077 textures, 2.11 GiB; store 10.64 GiB in 78 paks.
- **Full, part by part** (`--compact=full --part=2`): 699 s; staging peaks at 23.2 GiB (no mips
  left out), plus the 6.28 GiB package; store 15.12 GiB.
- **In place, Potato:** 569-576 s from clicking Install (`--compact=potato`).
- Timings were taken with another game and other tests running on the machine.
- **Interrupted while the store is written** (cancelled, or the tab closed): the staged paks
  already written to the store are deleted, and their slices may be gone. So once the package is
  complete, the store plan is saved (`store-plan.json`: the source paks and each store pak's
  left-out entries). Installing again writes only the store paks still missing. Checked with
  `--interrupt` (Cancel at pak 3 of 78, then on from 4).
- **Cancel** works through the whole build, not only the copy.

### Cutscene videos, on demand

The package is made without them (15 GiB). Later, picking the installer folder again offers
**Install: the cutscene videos, into the compact package built here**: their paks are added to
the package's store as they are (`addVideos` in `compactInstall.ts`), part by part if slices are
missing. The engine doesn't play them yet (CRI `.usm`, which browsers don't decode); transcoding
is a later step.

### What's not in the package yet

- **Videos:** left out (15 GiB); installable on demand (above), not yet playable.
- **Audio** stays in its original form in the store (Wwise/ogg); Opus is a later size saving.
- **Animations** are in the store as `.caf`/`.dba` (2.6 GiB), not converted.

## Not decided yet

- **Old packages:** whether a format change rebuilds them, or whether the engine reads older
  versions.
