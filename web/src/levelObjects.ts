// Static objects from the octree that follows the terrain in terrain.dat.
// Verified on Rataje (scripts/test-level-objects.ts, docs/LEVELS.md):
//
//   node: i16 version (5), u16 childMask (8 bits), AABB (6 f32), i32 objectBytes
//         objects (objectBytes), then the children whose mask bit is set, depth-first
//   objects in a node are sorted by type (EERType):
//     1 brush (100 bytes): u32 type, AABB, u32 (not the geometry: mostly 0),
//       u32 renderFlags, u16 nameIndex (into the brush-name table), u8, u8,
//       Matrix34 (3 rows of rotation·scale + translation), u32,
//       i32 materialIndex, u32
//       (the name index was confirmed by transforming each candidate model's
//       bbox by the matrix: u16 @+36 reproduces the stored AABB for 2150/2150
//       sampled brushes, u32 @+28 for 26)
//     2 vegetation (64 bytes): u32 type, AABB, u32, u32 renderFlags,
//       u16 groupIndex (vegetation group), u8, u8, Vec3 position, f32 scale,
//       u8 angle (1/256 turns about Z), 7 bytes
//     7 decal, 9 water volume, 11 road, 23 …: variable size, not decoded; since
//       blocks are sorted by type, parsing stops at the first of these.

export interface LevelObjects {
  /** brushes: name index, material index, world matrix (column-major 4×4) */
  brushName: Uint32Array;
  brushMaterial: Int32Array;
  brushMatrix: Float32Array; // 16 per brush
  /** vegetation: group index, position, scale, angle (radians) */
  vegGroup: Uint16Array;
  vegPos: Float32Array; // 3 per instance
  vegScale: Float32Array;
  vegAngle: Float32Array;
  nodes: number;
  skippedTypes: Map<number, number>; // blocks whose tail starts with an undecoded type
}

export function parseLevelObjects(bytes: Uint8Array, offset: number): LevelObjects {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // first pass: count, so the typed arrays can be sized exactly
  let nBrush = 0, nVeg = 0, nodes = 0;
  const skippedTypes = new Map<number, number>();
  const walk = (o: number, visit: (p: number, type: number) => void): number => {
    const version = dv.getInt16(o, true);
    if (version !== 5) throw new Error(`octree node version ${version} at byte ${o}`);
    const mask = dv.getUint16(o + 2, true);
    const size = dv.getInt32(o + 28, true);
    let p = o + 32;
    const end = p + size;
    while (p < end) {
      const type = dv.getUint32(p, true);
      if (type === 1) { visit(p, 1); p += 100; }
      else if (type === 2) { visit(p, 2); p += 64; }
      else break;
    }
    o = end;
    for (let c = 0; c < 8; c++) if (mask & (1 << c)) o = walk(o, visit);
    return o;
  };
  walk(offset, (p, t) => (t === 1 ? nBrush++ : nVeg++));

  const out: LevelObjects = {
    brushName: new Uint32Array(nBrush),
    brushMaterial: new Int32Array(nBrush),
    brushMatrix: new Float32Array(nBrush * 16),
    vegGroup: new Uint16Array(nVeg),
    vegPos: new Float32Array(nVeg * 3),
    vegScale: new Float32Array(nVeg),
    vegAngle: new Float32Array(nVeg),
    nodes: 0,
    skippedTypes,
  };
  let bi = 0, vi = 0;
  const end = walk(offset, (p, t) => {
    if (t === 1) {
      out.brushName[bi] = dv.getUint16(p + 36, true);
      out.brushMaterial[bi] = dv.getInt32(p + 92, true);
      const m = out.brushMatrix.subarray(bi * 16, bi * 16 + 16);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) m[c * 4 + r] = dv.getFloat32(p + 40 + (r * 4 + c) * 4, true);
      m[15] = 1;
      bi++;
    } else {
      out.vegGroup[vi] = dv.getUint16(p + 36, true);
      out.vegPos[vi * 3] = dv.getFloat32(p + 40, true);
      out.vegPos[vi * 3 + 1] = dv.getFloat32(p + 44, true);
      out.vegPos[vi * 3 + 2] = dv.getFloat32(p + 48, true);
      out.vegScale[vi] = dv.getFloat32(p + 52, true);
      out.vegAngle[vi] = (dv.getUint8(p + 56) / 256) * Math.PI * 2;
      vi++;
    }
  });
  // count nodes and the undecoded record types that end blocks
  const count = (o: number): number => {
    nodes++;
    const mask = dv.getUint16(o + 2, true);
    const size = dv.getInt32(o + 28, true);
    let p = o + 32;
    const blockEnd = p + size;
    while (p < blockEnd) {
      const type = dv.getUint32(p, true);
      if (type === 1) p += 100;
      else if (type === 2) p += 64;
      else { skippedTypes.set(type, (skippedTypes.get(type) ?? 0) + 1); break; }
    }
    o = blockEnd;
    for (let c = 0; c < 8; c++) if (mask & (1 << c)) o = count(o);
    return o;
  };
  count(offset);
  out.nodes = nodes;
  if (end !== bytes.byteLength) throw new Error(`octree ended at ${end}, file is ${bytes.byteLength} bytes`);
  return out;
}

/** Column-major world matrix for vegetation instance i. */
export function vegetationMatrix(o: LevelObjects, i: number, out = new Float32Array(16)): Float32Array {
  const s = o.vegScale[i], a = o.vegAngle[i];
  const c = Math.cos(a) * s, n = Math.sin(a) * s;
  out.set([c, n, 0, 0, -n, c, 0, 0, 0, 0, s, 0, o.vegPos[i * 3], o.vegPos[i * 3 + 1], o.vegPos[i * 3 + 2], 1]);
  return out;
}
