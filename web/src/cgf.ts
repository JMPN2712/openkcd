// CryEngine chunk-file (CrCh 0x746) geometry reader for .cgf/.cga/.skin/.chr.
// Static mesh data only: nodes, meshes, data streams, subsets, material name.
// Chunk ids/versions were verified against the KCD install (docs/RECON.md).

import { halfToFloat } from "./bcn.ts";

export const CHUNK = {
  Mesh: 0x1000,
  Helper: 0x1001,
  Node: 0x100b,
  MtlName: 0x1014,
  ExportFlags: 0x1015,
  DataStream: 0x1016,
  MeshSubsets: 0x1017,
  MeshPhysicsData: 0x1018,
} as const;

/** Compiled character chunks (.chr/.skin). */
export const CHUNK_SKELETON = {
  CompiledBones: 0x2000,
  CompiledPhysicalBones: 0x2001,
  CompiledMorphTargets: 0x2002,
  CompiledPhysicalProxies: 0x2003,
  CompiledIntFaces: 0x2004,
  CompiledIntSkinVertices: 0x2005,
  CompiledExt2IntMap: 0x2006,
  BonesBoxes: 0x3004,
} as const;

export const STREAM = {
  Positions: 0,
  Normals: 1,
  TexCoords: 2,
  Colors: 3,
  Colors2: 4,
  Indices: 5,
  Tangents: 6,
  ShapeDeformation: 8,
  BoneMapping: 9,
  FaceMap: 10,
  VertMats: 11,
  QTangents: 12,
  SkinData: 13,
  P3S_C4B_T2S: 15,
} as const;

export interface ChunkInfo {
  type: number;
  version: number;
  id: number;
  size: number;
  offset: number;
}

export interface Subset {
  firstIndex: number;
  numIndices: number;
  firstVert: number;
  numVerts: number;
  matId: number;
}

export interface CgfMesh {
  nodeName: string;
  /** node-to-model transform, column-major 4×4 */
  transform: Float32Array;
  positions: Float32Array; // xyz
  normals: Float32Array | null; // xyz
  uvs: Float32Array | null; // uv
  /** skinning (stream 9): 4 bone indices into the file's own CompiledBones list, 4 weights /255 */
  boneIds: Uint16Array | null;
  boneWeights: Uint8Array | null;
  indices: Uint32Array;
  subsets: Subset[];
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

export interface Cgf {
  chunks: ChunkInfo[];
  meshes: CgfMesh[];
  /** material file name from the node's MtlName chunk (no extension), if any */
  material: string | null;
  /** nodes skipped because they are physics proxies / helpers / empty */
  skippedNodes: string[];
}

function cstr(b: Uint8Array, o: number, max: number): string {
  let e = o;
  while (e < o + max && b[e]) e++;
  return new TextDecoder("latin1").decode(b.subarray(o, e));
}

interface Stream {
  type: number;
  count: number;
  elemSize: number;
  data: DataView;
}

export function parseCgf(bytes: Uint8Array): Cgf {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = cstr(bytes, 0, 4);
  const version = dv.getUint32(4, true);
  if (sig !== "CrCh" || version !== 0x746) throw new Error(`not a CryEngine 0x746 chunk file (${sig} ${version.toString(16)})`);
  const count = dv.getUint32(8, true);
  const tableOffset = dv.getUint32(12, true);
  const chunks: ChunkInfo[] = [];
  const byId = new Map<number, ChunkInfo>();
  for (let i = 0; i < count; i++) {
    const o = tableOffset + i * 16;
    const c = {
      type: dv.getUint16(o, true),
      version: dv.getUint16(o + 2, true),
      id: dv.getUint32(o + 4, true),
      size: dv.getUint32(o + 8, true),
      offset: dv.getUint32(o + 12, true),
    };
    if (c.offset + c.size > bytes.byteLength) throw new Error(`chunk ${c.id} extends past end of file`);
    chunks.push(c);
    byId.set(c.id, c);
  }

  const chunk = (id: number, type: number): ChunkInfo | null => {
    const c = byId.get(id);
    return c && c.type === type ? c : null;
  };

  const readStream = (id: number): Stream | null => {
    const c = chunk(id, CHUNK.DataStream);
    if (!c) return null;
    if (c.version !== 0x800) throw new Error(`data stream chunk version ${c.version.toString(16)} not supported`);
    const type = dv.getInt32(c.offset + 4, true);
    const n = dv.getInt32(c.offset + 8, true);
    const elemSize = dv.getInt32(c.offset + 12, true);
    const start = c.offset + 24;
    if (start + n * elemSize > c.offset + c.size) throw new Error(`stream ${id} data exceeds its chunk`);
    return { type, count: n, elemSize, data: new DataView(bytes.buffer, bytes.byteOffset + start, n * elemSize) };
  };

  const readSubsets = (id: number): Subset[] => {
    const c = chunk(id, CHUNK.MeshSubsets);
    if (!c) return [];
    const n = dv.getInt32(c.offset + 4, true);
    const out: Subset[] = [];
    for (let i = 0; i < n; i++) {
      const o = c.offset + 16 + i * 36;
      out.push({
        firstIndex: dv.getInt32(o, true),
        numIndices: dv.getInt32(o + 4, true),
        firstVert: dv.getInt32(o + 8, true),
        numVerts: dv.getInt32(o + 12, true),
        matId: dv.getInt32(o + 16, true),
      });
    }
    return out;
  };

  // node transforms: tm is node-to-parent, row-vector convention (translation in m[12..14])
  interface NodeInfo { name: string; objectId: number; parentId: number; matId: number; tm: Float32Array }
  const nodes = new Map<number, NodeInfo>();
  for (const c of chunks) {
    if (c.type !== CHUNK.Node) continue;
    if (c.version !== 0x824) throw new Error(`node chunk version ${c.version.toString(16)} not supported`);
    const tm = new Float32Array(16);
    for (let i = 0; i < 16; i++) tm[i] = dv.getFloat32(c.offset + 84 + i * 4, true);
    // stored as an affine 4×3 with the 4th column zeroed (tm[15] == 0): make it a proper 4×4
    tm[3] = tm[7] = tm[11] = 0;
    tm[15] = 1;
    // translation is in centimetres while vertices are in metres (e.g. cart_01.cga wheels at 62.3, 71.2)
    tm[12] /= 100;
    tm[13] /= 100;
    tm[14] /= 100;
    nodes.set(c.id, {
      name: cstr(bytes, c.offset, 64),
      objectId: dv.getInt32(c.offset + 64, true),
      parentId: dv.getInt32(c.offset + 68, true),
      matId: dv.getInt32(c.offset + 76, true),
      tm,
    });
  }
  const worldTm = (n: NodeInfo): Float32Array => {
    // row-vector matrices compose as child * parent; stored as row-major == column-major of the transpose,
    // which is exactly what a column-vector GPU convention (WebGPU/WGSL) wants.
    let m = n.tm;
    let p = nodes.get(n.parentId);
    for (let guard = 0; p && guard < 64; guard++) {
      m = mul(m, p.tm);
      p = nodes.get(p.parentId);
    }
    return m;
  };

  let material: string | null = null;
  const meshes: CgfMesh[] = [];
  const skippedNodes: string[] = [];
  for (const node of nodes.values()) {
    const mc = chunk(node.objectId, CHUNK.Mesh);
    if (!mc) continue; // helpers, bones
    if (mc.version !== 0x801 && mc.version !== 0x802) throw new Error(`mesh chunk version ${mc.version.toString(16)} not supported`);
    const o = mc.offset;
    const nVerts = dv.getInt32(o + 8, true);
    const nIndices = dv.getInt32(o + 12, true);
    if (node.name.startsWith("$") || nVerts === 0 || nIndices === 0) {
      skippedNodes.push(node.name);
      continue;
    }
    const mtl = chunk(node.matId, CHUNK.MtlName);
    if (mtl && material === null) material = cstr(bytes, mtl.offset, 128);

    const streamIds: number[] = [];
    // 0x801: nStreamChunkID[16]; 0x802: nStreamChunkID[16][8] (first column used)
    const per = mc.version === 0x802 ? 8 : 1;
    for (let s = 0; s < 16; s++) streamIds.push(dv.getInt32(o + 28 + s * 4 * per, true));
    const bboxOff = o + 28 + 16 * 4 * per + 16;
    const bboxMin: [number, number, number] = [dv.getFloat32(bboxOff, true), dv.getFloat32(bboxOff + 4, true), dv.getFloat32(bboxOff + 8, true)];
    const bboxMax: [number, number, number] = [dv.getFloat32(bboxOff + 12, true), dv.getFloat32(bboxOff + 16, true), dv.getFloat32(bboxOff + 20, true)];

    const get = (t: number) => (streamIds[t] ? readStream(streamIds[t]) : null);
    const pos = get(STREAM.Positions) ?? get(STREAM.P3S_C4B_T2S);
    const idx = get(STREAM.Indices);
    if (!pos || !idx) {
      skippedNodes.push(node.name);
      continue;
    }
    const positions = decodePositions(pos, nVerts);
    const uvs = decodeUvs(get(STREAM.TexCoords), pos.type === STREAM.P3S_C4B_T2S ? pos : null, nVerts);
    const normals = decodeNormals(get(STREAM.Normals), get(STREAM.Tangents), get(STREAM.QTangents), nVerts);
    const { boneIds, boneWeights } = decodeBoneMapping(get(STREAM.BoneMapping), nVerts);
    const indices = new Uint32Array(nIndices);
    for (let i = 0; i < nIndices; i++) indices[i] = idx.elemSize === 2 ? idx.data.getUint16(i * 2, true) : idx.data.getUint32(i * 4, true);

    const subsets = readSubsets(dv.getInt32(o + 20, true));
    meshes.push({
      nodeName: node.name,
      transform: worldTm(node),
      positions, normals, uvs, indices, boneIds, boneWeights,
      subsets: subsets.length ? subsets : [{ firstIndex: 0, numIndices: nIndices, firstVert: 0, numVerts: nVerts, matId: 0 }],
      bboxMin, bboxMax,
    });
  }
  return { chunks, meshes, material, skippedNodes };
}

function mul(a: Float32Array, b: Float32Array): Float32Array {
  // row-major a*b
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      r[i * 4 + j] = s;
    }
  }
  return r;
}

function decodePositions(s: Stream, n: number): Float32Array {
  if (s.count < n) throw new Error(`position stream has ${s.count} entries, mesh needs ${n}`);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * s.elemSize;
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] =
        s.elemSize === 12 || (s.elemSize === 16 && s.type === STREAM.Positions)
          ? s.data.getFloat32(o + c * 4, true)
          : halfToFloat(s.data.getUint16(o + c * 2, true)); // 8-byte half4, or P3S_C4B_T2S
    }
  }
  return out;
}

function decodeUvs(s: Stream | null, packed: Stream | null, n: number): Float32Array | null {
  const out = new Float32Array(n * 2);
  if (s && s.count >= n) {
    for (let i = 0; i < n * 2; i++) out[i] = s.data.getFloat32(i * 4, true);
    return out;
  }
  if (packed) {
    // P3S_C4B_T2S: half4 position, ubyte4 colour, half2 uv
    for (let i = 0; i < n; i++) {
      out[i * 2] = halfToFloat(packed.data.getUint16(i * 16 + 12, true));
      out[i * 2 + 1] = halfToFloat(packed.data.getUint16(i * 16 + 14, true));
    }
    return out;
  }
  return null;
}

function decodeNormals(normals: Stream | null, tangents: Stream | null, qtangents: Stream | null, n: number): Float32Array | null {
  const out = new Float32Array(n * 3);
  if (normals && normals.count >= n && normals.elemSize === 12) {
    for (let i = 0; i < n * 3; i++) out[i] = normals.data.getFloat32(i * 4, true);
    return out;
  }
  if (tangents && tangents.count >= n && tangents.elemSize === 16) {
    // SPipTangents: tangent int16×4 (w = handedness), bitangent int16×4; normal = (t × b) * w
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const t = [0, 1, 2, 3].map((c) => tangents.data.getInt16(o + c * 2, true) / 32767);
      const b = [0, 1, 2].map((c) => tangents.data.getInt16(o + 8 + c * 2, true) / 32767);
      const w = t[3] < 0 ? -1 : 1;
      let x = (t[1] * b[2] - t[2] * b[1]) * w, y = (t[2] * b[0] - t[0] * b[2]) * w, z = (t[0] * b[1] - t[1] * b[0]) * w;
      const l = Math.hypot(x, y, z) || 1;
      out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
    }
    return out;
  }
  if (qtangents && qtangents.count >= n && qtangents.elemSize === 8) {
    // quaternion int16×4; normal = third column of the rotation, sign from w
    for (let i = 0; i < n; i++) {
      const [x, y, z, w] = [0, 1, 2, 3].map((c) => qtangents.data.getInt16(i * 8 + c * 2, true) / 32767);
      const s = w < 0 ? -1 : 1;
      out[i * 3] = (2 * (x * z + y * w)) * s;
      out[i * 3 + 1] = (2 * (y * z - x * w)) * s;
      out[i * 3 + 2] = (1 - 2 * (x * x + y * y)) * s;
    }
    return out;
  }
  return null;
}


/** Bone mapping stream: 12 bytes = u16×4 ids + u8×4 weights, or 8 bytes = u8×4 + u8×4. */
function decodeBoneMapping(s: Stream | null, n: number): { boneIds: Uint16Array | null; boneWeights: Uint8Array | null } {
  if (!s || s.count < n || (s.elemSize !== 12 && s.elemSize !== 8)) return { boneIds: null, boneWeights: null };
  const ids = new Uint16Array(n * 4);
  const w = new Uint8Array(n * 4);
  const wide = s.elemSize === 12;
  for (let i = 0; i < n; i++) {
    const o = i * s.elemSize;
    for (let k = 0; k < 4; k++) {
      ids[i * 4 + k] = wide ? s.data.getUint16(o + k * 2, true) : s.data.getUint8(o + k);
      w[i * 4 + k] = s.data.getUint8(o + (wide ? 8 : 4) + k);
    }
  }
  return { boneIds: ids, boneWeights: w };
}
