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

## Terrain colour: cover.ctc (`web/src/cover.ts`)

- **Header.**
  - `"CRY\0"`, `u8 fileType` (100), `u8 flags`, `u16 version` (9).
  - `u16 layerCount` (2), `u16 flags`, `f32 brightness` (1.0).
  - Per layer: `u16 sectorPixels` (256), `u16`, `u32 format`,
    `u32 bytesPerSector` (32,768, i.e. 256² BC1).
- **Slot table.** **`u16`** `nodeCount` (5,461, matching the terrain
  quadtree), then `u16 slot[nodeCount]` in the terrain tree's depth-first
  order, with 0xFFFF for none. Reading the count as a u32 shifts the whole
  table by one entry; the u16 reading gives slots exactly 0…1364 and 4-byte
  aligned data.
- **Slot data.** Slots × (layer 0 = colour, layer 1 = normal map). The
  normal map's R ≈ −∂h/∂x and B ≈ −∂h/∂y; G is unused.
- **Coverage.** Only depths 0–5 are textured (1,365 nodes). The finest colour
  is 128 m per 256 px, about 0.5 m/px, an 8192² map.
- **Orientation.** Tiles are **X-major** like the heightmap: image rows run
  along world x. Correlating the normal layer with heightmap slopes gives
  r = −0.93 / −0.91 for this layout against about 0 for the alternative.
  (A side-by-side image comparison misled me here; the correlation didn't.)
- **Rendering.**
  - Each depth's mosaic is half the previous, so depths 5…0 are a ready-made
    mip chain.
  - The renderer uploads it as `bc1-rgba-unorm-srgb` (43 MB) when the device
    has `texture-compression-bc`; otherwise it decodes depth ≤ 4 to RGBA.
  - Sampled at uv = (y, x)/4096, ×2 brightness as the CryEngine terrain
    shader does.
  - Without water, the river shows as its muddy bed.

## Object octree (`web/src/levelObjects.ts`)

The octree follows the terrain tree and runs exactly to the end of
`terrain.dat`: 218,209 nodes, at most 9 levels deep. Checked by
`web/scripts/test-level-objects.ts`.

- **Node:** `i16 version` (5), `u16 childMask` (8 bits), AABB, `i32
  objectBytes`, then the objects, then the children whose mask bit is set,
  depth-first.
- **Object ordering.** Objects within a node are **sorted by type**
  (CryEngine `EERType`): zero order violations across 1.69M parsed records.
  So the parser can stop at the first type it doesn't know without losing
  brushes or vegetation.
- **Brush (type 1, 100 bytes):**
  - `u32 type`, world AABB, `u32` (mostly 0, *not* the geometry),
    `u32 renderFlags`;
  - **`u16 nameIndex`** into the 12,437-name table, `u8`, `u8`;
  - `Matrix34` (rotation·scale | translation, row-major), `u32`,
    `i32 material`, `u32`.
  - **How the index was identified:** transforming each candidate model's
    bounding box by the matrix reproduces the stored AABB for 2,150 of 2,150
    sampled records with the u16 at +36, against 26 with the u32 at +28.
  - Names starting `%level%/` refer to files inside the level pak
    (e.g. `brush/*.cgf`).
- **Vegetation (type 2, 64 bytes):** `u32 type`, AABB, `u32`, `u32 flags`,
  `u16 group` (into the 508 vegetation groups), `u8`, `u8`, `Vec3
  position`, `f32 scale`, `u8 angle` (1/256 turns about Z), 7 bytes.
  - All 1,479,226 positions lie inside their AABBs.
  - Instances sit on the decoded terrain: height above ground has a median
    of −2 cm and p5–p95 of −6 to +1 cm. That's an independent check of the
    heightmap decoding.
- **Decal (type 7):** a fixed 116 bytes. Skipped for now.
- **Water volume (type 9):**
  - Fields: type, AABB, `u64 id` (+44), `i32 material` (+52; mostly
    `materials/terrain/river/river_sazava_02`, plus marshland and pond
    water), `f32 fogDensity`, `Vec3 fogColor`, `Plane fogPlane` (+72),
    caustic and texture parameters, `u32 nVertices` (+124), `u32 nContour`
    (+136), physics parameters, then `Vec3 vertices[nVertices]` from +208,
    then `Vec3 contour[nContour]`. Size = 208 + 12·(nVertices + nContour).
  - The vertices are an absolute outline at the water height, and rivers
    slope, so each vertex keeps its own z.
  - Rataje has 282 volumes of 4–67 vertices, all inside their AABBs. With
    decal and water sizes known, 190,389 blocks parse to their exact end.
- **Type order is not strict.** 123 blocks break ascending type order.
  Parsing through decals and water found **3,999 more vegetation
  instances** that had been hidden behind decals.
- **Not decoded yet:** roads (11) and type 23, both variable-length.
  Size formulas based on the road's vertex and index counts (e.g. 108 + 12v
  + 2i) don't reproduce where the next record starts, so parsing a block
  stops at them.
- **Water rendering** (`web/src/waterRenderer.ts`): outlines are ear-clipped
  in XY and drawn in a blended pass after the opaque geometry, with a
  fog-colour tint, Fresnel sky reflection and a sun glint. That's 2,109
  triangles for the whole level.

**Rataje totals:** 212,879 brushes (12,436 distinct meshes), 1,483,225
vegetation instances, 20,212 decals and 282 water volumes. The most common are soil stones, modular rocks,
elder bushes and branch piles.

## Rendering (`web/src/terrainRenderer.ts`)

- **Heightmap on the GPU:** uploaded once as a 4097² `r16uint` texture. The
  vertex shader reads heights and central-difference normals from it.
- **Patches:** one instanced grid patch per 64 m sector, at 1, 4 or 16 m
  spacing by distance. Each patch has a skirt (its border duplicated 4 steps
  lower) to hide cracks between LODs. A typical ground-level view is about
  1M triangles.
- **Colour:** from `cover.ctc` (see above), with slope and height colouring as a fallback.
- **Headless check:** `web/scripts/render-terrain.ts` renders views to PNG
  through Dawn. Keep the object returned by `create()` referenced; if it is
  garbage-collected while the device is alive, Dawn aborts with a glibc
  mutex assertion.

## Objects in the world (`web/src/world.ts`, `levelView.ts`)

- **Scene building.** Instances within a radius of the camera are grouped by
  model, giving one instanced draw per model with per-instance matrices.
  - Vegetation matrix: T(position) · Rz(angle) · S(scale).
  - Brush matrix: its Matrix34.
- **Level-local paths.** `%level%/…` names resolve through a VFS overlay of
  the level pak. Otherwise `rataje_dlc4/level.pak`'s same-named
  `brush/*.cgf` would shadow Rataje's.
- **Not drawn (editor/helper content):**
  - brushes under `objects/editor/`, `*_nodraw.cgf`, and the test sky;
  - materials named `proxy_mat_*` or `shadowproxy`, flagged NODRAW (0x400),
    or whose diffuse texture is in `Materials/special/` (collision/barrier
    proxies on level-designer `brush/designer_*.cgf`, placeholders);
  - `%DECAL` sub-materials are alpha-tested at 0.5 until there's a blend
    pass.
- **Streaming.** The browser view streams objects within 250 m, up to 400
  models with 256 px textures, and rebuilds after the camera moves 120 m.
  Headless: `web/scripts/render-world.ts`.
- **LODs and culling** (`selectLods`, run per frame on the CPU, about 3 ms for 85k instances):
  - **LOD files:** models ship `x_lod1.cgf`, `x_lod2.cgf`, …. Only 3,154 of
    the 11,457 models used in Rataje have them, but those cover 89.6% of the
    instances: trees, bushes and rocks. A beech goes
    3,613 → 1,757 → 317 → 11 triangles.
  - **Node offsets:** LOD files keep the artist-scene node offset (the LODs
    sat side by side, e.g. `bridge_wooden_01_lod1` +5.4 m,
    `talmberk_dam_nobridge_lod2` +25.6 m). The loader re-anchors each LOD's
    root onto the base model's root; without that, bridges and dams vanish at
    distance.
  - **Billboard LODs:** the last LOD of trees is a ~10-triangle card for the
    engine's sprite path. It renders nearly invisible with a generic shader,
    so LOD chains stop before any LOD under 32 triangles.
  - **Rules:** LOD k from k × (8r + 10) m; culled beyond (80 + 70r) m or
    outside the frustum, where r is the instance's bounding radius. Half
    those distances emptied aerial views of hedgerows and forest.
  - **Result:** in three test views (aerial, village edge, riverbank) model
    triangles drop from 17–21M to 0.9–2.5M, and the images match the
    full-detail renders closely (`render-world.ts` writes both).
  - **Streaming:** now covers 500 m, up to 1,500 models.
- **Known gaps:**
  - no roads or decals (octree types 7 and 11 are not drawn);
  - road and terrain-blend meshes render as flat dark patches;
  - no shadows; terrain detail materials (the 26 surface types) aren't blended in.

## Not yet decoded

- Merged-mesh sectors and the `layers/*.xml` entities.

## Entity props, light shafts and uber-LODs

- **Entity props.** Furniture and other interactive props are not in the
  `terrain.dat` octree. They are entities in `objects_mission0.xml` with a
  `Properties object_Model` (and an optional `Scale`). Rataje has 4,250
  drawable ones: chests and shelves (`Stash`), beds, chairs, bird nests,
  alchemy tables, grindstones, and so on, in `.cgf` and `.cga` format
  (`.cga` geometry loads like `.cgf`).
- **Skipped entities** (`web/src/levelEntities.ts` `propEntities`):
  - trigger and area classes, whose models are editor shapes
    (`objects/default/primitive_cylinder.cgf` ×858, `box_nodraw`);
  - `.cdf`/`.chr` entities other than doors and AnimObjects (NPCs, graves).
- **Doors and AnimObjects.** Doors (792 `AnimDoor`) and AnimObjects (wells,
  flags, smokehouse doors) are `.cdf` characters: one skinned `.skin`, with
  a material from the CDF. They are drawn as instanced props in bind pose,
  which is the closed or at-rest position. Opening animations come later.
- **Light shafts.** `objects/lightshafts/*` brushes use the `Geometrybeam`
  and `Templbeamproc` shaders, which are additive volumetric beams.
  Drawn opaque, they came out as black shards in interiors, so their
  materials are now hidden (`mtl.ts`).
- **Uber-LODs.** `objects/uberlods/<town>/*` are single simplified meshes
  standing in for whole town blocks, placed as ordinary brushes. Drawn
  next to the detailed buildings, they overlapped them: blank walls in
  Rataje's market. The engine's switching rule is code, not data
  (`LODArea` entities are small interior volumes). The viewer draws
  uber-LODs only when the camera is more than 300 m from their bounds.

## Navigation data

Decoded by `web/src/navmesh.ts` and `tools/navmesh.py`.

- **Format:** Detour's tile format, version 14, with Warhorse's vertex
  packing. In world coordinates, z is up.
- **`recast.pak`** (per level) holds `recast/rdnavmesh_<name>.{hdr,nav}`
  pairs:
  - `rdnavmesh_1` is the whole level;
  - small layers cover quest and event states (burnt farms, the New Homes
    buildings, …).
- **`.nav`:** build settings, a tile count, then 16 m tiles back to back.
- **Each tile:**
  - a Detour-style header with bounds;
  - vertices, mostly packed into one u32 each and quantised over the tile
    bounds (11/11/10 bits);
  - polygons of up to 6 vertices, whose neighbour codes are internal
    neighbours or links across the tile border;
  - off-mesh connections.
- **Check** (`web/scripts/test-navmesh.ts`): Rataje has 58,056 tiles,
  2.52 M polygons and 4.08 M vertices, and all 5.47 M internal neighbour
  edges are shared in reverse. The parse ends exactly at the end of the
  95 MB file.
- **`level.pak/ubernav.tmm`** (796 KB): a packed graph, probably the coarse
  long-distance travel network. Not decoded.

## Editor layers

- **Layer field.** Brush records carry the editor layer id at +28 (u32;
  0 = no layer). In Rataje, 169,731 brushes have no layer and 43,148 sit in
  611 layers.
- **Layer names.** `leveldata.xml` lists 1,969 layers
  (`<Layer Name="re_executioner_state0{guid}" Id="1269" Specs="-1"/>`).
  Layered entities live in `layers/*.xml` (not loaded); mission entities
  have no layer.
- **States coexist in the file:**
  - alternative versions of places (`re_executioner_state0` / `_state1`,
    `hall_state0` / `hall_state2` / `hall_state12`, burned or intact farms,
    with matching uber-LODs);
  - cutscene set dressing (`cin_*`), event obstacles and barriers.

  The game switches them through quest-driven "layer profiles"
  (`streamLayerProfile` in Libs/Haste; `layer_profile` columns in the New
  Homes tables), but the profile definitions are not in the shipped XML or
  Lua.
- **The viewer's default** (`web/src/levelLayers.ts`): hide `cin_*`,
  `event*`, `test*`, `_dream*` and barrier layers, plus state N > 0 when the
  same prefix has a state 0. That is 652 layers.
- **Before this,** drawing every layer together doubled buildings up and
  left set dressing floating in Rattay.
