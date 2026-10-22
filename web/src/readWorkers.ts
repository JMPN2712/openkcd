// Pak entry reads (Blob slice + inflate) on worker threads, so streaming models and textures
// doesn't stall the frame. Vfs.read hands entries of READ_IN_WORKER bytes or more to a ReadWorkers
// when one is set; small reads stay on the calling thread (a round trip costs more than they do).
//
// The worker (readWorker.ts in the browser, scripts/readWorker-node.ts in Node) is sent each pak
// once: a Blob in the browser (Files from OPFS or a picked folder clone cheaply), a file path in
// Node (file-backed Blobs don't clone there).

import type { PakEntry } from "./zip.ts";
import type { PakSource } from "./paks.ts";

/** Compressed bytes from which an entry is read on a worker. */
export const READ_IN_WORKER = 32 * 1024;

export interface ReadRequest {
  id: number;
  /** the pak, and on its first request to this worker what to open it from */
  key: number;
  src?: Blob | string;
  entry: PakEntry;
}
export type ReadReply = { id: number; out: Uint8Array } | { id: number; error: string };

/** The part of a Web Worker or a worker_threads Worker this needs. */
export interface WorkerPort {
  postMessage(m: ReadRequest): void;
  onReply(fn: (r: ReadReply) => void): void;
  terminate(): void;
}

export class ReadWorkers {
  private workers: { port: WorkerPort; busy: number; sent: Set<number> }[];
  private keys = new Map<PakSource, number>();
  private waiting = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private handleOf: (pak: PakSource, blob: Blob) => Blob | string;

  constructor(ports: WorkerPort[], handleOf: (pak: PakSource, blob: Blob) => Blob | string = (_p, b) => b) {
    this.handleOf = handleOf;
    this.workers = ports.map((port) => ({ port, busy: 0, sent: new Set<number>() }));
    for (const w of this.workers) {
      w.port.onReply((r) => {
        w.busy--;
        const p = this.waiting.get(r.id);
        if (!p) return;
        this.waiting.delete(r.id);
        if ("error" in r) p.reject(new Error(r.error));
        else p.resolve(r.out);
      });
    }
  }

  /** Browser workers: one per spare core, 1 to 4. */
  static browser(): ReadWorkers {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 2));
    return new ReadWorkers(Array.from({ length: n }, () => {
      const w = new Worker(new URL("./readWorker.ts", import.meta.url), { type: "module" });
      return { postMessage: (m) => w.postMessage(m), onReply: (fn) => { w.onmessage = (ev) => fn(ev.data as ReadReply); }, terminate: () => w.terminate() };
    }));
  }

  read(pak: PakSource, blob: Blob, entry: PakEntry): Promise<Uint8Array> {
    let key = this.keys.get(pak);
    if (key === undefined) this.keys.set(pak, (key = this.keys.size));
    // the least busy worker
    let w = this.workers[0];
    for (const x of this.workers) if (x.busy < w.busy) w = x;
    w.busy++;
    const id = this.nextId++;
    const req: ReadRequest = { id, key, entry };
    if (!w.sent.has(key)) { w.sent.add(key); req.src = this.handleOf(pak, blob); }
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      w.port.postMessage(req);
    });
  }

  terminate(): void {
    for (const w of this.workers) w.port.terminate();
    for (const p of this.waiting.values()) p.reject(new Error("read workers stopped"));
    this.waiting.clear();
  }
}
