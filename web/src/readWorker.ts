// Browser worker for readWorkers.ts: reads and inflates pak entries, and reads and decodes the
// pieces of a compact package (slim.ts: inflate, meshoptimizer decode), transferring the arrays.

import { readEntry } from "./zip.ts";
import { decodePiece } from "./slim.ts";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import type { ReadReply, ReadRequest } from "./readWorkers.ts";

const sources = new Map<number, Blob>();

/** The ArrayBuffers under every typed array in a decoded value (each once), to transfer. */
function buffers(v: unknown, out = new Set<ArrayBuffer>()): Set<ArrayBuffer> {
  if (ArrayBuffer.isView(v)) out.add(v.buffer as ArrayBuffer);
  else if (v instanceof Map) for (const x of v.values()) buffers(x, out);
  else if (Array.isArray(v)) for (const x of v) buffers(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) buffers(x, out);
  return out;
}

self.onmessage = async (ev: MessageEvent<ReadRequest>) => {
  const { id, key, src, entry, slim } = ev.data;
  if (src) sources.set(key, src as Blob);
  let reply: ReadReply;
  try {
    if (slim) {
      await MeshoptDecoder.ready;
      const { piece, entries } = slim;
      const bytes = new Uint8Array(await sources.get(key)!.slice(piece.o, piece.o + piece.n).arrayBuffer());
      reply = { id, values: await decodePiece(bytes, piece.o, entries) };
    } else {
      reply = { id, out: await readEntry(sources.get(key)!, entry!, undefined, false) };
    }
  } catch (err) {
    reply = { id, error: (err as Error).message };
  }
  (self as unknown as Worker).postMessage(reply, "out" in reply ? [reply.out.buffer] : "values" in reply ? [...buffers(reply.values)] : []);
};
