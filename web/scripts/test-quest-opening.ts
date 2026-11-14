// Node test: a new game up to the opening of the main quest (src/questTrees.ts, quests.ts,
// btWorld.ts; research notes quest-system.md), with the game's own quest trees and diet mode on.
// usage: node scripts/test-quest-opening.ts [--root GAME_ROOT] (DEBUG=1: every trace line)

import { openAsBlob } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { gameSources } from "./lib.ts";
import { createAiWorld } from "../src/btWorld.ts";
import { LuaHost } from "../src/luaHost.ts";
import { parseEntityIndex } from "../src/levelEntities.ts";
import { Vfs } from "../src/vfs.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { DialogueDb } from "../src/dialogue.ts";
import { QuestDb, QuestSystem, type QuestEvent } from "../src/quests.ts";
import { DietMode } from "../src/diet.ts";
import { DIET } from "../src/dietConfig.ts";
import { QuestBrains } from "../src/questTrees.ts";
import { layerEntities, parseProfiles } from "../src/profiles.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const debug = !!process.env.DEBUG;

const sources = await gameSources(root);
const vfs = await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => /^libs\/(ai|tables)\/.*\.xml$/.test(n) || n === "libs/smartobjects.xml" || n.endsWith(".lua") || n.startsWith("libs/luaxml/"), includeHd: false });
const lua = await LuaHost.create(vfs, createRequire(import.meta.url).resolve("wasmoon-lua5.1/dist/liblua5.1.wasm"));
await lua.preload();
await lua.preloadTables();
const level = await openAsBlob(join(root, "Data/Levels/rataje/level.pak"));
const xml = new TextDecoder().decode(await readEntry(level, (await readCentralDirectory(level)).find((e) => e.name.toLowerCase() === "objects_mission0.xml")!));
const ents = parseEntityIndex(xml);
// the layers' entities too (the prologue's NPCs live in layers its profile loads)
const dir = await readCentralDirectory(level);
const profiles = parseProfiles(new TextDecoder().decode(await readEntry(level, dir.find((e) => e.name.toLowerCase() === "whdata_1")!)));
let layered = 0;
for (const e of await layerEntities(dir, (x) => readEntry(level, x))) { if (!ents.has(e.id)) { ents.set(e.id, e); layered++; } }
console.log(`${ents.size} entities (${layered} from layers), ${profiles.size} profiles`);

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

const [qdb, ddb] = await Promise.all([QuestDb.load(vfs), DialogueDb.load(vfs)]);
const quests = new QuestSystem(qdb);
new DietMode(qdb, ddb, DIET, () => true).attach(quests);
lua.quests = quests;
const events: string[] = [];
const objective = (e: QuestEvent & { kind: "objective" }) => `${e.quest}/${qdb.objective(e.quest, e.objective)?.name}`;
quests.on((e) => { if (e.kind === "quest" && e.state === 0 && e.banner) return; const s = e.kind === "quest" ? `quest ${e.quest} ${["started", "completed", "canceled", "failed", "reset", "active"][e.state]}` : e.kind === "objective" ? `objective ${objective(e)} ${["started", "completed", "canceled", "expired"][e.state]}` : `reward ${e.quest}`; events.push(s); if (debug) console.log(`${clock.real.toFixed(1).padStart(7)} s  ** ${s}`); });

const clock = { real: 0 };
const lines: string[] = [];
const patches: { npc: number; name: string; handle: string }[] = [];
const world = await createAiWorld(vfs, {
  ents, lua,
  realTime: () => clock.real,
  worldTime: () => clock.real * 15,
  random: () => 0.5,
  quest: (fn, q, o) => quests.apply(fn, q, o),
  questCall: (fn, q, o) => !!quests.call(fn, o === undefined ? [q] : [q, o]),
  daycycleChange: (npc, f) => { patches.push({ npc, name: String(f.name ?? ""), handle: String(f.handle ?? "") }); },
  trace: (m) => { lines.push(m); if (debug) console.log(`${clock.real.toFixed(1).padStart(7)} s  ${m}`); },
});
lua.boot();
world.runner.debug = true;
// FAILS=1: every distinct chain of nodes that failed, with the time it first did
const failed = new Set<string>();
if (process.env.FAILS) world.runner.onFail = (stack) => { const k = stack.slice(-7).join(" > "); if (!failed.has(k)) { failed.add(k); console.log(`${clock.real.toFixed(1).padStart(7)} s  fail: ${k}`); } };

const only = opt("--only", "");
const brains = new QuestBrains(world, quests, { runs: (q) => !quests.isCut(q), only: only ? only.split(",") : undefined });
const running = brains.start();
check(running > 100, `${running} quest trees run (of ${brains.entities.size} quest entities in the level that diet mode keeps)`);
const cutWithEntity = [...ents.values()].filter((e) => e.cls === "QuestObject" && quests.isCut(e.name)).map((e) => e.name);
check(cutWithEntity.length > 0 && cutWithEntity.every((q) => !brains.entities.has(qdb.canonical(q)!)), `the ${cutWithEntity.length} cut quests with an entity run no tree (${cutWithEntity.slice(0, 4).join(", ")}, …)`);
let ticks = 0;
const t0 = performance.now();
const run = (seconds: number) => { for (let i = 0; i < seconds * 10; i++) { brains.tick(); clock.real += 0.1; ticks++; } };

// before the game starts: the hubs and trackers that are activated from the start set themselves up
run(2);
check(!quests.flags("q_skalitz").activated && !events.some((e) => e.startsWith("objective q_master_main/q_skalitz")), "before a new game the opening quest is untouched");
check(world.profiles.has("q_skalitz_normal") && (profiles.get("q_skalitz_normal")?.layers.length ?? 0) > 50, `the master quest loads the prologue's profile (q_skalitz_normal: ${profiles.get("q_skalitz_normal")?.layers.length} layers)`);

brains.newGame();
run(30);
const at = (e: string) => events.indexOf(e);
const has = (re: RegExp) => lines.some((l) => re.test(l));
check(at("objective q_master_main/q_skalitz started") >= 0, "a new game starts the master quest's objective for the opening quest");
check(at("quest q_skalitz active") > at("objective q_master_main/q_skalitz started"), "which activates the opening quest (q_skalitz)");
// the data's own definition of this cutscene (Scripts/Script/cutscene.lua) is mode "dummy": nothing
// plays, the automaton only runs what surrounds a cutscene
check(has(/message cutscene to q_skalitz .*"alias":"stribrna_skalice"/) && has(/message cutsceneSubscription:event to q_master_main .*cutscenePhase\.start/),
  "its tree runs the opening cutscene through the cutscene automaton, and the master quest hears it start");
check(at("quest q_skalitz started") > at("quest q_skalitz active") && at("objective q_skalitz/objectiveStart started") >= 0, "after the cutscene the quest starts, with its first objective");
// (other layers hold their bodies for later quests under the same names)
const inProfile = (name: string) => [...ents.values()].find((e) => e.name === name && !!e.layer && profiles.get("q_skalitz_normal")!.layers.includes(e.layer));
const father = inProfile("ska_fatherOfHenry"), mother = inProfile("ska_motherOfHenry");
check(!!father && !!mother, `Henry's parents come from the profile's layers (${father?.layer?.replace(/\{.*/, "")})`);
check(patches.some((p) => p.npc === mother?.id && p.name === "motherPatch") && patches.some((p) => p.npc === father?.id && p.name === "fatherPatch"), "the quest gives Henry's mother and father their parts as daily-cycle patches (motherPatch, fatherPatch)");
check(world.profiles.has("q_skalitz_mother_dialog_cameras"), "and loads the cameras for the talk with his mother");
// the automaton fades in on the conversation with Henry's mother: it waits for that talk to start
// (the NPCs' quest patches and the dialogue they ask for come next)
world.runner.waiting = [];
brains.tickOne(brains.entities.get("q_skalitz")!);
check(world.runner.leaves().some((l) => l.endsWith("DialogGate")), "the cutscene's end waits for the player's conversation to begin (DialogGate)");
world.runner.waiting = null;
check(brains.ended.length <= 6, `quest trees that ended: ${brains.ended.map((id) => ents.get(id)?.name).join(", ") || "none"}`);
const ms = (performance.now() - t0) / ticks;
check(ms < 8, `one tick of all ${running} quest trees takes ${ms.toFixed(2)} ms here`);

if (debug) console.log(`\nevents:\n  ${events.join("\n  ")}`);
// where each tree waits: every branch left running by one more tick
for (const q of (opt("--waits", "q_master_main,q_skalitz")).split(",")) {
  const id = brains.entities.get(qdb.canonical(q) ?? "");
  if (id === undefined) continue;
  world.runner.waiting = [];
  brains.tickOne(id);
  console.log(`\n${q} waits in:\n  ${world.runner.leaves().map((l) => l.split(" > ").slice(-5).join(" > ")).join("\n  ")}`);
  world.runner.waiting = null;
}
console.log(`\nended trees: ${brains.ended.map((id) => ents.get(id)?.name).join(", ") || "none"}`);
console.log(`Lua errors: ${[...new Set(lua.errors)].slice(0, 12).join("\n  ") || "none"}`);
const gaps = [...world.unsupported].filter(([k]) => !k.startsWith("log: "));
console.log(`not supported yet (${gaps.length}):\n  ${gaps.map(([k, v]) => `${k} ×${v.size}`).sort().join("\n  ") || "none"}`);
console.log(fails ? `${fails} FAILED` : "OK");
process.exit(fails ? 1 : 0);
