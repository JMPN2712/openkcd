// CPU benchmark of the level view's NPC work (no GPU): the time to stream the
// NPCs around Rataje's market, then per frame: behaviour-tree ticks, placement
// and skeletal animation (palettes), and the periodic selection check.
// usage: node scripts/bench-npcs.ts [GAME_ROOT]

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
import { NpcWorld, animateNpcs, updateAi } from "../src/npcs.ts";
import { createAiWorld } from "../src/btWorld.ts";
import { NpcAi } from "../src/npcAi.ts";
import { AnimLibrary } from "../src/mannequin.ts";
import { LuaHost } from "../src/luaHost.ts";

const root = process.argv[2] ?? join(homedir(), "kcd1");
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
const world = await createAiWorld(vfs, { ents, lua, realTime: () => ai?.now ?? 0, gameTime: () => (ai?.now ?? 0) * 15, act: (a) => ai?.act(a) ?? 1 });
lua.boot();
lap("behaviour trees + AI tables + boot", t0);
const libs = { male: new AnimLibrary(vfs, "male"), female: new AnimLibrary(vfs, "female") };
ai = new NpcAi(world, libs);
const npcWorld = new NpcWorld(vfs, npcEnts, schedules, (x, y) => heightAt(terrain, x, y));
npcWorld.ai = ai;

const at: [number, number, number] = [2577.8, 574, 83.8];
const minute = 600;
t0 = T();
const npcs = await npcWorld.near(at, 120, 40, minute);
lap(`assemble ${npcs.length} NPCs (characters, textures 256 px)`, t0);
t0 = T();
updateAi(npcs, npcWorld, minute);
for (let i = 0; i < 50; i++) { ai.tick(0.1); await ai.settle(); }
lap(`start ${ai.ids().length} behaviour trees + 5 s of AI (incl. clip loads)`, t0);

// per-frame work, averaged
let parts = 0;
for (const n of npcs) parts += n.character.parts.length;
const ops = { setPalette: () => {}, paletteSize: () => 64, setItemTransform: () => {} };
const frames = 120;
let tAi = 0, tAnim = 0;
for (let f = 0; f < frames; f++) {
  let s = T(); ai.tick(1 / 60); tAi += T() - s;
  s = T(); animateNpcs(npcs, npcWorld, minute + f / 3600, f / 60, ops); tAnim += T() - s;
}
console.log(`per frame (${npcs.length} NPCs, ${parts} skinned parts): behaviour trees ${(tAi / frames).toFixed(2)} ms, placement + animation ${(tAnim / frames).toFixed(2)} ms`);
t0 = T();
for (let i = 0; i < 10; i++) await npcWorld.select(at, 120, 40, minute + i);
console.log(`NPC selection check (every 0.5 s): ${((T() - t0) / 10).toFixed(1)} ms each`);
