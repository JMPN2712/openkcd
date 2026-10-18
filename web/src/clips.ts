// Which animation clips belong to a skeleton: its .chrparams lists folders
// (<Animation name="#filepath" path="Animations\humans\male"/>) whose .caf
// files apply, and may $Include other .chrparams.

import { parseXml } from "./xml.ts";
import type { Vfs } from "./vfs.ts";

function folders(vfs: Vfs, chrparams: string, out: Set<string>, seen: Set<string>): Promise<void> | void {
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
      if (a.attrs.name === "#filepath" && path) out.add(path + "/");
      else if (a.attrs.name === "$Include" && path) await folders(vfs, path, out, seen);
    }
  });
}

/** All .caf clips usable with `skeletonPath` (a .chr), sorted by path. */
export async function clipsFor(vfs: Vfs, skeletonPath: string): Promise<string[]> {
  const dirs = new Set<string>();
  await folders(vfs, skeletonPath.replace(/\.chr$/i, ".chrparams"), dirs, new Set());
  if (!dirs.size) return [];
  const prefixes = [...dirs];
  const clips: string[] = [];
  for (const p of vfs.paths()) {
    if (p.endsWith(".caf") && prefixes.some((d) => p.startsWith(d))) clips.push(p);
  }
  return clips.sort();
}
