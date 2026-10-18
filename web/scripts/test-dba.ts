// Node test for src/dba.ts: parses every .dba in a real install (read-only)
// and decodes every animation in it.
// usage: node scripts/test-dba.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { Dba } from "../src/dba.ts";
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
const chars = await openAsBlob(join(root, "Data/Characters.pak"));
const ents = await readCentralDirectory(chars);
const ids = new Set<number>();
for (const s of ["male", "female"]) {
  const sk = parseSkeleton(await readEntry(chars, ents.find((e) => e.name.toLowerCase() === `objects/characters/humans/skeleton/${s}.chr`)!))!;
  for (const b of sk.bones) ids.add(b.controllerId);
}

let files = 0, anims = 0, tracks = 0, nonMono = 0, nonUnit = 0, humanTracks = 0, humanMapped = 0, steps = 0, jumps = 0;
const errors = new Map<string, string[]>();
const t0 = performance.now();
for (const pak of await findPaks(root)) {
  const blob = await openAsBlob(pak);
  for (const e of (await readCentralDirectory(blob)).filter((e) => e.name.toLowerCase().endsWith(".dba"))) {
    files++;
    try {
      const db = new Dba(await readEntry(blob, e));
      const human = /\/humans\//i.test(e.name) && !/facials/i.test(e.name);
      for (const a of db.anims) {
        anims++;
        const clip = db.clip(a.name);
        for (const t of clip.tracks.values()) {
          tracks++;
          for (const times of [t.rotTimes, t.posTimes]) for (let i = 1; i < times.length; i++) if (times[i] <= times[i - 1]) { nonMono++; break; }
          for (let i = 0; i < t.rotations.length; i++) {
            const q = t.rotations[i];
            if (Math.abs(Math.hypot(...q) - 1) > 1e-3) nonUnit++;
            if (i) {
              const p = t.rotations[i - 1];
              steps++;
              if (Math.abs(q[0] * p[0] + q[1] * p[1] + q[2] * p[2] + q[3] * p[3]) < 0.995) jumps++;
            }
          }
          if (human) { humanTracks++; if (ids.has(t.controllerId)) humanMapped++; }
        }
      }
    } catch (err) {
      const k = (err as Error).message.replace(/\d+/g, "N");
      if (!errors.has(k)) errors.set(k, []);
      errors.get(k)!.push(e.name);
    }
  }
}
console.log(`${files} .dba files, ${anims} animations, ${tracks} tracks, ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log(`non-increasing key times: ${nonMono}, non-unit quaternions: ${nonUnit}, key-to-key jumps > ~11°: ${(100 * jumps / Math.max(1, steps)).toFixed(3)}% of ${steps}`);
console.log(`human (non-facial) tracks matching male/female controller ids: ${humanMapped}/${humanTracks} (${(100 * humanMapped / Math.max(1, humanTracks)).toFixed(1)}%)`);
for (const [k, v] of errors) console.log(`FAIL ${k}: ${v.length} e.g. ${v.slice(0, 2).join(" | ")}`);
process.exit(errors.size ? 1 : 0);
