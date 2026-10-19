// NPC crowd over time, headless: streams the NPCs around a point, runs their
// schedules and behaviour trees, steps collision avoidance at 30 fps and counts
// NPCs drawn inside one another (centres closer than 0.5 m).
// usage: node scripts/sim-crowd.ts [--at x,y,z] [--clock HH:MM] [--seconds N] [--root GAME_ROOT]
// (defaults: Rataje market, 10:00, 60 s)

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { ASSET_RE } from "../src/assets.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { parseTerrain, heightAt } from "../src/terrain.ts";
import { parseNpcEntities, parseEntityIndex } from "../src/levelEntities.ts";
import { Schedules } from "../src/schedule.ts";
import { NavMesh } from "../src/navmesh.ts";
import { NpcWorld, updateAi } from "../src/npcs.ts";
import { createAiWorld } from "../src/btWorld.ts";
import { NpcAi } from "../src/npcAi.ts";
import { AnimLibrary } from "../src/mannequin.ts";
import { LuaHost } from "../src/luaHost.ts";
import { setGpuBlockCompression } from "../src/model.ts";

setGpuBlockCompression(true);

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const root = arg("--root") ?? join(homedir(), "kcd1");
const T = () => performance.now();
const lap = (label: string, t0: number) => console.log(`${label.padEnd(44)} ${(T() - t0).toFixed(0).padStart(6)} ms`);

async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak")) out.push(p);
  }
  return out;
}
let t0 = T();
const sources: PakSource[] = [];
for (const p of await findPaks(join(root, "Data"))) {
  const b = await openAsBlob(p);
  sources.push({ path: relative(root, p), size: b.size, open: async () => b });
}
const level = sources.find((s) => s.path.toLowerCase() === "data/levels/rataje/level.pak")!;
const vfs = await (await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => ASSET_RE.test(n), includeHd: true })).extend(level, (n) => ASSET_RE.test(n));
lap("asset index (VFS)", t0);

t0 = T();
const lb = await level.open();
const es = await readCentralDirectory(lb);
const terrain = parseTerrain(await readEntry(lb, es.find((e) => e.name.toLowerCase() === "terrain/terrain.dat")!));
const xml = new TextDecoder().decode(await readEntry(lb, es.find((e) => e.name.toLowerCase() === "objects_mission0.xml")!));
lap("terrain + mission file", t0);
t0 = T();
const npcEnts = parseNpcEntities(xml);
const ents = parseEntityIndex(xml);
const schedules = new Schedules(npcEnts, ents);
lap("entities + schedules", t0);
t0 = T();
const recast = sources.find((s) => s.path.toLowerCase() === "data/levels/rataje/recast.pak")!;
const rb = await recast.open();
schedules.setNavMesh(new NavMesh(await readEntry(rb, (await readCentralDirectory(rb)).find((e) => e.name.toLowerCase() === "recast/rdnavmesh_1.nav")!)));
lap("navmesh", t0);

t0 = T();
const lua = await LuaHost.create(vfs, createRequire(import.meta.url).resolve("wasmoon-lua5.1/dist/liblua5.1.wasm"));
await lua.preload();
await lua.preloadTables();
lap("Lua + scripts + tables", t0);
t0 = T();
let ai: NpcAi | null = null;
const world = await createAiWorld(vfs, { ents, lua, realTime: () => ai?.now ?? 0, worldTime: () => (ai?.now ?? 0) * 15, act: (a) => ai?.act(a) ?? 1 });
lua.boot();
lap("behaviour trees + AI tables + boot", t0);
const libs = { male: new AnimLibrary(vfs, "male"), female: new AnimLibrary(vfs, "female") };
ai = new NpcAi(world, libs);
const npcWorld = new NpcWorld(vfs, npcEnts, schedules, (x, y) => heightAt(terrain, x, y));
npcWorld.ai = ai;

const at = (arg("--at") ?? "2577.8,574,83.8").split(",").map(Number) as [number, number, number];
const [hh, mm] = (arg("--clock") ?? "10:00").split(":").map(Number);
const seconds = Number(arg("--seconds") ?? 60);
let minute = hh * 60 + mm;
t0 = T();
const npcs = await npcWorld.near(at, 120, 40, minute);
lap(`assemble ${npcs.length} NPCs`, t0);

const dt = 1 / 30;
let crowdMs = 0, pairFrames = 0, worst = 0;
const offenders = new Map<string, number>();
for (let f = 0; f < seconds * 30; f++) {
  if (f % 15 === 0) updateAi(npcs, npcWorld, minute);
  ai.tick(dt);
  if (f % 30 === 0) await ai.settle();
  const s = T();
  npcWorld.stepCrowd(npcs, minute, dt);
  crowdMs += T() - s;
  minute += (dt * 15) / 60;
  const pos = npcs.map((n) => (npcWorld.drawn(n.entity.id) ?? npcWorld.placeAt(n.entity, n.schedule, minute)).pos);
  let pairs = 0;
  for (let i = 0; i < npcs.length; i++) for (let j = i + 1; j < npcs.length; j++) {
    if (Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]) < 0.5 && Math.abs(pos[i][2] - pos[j][2]) < 1.5) {
      pairs++;
      const k = `${npcs[i].entity.name} / ${npcs[j].entity.name}`;
      if (!offenders.has(k)) {
        const how = (n: (typeof npcs)[number]) => `${npcWorld.drawn(n.entity.id)?.pose ?? "?"} (plan ${npcWorld.placeAt(n.entity, n.schedule, minute).pose})`;
        console.log(`  t=${(f / 30).toFixed(1)} s ${k}: ${how(npcs[i])} / ${how(npcs[j])}, ${Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]).toFixed(2)} m apart`);
      }
      offenders.set(k, (offenders.get(k) ?? 0) + 1);
    }
  }
  pairFrames += pairs;
  worst = Math.max(worst, pairs);
}
const frames = seconds * 30;
console.log(`${npcs.length} NPCs, ${seconds} s from ${hh}:${String(mm).padStart(2, "0")}: overlapping pairs ${worst} at worst, ${(pairFrames / frames).toFixed(2)} per frame; crowd step ${(crowdMs / frames).toFixed(2)} ms`);
for (const [k, n] of [...offenders].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${k}: ${n} frames`);
process.exit(0);
