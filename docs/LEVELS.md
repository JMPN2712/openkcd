# Levels

How KCD's single open-world level, Rataje (`Data/Levels/rataje/`), is stored,
as decoded by `web/src/terrain.ts`. Verified by `web/scripts/test-terrain.ts`
(which also renders a hillshade).

## level.pak contents

| Path | Size | Contents |
|---|---:|---|
| `terrain/terrain.dat` | 297 MB | Compiled terrain: vegetation groups, static-object and material name tables, the heightmap quadtree, then the object octree (vegetation and brush instances) |
| `terrain/cover.ctc` | 89 MB | Terrain colour texture (`CRY` header, tiled) |
| `terrain/merged_meshes_sectors/*.dat` | 142,830 files, 329 MB | Merged-mesh sectors (instanced grass and small vegetation, magic 0xCAFEBABE) |
| `layers/*.xml` | 1,831 files, 92 MB | Editor object layers |
| `objects_mission0.xml` | 52 MB | Mission entities |
| `brush/*.cgf` | 4,007 | Level-specific geometry |
| `levelinfo.xml`, `leveldata.xml` | small | Heightmap size (4096), unit (1 m), sector size (64 m), max height (270 m), surface types |

Also present: `occluder.ocm`, `ubernav.tmm`, `whdata_0/1`, `newgame.whs`,
`triggerareas.fubar`, and a few smaller files.

## terrain.dat

- **Header (32 bytes).**
  - `i8 version` (28), `i8`, `i8 flags`, `i8 flags2`, `u32 chunkSize` (= the
    file size).
  - `u32 heightmapSize` (4096), `unitSize` (1), `sectorSize` (64),
    `sectorsTableSize` (64).
  - `f32 heightmapZRatio` (0.00412), `f32 oceanLevel`.
- **Vegetation groups:** `u32 n` (508), then 360-byte records: `char
  name[256]` plus 104 bytes of parameters (bending, view-distance ratios,
  density, …).
- **Static object names:** `u32 n` (12,437), then 256-byte names. Some are
  empty, and the octree refers to these by index.
- **Materials:** `u32 n` (1,077), then 256-byte names.
- **Terrain quadtree.** Depth-first, with children in the order (x0,y0),
  (x1,y0), (x0,y1), (x1,y1). That's 5,461 nodes: 7 levels from 4,096 m down
  to the 64 m leaves.
  - **Node header (44 bytes):** `i16 version` (7), `i16 hasHoles`, AABB
    (6× f32), `f32 offset`, `f32 range`, `i32 samplesPerSide` (0 for inner
    nodes), `i32 surfaceTypeCount`.
  - **Samples:** `u16 samples[n·n]`, padded to 4, stored **X-major**
    (index = x·n + y).
  - **Geometric errors:** `f32 geometricError[6]`, e.g. 0, 0.5, 1, 1.5, 2,
    3.48 for a leaf.
  - **Surface types:** `u8 surfaceTypes[count]`, padded to 4.
  - **Leaf resolutions:** 65² (4,046 leaves), 33² (40), 17² (6) and 9² (4).
    Flat areas get fewer samples.
  - The tree ends at byte 38,353,152, where the object octree starts.

### Sample decoding

**height = offset + (sample & 0xFFF0) / 320 metres.** That's 5 cm steps; the
low 4 bits index the node's surface-type list. The node's `range` field is
not the sample scale, and `offset` is always the AABB minimum + 3 m.

How this was established (none of it was guessable from the field names):

1. **Field order.** The 24 bytes right after the header looked like errors,
   but reading heights from there leaves the float ladder 0, 0.5, 1, 1.5,
   2 … at the end of the "height" block. So the samples come first.
2. **Orientation.** Correlating every edge of a leaf with every edge of its
   +x neighbour is scale-free. Leaf A's last row matches leaf B's first row
   with r = 0.999, so the first index is X.
3. **Scale.** On matched edges, raw_B ≈ raw_A + c with slope exactly 1,
   even where the stored ranges differ by 2.6×. So samples share one global
   scale. Solving offset_A − offset_B = c·Z over 3,443 neighbour pairs gives
   Z = 0.0031249 (interquartile range ±0.000002), i.e. 1/320.
4. **Result.** Shared edges agree within 5 cm everywhere: one height step,
   median 3.7 cm. Every leaf fits its bounding box. Curvature at sector
   borders (0.060 m) matches the curvature inside sectors (0.057 m).

Heights range from 10.5 to 218.4 m. The viewer keeps one 4097² `Uint16Array`
in 5 cm units (34 MB) and upsamples coarse leaves bilinearly.

## Not yet decoded

- The object octree in `terrain.dat` (vegetation and brush instances).
- `cover.ctc` (terrain colour), merged-mesh sectors, and the `layers/*.xml`
  entities.
