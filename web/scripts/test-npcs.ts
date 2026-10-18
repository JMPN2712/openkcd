// Node test for src/levelEntities.ts on Rataje (read-only): parses NPC
// entities from objects_mission0.xml, matches them to souls and checks how
// many stand on the terrain.
// usage: node scripts/test-npcs.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { parseTerrain, heightAt } from "../src/terrain.ts";
import { parseNpcEntities } from "../src/levelEntities.ts";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { ASSET_RE } from "../src/assets.ts";
import { CharacterDb } from "../src/character.ts";

const root = process.argv[2] ?? join(homedir(), "kcd1");
const blob = await openAsBlob(join(root, "Data/Levels/rataje/level.pak"));
const entries = await readCentralDirectory(blob);
const find = (n: string) => entries.find((e) => e.name.toLowerCase() === n)!;
const t0 = performance.now();
const npcs = parseNpcEntities(new TextDecoder().decode(await readEntry(blob, find("objects_mission0.xml"))));
console.log(`${npcs.length} NPC entities (${npcs.filter((n) => n.female).length} female) in ${Math.round(performance.now() - t0)} ms`);

const terrain = parseTerrain(await readEntry(blob, find("terrain/terrain.dat")));
const dz = npcs.map((n) => n.pos[2] - heightAt(terrain, n.pos[0], n.pos[1]));
console.log(`on the terrain (±0.25 m): ${dz.filter((d) => Math.abs(d) < 0.25).length}; above it by >1 m (upper floors, walls): ${dz.filter((d) => d > 1).length}`);
const links = new Map<string, number>();
for (const n of npcs) for (const k of n.links.keys()) { const key = k.replace(/\[.*$/, "[…]"); links.set(key, (links.get(key) ?? 0) + 1); }
console.log("entity links:", [...links].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => `${k} ×${c}`).join(", "));

async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak") && !p.toLowerCase().includes("/levels/")) out.push(p);
  }
  return out;
}
const sources: PakSource[] = [];
for (const p of await findPaks(join(root, "Data"))) {
  const b = await openAsBlob(p);
  sources.push({ path: relative(root, p), size: b.size, open: async () => b });
}
const db = await CharacterDb.load(await Vfs.build(sources, { filter: (n) => ASSET_RE.test(n), includeHd: false }));
const souls = new Set(db.souls.map((s) => s.name));
const missing = npcs.filter((n) => !souls.has(n.name));
console.log(`entity name = soul_name for ${npcs.length - missing.length}/${npcs.length}; unmatched e.g. ${missing.slice(0, 5).map((n) => n.name).join(", ")}`);
const ok = npcs.length > 900 && missing.length < 50;
console.log(ok ? "OK" : "FAIL");
if (!ok) process.exit(1);
