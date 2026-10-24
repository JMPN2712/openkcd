// Discovery and classification of .pak files under a KCD game root.

import type { PakEntry } from "./zip.ts";

export type Owner =
  | "Base"
  | "Base patch"
  | "DLC2 · Hans Capon"
  | "DLC3 · Band of Bastards"
  | "DLC4 · A Woman's Lot"
  | "HD Texture Pack"
  | "Other DLC";

export const OWNER_ORDER: Owner[] = [
  "Base",
  "Base patch",
  "DLC2 · Hans Capon",
  "DLC3 · Band of Bastards",
  "DLC4 · A Woman's Lot",
  "HD Texture Pack",
  "Other DLC",
];

/** Anything that can hand out a Blob: a FileSystemFileHandle in the browser, a file in Node tests. */
export interface PakSource {
  path: string; // relative to game root, '/'-separated, original case
  size: number;
  open(): Promise<Blob>;
  /**
   * Entries left out of this copy that still count as present, by size only (a Potato staging
   * copy's texture mips above 512 px, compactInstall.ts): the VFS lists them so that choosing a
   * texture version gives what the whole pak would, but they can't be read.
   */
  phantoms?: PakEntry[];
}

export function classify(path: string): Owner {
  const p = path.toLowerCase();
  if (p.includes("_hd")) return "HD Texture Pack";
  const m = /dlc(\d)/.exec(p);
  if (m) {
    switch (m[1]) {
      case "2": return "DLC2 · Hans Capon";
      case "3": return "DLC3 · Band of Bastards";
      case "4": return "DLC4 · A Woman's Lot";
      default: return "Other DLC";
    }
  }
  if (p.startsWith("data/patch/") || p.startsWith("localization/patch/")) return "Base patch";
  return "Base";
}

// Folders that never contain game paks; skipping them keeps the scan fast.
const SKIP_DIRS = new Set(["__redist", "tmp", "app", "commonappdata", "bin", "user", "logs"]);

/** Recursively find .pak files below a directory handle picked by the user. */
export async function scanDirectory(root: FileSystemDirectoryHandle): Promise<PakSource[]> {
  const out: PakSource[] = [];
  async function walk(dir: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory") {
        if (depth === 0 && SKIP_DIRS.has(name.toLowerCase())) continue;
        if (depth < 6) await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, depth + 1);
      } else if (name.toLowerCase().endsWith(".pak")) {
        const fh = handle as FileSystemFileHandle;
        const file = await fh.getFile();
        out.push({ path: prefix + name, size: file.size, open: () => fh.getFile() });
      }
    }
  }
  await walk(root, "", 0);
  out.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base", numeric: true }));
  return out;
}

/** The game root is the folder holding Data/ and bin/ (any case). */
export async function looksLikeGameRoot(root: FileSystemDirectoryHandle): Promise<boolean> {
  const names = new Set<string>();
  for await (const name of root.keys()) names.add(name.toLowerCase());
  return names.has("data") && names.has("bin");
}
