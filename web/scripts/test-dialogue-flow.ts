// Node test for src/dialogueFlow.ts (read-only): the research note's tailor walkthrough. Henry talks
// to Rataje's tailor while his shop is open (MERCHANT, REPAIRMAN granted): the greeting plays
// first, then the menu is trade, repair, end topic; trade ends the conversation (flag 1) and the
// tailor barks a farewell. Without MERCHANT, trade is gone. Topic 6807 shows its choices by
// priority (0, 1, 2) with a 10 s limit. Every condition in the tables parses.
// usage: node scripts/test-dialogue-flow.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { DialogueDb } from "../src/dialogue.ts";
import { parses } from "../src/dialogueCondition.ts";
import { Conversation, DialogueState, luaScripts, menuOrder, neutralWorld, participant, type Candidate, type Step } from "../src/dialogueFlow.ts";
import { parseNpcEntities } from "../src/levelEntities.ts";
import { Localization } from "../src/localization.ts";
import { LuaHost } from "../src/luaHost.ts";
import { prepareSequence } from "../src/dialoguePlayer.ts";
import { readTable } from "../src/tables.ts";
import { Vfs } from "../src/vfs.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { gameSources } from "./lib.ts";

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

const root = process.argv[2] ?? join(homedir(), "kcd1");
const all = await gameSources(root);
const sources = all.filter((s) => !s.path.toLowerCase().includes("levels/"));
const vfs = await Vfs.build(sources, { filter: (n) => /^libs\/tables\//.test(n) || n.endsWith(".lua") || n.startsWith("libs/luaxml/"), includeHd: false });
let t0 = performance.now();
const db = await DialogueDb.load(vfs);
console.log(`dialogue tables: ${db.sequenceCount} sequences, ${db.branches.length} branches in ${Math.round(performance.now() - t0)} ms`);
const text = new Localization();
await text.load(all, ["text_ui_dialog", "text_ui_soul", "text_ui_ingame"]);
const label = (k: string) => text.get(k) ?? `[${k}]`;

// every condition parses
const bad: string[] = [];
for (const r of await readTable(vfs, "text/topic2sequence")) for (const c of [r.entry_condition, r.npc_entry_condition]) if (c?.trim()) { const e = parses(c); if (e) bad.push(`${c}: ${e}`); }
for (const [n, c] of db.functions) if (c.trim()) { const e = parses(c); if (e) bad.push(`${n}: ${e}`); }
console.log(bad.slice(0, 5).map((b) => JSON.stringify(b)).join("\n"));
check(bad.length === 0, `every entry condition and named condition parses (${bad.length} don't)`);

const lua = await LuaHost.create(vfs, createRequire(import.meta.url).resolve("wasmoon-lua5.1/dist/liblua5.1.wasm"));
await lua.preload();
await lua.preloadTables();
lua.boot();
const level = await openAsBlob(join(root, "Data/Levels/rataje/level.pak"));
const xml = new TextDecoder().decode(await readEntry(level, (await readCentralDirectory(level)).find((e) => e.name.toLowerCase() === "objects_mission0.xml")!));
const tailorEnt = parseNpcEntities(xml).find((n) => n.name === "rat_tailor")!;
const souls = await readTable(vfs, "rpg/soul");
const soulOf = (name: string) => { const r = souls.find((s) => s.soul_name === name)!; return { id: r.soul_id, name }; };
const HENRY_ENTITY = -1;
const entityOf = (name: string) => (name === "dude" ? HENRY_ENTITY : name === "rat_tailor" ? tailorEnt.id : undefined);
lua.setMetarole(tailorEnt.id, "MERCHANT", true);
lua.setMetarole(tailorEnt.id, "REPAIRMAN", true);

const state = new DialogueState();
const reports = new Set<string>();
let clock = 10 * 3600;
const host = { now: () => clock, call: neutralWorld(() => clock / 3600), runScript: luaScripts(lua, entityOf), report: (w: string) => reports.add(w) };
const people = () => [participant(db, soulOf("dude"), true, lua.metaroleChanges(HENRY_ENTITY)), participant(db, soulOf("rat_tailor"), false, lua.metaroleChanges(tailorEnt.id))];

/** Drive a conversation, choosing with `pick` at menus; returns the steps as text. */
function talk(conv: Conversation, pick: (options: string[]) => number): { log: string[]; menus: string[][] } {
  const log: string[] = [], menus: string[][] = [];
  let s: Step = conv.start();
  for (let guard = 0; guard < 40; guard++) {
    if (s.kind === "play") {
      const say = s.candidate.sequence.lines.find((l) => l.text);
      log.push(`play topic ${s.candidate.topic} seq ${s.candidate.sequence.id}${s.greeting ? " (greeting)" : ""}${say ? `: "${label(say.text!)}"` : ""}`);
      s = conv.played();
    } else if (s.kind === "menu") {
      const opts = s.options.map((o) => label(o.label));
      if (process.env.DEBUG) for (const o of s.options) console.log(`    option ${o.index}: topic ${o.candidate?.topic} seq ${o.candidate?.sequence.id} branch type ${o.candidate?.branchType} prio ${o.candidate?.branchPriority} topic prio ${o.candidate?.topicPriority} pairs ${JSON.stringify(o.candidate ? db.rolePairs(o.candidate.owner).map((p) => `${db.metaroleName(p.metarole)}/${db.role(p.role)?.name}`) : [])} cond "${db.topicSequences(o.candidate?.topic ?? -1).find((e) => e.sequence === o.candidate?.sequence.id)?.entryCondition}" ${o.label}`);
      menus.push(opts);
      log.push(`menu${s.timeLimit ? ` (${s.timeLimit} s)` : ""}: ${opts.map((o, i) => `${i + 1}. ${o}`).join(" | ")}`);
      s = conv.choose(pick(opts));
    } else if (s.kind === "haggle") {
      log.push(`price panel: ${JSON.stringify(s.prices)}`);
      s = conv.played();
    } else if (s.kind === "bark") {
      log.push(`farewell (topic seq ${s.sequence.id}), ${conv.participants[s.participant].name}: "${label(s.line.text ?? "")}"`);
      break;
    } else { log.push(`end: ${s.reason}`); break; }
  }
  return { log, menus };
}

// the "Talk" prompt's check (once per faced NPC every 2 s in the view)
t0 = performance.now();
for (let i = 0; i < 20; i++) new Conversation(db, state, people(), host).hasSomethingToSay();
console.log(`  has something to say: ${((performance.now() - t0) / 20).toFixed(2)} ms per check`);

// 1. shop open: greeting, then trade / repair / end topic; pick trade
const first = talk(new Conversation(db, state, people(), host), (o) => o.findIndex((x) => /trade|buy|goods/i.test(x)));
console.log("  " + first.log.join("\n  "));
check(first.log[0]?.includes("topic 25570") && first.log[0].includes("greeting"), "the greeting 25570 plays first (7930's empty condition is skipped at an entry point)");
const menu = first.menus[0] ?? [];
check(menu.length === 3 && menu[2] === label("ui_end_topic"), `the menu is trade, repair, end topic (${menu.length} options)`);
check(first.log.some((l) => l.includes("seq 42432")), "trade (sequence 42432) plays");
check(first.menus.length === 1 && /farewell/.test(first.log.at(-1) ?? "") && first.log.at(-1)!.includes("rat_tailor"), "trade ends it (flag 1): no menu again, the tailor barks the farewell");

// 2. the greeting script took his POZDRAV metarole: the next talk starts at the menu; end topic
clock += 600;
const second = talk(new Conversation(db, state, people(), host), (o) => o.length - 1);
console.log("  " + second.log.join("\n  "));
check(!second.log.some((l) => l.includes("greeting")), "no greeting the second time (the greeting's script removed POZDRAV)");
check(/farewell/.test(second.log.at(-1) ?? ""), "end topic goes straight to the farewell");

// 3. shop closed: no MERCHANT, so no trade
lua.setMetarole(tailorEnt.id, "MERCHANT", false);
const third = talk(new Conversation(db, state, people(), host), (o) => o.length - 1);
console.log("  " + third.log.join("\n  "));
const m3 = third.menus[0] ?? [];
check(m3.length === 2 && !m3.some((x) => /trade|buy/i.test(x)), `without MERCHANT the menu is repair, end topic (${m3.join(", ")})`);

// 5. with q_revenge started the townsman topic (20464) is on the menu, first (topic priority 7);
// it leads into follow-ups and, not ending the conversation, back to the menu
lua.setMetarole(tailorEnt.id, "MERCHANT", true);
clock += 600;
const world = neutralWorld(() => clock / 3600);
const questHost = { ...host, call: (name: string, args: (string | number)[], who: Parameters<typeof world>[2], named?: string) => (name === "IsQuestStarted" && args[0] === "q_revenge" ? 1 : world(name, args, who, named)) };
let menusSeen = 0;
const fifth = talk(new Conversation(db, state, people(), questHost), (o) => (menusSeen++ === 0 ? 0 : o.length - 1));
console.log("  " + fifth.log.join("\n  "));
check(fifth.menus.length >= 2 && fifth.menus[0].length === 4, `with q_revenge: the townsman topic joins the menu (${fifth.menus[0]?.length} options), and the menu comes back after it`);

// 4. topic 6807: table order 0, 2, 1 shown as 0, 1, 2; 10 s limit
const cands: Candidate[] = db.topicSequences(6807).map((e) => ({ topic: 6807, sequence: db.sequence(e.sequence)!, npcEntryCondition: "", branchType: 0, branchPriority: 0, topicPriority: db.topic(6807).priority, owner: db.owner(6807), requested: false }));
console.log(`  topic 6807: table order ${cands.map((c) => c.sequence.priority).join(", ")}, menu ${menuOrder(cands).map((c) => c.sequence.priority).join(", ")}, limit ${db.topic(6807).timeLimit} s`);
check(menuOrder(cands).map((c) => c.sequence.priority).join(",") === "0,1,2" && db.topic(6807).timeLimit === 10, "topic 6807: menu 0, 1, 2 (a timeout picks the first), 10 s");

// clocks (dialogue.md): a cooldown is `timeout` seconds of play time since the sequence was used;
// -1 once only, 0 always. The view passes play seconds (real time at game speed), not world time.
{
  const seq = (timeout: number) => ({ ...db.sequence(42432)!, id: 900000 + timeout + 1, timeout });
  const st = new DialogueState();
  const s300 = seq(300), once = seq(-1), always = seq(0);
  for (const s of [s300, once, always]) st.used.set(s.id, 1000);
  check(!st.available(s300, 1299) && st.available(s300, 1300), "timeout 300: available again 300 s of play time after use, not before");
  check(!st.available(once, 1e9) && st.available(always, 1000), "timeout -1: once only; 0: always available");
  // world time runs 15x: 300 s of it is 20 s of play time, far short of the cooldown
  check(!st.available(s300, 1000 + 300 / 15), "300 world seconds (20 s of play) don't end a 300 s cooldown");
}
// line types 2 and 4 are skipped at playback: no event, no time
{
  const base = db.sequence(42432)!;
  const lines = [{ id: 1, order: 0, type: 4 }, { id: 2, order: 1, type: 2 }, { id: 3, order: 2, type: 1, role: 0, text: "x" }, { id: 4, order: 3, type: 2 }];
  const tl = await prepareSequence(db, { ...base, lines } as typeof base, new Map(), null, null);
  check(tl.events.length === 1 && tl.events[0].kind === "say", `line types 2 and 4 are skipped (${tl.events.map((e) => e.kind).join(", ")})`);
}

if (reports.size) console.log(`not modelled (counted as 0): ${[...reports].slice(0, 12).join("; ")}`);
if (lua.errors.length) console.log(`Lua errors: ${[...new Set(lua.errors)].slice(0, 5).join(" | ")}`);
console.log(fails ? `${fails} FAILED` : "OK");
if (fails) process.exit(1);
