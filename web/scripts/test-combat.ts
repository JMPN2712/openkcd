// Node test for src/combat.ts (research notes: combat-melee.md, combat-damage.md, combat-ai.md):
// the formulas against the notes' worked numbers, then fights from the game's tables: Henry's
// fist fight with Kunesh (the opening quest), and a swordsman against a bandit.
// usage: node scripts/test-combat.ts [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { gameSources } from "./lib.ts";
import { Vfs } from "../src/vfs.ts";
import {
  ATTACK_TYPES, CombatDb, Fight, P, aggression, attackChance, attackDelay, attackSpeed, attackStaminaCost, attackVector, blockDefence, blockProbability, defenceWeights, dodgeSlot,
  energy, evaluateHit, healthFactor, normalCdf, perfectBlockSlot, pickAnswer, sCurve, skillMultiplier, staminaCost, statMultiplier, windowLength, windows, type Fighter, type Weapon,
} from "../src/combat.ts";
import { defaultGameRoot } from "./paths.ts";

const args = process.argv.slice(2);
const root = args.includes("--root") ? args[args.indexOf("--root") + 1] : defaultGameRoot;
let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps;

// ---- the notes' numbers ----
check([0.25, 0.5, 1, 2, 4].map((x) => staminaCost(x).toFixed(1)).join() === "10.0,14.3,19.2,24.4,29.7" && staminaCost(0) === 0, "stamina cost of a ratio: 10.0, 14.3, 19.2, 24.4, 29.7 for 0.25 … 4");
check(statMultiplier(10, 5) === 1.1 && statMultiplier(5, 5) === 1 && statMultiplier(0, 5) === 0.5 && near(statMultiplier(3, 5), 0.8, 1e-9), "stat multiplier: 0.5 five below the requirement, 1 at it, 1.1 five above");
check(near(skillMultiplier(20), 1.08, 1e-9), "skill 20 multiplies the attack by 1.08");
check(healthFactor(0, 0.5) === 0.5 && healthFactor(1, 0.5) === 1 && healthFactor(0.25, 0.67) === 0.67, "item health factors: a broken weapon 0.5, armour at a quarter 0.67");
check(energy(1) === 1 && energy(0) === 0.5 && near(energy(0.5), 0.75, 1e-9), "swing energy: 1 at full stamina, 0.75 at half, floored at 0.5");
const sword: Weapon = { id: "s", name: "sword", cls: 1, attack: 5, defence: 4.5, strReq: 5, agiReq: 0, mods: [0.9, 1.25, 0.05], health: 1 };
const man = (o: Partial<Fighter> = {}): Fighter => ({ name: "man", str: 5, agi: 5, vit: 5, fencing: 10, defenceSkill: 10, weaponSkill: 10, weapon: sword, unarmedBase: 2.6, bodyArmour: 1.3, armour: [0, 0, 0], maxStamina: 110, load: 0, ...o });
check(near(blockDefence(man({ defenceSkill: 20 })), 4.5 * 1.5714, 1e-3) && blockDefence(man({ weapon: null })) === 3, "block defence: ×1.57 at defence skill 20; unarmed 3");
check(near(attackVector(man(), ATTACK_TYPES[1])[1], 5 * 1.04 * 1.25, 1e-9), "a slash: weapon attack × skill multiplier × the slash modifier");
check(near(attackVector(man({ weapon: null, str: 2, weaponSkill: 0 }), ATTACK_TYPES[5])[2], 2.6, 1e-9) && near(attackVector(man({ weapon: null, str: 2, weaponSkill: 0 }), ATTACK_TYPES[4])[2], 2.6 * 1.2, 1e-9), "unarmed: the archetype's base × the type's factor (a kick 1.2)");
check(near(attackStaminaCost(man(), ATTACK_TYPES[1]), 14.4, 1e-9) && near(attackStaminaCost(man({ str: 10 }), ATTACK_TYPES[1]), 11.52, 1e-9) && near(attackStaminaCost(man({ str: 0 }), ATTACK_TYPES[0]), 24, 1e-9), "attack cost: 12 × type × stat factor (0.8 five above the requirement, 2 five below)");
// hits
{
  const full = evaluateHit({ attack: 4, armour: 1.3, block: 4, stamina: 100 });
  check(full.block === "full" && near(full.stamina, 19.2, 0.05) && full.health === 0, "attack equal to block defence: a full block for about 19 stamina, no health");
  const partial = evaluateHit({ attack: 8, armour: 1.3, block: 4, stamina: 100 });
  check(partial.block === "partial" && near(partial.dmgR, 8 / (1.3 + 4 / 3), 1e-9) && partial.health > 0, "attack above it: a partial block, the block counting a third");
  const broken = evaluateHit({ attack: 8, armour: 1.3, block: 4, stamina: 5 });
  check(broken.block === "broken" && broken.dmgR === 4 && near(broken.health, (29.7 - 5) * 0.75 + 64 * 1.6, 0.1), "out of stamina: a broken block, DmgR capped at 4, overflow and hard-hit health");
  const hard = [1.25, 1.5, 2, 3, 4].map((d) => (evaluateHit({ attack: d, armour: 1, block: null, stamina: 1000 }).health).toFixed(1)).join();
  check(hard === "3.1,5.4,12.8,43.2,102.4", `hard-hit health for DmgR 1.25 … 4: ${hard}`);
  check(evaluateHit({ attack: 0.5, armour: 1, block: null, stamina: 100 }).health === 0 && near(evaluateHit({ attack: 2, armour: 1, block: null, stamina: 1000, bodyCoef: 1.5 }).health, 19.2, 1e-9) && near(evaluateHit({ attack: 1, armour: 1, block: null, stamina: 100, fromBehind: true }).dmgR, 1.2, 1e-9), "a weak hit costs stamina only; a head hit ×1.5; from behind DmgR ×1.2");
}
// windows
check(near(perfectBlockSlot(0), 0.3, 1e-9) && near(perfectBlockSlot(10), 0.795, 1e-3) && perfectBlockSlot(20) === 1 && near(perfectBlockSlot(20, true), 0.86, 1e-9), "perfect-block slot: 0.30, 0.79, 1.0 at skill 0, 10, 20; 0.86 with the guard far");
check([0, 10, 20].map((d) => windowLength(0.37 * P.maxPerfectBlockSlotModifier, perfectBlockSlot(d)).toFixed(2)).join() === "0.20,0.28,0.31", "perfect-block window of a heavy one-hand slash: 0.20, 0.28, 0.31 s");
check(dodgeSlot(20, -0.2) === 1 && near(dodgeSlot(0, 0.2), 0, 1e-9) && near(dodgeSlot(10, 0), Math.SQRT1_2, 1e-9), "dodge slot from agility and load");
// the NPC's choices
check(sCurve(10, 10) === 0.5 && sCurve(20, 0) === 1 && sCurve(0, 20) === 0 && near(sCurve(15, 10, 2), 0.625, 1e-9), "the S-curve of a skill difference");
check(attackSpeed(10, 10, 5) === 0.5 && attackSpeed(20, 10, 10) === 1, "attack speed: 0.5 for equals of agility 5");
{
  const w = defenceWeights(man(), man());
  check(near(blockProbability(man()), 0.67, 1e-9) && near(w.block, 1.88, 0.01) && near(w.perfectBlock, 0.8 * 0.795 * 2.5, 0.01) && near(w.masterStrike, 0.8 * 0.795 * 1.5, 0.01) && near(w.none, 0.2, 1e-9), `equal skill-10 swordsmen: perfect block ${w.perfectBlock.toFixed(2)}, master strike ${w.masterStrike.toFixed(2)}, block ${w.block.toFixed(2)}, none ${w.none.toFixed(2)}, dodge ${w.dodge.toFixed(2)}`);
  check(near(blockProbability(man({ weapon: { ...sword, defence: 1 } })), 0.067, 1e-9) && blockProbability(man({ weapon: { ...sword, defence: 20 } })) === 1 && blockProbability(man({ weapon: null })) === 1.6, "block chance: 0.067, 0.67, 1 at weapon defence 1, 4.5, 20; unarmed 1.6");
  check(pickAnswer(w, 0) === "perfectBlock" && pickAnswer(w, 0.999) === "none", "an answer is drawn in proportion to the weights");
  check(aggression(man()) === 0.5 && near(attackDelay(man(), 1), 3, 1e-9) && near(attackDelay(man(), 0), 1.5, 1e-9) && near(attackDelay(man({ fencing: 20, defenceSkill: 0 }), 1), 0, 1e-9), "attack delay: 3 s between equals, sooner on a tired target, none for the all-out attacker");
  check(near(normalCdf(0), 0.5, 1e-6) && near(normalCdf(1), 0.8413, 1e-3) && near(attackChance(3, 3), 0.5, 1e-6), "the attack chance is the normal CDF of the time past the mean delay");
}

// ---- the game's tables ----
const sources = await gameSources(root);
const vfs = await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => /^libs\/tables\/(item|combat|rpg)\/.*\.xml$/.test(n), includeHd: false });
const db = await CombatDb.load(vfs);
check(db.rows.length === 113, `${db.rows.length} regular attack rows on foot`);
const heavy = db.attackRow(1, 1, 2)!, punch = db.attackRow(12, 0, 0)!;
check(near(heavy.start, 0.3, 0.01) && near(heavy.hit, 0.7, 0.01) && near(heavy.end, 1.6, 0.01) && near(heavy.perfectBlockWindow, 0.37, 0.01) && ATTACK_TYPES[heavy.type].name === "slash", `a sword's heavy attack: a slash, live at ${heavy.start.toFixed(2)}, contact ${heavy.hit.toFixed(2)}, over at ${heavy.end.toFixed(2)} s`);
check(ATTACK_TYPES[punch.type].name === "direct" && !ATTACK_TYPES[punch.type].canKill, "unarmed light attack: a direct punch, which cannot kill");
const w0 = windows(heavy, man({ defenceSkill: 0 }));
check(near(w0.perfectBlock, 0.2, 0.01) && w0.masterStrike < w0.perfectBlock, `a novice's windows against it: perfect block ${w0.perfectBlock.toFixed(2)} s, master strike ${w0.masterStrike.toFixed(2)} s, dodge ${w0.dodge.toFixed(2)} s`);

/** A seeded generator (mulberry32). */
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
type Plan = "automation" | "attack" | "block" | "perfect";
/** Fight to the end (or 5 minutes): fighter 0 follows `plan`, fighter 1 is an NPC. */
function duel(one: Fighter, two: Fighter, plan: Plan, seed: number) {
  const fight = new Fight(db, one, two, { random: rng(seed), auto: [plan === "automation", true] });
  const tally = { hits: [0, 0], blocked: 0, perfect: 0, counters: 0 };
  while (!fight.over && fight.time < 300) {
    const me = fight.a[0], foe = fight.a[1];
    if (plan !== "automation") {
      const incoming = foe.action && !foe.action.resolved ? foe.action : null;
      if (plan === "attack") { if (!me.action) fight.attack(0, 1, 2); }
      else if (incoming) {
        fight.block(0, true);
        // a perfect block is pressed 0.1 s before contact
        if (plan === "perfect" && incoming.row.hit - incoming.t <= 0.1) fight.press(0, "perfectBlock");
      } else {
        fight.block(0, false);
        // strike while the foe recovers or waits, with stamina to spare
        if (!me.action && me.stamina > 40) fight.attack(0, 1, 2);
      }
    }
    for (const e of fight.step(1 / 30)) {
      if (e.kind === "hit" && e.health > 0) tally.hits[e.by]++;
      if (e.kind === "hit" && e.by === 1 && e.block === "full") tally.blocked++;
      if (e.kind === "hit" && e.by === 1 && e.answer === "perfectBlock") tally.perfect++;
      if (e.kind === "counter") tally.counters++;
    }
  }
  return { fight, tally, winner: fight.a[0].out ? 1 : fight.a[1].out ? 0 : -1 };
}
function series(one: Fighter, two: Fighter, plan: Plan, n = 200) {
  let wins = 0, losses = 0, time = 0, kos = 0, deaths = 0;
  for (let i = 0; i < n; i++) {
    const r = duel(structuredClone(one), structuredClone(two), plan, 1000 + i);
    if (r.winner === 0) wins++; else if (r.winner === 1) losses++;
    time += r.fight.time;
    for (const s of r.fight.a) { if (s.out === "knockedOut") kos++; if (s.out === "dead") deaths++; }
  }
  return { wins, losses, draws: n - wins - losses, seconds: time / n, kos, deaths };
}
const show = (who: string, r: ReturnType<typeof series>) => console.log(`  ${who}: won ${r.wins}, lost ${r.losses}, unfinished ${r.draws}; ${r.seconds.toFixed(0)} s on average; ${r.kos} knock-outs, ${r.deaths} deaths`);

// Henry's fist fight with Kunesh in the opening quest
const henry = db.fighter("dude", null)!, kunes = db.fighter("ska_kunes", null)!;
check(henry.str === 1 && henry.unarmedBase === 2.2 && henry.bodyArmour === 2.5 && kunes.defenceSkill > henry.defenceSkill, `Henry starts with 1 in every stat (unarmed base ${henry.unarmedBase}, body armour ${henry.bodyArmour}); Kunesh: strength ${kunes.str}, agility ${kunes.agi}, defence ${kunes.defenceSkill}, unarmed ${kunes.weaponSkill}`);
const fists = { attack: series(henry, kunes, "attack"), block: series(henry, kunes, "block"), perfect: series(henry, kunes, "perfect") };
show("Henry only punching Kunesh", fists.attack);
show("Henry blocking, then punching", fists.block);
show("Henry perfect-blocking, then punching", fists.perfect);
check(fists.attack.deaths + fists.block.deaths + fists.perfect.deaths === 0 && fists.block.kos > 0, "a fist fight ends in a knock-out, never a death");
check(fists.perfect.losses === 0 && fists.block.losses > 0 && fists.attack.losses > fists.attack.wins, "Kunesh beats a Henry who only punches or only blocks; perfect blocks keep Henry on his feet");
check(fists.attack.seconds > 8 && fists.block.seconds < 300, `the fights take a believable time (${fists.attack.seconds.toFixed(0)} s punching, ${fists.block.seconds.toFixed(0)} s blocking)`);

// swords: a trained fighter against a bandit, both run by the automations and by plans
const blade = db.weaponByName("sword_short_b")!;
const banditSoul = "event_spawn_bandit524";
const bandit = db.fighter(banditSoul, blade)!;
check(!!blade && !!bandit, `a bandit from the tables (${banditSoul}: strength ${bandit?.str}, agility ${bandit?.agi}, fencing ${bandit?.fencing}, defence ${bandit?.defenceSkill}) with ${blade?.name} (attack ${blade?.attack}, defence ${blade?.defence.toFixed(1)})`);
const trained: Fighter = { ...db.fighter("dude", blade)!, str: 8, agi: 8, vit: 8, fencing: 8, defenceSkill: 8, weaponSkill: 8, armour: [3, 4, 3] };
const novice: Fighter = { ...db.fighter("dude", blade)! };
const swords = { trained: series(trained, bandit, "block"), novice: series(novice, bandit, "block"), auto: series(trained, bandit, "automation"), mirror: series(bandit, bandit, "automation") };
show("a trained, armoured Henry (all 8) blocking and striking the bandit", swords.trained);
show("the Henry of the first day doing the same", swords.novice);
show("the trained Henry run by the automations", swords.auto);
show("the bandit against himself (automations)", swords.mirror);
check(swords.trained.wins > swords.novice.wins, "training and armour win more sword fights than the first day's Henry does");
check(swords.mirror.wins + swords.mirror.losses > 150 && Math.abs(swords.mirror.wins - swords.mirror.losses) < 60, "two equal NPCs finish their fights, about evenly");
check(swords.trained.deaths > 0, "swords kill");
const one = duel(structuredClone(trained), structuredClone(bandit), "block", 7);
console.log(`  one fight: ${one.fight.time.toFixed(1)} s, ${one.fight.events.filter((e) => e.kind === "attack").length} attacks, Henry landed ${one.tally.hits[0]}, the bandit ${one.tally.hits[1]}, ${one.tally.blocked} full blocks, ${one.tally.counters} master strikes; Henry health ${one.fight.a[0].health.toFixed(0)}, stamina ${one.fight.a[0].stamina.toFixed(0)}`);

console.log(fails ? `${fails} FAILED` : "OK");
process.exit(fails ? 1 : 0);
