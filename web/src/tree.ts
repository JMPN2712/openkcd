// Case-insensitive directory tree built from a pak's entry list.
// CryEngine resolves paths case-insensitively, and KCD's paks mix cases
// ("Libs/" vs "libs/"), so siblings are merged by lowercase name and the
// first spelling seen is kept for display.

import type { PakEntry } from "./zip.ts";

export interface TreeDir {
  name: string;
  dirs: Map<string, TreeDir>;
  files: Map<string, PakEntry>;
  fileCount: number; // recursive
  size: number; // recursive, uncompressed
}

function newDir(name: string): TreeDir {
  return { name, dirs: new Map(), files: new Map(), fileCount: 0, size: 0 };
}

export function buildTree(entries: PakEntry[]): TreeDir {
  const root = newDir("");
  for (const e of entries) {
    const parts = e.name.split("/").filter(Boolean);
    let d = root;
    d.fileCount++;
    d.size += e.usize;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i].toLowerCase();
      let next = d.dirs.get(key);
      if (!next) d.dirs.set(key, (next = newDir(parts[i])));
      d = next;
      d.fileCount++;
      d.size += e.usize;
    }
    d.files.set(parts[parts.length - 1].toLowerCase(), e);
  }
  return root;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function sortedDirs(d: TreeDir): TreeDir[] {
  return [...d.dirs.values()].sort((a, b) => collator.compare(a.name, b.name));
}

export function sortedFiles(d: TreeDir): PakEntry[] {
  return [...d.files.values()].sort((a, b) => collator.compare(baseName(a.name), baseName(b.name)));
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
