// Compiled CryEngine terrain (levels/<name>/terrain/terrain.dat), as used by
// KCD. Layout and decoding verified on Rataje (scripts/test-terrain.ts,
// docs/LEVELS.md):
//
//   header (32 bytes): i8 version (28), i8, i8 flags, i8 flags2, u32 chunkSize,
//     u32 heightmapSize (4096), u32 unitSize (1), u32 sectorSize (64),
//     u32 sectorsTableSize (64), f32 heightmapZRatio, f32 oceanLevel
//   u32 nGroups, then nGroups × 360-byte vegetation groups (char name[256] + params)
//   u32 nBrushNames, then × 256-byte names (static objects referenced by the octree)
//   u32 nMaterials, then × 256-byte names
//   terrain quadtree, depth-first, children in (x0,y0) (x1,y0) (x0,y1) (x1,y1) order:
//     node: i16 version (7), i16 hasHoles, AABB (6 f32), f32 offset, f32 range,
//           i32 samplesPerSide (0 for inner nodes), i32 surfaceTypeCount
//           u16 samples[n*n] (padded to 4)   — stored X-major: index = x*n + y
//           f32 geometricError[6]
//           u8 surfaceTypes[count] (padded to 4)
//   object octree follows (not decoded here)
//
// Sample decoding (found from edge continuity between neighbouring leaves):
//   height = offset + (sample & 0xFFF0) / 320   metres
// i.e. 5 cm steps; the low 4 bits index the node's surface-type list. The
// stored "range" field is NOT the sample scale.

export interface VegetationGroup {
  index: number;
  model: string;
  /** raw 104-byte parameter block (bending, view distance, density, …) */
  params: Float32Array;
}

export interface Terrain {
  size: number; // heightmap samples per side - 1 (4096)
  unit: number; // metres per sample (1)
  sectorSize: number; // leaf size in metres (64)
  /** (size+1)² heights in 5 cm units, row-major [y][x] */
  heights: Uint16Array;
  /**
   * (size+1)² surface types, row-major [y][x]: the level's SurfaceTypeID (leveldata.xml
   * <SurfaceTypes>), from the sample's low 4 bits indexing its leaf's surface-type list; 255 none
   */
  surface: Uint8Array;
  minHeight: number;
  maxHeight: number;
  vegetation: VegetationGroup[];
  brushNames: string[];
  materials: string[];
  /** byte offset of the object octree that follows the terrain nodes */
  objectsOffset: number;
  leaves: number;
  leafResolutions: Map<number, number>;
}

export const HEIGHT_UNIT = 0.05; // metres per heights[] step

const latin1 = new TextDecoder("latin1");
const cstr = (b: Uint8Array, o: number, max: number) => {
  let e = o;
  while (e < o + max && b[e]) e++;
  return latin1.decode(b.subarray(o, e));
};
const align4 = (n: number) => (n + 3) & ~3;

export function parseTerrain(bytes: Uint8Array): Terrain {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getInt8(0);
  if (version !== 28) throw new Error(`terrain version ${version} not supported (expected 28)`);
  const size = dv.getUint32(8, true);
  const unit = dv.getUint32(12, true);
  const sectorSize = dv.getUint32(16, true);
  let o = 32;

  const nGroups = dv.getUint32(o, true);
  o += 4;
  const vegetation: VegetationGroup[] = [];
  for (let i = 0; i < nGroups; i++, o += 360) {
    vegetation.push({ index: i, model: cstr(bytes, o, 256).replaceAll("\\", "/").toLowerCase(), params: new Float32Array(bytes.slice(o + 256, o + 360).buffer) });
  }
  const names = () => {
    const n = dv.getUint32(o, true);
    o += 4;
    const out: string[] = [];
    for (let i = 0; i < n; i++, o += 256) out.push(cstr(bytes, o, 256).replaceAll("\\", "/").toLowerCase());
    return out;
  };
  const brushNames = names();
  const materials = names();

  const side = size / unit + 1;
  const heights = new Uint16Array(side * side);
  const surface = new Uint8Array(side * side).fill(255);
  let minHeight = Infinity, maxHeight = -Infinity, leaves = 0;
  const leafResolutions = new Map<number, number>();

  const node = (depth: number): void => {
    const v = dv.getInt16(o, true);
    if (v !== 7) throw new Error(`terrain node version ${v} at byte ${o}`);
    const bx = dv.getFloat32(o + 4, true), by = dv.getFloat32(o + 8, true);
    const bx1 = dv.getFloat32(o + 16, true);
    const offset = dv.getFloat32(o + 28, true);
    const n = dv.getInt32(o + 36, true);
    const nSurf = dv.getInt32(o + 40, true);
    const samples = o + 44;
    o = samples + align4(n * n * 2) + 24 + align4(nSurf);
    if (n > 1) {
      leaves++;
      leafResolutions.set(n, (leafResolutions.get(n) ?? 0) + 1);
      // place into the global grid; leaves span [bx, bx1] metres with n samples per side
      const span = Math.round((bx1 - bx) / unit);
      const x0 = Math.round(bx / unit), y0 = Math.round(by / unit);
      const step = span / (n - 1);
      const at = (ix: number, iy: number) => offset + (dv.getUint16(samples + (ix * n + iy) * 2, true) & 0xfff0) / 320;
      const types = samples + align4(n * n * 2) + 24;
      const surf = (ix: number, iy: number) => {
        const k = dv.getUint16(samples + (ix * n + iy) * 2, true) & 15;
        return k < nSurf ? dv.getUint8(types + k) : 255;
      };
      for (let gy = 0; gy <= span; gy++) {
        const fy = gy / step, iy = Math.min(n - 2, Math.floor(fy)), ty = fy - iy;
        for (let gx = 0; gx <= span; gx++) {
          const fx = gx / step, ix = Math.min(n - 2, Math.floor(fx)), tx = fx - ix;
          const h = step === 1
            ? at(gx, gy)
            : (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
          heights[(y0 + gy) * side + x0 + gx] = Math.max(0, Math.round(h / HEIGHT_UNIT));
          surface[(y0 + gy) * side + x0 + gx] = surf(Math.min(n - 1, Math.round(fx)), Math.min(n - 1, Math.round(fy)));
          if (h < minHeight) minHeight = h;
          if (h > maxHeight) maxHeight = h;
        }
      }
    }
    if (depth < 32 && (bx1 - bx) > sectorSize + 0.5) for (let c = 0; c < 4; c++) node(depth + 1);
  };
  node(0);
  return { size, unit, sectorSize, heights, surface, minHeight, maxHeight, vegetation, brushNames, materials, objectsOffset: o, leaves, leafResolutions };
}

/** Height in metres at world (x, y), bilinear. */
export function heightAt(t: Terrain, x: number, y: number): number {
  const side = t.size / t.unit + 1;
  const fx = Math.min(Math.max(x / t.unit, 0), side - 1.001), fy = Math.min(Math.max(y / t.unit, 0), side - 1.001);
  const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
  const h = (i: number, j: number) => t.heights[j * side + i] * HEIGHT_UNIT;
  return (h(ix, iy) * (1 - tx) + h(ix + 1, iy) * tx) * (1 - ty) + (h(ix, iy + 1) * (1 - tx) + h(ix + 1, iy + 1) * tx) * ty;
}
