// Writing compact package entries (slim.ts): used by the converters only, so the meshoptimizer
// encoder stays out of the engine.
//
// Model entries are compressed losslessly in two steps, chosen by measuring (docs/SLIM.md):
// each mesh's vertex streams and its indices are encoded with meshoptimizer (byte-oriented,
// made to compress well), then the whole entry is deflated. Measured on a sample of Rataje's
// models: 37% of the raw size, against 41% with deflate alone and 36% with zstd, which the
// browser can't inflate natively.

import { MeshoptEncoder } from "meshoptimizer/encoder";
import type { ModelParts } from "./model.ts";
import { encodeEntry } from "./slim.ts";

/** Vertex streams of a mesh and their bytes per vertex. */
export const MESH_STREAMS: [string, number][] = [["positions", 12], ["normals", 12], ["tangents", 16], ["uvs", 8], ["colors", 4], ["boneIds", 8], ["boneWeights", 4]];

export const encoderReady = MeshoptEncoder.ready;

/** A typed array as meshoptimizer's vertex or index codec writes it (decodeEntry turns it back). */
function encoded(a: ArrayBufferView & { length: number }, kind: "v" | "i", count: number, size: number) {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const data = kind === "v" ? MeshoptEncoder.encodeVertexBufferLevel(bytes, count, size, 3) : MeshoptEncoder.encodeIndexBuffer(bytes, count, size);
  return { $mo: kind, t: a.constructor.name, n: a.length, count, size, data };
}

/** A model's entry: meshopt-encoded streams, then deflated. Returns the bytes stored and their size once inflated. */
export async function encodeModel(parts: ModelParts, deflate: (b: Uint8Array) => Promise<Uint8Array>): Promise<{ bytes: Uint8Array; raw: number }> {
  const meshes = parts.cgf.meshes.map((m) => {
    const out: Record<string, unknown> = { ...m };
    const nv = m.positions.length / 3;
    for (const [k, size] of MESH_STREAMS) {
      const a = (m as unknown as Record<string, (ArrayBufferView & { length: number }) | null>)[k];
      if (a && nv) out[k] = encoded(a, "v", nv, size);
    }
    // (triangle lists only; anything else stays as it is)
    if (m.indices.length && m.indices.length % 3 === 0) out.indices = encoded(m.indices, "i", m.indices.length, 4);
    return out;
  });
  const raw = encodeEntry({ path: parts.path, cgf: { ...parts.cgf, chunks: [], meshes }, skeleton: parts.skeleton, mtlPath: parts.mtlPath, materials: parts.materials });
  return { bytes: await deflate(raw), raw: raw.byteLength };
}
