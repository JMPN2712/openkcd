// Node test for src/anim.ts: parses every .caf in a real install (read-only),
// checks that controller blocks add up to their chunk sizes, key times increase,
// and controllers map to skeleton bones.
// usage: node scripts/test-anim.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { parseCaf } from "../src/anim.ts";
import { parseSkeleton } from "../src/skeleton.ts";

const root = process.argv[2] ?? join(homedir(), "kcd1");
async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak")) out.push(p);
  }
  return out;
}

// controller ids of the human male skeleton, to check how many tracks map to bones
const chars = await openAsBlob(join(root, "Data/Characters.pak"));
const maleEntry = (await readCentralDirectory(chars)).find((e) => e.name.toLowerCase() === "objects/characters/humans/skeleton/male.chr")!;
const male = parseSkeleton(await readEntry(chars, maleEntry))!;
const maleIds = new Set(male.bones.map((b) => b.controllerId));

let files = 0, tracks = 0, keys = 0, humanFiles = 0, humanTracks = 0, humanMapped = 0, nonMonotonic = 0;
const errors = new Map<string, string[]>();
const fpsSeen = new Map<number, number>();
const t0 = performance.now();
for (const pak of await findPaks(root)) {
  const blob = await openAsBlob(pak);
  for (const e of (await readCentralDirectory(blob)).filter((e) => e.name.toLowerCase().endsWith(".caf"))) {
    files++;
    try {
      const clip = parseCaf(await readEntry(blob, e));
      fpsSeen.set(clip.fps, (fpsSeen.get(clip.fps) ?? 0) + 1);
      const human = e.name.toLowerCase().includes("/humans/male") || e.name.toLowerCase().includes("/humans/") && !e.name.toLowerCase().includes("female");
      if (human) humanFiles++;
      for (const t of clip.tracks.values()) {
        tracks++;
        keys += t.rotations.length + t.positions.length;
        for (const times of [t.rotTimes, t.posTimes]) for (let i = 1; i < times.length; i++) if (times[i] <= times[i - 1]) { nonMonotonic++; break; }
        if (human) { humanTracks++; if (maleIds.has(t.controllerId)) humanMapped++; }
      }
    } catch (err) {
      const k = (err as Error).message.replace(/\d+/g, "N");
      if (!errors.has(k)) errors.set(k, []);
      errors.get(k)!.push(e.name);
    }
  }
}
console.log(`${files} .caf files, ${tracks} tracks, ${(keys / 1e6).toFixed(1)}M keys, ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log(`tracks with non-increasing key times: ${nonMonotonic}`);
console.log(`human clips: ${humanFiles}; their tracks matching male.chr controller ids: ${humanMapped}/${humanTracks} (${(100 * humanMapped / Math.max(1, humanTracks)).toFixed(1)}%)`);
console.log(`fps: ${[...fpsSeen].map(([k, v]) => `${k}=${v}`).join(" ")}`);
for (const [k, v] of errors) console.log(`FAIL ${k}: ${v.length} e.g. ${v.slice(0, 2).join(" | ")}`);
process.exit(errors.size ? 1 : 0);
