// Which animation clips belong to a skeleton: its .chrparams lists folders
// (<Animation name="#filepath" path="Animations\humans\male"/>) whose .caf
// files apply, animation databases (name="$TracksDatabase", path may contain
// a * wildcard), and may $Include other .chrparams.

import { parseXml } from "./xml.ts";
import type { Vfs } from "./vfs.ts";

interface Sources {
  folders: Set<string>;
  databases: Set<string>; // glob patterns
}

function folders(vfs: Vfs, chrparams: string, out: Sources, seen: Set<string>): Promise<void> | void {
  const key = chrparams.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  const hit = vfs.lookup(key);
  if (!hit) return;
  return vfs.read(hit).then(async (bytes) => {
    const root = parseXml(new TextDecoder().decode(bytes));
    const list = root.children.find((c) => c.tag === "Params")?.children.find((c) => c.tag === "AnimationList")?.children ?? [];
    for (const a of list) {
      if (a.tag !== "Animation") continue;
      const path = (a.attrs.path ?? "").replaceAll("\\", "/").toLowerCase().replace(/\/$/, "");
      if (a.attrs.name === "#filepath" && path) out.folders.add(path + "/");
      else if (a.attrs.name === "$TracksDatabase" && path) out.databases.add(path);
      else if (a.attrs.name === "$Include" && path) await folders(vfs, path, out, seen);
    }
  });
}

const globRe = (pattern: string) => new RegExp("^" + pattern.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");

/** Clips (.caf) and animation databases (.dba) usable with `skeletonPath` (a .chr), sorted by path. */
export async function clipsFor(vfs: Vfs, skeletonPath: string): Promise<{ clips: string[]; databases: string[] }> {
  const src: Sources = { folders: new Set(), databases: new Set() };
  await folders(vfs, skeletonPath.replace(/\.chr$/i, ".chrparams"), src, new Set());
  const prefixes = [...src.folders];
  const dbRes = [...src.databases].map(globRe);
  const clips: string[] = [];
  const databases: string[] = [];
  for (const p of vfs.paths()) {
    if (p.endsWith(".caf") && prefixes.some((d) => p.startsWith(d))) clips.push(p);
    else if (p.endsWith(".dba") && dbRes.some((r) => r.test(p))) databases.push(p);
  }
  return { clips: clips.sort(), databases: databases.sort() };
}
