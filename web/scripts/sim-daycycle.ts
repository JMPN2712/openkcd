// Headless run of NPC daily cycles around Rataje's market (read-only): the NPCs
// near a point are streamed in as in the view (up to --max, Potato's 8 by default),
// their behaviour trees run from their daily cycles (daycycle.ts) across an
// activity change, and the script follows one NPC (the tailor by default), counts
// how the trees start and end, and times the per-frame NPC work.
// usage: node scripts/sim-daycycle.ts [--clock HH:MM] [--minutes N] [--max N] [--follow NAME] [--at x,y,z] [--root GAME_ROOT]

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
import { NpcWorld, animateNpcs, updateAi, type WorldNpc } from "../src/npcs.ts";
import { createAiWorld } from "../src/btWorld.ts";
import { cycleData } from "../src/daycycle.ts";
import { NpcAi } from "../src/npcAi.ts";
import { AnimLibrary } from "../src/mannequin.ts";
import { LuaHost } from "../src/luaHost.ts";
import { setGpuBlockCompression } from "../src/model.ts";

setGpuBlockCompression(true);
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const root = arg("--root") ?? join(homedir(), "kcd1");
const follow = arg("--follow") ?? "rat_tailor";
const max = Number(arg("--max") ?? 8);
const [hh, mm] = (arg("--clock") ?? "18:25").split(":").map(Number);
const gameMinutes = Number(arg("--minutes") ?? 20);
const T = () => performance.now();

async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak")) out.push(p);
  }
  return out;
}
const sources: PakSource[] = [];
for (const p of await findPaks(join(root, "Data"))) {
  const b = await openAsBlob(p);
  sources.push({ path: relative(root, p), size: b.size, open: async () => b });
}
const level = sources.find((s) => s.path.toLowerCase() === "data/levels/rataje/level.pak")!;
const vfs = await (await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => ASSET_RE.test(n), includeHd: true })).extend(level, (n) => ASSET_RE.test(n));
const lb = await level.open();
const es = await readCentralDirectory(lb);
const terrain = parseTerrain(await readEntry(lb, es.find((e) => e.name.toLowerCase() === "terrain/terrain.dat")!));
const xml = new TextDecoder().decode(await readEntry(lb, es.find((e) => e.name.toLowerCase() === "objects_mission0.xml")!));
const npcEnts = parseNpcEntities(xml);
const ents = parseEntityIndex(xml);
const schedules = new Schedules(npcEnts, ents);
const recast = sources.find((s) => s.path.toLowerCase() === "data/levels/rataje/recast.pak")!;
const rb = await recast.open();
schedules.setNavMesh(new NavMesh(await readEntry(rb, (await readCentralDirectory(rb)).find((e) => e.name.toLowerCase() === "recast/rdnavmesh_1.nav")!)));
const lua = await LuaHost.create(vfs, createRequire(import.meta.url).resolve("wasmoon-lua5.1/dist/liblua5.1.wasm"));
await lua.preload();
await lua.preloadTables();
let ai: NpcAi | null = null;
let minute = 0;
const world = await createAiWorld(vfs, { ents, lua, realTime: () => ai?.now ?? 0, worldTime: () => (ai?.now ?? 0) * 15, act: (a) => ai?.act(a) ?? 1, daycycleChange: (npc, f) => { console.log(`  daycycle:change for ${ents.get(npc)?.name}: ${JSON.stringify(f)}`); schedules.cycleOf(npc)?.change(f, minute); } });
lua.boot();
schedules.setCycleData(await cycleData(vfs, world));
ai = new NpcAi(world, { male: new AnimLibrary(vfs, "male"), female: new AnimLibrary(vfs, "female") });
ai.nav = schedules.navMesh;
const npcWorld = new NpcWorld(vfs, npcEnts, schedules, (x, y) => heightAt(terrain, x, y));
npcWorld.ai = ai;

// the camera stays by the followed NPC's workplace (the market by default)
const followed = npcEnts.find((n) => n.name === follow);
const at = (arg("--at")?.split(",").map(Number) ?? (followed ? [...followed.pos] : [2577.8, 574, 83.8])) as [number, number, number];
minute = hh * 60 + mm;
const clock = () => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(Math.floor(minute % 60)).padStart(2, "0")}`;

const events = new Map<string, number>();
const early = new Map<string, number>();
const failed = new Map<string, number>();
npcWorld.aiLog = (npc, event, detail) => {
  events.set(event, (events.get(event) ?? 0) + 1);
  const behaviour = detail.split(" ").at(-2) && detail.split("/").at(-1)?.split(" ")[0];
  if (event === "early") early.set(behaviour ?? detail, (early.get(behaviour ?? detail) ?? 0) + 1);
  if (event === "failedStart") failed.set(detail.split(" ").at(-1)!, (failed.get(detail.split(" ").at(-1)!) ?? 0) + 1);
  if (npc.name === follow || process.env.TRACE_EVENTS) console.log(`  ${clock()} ${npc.name}: ${event} ${detail}`);
};

let npcs: WorldNpc[] = [];
let key = "";
const ops = { setPalette: () => {}, paletteSize: () => 64, setItemTransform: () => {} };
const dt = 1 / 30;
const frames = Math.round(gameMinutes * 4 / dt);
let tAi = 0, tCrowd = 0, tAnim = 0, tCheck = 0, tSelect = 0, checks = 0, worstFrame = 0;
const checkTimes: number[] = [];
let lastWhere = "";
for (let f = 0; f < frames; f++) {
  if (f % 15 === 0) {
    // the view's NPC check every 0.5 s: selection (every NPC's daily cycle), re-stream on change, trees
    const s = T();
    const sel = await npcWorld.select(at, 120, max, Math.floor(minute));
    const k = NpcWorld.key(sel);
    const s1 = T();
    updateAi(npcs, npcWorld, Math.floor(minute));
    tCheck += T() - s;
    tSelect += s1 - s;
    checkTimes.push(T() - s);
    checks++;
    if (k !== key) { npcs = await npcWorld.near(at, 120, max, Math.floor(minute)); key = k; }
  }
  const s0 = T();
  ai.tick(dt);
  const s1 = T();
  npcWorld.stepCrowd(npcs, minute, dt);
  const s2 = T();
  animateNpcs(npcs, npcWorld, minute, f * dt, ops, at);
  const s3 = T();
  tAi += s1 - s0; tCrowd += s2 - s1; tAnim += s3 - s2;
  worstFrame = Math.max(worstFrame, s3 - s0);
  if (f % 30 === 0) await ai.settle();
  minute += (dt * 15) / 60;
  const fn = npcs.find((n) => n.entity.name === follow);
  if (fn) {
    const c = npcWorld.cycle(fn.entity, fn.schedule, Math.floor(minute));
    const p = npcWorld.drawn(fn.entity.id) ?? npcWorld.placeAt(fn.entity, fn.schedule, minute);
    const st = ai.state(fn.entity.id);
    const where = `${c?.activity?.handle} ${c?.target ? `${c.target.behaviour}` : "-"} | ${p.where} ${p.pose}${st?.fragment ? ` ${st.fragment}` : ""}`;
    if (where !== lastWhere) console.log(`  ${clock()} ${follow}: ${where} at ${p.pos.map((v) => v.toFixed(1)).join(",")}`);
    lastWhere = where;
  }
}
const per = (t: number) => (t / frames).toFixed(2);
console.log(`\n${gameMinutes} game minutes from ${hh}:${String(mm).padStart(2, "0")}, up to ${max} NPCs shown (${npcs.length} at the end), ${ai.ids().length} trees running`);
console.log(`tree events: ${[...events].map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (early.size) console.log(`returned before the time changed (by behaviour): ${[...early].map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (failed.size) console.log(`could not start: ${[...failed].map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`per frame: behaviour trees ${per(tAi)} ms, crowd ${per(tCrowd)} ms, placement + animation ${per(tAnim)} ms (worst frame ${worstFrame.toFixed(1)} ms)`);
const sorted = [...checkTimes].sort((a, b) => a - b);
console.log(`NPC check every 0.5 s: mean ${(tCheck / checks).toFixed(2)} ms, median ${sorted[sorted.length >> 1].toFixed(2)}, worst ${sorted.at(-1)!.toFixed(1)} (first ${checkTimes[0].toFixed(1)}); selection over every NPC's daily cycle ${(tSelect / checks).toFixed(2)} ms of the mean, the rest updateAi`);
if (process.argv.includes("--list")) {
  // what each shown NPC is doing at the end
  for (const n of [...npcs].sort((a, b) => a.entity.name.localeCompare(b.entity.name))) {
    const c = npcWorld.cycle(n.entity, n.schedule, Math.floor(minute));
    const p = npcWorld.drawn(n.entity.id) ?? npcWorld.placeAt(n.entity, n.schedule, minute);
    const st = ai.state(n.entity.id);
    const run = npcWorld.running.get(n.entity.id) ?? "";
    console.log(`  ${n.entity.name.padEnd(28)} ${(c?.activity?.handle ?? "-").padEnd(14)} ${(c?.target ? `${c.target.behaviour} on ${ents.get(c.target.area)?.name}` : "-").padEnd(40)} ${run.startsWith("!") ? "held" : ai.has(n.entity.id) ? `tree ${st?.mode}${st?.fragment ? ` ${st.fragment}` : ""}` : p.pose}`);
  }
}
const unsupported = [...world.unsupported].map(([k, v]) => `${k} (${v.size})`);
if (unsupported.length) console.log(`unsupported: ${unsupported.join("; ")}`);
process.exit(0);
