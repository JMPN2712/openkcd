// Repacking the installed paks without dead files: versions of a file that
// a higher-priority pak replaces and that the engine can never pick. Later
// patches re-ship whole files, so the base game carries about 14 GiB of them.
//
// What counts as dead follows the engine's own choices (vfs.ts, texture.ts,
// model.ts), and errs on the side of keeping:
// - most files: the engine reads only the top version, so every lower one goes;
// - split texture mips (foo.dds.N): any version of the right size is taken,
//   highest first, so a version goes only if a higher one has the same size.
//   That holds whichever header asks for it, including HD headers added later;
// - texture headers: versions below the highest complete one (all its mips
//   present) go; with no complete version, all stay;
// - models: versions below the highest one with geometry go (fast-load stubs);
// - level paks (layered per level) and HD paks (switched on and off at run
//   time) are left alone and replace nothing, and equal ranks replace nothing.

import { readZip, type PakEntry } from "./zip.ts";
import { isPhantom, pakRank, Vfs, type VfsHit } from "./vfs.ts";
import { openTexture, TEXTURE_RE, textureStem } from "./texture.ts";
import { MODEL_RE } from "./model.ts";
import { parseCgf } from "./cgf.ts";
import type { PakSource } from "./paks.ts";

/** Paks the repack may shrink, and whose files may replace others'. */
export function repackable(path: string): boolean {
  const p = path.toLowerCase();
  return p.endsWith(".pak") && !p.startsWith("data/levels/") && !p.includes("_hd");
}

export interface PakPlan {
  pak: PakSource;
  entries: PakEntry[];
  /** where the central directory starts: the end of the last entry's data */
  cdOffset: number;
  /** entries to leave out */
  dead: Set<PakEntry>;
  /** compressed bytes of the dead entries */
  deadBytes: number;
}

/**
 * Work out the dead entries of every repackable pak in `paks`. With `only`, just the files those
 * paks hold are looked at (a part-by-part staging: what the paks just added change), in every pak.
 * Phantom entries (PakSource.phantoms) count for choosing versions but are never dead.
 */
export async function planRepack(paks: PakSource[], onProgress?: (done: number, total: number) => void, only?: Set<PakSource>): Promise<PakPlan[]> {
  const sources = paks.filter((p) => repackable(p.path));
  const vfs = await Vfs.build(sources, { filter: () => true, includeHd: false });
  const plans = new Map<PakSource, PakPlan>();
  for (const pak of sources) plans.set(pak, { pak, entries: [], cdOffset: 0, dead: new Set(), deadBytes: 0 });
  const kill = (h: VfsHit) => {
    if (isPhantom(h)) return;
    const plan = plans.get(h.pak)!;
    if (plan.dead.has(h.entry)) return;
    plan.dead.add(h.entry);
    plan.deadBytes += h.entry.csize;
  };
  const rank = (h: VfsHit) => pakRank(h.pak.path);

  const paths = only ? [...vfs.paths()].filter((p) => vfs.lookupAll(p).some((h) => only.has(h.pak))) : [...vfs.paths()];
  let done = 0;
  for (const path of paths) {
    if (++done % 4096 === 0) onProgress?.(done, paths.length);
    const hits = vfs.lookupAll(path); // highest first
    if (hits.length < 2) continue;
    let keepDownTo: number; // lowest rank still needed
    if (TEXTURE_RE.test(path) && textureStem(path) !== path) {
      // a split mip: dead if a higher version has the same size
      for (let i = 1; i < hits.length; i++) {
        if (hits.slice(0, i).some((h) => rank(h) > rank(hits[i]) && h.entry.usize === hits[i].entry.usize)) kill(hits[i]);
      }
      continue;
    } else if (TEXTURE_RE.test(path)) {
      const tex = await openTexture(vfs, path).catch(() => null);
      if (!tex || tex.partHits.length < tex.splitParts) continue; // no complete version: keep all
      keepDownTo = rank(tex.headerHit);
    } else if (MODEL_RE.test(path)) {
      let withMesh: VfsHit | null = null;
      for (const h of hits) {
        const ok = await vfs.read(h).then((b) => parseCgf(b).meshes.length > 0).catch(() => false);
        if (ok) {
          withMesh = h;
          break;
        }
      }
      if (!withMesh) continue;
      keepDownTo = rank(withMesh);
    } else {
      keepDownTo = rank(hits[0]);
    }
    for (const h of hits) if (rank(h) < keepDownTo) kill(h);
  }
  onProgress?.(paths.length, paths.length);

  // entries in pak order, as the rewrite needs them
  for (const plan of plans.values()) if (!only || plan.dead.size || only.has(plan.pak)) Object.assign(plan, await readZip(await plan.pak.open()));
  // Vfs.build read its own copies of the entries; match them up by offset
  for (const plan of plans.values()) {
    if (!plan.dead.size) continue;
    const offsets = new Set([...plan.dead].map((e) => e.offset));
    plan.dead = new Set(plan.entries.filter((e) => offsets.has(e.offset)));
  }
  return [...plans.values()];
}

/**
 * The pak without its dead entries, as a stream: the kept entries' local
 * headers, data and data descriptors are copied byte for byte, followed by
 * their central directory records (offsets updated) and a new end record.
 */
export async function* repackedPak(blob: Blob, plan: PakPlan): AsyncGenerator<Uint8Array> {
  const byOffset = [...plan.entries].sort((a, b) => a.offset - b.offset);
  const moved = new Map<PakEntry, number>();
  let out = 0;
  // copy runs of consecutive kept entries in one go
  let run: { start: number; end: number } | null = null;
  async function* flush(): AsyncGenerator<Uint8Array> {
    if (!run) return;
    const reader = blob.slice(run.start, run.end).stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
    run = null;
  }
  for (let i = 0; i < byOffset.length; i++) {
    const e = byOffset[i];
    const end = byOffset[i + 1]?.offset ?? plan.cdOffset;
    if (plan.dead.has(e)) {
      yield* flush();
      continue;
    }
    moved.set(e, out);
    out += end - e.offset;
    if (run && run.end === e.offset) run.end = end;
    else {
      yield* flush();
      run = { start: e.offset, end };
    }
  }
  yield* flush();

  const records = [...moved.keys()].sort((a, b) => a.record - b.record);
  const cdStart = records[0]?.record ?? 0;
  const cdEnd = records.reduce((a, e) => Math.max(a, e.record + e.recordLen), 0);
  const cd = new Uint8Array(await blob.slice(cdStart, cdEnd).arrayBuffer());
  const dir = new Uint8Array(records.reduce((a, e) => a + e.recordLen, 0) + 22);
  const view = new DataView(dir.buffer);
  let o = 0;
  for (const e of records) {
    dir.set(cd.subarray(e.record - cdStart, e.record - cdStart + e.recordLen), o);
    if (view.getUint32(o + 42, true) === 0xffffffff) throw new Error(`${e.name}: ZIP64 offsets are not supported`);
    view.setUint32(o + 42, moved.get(e)!, true);
    o += e.recordLen;
  }
  // end of central directory; like the game's own paks, the entry count is stored mod 65536
  view.setUint32(o, 0x06054b50, true);
  view.setUint16(o + 8, records.length & 0xffff, true);
  view.setUint16(o + 10, records.length & 0xffff, true);
  view.setUint32(o + 12, o, true);
  view.setUint32(o + 16, out, true);
  yield dir;
}

/** Size of the repacked pak. */
export function repackedSize(plan: PakPlan): number {
  const byOffset = [...plan.entries].sort((a, b) => a.offset - b.offset);
  let size = 22;
  byOffset.forEach((e, i) => {
    if (!plan.dead.has(e)) size += (byOffset[i + 1]?.offset ?? plan.cdOffset) - e.offset + e.recordLen;
  });
  return size;
}
