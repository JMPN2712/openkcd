# Physics geometry and player collision

How KCD models store their collision geometry, and what OpenKCD's player
collides with. The format was worked out from the game's data files alone and
checked over every model in the install.

## MeshPhysicsData (chunk 0x1018 v0x800)

A mesh chunk (0x1000) lists up to four physics chunks in `nPhysicsDataChunkId[4]`,
right after its 16 stream ids. `$physics_proxy…` nodes point to mesh chunks
with no vertices whose only content is these physics chunks.

| Offset | Contents |
|---|---|
| +0 | `u32` size of the data after a 24-byte header |
| +32 | inertia (3 `f32`), principal-axes quaternion (4 `f32`), centre of mass (3 `f32`) |
| +72 | `f32` volume |
| +80 | `i32` surface / material index |
| +92 | `i32` geometry type; the geometry follows from +96 |

| Type | Geometry | Check |
|---|---|---|
| 0 box | basis (3×3 `f32`, rows = axes), `i32` oriented, centre, half-size | 8·hx·hy·hz = volume in 10,566 of 10,566 |
| 1 mesh | `i32` vertices, `i32` triangles, `i32`, `i32` flags, `u8` shared | see below |
| 4 sphere | centre, radius | |
| 5 cylinder | centre, axis, radius, half-height | πr²·2h = volume in 393 of 393 |
| 6 capsule | centre, axis, radius, half-height of the cylinder part | + 4/3πr³: 1,214 of 1,214 |

- **Mesh, shared = 0:** a proxy mesh. `f32×3` vertices start at +114, then
  `u16×3` indices per triangle. Every index is in range in all 867 such
  meshes.
- **Mesh, shared = 1:** no vertices; the render mesh itself is physicalised.
  The triangle count equals the render mesh's in 314 of 319 cases. In the
  other 5 it equals one subset combination (a castle wall's 225 of 33,000
  triangles, for example).
- **Space:** coordinates are in model space. Proxy centres lie inside the
  render bounds, whatever the proxy node's own offset.
- **Coverage near Rataje:** 72% of the models within 400 m of the town carry
  physics data.

## What the player collides with (`web/src/collision.ts`)

Per model, in this order:

1. **proxy:** its physics proxies (primitives tessellated into triangles),
   plus any render mesh that is physicalised itself;
2. **render:** no proxies, but a physicalised render mesh: its triangles, or
   the subsets matching the physics triangle count;
3. **visible (fallback):** no physics data at all: the simplified visible
   mesh (LOD1 when it exists), opaque subsets only;
4. **none:**
   - vegetation without physics (grass, bushes);
   - decals and uber-LODs;
   - models whose materials all have a surface type the player passes
     through (`Libs/MaterialEffects/SurfaceTypes.xml`, Physics
     `horse_only="1"` or `no_collide="1"`): bushes (`mat_vegetation`), and
     the invisible horse-only blockers level designers put in doorways
     (`brush/designer_*.cgf` with `materials/special/collision_proxy_horseonly`,
     surface type `mat_horse_only`). Solid for Henry, those had shut every
     doorway they stood in: 260 within 200 m of the market;
   - door and animated `.cdf` skins. Doors collide as moving shapes
     instead: the leaf's box, under its current swing, for the doors within
     12 m of Henry (`CollisionWorld.setDynamic`, `web/src/doors.ts`).

Terrain collision is the heightmap. Triangles go into 4 m cells, built when
the player first nears them.

**Sources around Rataje's market** (`scripts/test-collision.ts`, 200 m, 2,161
models):

| Category | proxy | render | visible | none |
|---|---|---|---|---|
| level brushes (designer geometry) | 81 | 23 | 0 | 260 (horse-only blockers) |
| buildings/houses | 174 | 0 | 54 | 13 |
| props/interiors | 93 | 0 | 23 | 24 |
| vegetation: trees | 75 | 0 | 0 | 16 |
| buildings/walls | 46 | 0 | 33 | 1 |
| buildings/castles | 53 | 0 | 14 | 10 |
| props/furniture | 63 | 0 | 2 | 2 |
| props/misc | 53 | 0 | 7 | 2 |
| props/groups_of_stuff, fences, rocks, ceramics, piles_of_logs, tools, carts | all | | | |
| doors and animated props (.cdf skins) | 0 | 0 | 0 | 42 |
| vegetation: bushes | 0 | 0 | 0 | 38 |
| props/windows | 1 | 0 | 11 | 0 |
| vegetation/vines, uberlods, nature/city_generic decals | | | | all |
| **All** | **1,334** | **23** | **220** | **584** |

## Character controller

`web/src/player.ts` is a kinematic capsule.

- **Values:** the actor scripts' living-entity values: 0.3 m radius, centre
  1.05 m above the feet, cylinder half-height 0.4 m. The capsule's lower end
  is at 0.35 m; the gap under it is the step height.
- **Ground:** a vertical probe finds the highest walkable surface (terrain or
  triangles).
- **Walls:** they push the capsule sideways, and the push is applied again
  after any step-up.

Checks:

- 150 random 6 s runs through the town: the capsule ends no frame more than
  1 cm inside geometry, never drops below the terrain, and costs 0.05 ms a
  frame.

## Open questions

- **Physicalised render subsets.** Which ones physicalise when only some do.
  OpenKCD picks the subset combination that matches the triangle count; the
  rule (probably the material's physicalise setting) needs confirming.
- **Models without physics data.** Whether the game gives them no collision
  at all. The "visible" fallback may block where the game doesn't (cloth,
  window frames).
- **Vegetation.** Collision from the vegetation group parameters is not read
  yet.
