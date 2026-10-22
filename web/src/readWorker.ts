// Browser worker for readWorkers.ts: reads and inflates pak entries.

import { readEntry } from "./zip.ts";
import type { ReadReply, ReadRequest } from "./readWorkers.ts";

const paks = new Map<number, Blob>();
self.onmessage = async (ev: MessageEvent<ReadRequest>) => {
  const { id, key, src, entry } = ev.data;
  if (src) paks.set(key, src as Blob);
  let reply: ReadReply;
  try {
    reply = { id, out: await readEntry(paks.get(key)!, entry, undefined, false) };
  } catch (err) {
    reply = { id, error: (err as Error).message };
  }
  (self as unknown as Worker).postMessage(reply, "out" in reply ? [reply.out.buffer] : []);
};
