// Node worker for src/readWorkers.ts (the headless scripts): reads and inflates pak entries.

import { parentPort } from "node:worker_threads";
import { openAsBlob } from "node:fs";
import { readEntry } from "../src/zip.ts";
import type { ReadReply, ReadRequest } from "../src/readWorkers.ts";

const paks = new Map<number, Promise<Blob>>();
parentPort!.on("message", async ({ id, key, src, entry }: ReadRequest) => {
  if (src) paks.set(key, openAsBlob(src as string));
  let reply: ReadReply;
  try {
    // (compact package pieces are decoded in Node's main thread: nodeSlimFiles)
    if (!entry) throw new Error("only pak entries are read here");
    reply = { id, out: await readEntry(await paks.get(key)!, entry, undefined, false) };
  } catch (err) {
    reply = { id, error: (err as Error).message };
  }
  parentPort!.postMessage(reply, "out" in reply ? [reply.out.buffer as ArrayBuffer] : []);
});
