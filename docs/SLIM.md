# The compact web format (milestone 2): design

Status: proposal, 2026-10-23. Nothing here is built yet.

## Goal

Loading speed first (decided with the player, 2026-10-23). Textures stay at full resolution, and
cutscene videos are left out for now (added later, on demand).

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

## Not decided yet

- **Tile size:** 256 m, or 512 m (fewer, larger reads).
- **Texture packs:** packed by tile too, or one stream ordered by first use.
- **Old packages:** whether a format change rebuilds them, or whether the engine reads older
  versions.
