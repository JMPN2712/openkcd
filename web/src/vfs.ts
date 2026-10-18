// Game-wide virtual file system: merges selected entries from every pak
// into one case-insensitive path map, with later layers overriding earlier
// ones the way the game applies them (base < DLC < HD textures < patches).
//
// Only entries accepted by `filter` are kept, so indexing a million-file
// install stays cheap (textures only: ~240k entries).

import { readCentralDirectory, readEntry, type PakEntry } from "./zip.ts";
import type { PakSource } from "./paks.ts";

export interface VfsHit {
  pak: PakSource;
  entry: PakEntry;
}

/**
 * Load-order rank for a pak path. Higher wins. Inferred from the data, not
 * from engine code: patch paks (ranked by version suffix, e.g.
 * ipl_patch_010700b) override base and DLC, and HD paks override everything
 * non-HD: the 1.4–1.7 patches re-ship 1024² headers for textures whose 2048²
 * HD header has no HD patch, so patches can't outrank the HD pack.
 * Callers still pick the best *complete* version (texture.ts, model.ts).
 */
export function pakRank(path: string): number {
  const p = path.toLowerCase();
  const hd = p.includes("_hd") ? 1_000_000 : 0;
  // _fastload/startup_*.pak hold stub models without geometry and early copies
  // of texture headers: lowest priority within their group
  if (p.includes("_fastload/")) return hd - 1;
  const m = /patch_(\d{6})(b?)/.exec(p);
  if (m) return hd + 1000 + Number(m[1]) * 10 + (p.includes("ipl_") ? 1 : 0) + (m[2] ? 2 : 0);
  if (/dlc\d/.test(p)) return hd + 100;
  return hd;
}

export class Vfs {
  /** every version of each file, ascending rank: the last one wins */
  private files = new Map<string, VfsHit[]>();
  private blobs = new Map<PakSource, Promise<Blob>>();

  get size(): number {
    return this.files.size;
  }

  static async build(
    paks: PakSource[],
    opts: { filter: (lowerName: string) => boolean; includeHd: boolean; onProgress?: (done: number, total: number) => void },
  ): Promise<Vfs> {
    const vfs = new Vfs();
    const ordered = paks
      .filter((p) => opts.includeHd || !p.path.toLowerCase().includes("_hd"))
      .sort((a, b) => pakRank(a.path) - pakRank(b.path) || a.path.localeCompare(b.path));
    let done = 0;
    for (const pak of ordered) {
      const entries = await readCentralDirectory(await vfs.blob(pak));
      for (const entry of entries) {
        const key = entry.name.toLowerCase();
        if (!opts.filter(key)) continue;
        const list = vfs.files.get(key);
        if (list) list.push({ pak, entry });
        else vfs.files.set(key, [{ pak, entry }]);
      }
      opts.onProgress?.(++done, ordered.length);
    }
    return vfs;
  }

  /**
   * A copy of this VFS with one pak's matching entries layered on top: used
   * for a level pak, whose files (brush/*.cgf, …) are referenced as
   * %level%/… and must not be confused with another level's.
   */
  async extend(pak: PakSource, filter: (lowerName: string) => boolean): Promise<Vfs> {
    const v = new Vfs();
    for (const [k, list] of this.files) v.files.set(k, list);
    v.blobs = this.blobs;
    for (const entry of await readCentralDirectory(await v.blob(pak))) {
      const key = entry.name.toLowerCase();
      if (!filter(key)) continue;
      v.files.set(key, [...(v.files.get(key) ?? []), { pak, entry }]);
    }
    return v;
  }

  private blob(pak: PakSource): Promise<Blob> {
    let b = this.blobs.get(pak);
    if (!b) this.blobs.set(pak, (b = pak.open()));
    return b;
  }

  lookup(path: string): VfsHit | undefined {
    return this.files.get(path.toLowerCase().replaceAll("\\", "/"))?.at(-1);
  }

  /** All versions of a path, highest priority first. */
  lookupAll(path: string): VfsHit[] {
    return [...(this.files.get(path.toLowerCase().replaceAll("\\", "/")) ?? [])].reverse();
  }

  paths(): IterableIterator<string> {
    return this.files.keys();
  }

  async read(hit: VfsHit, limit?: number): Promise<Uint8Array> {
    return readEntry(await this.blob(hit.pak), hit.entry, limit);
  }
}
