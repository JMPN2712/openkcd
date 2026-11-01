// Diet mode (src/diet.ts, dietConfig.ts, quests.ts). First the overlay on a small hand-made quest
// table: a cut quest reads as cancelled, refuses every change and gives no events, and turning the
// setting off restores its true stored state. Then the research notes' five reachability checks,
// with diet mode on, against the game's quest tables, quest trees and dialogue tables:
//   1. no main step waits on a cut quest (the Simon route of q_recruiters is the allowed exception);
//   2. every required quest can start, from a kept source (and the one the spec names);
//   3. reading (q_learnToRead) is not cut;
//   4. each main quest's end is reachable through its objective graph;
//   5. no kept quest is started by a cut quest, beyond the expected matches (starts of cut quests,
//      the hubs' and the bookkeeping quest's objectives).
// Also: every configured quest, objective, item and shop exists.
// usage: node scripts/test-diet.ts [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { gameSources } from "./lib.ts";
import { Vfs } from "../src/vfs.ts";
import { readTable, type Row } from "../src/tables.ts";
import { DialogueDb } from "../src/dialogue.ts";
import { parseCondition, type CondNode, type CondValue } from "../src/dialogueCondition.ts";
import { QuestDb, QuestSystem, CANCELED, COMPLETED, END, START, SEQ_START, UNCHANGED, type QuestEvent } from "../src/quests.ts";
import { DietMode } from "../src/diet.ts";
import { DIET, cutQuests, type DietConfig } from "../src/dietConfig.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

// ---- the overlay, on a hand-made table ----
{
  const quest = (id: string, name: string, activated = "False") => ({ quest_id: id, quest_name: name, is_activated: activated, counter: "1", quest_type_id: "2", group: "" });
  const obj = (q: string, id: string, name: string, condition = "", hidden = "False") => ({ quest_id: q, objective_id: id, objective_name: name, condition, is_hidden: hidden, is_exclusive: "False" });
  const edge = (q: string, from: string, to: string) => ({ quest_id: q, from_objective_id: from, to_objective_id: to, enabled: "True" });
  const db = QuestDb.from({
    quests: [quest("1", "q_cut", "True"), quest("2", "q_kept"), quest("3", "q_hub", "True"), quest("4", "q_route")],
    objectives: [
      obj("1", "4", "offer"), obj("1", "5", "reward"),
      obj("2", "4", "talk"),
      obj("3", "4", "q_cut_giver", "IsQuestStarted('q_cut') | IsQuestCanceled('q_cut')", "True"),
      obj("4", "4", "askCut"), obj("4", "5", "askOther"),
    ],
    transitions: [edge("1", "2", "4"), edge("1", "4", "5"), edge("1", "5", "3"), edge("2", "2", "4"), edge("2", "4", "3"), edge("3", "2", "4"), edge("4", "2", "5")],
    subchapters: [{ quest_id: "1", skald_subchapter_id: "10" }, { quest_id: "2", skald_subchapter_id: "11" }],
    topics: [{ skald_subchapter_id: "10", start_topic: "100" }],
    skald: [{ quest_id: "1", objective_id: "4" }],
    s2q: [
      { sequence_id: "500", quest_id: "1", objective_id: "4", action: "1", condition: "", order_by: "1" },
      { sequence_id: "501", quest_id: "2", objective_id: "4", action: "1", condition: "", order_by: "1" },
      { sequence_id: "501", quest_id: "1", objective_id: "4", action: "1", condition: "", order_by: "2" },
    ],
    places: [{ quest_id: "1", entity: "cut_spot" }],
    rewards: [{ quest_id: "1", objective_id: "5", is_immediate: "False" }],
  });
  const config: DietConfig = {
    cut: { test: ["q_cut"] }, required: {}, mainHelpers: [], bookkeeping: ["q_hub"],
    rewire: { q_route: { objectives: ["askCut"], sequences: [600], why: "test", when: "q_cut" } },
    grants: [{ item: "i", itemName: "thing", shop: 7, shopName: "shop", amount: 1, lostWith: "q_cut" }],
  };
  let on = true;
  const sys = new QuestSystem(db);
  const diet = new DietMode(db, { owner: (t) => t, sequence: () => undefined }, config, () => on).attach(sys);
  const events: QuestEvent[] = [];
  sys.on((e) => events.push(e));
  check(diet.missing.length === 0, "unit: the test config resolves");

  check(sys.call("IsQuestCanceled", ["q_cut"]) === 1 && sys.call("IsQuestStarted", ["q_cut"]) === 0 && sys.call("IsQuestCompleted", ["q_cut"]) === 0
    && sys.call("IsQuestAvailable", ["q_cut"]) === 0 && sys.call("IsQuestActivated", ["q_cut"]) === 0, "unit: a cut quest reads as cancelled (not activated, started, completed or available)");
  check(sys.call("IsObjectiveCanceled", ["q_cut", "offer"]) === 1 && sys.call("IsObjectiveUnchanged", ["q_cut", "offer"]) === 0, "unit: its objectives read as cancelled");
  check(!sys.startQuest("q_cut") && !sys.activate("q_cut") && !sys.startObjective("q_cut", "offer") && !sys.apply("StartQuest", "q_cut") && !sys.cancelQuest("q_cut") && !sys.resetQuest("q_cut"),
    "unit: starting, activating, cancelling or resetting it is refused");
  sys.runSequence(500);
  check(events.length === 0, "unit: no notification, banner or reward event for it");
  check(!("q_cut" in sys.save()), "unit: nothing is written to the saved state for it");
  check(diet.hidesSequence(500, 1) && diet.hidesSequence(1, 100) && !diet.hidesSequence(501, 1), "unit: its offers are hidden (an owned topic, a sequence that only starts it), not a sequence that also starts a kept quest");
  check(!diet.treeRuns("q_cut") && diet.treeRuns("q_kept"), "unit: its own trees don't run");
  check(diet.shopGrants(7).length === 1 && diet.shopGrants(8).length === 0, "unit: the grant is stocked in its shop");

  // a hub objective that waits for the giver's quest to start or be cancelled moves on
  sys.startQuest("q_hub");
  check(sys.objectiveState("q_hub", "q_cut_giver") === COMPLETED, "unit: a hub's objective keyed on the cut quest reads it as cancelled and completes");
  check(diet.hubLink("q_hub", 4) === "q_cut" && diet.hidesMarker({ quest: "q_hub", objective: 4 }), "unit: the hub's marker for its giver is hidden");

  // a rewired option
  sys.startQuest("q_route");
  check(!sys.startObjective("q_route", "askCut") && sys.objectiveState("q_route", "askCut") === UNCHANGED, "unit: a rewired objective is never started");
  check(diet.hidesSequence(600, 1), "unit: a rewired sequence is hidden");

  // the setting off: the true stored state (never started), and the full game
  on = false;
  check(sys.call("IsQuestCanceled", ["q_cut"]) === 0 && sys.call("IsQuestAvailable", ["q_cut"]) === 1 && sys.call("IsQuestActivated", ["q_cut"]) === 1,
    "unit: turned off, the cut quest reads its true state (activated, available, not cancelled)");
  check(sys.objectiveState("q_cut", "offer") === UNCHANGED && !diet.hidesSequence(500, 1) && diet.shopGrants(7).length === 0, "unit: turned off, its objectives, offers and the shop are the full game's");
  check(sys.startQuest("q_cut") && sys.call("IsObjectiveStarted", ["q_cut", "offer"]) === 1 && events.some((e) => e.quest === "q_cut"), "unit: turned off, it starts and announces itself");
  check(sys.startObjective("q_route", "askCut"), "unit: turned off, the rewired objective starts");
  on = true;
  check(sys.call("IsQuestStarted", ["q_cut"]) === 1 && !sys.isCut("q_cut"), "unit: a cut quest started with diet mode off keeps running when it is turned on");
  sys.completeObjective("q_cut", "offer");
  sys.completeObjective("q_cut", "reward");
  check(sys.call("IsQuestCompleted", ["q_cut"]) === 1 && events.some((e) => e.kind === "reward" && e.quest === "q_cut"), "unit: and it finishes with its reward");
}

// ---- the game data ----

const sources = await gameSources(root);
const vfs = await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => /^libs\/(tables\/.*\.xml|ai\/quests\/.*\.xml)$/.test(n), includeHd: false });
const [qdb, ddb, items, shops] = await Promise.all([QuestDb.load(vfs), DialogueDb.load(vfs), readTable(vfs, "item/item"), readTable(vfs, "shop/shop")]);
const sys = new QuestSystem(qdb);
const diet = new DietMode(qdb, ddb, DIET, () => true).attach(sys);
const cut = new Set(cutQuests().map((q) => qdb.canonical(q)!));

check(cutQuests().length === 39 && cut.size === 39, `the config cuts 39 quests (${cut.size} distinct)`);
check(diet.missing.length === 0, `every configured quest and objective exists${diet.missing.length ? `: missing ${diet.missing.join(", ")}` : ""}`);
const itemName = new Map(items.map((r: Row) => [r.item_id, r.item_name]));
const shopName = new Map(shops.map((r: Row) => [Number(r.shop_id), r.shop_name]));
for (const g of DIET.grants) {
  check(itemName.has(g.item) && shopName.get(g.shop) === g.shopName, `grant: ${g.itemName} (${g.item.slice(0, 8)}…) in ${g.shopName} (shop ${g.shop}), for ${g.lostWith}`);
}

const main = new Set([...qdb.quests.values()].filter((q) => q.type === 1 && q.group === "Main").map((q) => q.name));
for (const h of DIET.mainHelpers) main.add(qdb.canonical(h)!);
const required = Object.keys(DIET.required).map((q) => qdb.canonical(q)!);
const story = new Set([...main, ...required]);
check(main.size >= 30, `the main story: ${main.size} quests (type 1, group Main, and the hidden helpers)`);
check([...story].every((q) => !cut.has(q)), "no main or required quest is cut");

// ---- condition analysis: three-valued (unknown where the game decides) ----

const UNKNOWN = Symbol("unknown");
type V = CondValue | typeof UNKNOWN;
const truth = (v: CondValue) => (typeof v === "number" ? v !== 0 : v !== "" && v !== "0");
/** Evaluate with cut quests read as cancelled (or unknown, `cutKnown` false); everything else is unknown. */
function evaluate(n: CondNode, cutKnown: boolean): V {
  switch (n.k) {
    case "lit": return n.v;
    case "ref": return UNKNOWN;
    case "not": { const v = evaluate(n.e, cutKnown); return v === UNKNOWN ? UNKNOWN : truth(v) ? 0 : 1; }
    case "neg": { const v = evaluate(n.e, cutKnown); return v === UNKNOWN ? UNKNOWN : -Number(v); }
    case "call": {
      const a = n.args.map((x) => evaluate(x, cutKnown));
      if (cutKnown && /^Is(Quest|Objective)/.test(n.name) && a[0] !== UNKNOWN && cut.has(qdb.canonical(String(a[0])) ?? "")) {
        return sys.call(n.name, a as CondValue[]) ?? UNKNOWN;
      }
      return UNKNOWN;
    }
    case "bin": {
      const a = evaluate(n.a, cutKnown), b = evaluate(n.b, cutKnown);
      if (n.op === "&") return (a !== UNKNOWN && !truth(a)) || (b !== UNKNOWN && !truth(b)) ? 0 : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : 1;
      if (n.op === "|") return (a !== UNKNOWN && truth(a)) || (b !== UNKNOWN && truth(b)) ? 1 : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : 0;
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      const x = Number(a), y = Number(b);
      switch (n.op) {
        case "==": return String(a) === String(b) ? 1 : 0;
        case "!=": return String(a) !== String(b) ? 1 : 0;
        case "<": return x < y ? 1 : 0;
        case ">": return x > y ? 1 : 0;
        case "<=": return x <= y ? 1 : 0;
        case ">=": return x >= y ? 1 : 0;
        case "+": return x + y;
        case "-": return x - y;
        case "*": return x * y;
        default: return UNKNOWN;
      }
    }
  }
}
/** Never true with diet mode on, though it could be in the full game: it needs a cut quest. */
function needsCut(condition: string): boolean {
  if (!condition.trim()) return false;
  let n: CondNode;
  try { n = parseCondition(condition); } catch { return false; }
  const on = evaluate(n, true), off = evaluate(n, false);
  return on !== UNKNOWN && !truth(on) && !(off !== UNKNOWN && !truth(off));
}
const rewireWhen = (q: string) => { const r = Object.entries(DIET.rewire).find(([k]) => qdb.canonical(k) === q)?.[1]; return r ? qdb.canonical(r.when) : undefined; };

// ---- 1. no main step waits on a cut quest ----
{
  const bad: string[] = [], allowed: string[] = [];
  let tallies = 0;
  for (const q of story) {
    for (const o of qdb.objectivesOf(q)) {
      if (!needsCut(o.condition)) continue;
      // the bookkeeping quest's tallies of cut quests: a cancelled quest simply does not count
      if (DIET.bookkeeping.includes(q) && diet.hubLink(q, o.id)) { tallies++; continue; }
      const when = rewireWhen(q);
      (when && o.condition.toLowerCase().includes(`'${when.toLowerCase()}'`) ? allowed : bad).push(`${q}/${o.name}: ${o.condition.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }
  for (const a of allowed) console.log(`     allowed (rewired route): ${a}`);
  check(bad.length === 0, `1. no objective of the ${story.size} main and required quests needs a cut quest (${allowed.length} on the rewired Simon route, ${tallies} bookkeeping tallies)${bad.length ? `:\n       ${bad.join("\n       ")}` : ""}`);
}

// ---- the starts: every start or activation in the trees, the dialogue and its scripts ----

interface Start {
  source: string;
  how: string;
  target: string;
  /** a StartObjective's objective id */
  objective?: number;
}
const starts: Start[] = [];
const START_FNS = new Set(["StartQuest", "ActivateQuest", "StartObjective"]);
/** a quoted property's content ("" for an empty one), or null for a variable */
const quotedText = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : null);
const LUA_START = /QuestSystem\.(StartQuest|ActivateQuest|StartObjective)\(\s*['"]([^'"]+)['"]/g;
let treeFiles = 0, containerStarts = 0;
// every SetQuest / SetQuestObjective element under a tree's Root. ForestContainer groups (the
// editor's loose nodes) never run, per the research notes, so they are cut out before the scan;
// EditorData copies carry no properties
const unescape = (x: string) => x.replace(/&(quot|apos|lt|gt|amp|#xD|#xA|#x9);/g, (_, e: string) => ({ quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" } as Record<string, string>)[e] ?? " ");
const attr = (tag: string, name: string) => unescape(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "");
const objectiveOf = (q: string, ref: string) => (ref ? qdb.objectiveId(q, ref) : undefined);
for (const path of vfs.paths()) {
  if (!path.startsWith("libs/ai/quests/")) continue;
  const raw = new TextDecoder().decode(await vfs.read(vfs.lookup(path)!));
  if (!raw.includes("<BehaviorTree")) continue;
  const xml = raw.replace(/<ForestContainer>[\s\S]*?<\/ForestContainer>/g, (c) => {
    containerStarts += [...c.matchAll(/<SetQuest(?:Objective)?\s[^>]*function="&quot;(?:StartQuest|ActivateQuest|StartObjective)&quot;"/g)].length;
    return "";
  });
  treeFiles++;
  const file = path.slice("libs/ai/quests/".length, -4);
  const source = qdb.canonical(file) ?? `tree:${file}`;
  for (const m of xml.matchAll(/<SetQuest(Objective)?\s[^>]*>/g)) {
    const tag = m[0], obj = !!m[1];
    const fn = quotedText(attr(tag, "function"));
    const name = quotedText(attr(tag, obj ? "quest" : "questName"));
    if (!fn || !START_FNS.has(fn) || name === null) continue;
    const target = name === "" ? (qdb.canonical(source) ?? undefined) : qdb.canonical(name);
    if (!target) continue;
    const ref = quotedText(attr(tag, obj ? "objective" : "objectiveName")) ?? "";
    starts.push({ source, how: `tree ${fn}`, target, objective: fn === "StartObjective" ? objectiveOf(target, ref) : undefined });
  }
  for (const m of unescape(xml).matchAll(LUA_START)) {
    const t = qdb.canonical(m[2]);
    if (t) starts.push({ source, how: `tree Lua ${m[1]}`, target: t, objective: m[1] === "StartObjective" ? objectiveOf(t, /^\s*['"]([^'"]*)['"]/.exec(unescape(xml).slice(m.index + m[0].length).replace(/^\s*,/, ""))?.[1] ?? "") : undefined });
  }
}
// a sequence's source: the quest whose journal entry owns its topic, else "dialogue"
const topicQuest = new Map<number, string>();
for (const q of qdb.quests.keys()) for (const t of qdb.startTopics(q)) if (!topicQuest.has(t)) topicQuest.set(t, q);
const t2s = await readTable(vfs, "text/topic2sequence");
const seqSource = new Map<number, string>();
for (const r of t2s) {
  const q = topicQuest.get(ddb.owner(Number(r.topic_id)));
  const s = Number(r.sequence_id);
  if (!seqSource.has(s) || q) seqSource.set(s, q ?? "dialogue");
}
for (const [seq, writes] of qdb.sequencesWriting()) {
  let source = seqSource.get(seq) ?? "dialogue";
  // a sequence no journal entry owns that only changes cut quests is part of their dialogue
  if (source === "dialogue" && writes.every((w) => cut.has(w.quest))) source = writes[0].quest;
  for (const w of writes) if (w.action === SEQ_START) starts.push({ source, how: `sequence ${seq}`, target: w.quest, objective: w.objective });
}
for (const r of t2s) {
  const seq = Number(r.sequence_id), script = ddb.sequence(seq)?.script ?? "";
  for (const m of script.matchAll(LUA_START)) { const t = qdb.canonical(m[2]); if (t) starts.push({ source: seqSource.get(seq) ?? "dialogue", how: `sequence ${seq} script ${m[1]}`, target: t }); }
}
console.log(`starts: ${starts.length} (from ${treeFiles} quest tree files and the dialogue tables)`);
console.log(`     left out: ${containerStarts} start nodes in ForestContainer groups (editor data that never runs)`);

// ---- 2. every required quest can start from a kept source ----
for (const [name, expected] of Object.entries(DIET.required)) {
  const q = qdb.canonical(name)!;
  const from = starts.filter((s) => s.target === q && s.source !== q);
  const kept = from.filter((s) => !cut.has(s.source));
  const sources = [...new Set(kept.map((s) => s.source))];
  const named = expected === null || sources.includes(qdb.canonical(expected) ?? expected);
  check(kept.length > 0 && named, `2. ${q} starts from ${sources.join(", ") || "nothing"}${expected ? ` (expected ${expected})` : ""}${from.length > kept.length ? `; ${from.length - kept.length} starts from cut quests` : ""}`);
}

// ---- 3. reading is reachable ----
check(!cut.has("q_learnToRead") && !diet.listed("q_learnToRead"), "3. Mightier than the Sword (reading, before the monastery porter) is not cut");

// ---- 4. each main quest's end is reachable ----
{
  // ASSUMPTION: most objectives are started by name (the quest's trees, dialogue), so every
  // objective a source starts is a seed besides the initial ones; an objective is reached when any
  // predecessor is (exclusive siblings and cancels finish the others), and passed unless its
  // condition needs a cut quest or a rewire blocks it. The same walk with diet mode off is the
  // control: a quest it can't follow either is beyond this static walk, not lost to the diet.
  const reaches = (q: string, dietOn: boolean): boolean => {
    const blocked = (id: number) => { const o = qdb.objective(q, id); return !o || (dietOn && (needsCut(o.condition) || diet.blocks(q, o.name))); };
    const seen = new Set<number>();
    const queue = [...qdb.initial(q).filter((id) => id !== END), ...starts.filter((s) => s.target === q && s.objective !== undefined && !(dietOn && cut.has(s.source))).map((s) => s.objective!)];
    let end = qdb.initial(q).includes(END);
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (blocked(id)) continue;
      for (const s of qdb.successors(q, id)) { if (s === END) end = true; else if (!seen.has(s)) queue.push(s); }
    }
    return end;
  };
  const withEnd = [...story].filter((q) => qdb.objectivesOf(q).some((o) => qdb.isFinal(q, o.id)));
  const lost = withEnd.filter((q) => reaches(q, false) && !reaches(q, true));
  const beyond = withEnd.filter((q) => !reaches(q, false));
  if (beyond.length) console.log(`     not followed by the static walk even in the full game (control): ${beyond.join(", ")}`);
  check(lost.length === 0, `4. every main and required quest with an end (${withEnd.length - beyond.length} followed) reaches it with cut quests read as cancelled${lost.length ? `: not ${lost.join(", ")}` : ""}`);
}

// ---- 5. nothing kept is started only by accident from a cut quest ----
{
  const bookkeeping = new Set(DIET.bookkeeping.map((q) => qdb.canonical(q)));
  /** starts from a quest in `cutSet` of a quest outside it, other than the hubs and the bookkeeping quest */
  const accidental = (cutSet: Set<string>) => starts.filter((s) => cutSet.has(s.source) && !cutSet.has(s.target) && !bookkeeping.has(s.target));
  const fromCut = starts.filter((s) => cut.has(s.source));
  console.log(`     ${fromCut.length} starts from cut quests; expected: ${fromCut.filter((s) => cut.has(s.target)).length} inside the cut lines, ${fromCut.filter((s) => bookkeeping.has(s.target)).length} on the hubs and the bookkeeping quest`);
  const lines = [...new Set(accidental(cut).map((s) => `${s.source} → ${s.target} (${s.how})`))];
  check(lines.length === 0, `5. no kept quest is started by a cut quest beyond the expected matches${lines.length ? `:\n       ${lines.join("\n       ")}` : ""}`);
  // the check itself: cutting the counterfeiters too must flag its tree's start of the abducted woman
  const probe = accidental(new Set([...cut, "q_counterfeiters"]));
  check(probe.some((s) => s.source === "q_counterfeiters" && s.target === "q_abductedWoman" && s.how.startsWith("tree")), "5. (self-test) cutting the counterfeiters as well would be flagged: its tree starts the abducted woman");
}

// ---- the overlay on the real tables ----
{
  const offers = [...cut].reduce((n, q) => n + qdb.startTopics(q).length, 0);
  check(offers > 0 && diet.hidesSequence(54493, 0), `the cut quests' offers are hidden (${offers} journal start topics; Simon's "StartQuest" sequence)`);
  check(diet.hidesSequence(37674, 0), "q_recruiters: the innkeeper's line pointing at Miller Simon is hidden");
  sys.startQuest("q_recruiters");
  check(!sys.startObjective("q_recruiters", "talkToSimon") && sys.objectiveState("q_recruiters", "talkToSimon") === UNCHANGED, "q_recruiters: the Simon route is never started");
  check(sys.startObjective("q_recruiters", "askSimon") === false && sys.call("IsObjectiveUnchanged", ["q_recruiters", "askSimon"]) === 1, "q_recruiters: askSimon stays unchanged, so the Sasau innkeeper route opens");
  check(!sys.startQuest("a_swordofsheba") && sys.objectiveState("a_swordofsheba", 4) === CANCELED || qdb.objective("a_swordofsheba", 4) === undefined, "a cut quest in the real tables refuses to start and reads as cancelled");
  const hubMarkers = [...qdb.quests.keys()].filter((q) => DIET.bookkeeping.includes(q)).flatMap((q) => qdb.objectivesOf(q).filter((o) => diet.hubLink(q, o.id)));
  check(hubMarkers.length > 0, `${hubMarkers.length} hub and bookkeeping objectives follow a cut quest (their markers are hidden)`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
