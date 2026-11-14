// Node test for the quest state's automatic completion (src/quests.ts; research notes,
// quest-system.md "Automatic completion"): tracked assets and objective timers, on a made-up quest.
// No game files needed.
// usage: node scripts/test-quests.ts

import { QuestDb, QuestSystem, type QuestEvent } from "../src/quests.ts";

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

const obj = (id: string, name: string, o: { condition?: string; auto?: string; expire?: string } = {}) => ({ quest_id: "1", objective_id: id, objective_name: name, condition: o.condition ?? "1", is_hidden: "True", is_exclusive: "False", autocomplete_timeout_str: o.auto ?? "-1", expiration_timeout_str: o.expire ?? "" });
const edge = (from: string, to: string) => ({ quest_id: "1", from_objective_id: from, to_objective_id: to, enabled: "True" });
const tracked = (objective: string, asset: string, count: string) => ({ quest_id: "1", objective_id: objective, quest_asset_id: asset, count, on_map: "False", pos: "", map_asset_id: "" });
const db = QuestDb.from({
  quests: [{ quest_id: "1", quest_name: "q_test", is_activated: "True", counter: "1", quest_type_id: "2", group: "" }],
  objectives: [
    obj("4", "passThrough"), obj("5", "haveHerbs"), obj("6", "banditDead"), obj("7", "atTheMill"), obj("8", "kills"),
    obj("9", "blankWithItem", { condition: "" }), obj("10", "markerOnly"),
    obj("11", "afterTwoHours", { auto: "2h #WT" }), obj("12", "tenSeconds", { auto: "10s #GT" }), obj("13", "expires", { condition: "0", expire: "1m" }), obj("14", "pulse", { condition: "0", expire: "0s #WT" }),
    obj("15", "end"),
  ],
  transitions: [...["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14"].map((o) => edge("2", o)), edge("15", "3")],
  assetItems: [{ quest_id: "1", quest_asset_id: "20", item_id: "herb" }, { quest_id: "1", quest_asset_id: "24", item_id: "" }],
  assetNpcs: [{ quest_id: "1", quest_asset_id: "21", soul_id: "bandit" }],
  places: [{ quest_id: "1", quest_asset_id: "22", entity: "mill" }],
  assetStats: [{ quest_id: "1", quest_asset_id: "23", statistic_id: "7" }],
  tracked: [tracked("5", "20", "5"), tracked("6", "21", "1"), tracked("7", "22", "1"), tracked("8", "23", "3"), tracked("9", "20", "1"), tracked("10", "20", "0"), tracked("10", "", "1")],
});

const quests = new QuestSystem(db);
const world = { herbs: 0, deaths: 0, at: "", kills: 0, ms: 0 };
quests.world = {
  itemCount: (i) => (i === "herb" ? world.herbs : 0),
  deaths: (s) => (s === "bandit" ? world.deaths : 0),
  playerAt: (e) => e === world.at,
  statistic: (id) => (id === 7 ? world.kills : 0),
  clock: (which) => (which === "world" ? world.ms * 15 : world.ms),
};
const events: string[] = [];
quests.on((e: QuestEvent) => { if (e.kind === "objective") events.push(`${db.objective(e.quest, e.objective)?.name} ${["started", "completed", "canceled", "expired"][e.state]}`); });
const is = (fn: string, o: string) => quests.call(fn, ["q_test", o]) === 1;
const started = (o: string) => is("IsObjectiveStarted", o), completed = (o: string) => is("IsObjectiveCompleted", o);

check(db.tracked("q_test", 5)[0]?.kind === "item" && db.tracked("q_test", 6)[0]?.kind === "npc" && db.tracked("q_test", 7)[0]?.kind === "place" && db.tracked("q_test", 8)[0]?.kind === "statistic", "an asset's kind is the table that holds it");
check(db.tracked("q_test", 10).length === 0, "a count of 0 and a map-only row track nothing");

quests.startQuest("q_test");
check(completed("passThrough") && completed("markerOnly"), "condition 1 with nothing to count passes through at once");
check(["haveHerbs", "banditDead", "atTheMill", "kills", "blankWithItem"].every(started), "objectives that track something wait");
check(started("afterTwoHours") && started("tenSeconds"), "objectives with an auto-complete timer wait for it");
check(events.includes("pulse started") && !events.includes("pulse expired"), "timers fire in update(), not at the start");

world.herbs = 4;
quests.recheck();
check(started("haveHerbs") && !is("IsObjectiveTrackedCompleted", "haveHerbs"), "4 of 5 herbs: still waiting");
world.herbs = 5;
quests.recheck();
check(completed("haveHerbs"), "5 herbs complete it");
check(started("blankWithItem") && is("IsObjectiveTrackedCompleted", "blankWithItem"), "a blank condition never completes by itself, but reads as tracked completed");
world.herbs = 0;
quests.recheck();
check(!is("IsObjectiveTrackedCompleted", "blankWithItem") && started("blankWithItem"), "and no longer once the item is gone");
world.deaths = 1; world.at = "mill"; world.kills = 3;
quests.recheck();
check(completed("banditDead") && completed("atTheMill") && completed("kills"), "a death, the player at the place and a statistic complete theirs");

// timers: 10 s of play time; 2 h of world time is 8 real minutes
world.ms = 9_000;
quests.update();
check(started("tenSeconds"), "9 s: the 10 s timer has not elapsed");
world.ms = 10_000;
quests.update();
check(completed("tenSeconds") && started("afterTwoHours"), "10 s of play time complete tenSeconds");
check(events.includes("pulse expired") && started("pulse"), "a 0 s expiration announces Expired at the first update; the objective stays active");
world.ms = 61_000;
quests.update();
check(events.filter((e) => e === "expires expired").length === 1 && events.filter((e) => e === "pulse expired").length === 1, "a 1 m expiration fires once after a minute");
world.ms = 7 * 60_000;
quests.update();
check(started("afterTwoHours"), "7 real minutes: 2 world hours have not passed");
world.ms = 8 * 60_000;
quests.update();
check(completed("afterTwoHours"), "8 real minutes are 2 hours of world time");

// timers survive a save
const q2 = new QuestSystem(db);
q2.world = { clock: () => world.ms };
q2.startQuest("q_test");
const saved = q2.save();
const q3 = new QuestSystem(db);
q3.world = { clock: () => world.ms + 10_000 };
q3.load(saved);
q3.update();
check(q3.call("IsObjectiveCompleted", ["q_test", "tenSeconds"]) === 1, "armed timers are saved with the quest");
// without a clock nothing elapses
const q4 = new QuestSystem(db);
q4.startQuest("q_test");
q4.update();
check(q4.call("IsObjectiveStarted", ["q_test", "tenSeconds"]) === 1, "without a clock, timed objectives wait");

console.log(fails ? `${fails} FAILED` : "OK");
process.exit(fails ? 1 : 0);
