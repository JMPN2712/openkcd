// A pak read in place from the GOG installer, without installing it (docs/SLIM.md, phase 4).
// GOG stores each file as zlib parts of 10 MiB (docs/INSTALLER.md), so a read inflates just the
// parts it covers: the pak's central directory is in its last part, and an entry in one or two.
// The pak readers only use size, slice(), arrayBuffer() and stream(), so this stands in for the
// Blob of an installed pak (not for the read workers: it can't be posted to them).

import { inflatePart, type InstallerFile, type Part } from "./inno.ts";
import type { PakSource } from "./paks.ts";

type SliceOf = (index: number) => Promise<Blob>;

/** Inflated parts recently read, shared by all of an install's paks (least recently used out). */
export class PartCache {
  private parts = new Map<Part, Promise<Uint8Array>>();
  private readonly max: number;
  constructor(maxParts = 24) {
    this.max = maxParts;
  }
  get(part: Part, slice: SliceOf): Promise<Uint8Array> {
    let p = this.parts.get(part);
    if (p) this.parts.delete(part); // re-inserted below: most recent last
    else p = inflatePart(part, slice);
    this.parts.set(part, p);
    if (this.parts.size > this.max) this.parts.delete(this.parts.keys().next().value!);
    p.catch(() => this.parts.delete(part));
    return p;
  }
}

/** A byte range of an installer file, Blob-like. */
class PartsBlob {
  readonly size: number;
  private readonly file: InstallerFile;
  private readonly starts: number[]; // inflated offset of each part
  private readonly slices: SliceOf;
  private readonly cache: PartCache;
  private readonly start: number;
  private readonly end: number;
  constructor(file: InstallerFile, starts: number[], slices: SliceOf, cache: PartCache, start: number, end: number) {
    this.file = file;
    this.starts = starts;
    this.slices = slices;
    this.cache = cache;
    this.start = start;
    this.end = end;
    this.size = end - start;
  }

  slice(a = 0, b = this.size): PartsBlob {
    const clamp = (x: number) => Math.max(0, Math.min(this.size, x < 0 ? this.size + x : x));
    const s = this.start + clamp(a);
    return new PartsBlob(this.file, this.starts, this.slices, this.cache, s, Math.max(s, this.start + clamp(b)));
  }

  /** The parts covering [start, end), with the byte range wanted of each. */
  private *covering(): Generator<{ part: Part; from: number; to: number }> {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= this.start) lo = mid;
      else hi = mid - 1;
    }
    for (let i = lo; i < this.file.parts.length && this.starts[i] < this.end; i++) {
      const p = this.file.parts[i];
      yield { part: p, from: Math.max(0, this.start - this.starts[i]), to: Math.min(p.size, this.end - this.starts[i]) };
    }
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const { part, from, to } of this.covering()) {
      out.set((await this.cache.get(part, this.slices)).subarray(from, to), o);
      o += to - from;
    }
    return out.buffer;
  }

  /** Sequential reads (copying a pak): parts inflated one at a time, not cached. */
  stream(): ReadableStream<Uint8Array> {
    const it = this.covering();
    return new ReadableStream<Uint8Array>({
      pull: async (c) => {
        const n = it.next();
        if (n.done) return c.close();
        const { part, from, to } = n.value;
        c.enqueue((await inflatePart(part, this.slices)).subarray(from, to));
      },
    });
  }
}

/** A pak of an installer as a PakSource (read in place). */
export function installerPak(file: InstallerFile, slices: SliceOf, cache: PartCache): PakSource {
  const starts: number[] = [];
  let at = 0;
  for (const p of file.parts) {
    starts.push(at);
    at += p.size;
  }
  const blob = new PartsBlob(file, starts, slices, cache, 0, file.size) as unknown as Blob;
  return { path: file.path, size: file.size, open: async () => blob };
}
