// Node test for src/daycycle.ts: the schedule store's rules (base windows,
// midnight, patches by priority, skips, once patches) on made-up schedules, then
// Rataje's tailor and the market's NPCs from the game data (read-only): their
// windows, hobby draws and the areas the hobbies run on.
// usage: node scripts/test-daycycle.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DayCycles, ScheduleStore, loadHobbies } from "../src/daycycle.ts";
import { AiDb } from "../src/btWorld.ts";
import { CharacterDb } from "../src/character.ts";
import { parseEntityIndex, parseNpcEntities } from "../src/levelEntities.ts";
import { readTable } from "../src/tables.ts";
import { Vfs } from "../src/vfs.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { gameSources } from "./lib.ts";

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const hm = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

// ---- the store, on the tailor's schedule (work 9:02, fun 18:31, sleep 23:15) ----
const tailor = [{ start: 542, activity: "work" }, { start: 1111, activity: "fun" }, { start: 1395, activity: "sleep" }];
{
  const s = new ScheduleStore(tailor);
  check(s.current(12).handle === "work_0_GH" && s.current(20).handle === "fun_1_GH" && s.current(23.5).handle === "sleep_2_GH", "base windows: work_0_GH, fun_1_GH, sleep_2_GH");
  const late = s.current(23.9), early = new ScheduleStore(tailor).current(3);
  check(late.id === early.id - 0 || (late.name === "sleep" && early.name === "sleep"), "sleep crosses midnight: one window");
  check(Math.abs(new ScheduleStore(tailor).current(23.5).remaining - (24 - 23.5 + 542 / 60)) < 1e-9, "sleep at 23:30 ends at 9:02 (remaining wraps)");
  // fun returning early is skipped: sleep starts now; midnight clears it
  const t = new ScheduleStore(tailor);
  t.current(19);
  t.skip("fun_1_GH");
  check(t.current(19.5).name === "sleep", "skipped fun: sleep starts early");
  t.current(23.9);
  check(t.current(0.5).name === "sleep" && t.current(19).name === "fun", "midnight clears the skip");
  // patches: higher priority wins, newest wins among overlapping equals, removal restores
  const p = new ScheduleStore(tailor);
  p.add({ start: 10, end: 11, name: "hideFromRain", handle: "rain", once: true }, 30);
  check(p.current(10.5).name === "hideFromRain" && p.current(11.5).name === "work", "priority-30 patch over work, only in its window");
  p.add({ start: 10, end: 12, name: "a", handle: "a" }, 10);
  p.add({ start: 10.5, end: 12, name: "b", handle: "b" }, 10);
  check(p.current(11.5).name === "b", "overlapping equal priority: the newest wins");
  check(!p.add({ start: 1, end: 2, name: "x", handle: "b" }, 10), "duplicate handle refused");
  p.remove("b");
  check(p.current(11.5).name === "a", "removing a patch uncovers the older one");
  check(!p.remove("work_0_GH"), "base patches can't be removed");
  p.started("rain");
  p.ended("rain", true);
  check(p.current(10.5).name !== "hideFromRain", "a once patch goes after its behaviour succeeds");
  // a skipped patch hides its bucket, the base shows through
  p.skip("a");
  check(p.current(11.5).name === "work", "skipped patch: the base below runs");
  // relative-day patch crossing midnight
  const q = new ScheduleStore(tailor);
  q.add({ start: 22, end: 2, name: "night", handle: "n" }, 10);
  check(q.current(23).name === "night" && q.current(1).name === "night" && q.current(3).name === "sleep", "patch 22:00–2:00 crosses midnight");
  check(new ScheduleStore([]).current(12).name === "Sleep", "empty schedule: Sleep all day");
  // every base entry skipped: skips clear
  const all = new ScheduleStore(tailor);
  for (const h of ["work_0_GH", "fun_1_GH", "sleep_2_GH"]) all.skip(h);
  check(all.current(12).name === "work", "all base entries skipped: the skips clear");
}

// ---- daycycle:change messages on a cycle (no level data needed: an NPC without links) ----
{
  const npc = { id: 1, name: "test", female: false, pos: [0, 0, 0], rot: [1, 0, 0, 0], links: new Map(), behaviorTree: "" } as unknown as Parameters<DayCycles["at"]>[0];
  const cycles = new DayCycles({ ents: new Map(), hobbies: new Map(), areaBehaviours: () => undefined });
  const c = cycles.at(npc, tailor, 600);
  c.change({ add: true, startTime: -1, endTime: 0.5, handle: "chat", name: "chat", priority: 20 }, 600);
  check(cycles.at(npc, tailor, 610).activity!.name === "chat", "relative patch: from now");
  // during the priority-20 patch, a now-or-never one at 5 is refused
  c.change({ add: true, handle: "low", name: "low", priority: 5, nowOrNever: true, immediate: true }, 615);
  check(cycles.at(npc, tailor, 640).activity!.name === "work", "relative patch over after 30 minutes; the now-or-never patch below it was refused");
  c.change({ add: true, handle: "cut", name: "cutscene", criticalPriority: "cutscene_init", immediate: true, immediateDaycycleHaltSpeed: "daycycleHaltSpeed.instant" }, 660);
  check(cycles.at(npc, tailor, 661).activity!.name === "cutscene" && cycles.at(npc, tailor, 661).activity!.priority === 100 && c.haltNow, "immediate cutscene patch: priority 100, all day, halts at once");
  c.change({ add: false, handle: "cut" }, 670);
  check(cycles.at(npc, tailor, 671).activity!.name === "work", "removing the patch: back to work");
}

// ---- the game data ----
const root = process.argv[2] ?? join(homedir(), "kcd1");
const sources = (await gameSources(join(root, "Data"))).filter((s) => !s.path.toLowerCase().includes("levels/"));
const vfs = await Vfs.build(sources, { filter: (n) => /^libs\/tables\//.test(n) || n.startsWith("libs/") && n.endsWith(".xml"), includeHd: false });
const level = await openAsBlob(join(root, "Data/Levels/rataje/level.pak"));
const xml = new TextDecoder().decode(await readEntry(level, (await readCentralDirectory(level)).find((e) => e.name.toLowerCase() === "objects_mission0.xml")!));
const ents = parseEntityIndex(xml);
const npcs = parseNpcEntities(xml);
const T = AiDb.TABLES;
const ai = new AiDb({ soTag: await readTable(vfs, T.soTag), so2tag: await readTable(vfs, T.so2tag), saTag: await readTable(vfs, T.saTag), sa2tag: await readTable(vfs, T.sa2tag) });
const offered = new Map([...ai.sa].map(([k, v]) => [k, new Set(v.map((b) => b.name.toLowerCase()))]));
const hobbies = await loadHobbies(vfs);
const db = await CharacterDb.load(vfs);
const souls = new Map(db.souls.map((s) => [s.name, s]));
let seed = 1;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const cycles = new DayCycles({ ents, hobbies, areaBehaviours: (t) => offered.get(t), random });
const name = (id: number | undefined) => (id === undefined ? "-" : ents.get(id)?.name ?? `#${id}`);

const t = npcs.find((n) => n.name === "rat_tailor")!;
const ts = souls.get("rat_tailor")!.schedule;
console.log(`rat_tailor: ${ts.map((s) => `${s.activity} ${hm(s.start / 60)}`).join(", ")}; hobbies ${[...hobbies.get("rat_tailor") ?? []].map(([k, v]) => `${k}:${v}`).join(", ")}`);
const day: string[] = [];
for (const m of [600, 1111, 1200, 1394, 1400, 60]) {
  const c = cycles.at(t, ts, m);
  day.push(`${hm(m / 60)} ${c.activity!.handle} → ${c.target ? `${c.target.behaviour} on ${name(c.target.area)}${c.target.moveToArea ? "" : " (where he stands)"}` : "-"}`);
}
console.log("  " + day.join("\n  "));
const fun = cycles.get(t.id)!;
cycles.at(t, ts, 1200);
check(cycles.at(t, ts, 1200).target?.behaviour === "cityWalk" && name(cycles.get(t.id)!.target?.area) === "sa_rat_city" && !cycles.get(t.id)!.target!.moveToArea, "tailor's fun: cityWalk on sa_rat_city, from where he stands");
void fun;
check(cycles.at(t, ts, 1400).target?.behaviour === "Sleeper" && name(cycles.get(t.id)!.target?.area) === "rat_home1_1", "tailor's sleep: Sleeper at rat_home1_1");
check(cycles.fun.city(ents.get([...ents.values()].find((e) => e.name === "rat_home1_1")!.id)!.id) === [...ents.values()].find((e) => e.name === "sa_rat_city")!.id, "tailor's home city: sa_rat_city");

// the wife: pray 60 %, cityWalk 40 % over many fun windows
const w = npcs.find((n) => n.name === "rat_tailors_wife")!;
const draws = new Map<string, number>();
for (let k = 0; k < 400; k++) {
  const c = new DayCycles({ ents, hobbies, areaBehaviours: (t) => offered.get(t), random }).at(w, souls.get(w.name)!.schedule, 1200);
  const key = `${c.target?.behaviour} on ${name(c.target?.area)}`;
  draws.set(key, (draws.get(key) ?? 0) + 1);
}
console.log(`rat_tailors_wife at 20:00 over 400 draws: ${[...draws].map(([k, v]) => `${k} ${v}`).join(", ")}`);
const pray = [...draws].find(([k]) => k.startsWith("pray"))?.[1] ?? 0;
check(pray > 200 && pray < 280, "wife draws pray about 60 % of the time");

// the market: every NPC with a fun window whose home is in Rataje, at 20:00
const city = [...ents.values()].find((e) => e.name === "sa_rat_city")!;
const inRataje = npcs.filter((n) => { const h = [...n.links].find(([k]) => k.includes("Home")); return h && cycles.fun.city(h[1]) === city.id; });
const byHobby = new Map<string, number>(), byArea = new Map<string, number>();
let withFun = 0, early = 0;
for (const n of inRataje) {
  const s = souls.get(n.name)?.schedule;
  if (!s?.some((x) => x.activity === "fun")) continue;
  const fn = s.find((x) => x.activity === "fun")!;
  withFun++;
  const c = new DayCycles({ ents, hobbies, areaBehaviours: (t) => offered.get(t), random }).at(n, s, fn.start + 1);
  if (c.activity!.name !== "fun") { early++; continue; }
  byHobby.set(c.target!.behaviour, (byHobby.get(c.target!.behaviour) ?? 0) + 1);
  byArea.set(name(c.target!.area), (byArea.get(name(c.target!.area)) ?? 0) + 1);
}
console.log(`Rataje (home in sa_rat_city): ${inRataje.length} NPCs, ${withFun} with fun; ${early} found no hobby area (fun skipped)`);
console.log(`  hobbies drawn: ${[...byHobby].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`  areas: ${[...byArea].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
check(withFun > 0 && byHobby.size > 0, "market NPCs get hobbies");
console.log(fails ? `${fails} FAILED` : "OK");
if (fails) process.exit(1);
