// Node test for src/schedule.ts on Rataje (read-only): places every NPC at a
// few times of day from its soul's schedule and the entity links, and reports
// where they end up.
// usage: node scripts/test-schedule.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { parseTerrain, heightAt } from "../src/terrain.ts";
import { parseNpcEntities, parseEntityIndex } from "../src/levelEntities.ts";
import { Schedules, activityAt } from "../src/schedule.ts";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { ASSET_RE } from "../src/assets.ts";
import { CharacterDb } from "../src/character.ts";

const root = process.argv[2] ?? join(homedir(), "kcd1");
const blob = await openAsBlob(join(root, "Data/Levels/rataje/level.pak"));
const entries = await readCentralDirectory(blob);
const find = (n: string) => entries.find((e) => e.name.toLowerCase() === n)!;
const xml = new TextDecoder().decode(await readEntry(blob, find("objects_mission0.xml")));
const npcs = parseNpcEntities(xml);
let t0 = performance.now();
const ents = parseEntityIndex(xml);
const areas = [...ents.values()].filter((e) => e.points);
const rotated = areas.filter((e) => Math.abs(e.rot[0]) < 0.9999);
console.log(`${ents.size} entities indexed in ${Math.round(performance.now() - t0)} ms; ${areas.length} area shapes, ${rotated.length} rotated`);
const terrain = parseTerrain(await readEntry(blob, find("terrain/terrain.dat")));

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
const souls = new Map(db.souls.map((s) => [s.name, s]));
const g = souls.get("rat_guard8")!;
console.log(`rat_guard8 schedule: ${g.schedule.map((s) => `${Math.floor(s.start / 60)}:${String(s.start % 60).padStart(2, "0")} ${s.activity}`).join(", ")}; at 03:00 → ${activityAt(g.schedule, 180)}, at 12:00 → ${activityAt(g.schedule, 720)}`);

const sched = new Schedules(npcs, ents);
console.log(`beds assigned: ${sched.bedCount}`);
let bad = 0;
const ground = (x: number, y: number) => heightAt(terrain, x, y);
for (const hhmm of ["03:00", "07:00", "08:05", "12:00", "19:00", "20:40"]) {
  const [h, m] = hhmm.split(":").map(Number);
  t0 = performance.now();
  const where = new Map<string, number>(), acts = new Map<string, number>();
  let moved = 0;
  for (const n of npcs) {
    const s = souls.get(n.name);
    if (!s) continue;
    const p = sched.at(n, s.schedule, h * 60 + m, ground, n.female ? 1.29 : 1.4);
    where.set(p.where, (where.get(p.where) ?? 0) + 1);
    acts.set(p.activity || "(none)", (acts.get(p.activity || "(none)") ?? 0) + 1);
    const d = Math.hypot(p.pos[0] - n.pos[0], p.pos[1] - n.pos[1]);
    if (d > 1) moved++;
    if (!p.pos.every(Number.isFinite)) bad++;
  }
  const fmt = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`${hhmm}: ${fmt(acts)} | at ${fmt(where)} | ${moved} away from spawn (${Math.round(performance.now() - t0)} ms)`);
}
console.log(bad ? `FAIL: ${bad} non-finite positions` : "OK");
if (bad) process.exit(1);
