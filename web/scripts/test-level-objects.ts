// Node test for src/levelObjects.ts on Rataje (read-only): parses the object
// octree after the terrain and checks instances against the terrain.
// usage: node scripts/test-level-objects.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { parseTerrain, heightAt } from "../src/terrain.ts";
import { parseLevelObjects } from "../src/levelObjects.ts";

const root = process.argv[2] ?? join(homedir(), "kcd1");
const blob = await openAsBlob(join(root, "Data/Levels/rataje/level.pak"));
const entry = (await readCentralDirectory(blob)).find((e) => e.name.toLowerCase() === "terrain/terrain.dat")!;
const bytes = await readEntry(blob, entry);
const terrain = parseTerrain(bytes);
const t0 = performance.now();
const objs = parseLevelObjects(bytes, terrain.objectsOffset);
console.log(`${objs.nodes} octree nodes, ${objs.brushName.length} brushes, ${objs.vegGroup.length} vegetation instances in ${Math.round(performance.now() - t0)} ms`);
console.log(`undecoded record types ending blocks: ${[...objs.skippedTypes].map(([t, n]) => `${t}:${n}`).join(" ")}`);

const badName = objs.brushName.filter((i) => i >= terrain.brushNames.length || !terrain.brushNames[i]).length;
const badGroup = objs.vegGroup.filter((g) => g >= terrain.vegetation.length).length;
const dz: number[] = [];
for (let i = 0; i < objs.vegGroup.length; i += 37) {
  const x = objs.vegPos[i * 3], y = objs.vegPos[i * 3 + 1];
  if (x >= 0 && y >= 0 && x <= terrain.size && y <= terrain.size) dz.push(objs.vegPos[i * 3 + 2] - heightAt(terrain, x, y));
}
dz.sort((a, b) => a - b);
const q = (f: number) => dz[Math.floor(f * (dz.length - 1))].toFixed(2);
console.log(`brushes with an empty/out-of-range name: ${badName}; vegetation with a bad group: ${badGroup}`);
console.log(`vegetation height above terrain: p5 ${q(0.05)} m, median ${q(0.5)} m, p95 ${q(0.95)} m`);
const groups = new Map<number, number>();
for (const g of objs.vegGroup) groups.set(g, (groups.get(g) ?? 0) + 1);
console.log("most common vegetation:", [...groups].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g, n]) => `${terrain.vegetation[g].model.split("/").pop()} ×${n}`).join(", "));
const names = new Map<number, number>();
for (const n of objs.brushName) names.set(n, (names.get(n) ?? 0) + 1);
console.log(`unique brush meshes: ${names.size}; most common:`, [...names].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${terrain.brushNames[n]?.split("/").pop()} ×${c}`).join(", "));
