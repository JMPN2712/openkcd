// Melee combat rules (research notes: combat-melee.md, combat-damage.md, combat-ai.md): what a
// swing costs and does, how blocks, perfect blocks, master strikes and dodges answer it, and how
// an NPC chooses when to attack and how to defend. No animation here: a Fight advances two
// fighters through the attack rows' timings and reports what happened; the view plays it.
//
// Not modelled yet: body parts and armour pieces (a fighter has one armour vector), injuries and
// bleeding, wear, combos, feints, the clinch, knock-out rolls, several attackers, horses, perks
// and buffs. ASSUMPTIONs are marked; they are research questions in docs/HANDOFF.md.

import { readTable, type Row } from "./tables.ts";
import type { Vfs } from "./vfs.ts";

/** The tunables, with the effective values the notes give (rpg_param, else the engine's default). */
export const P = {
  skillCap: 20,
  stamDamage: 8,
  weakBlockStamCoef: 2,
  maxDmgR: 4,
  maxDamage: 200,
  dmgRFromBehind: 1.2,
  dmgRToHealthB: 1.6,
  staminaToHealthMin: 0.25,
  staminaToHealthMax: 0.75,
  skillToDefense: 0.02857,
  skillToDmgConstA: 250,
  minStatToAttackMult: 0.5,
  maxStatToAttackMult: 1.1,
  maxStatDiff: 5,
  weaponStatusToAttackCoef: 0.5,
  unarmedBlockDefense: 3,
  unarmedAttackReqStrBase: 2,
  attackEnergyModifier: 2,
  attackStamModMin: 0.5,
  attackStaminaCost: 12,
  minStatToStaminaCost: 0.8,
  maxStatToStaminaCost: 2,
  stamRegenBase: 22,
  stamRegenCooldown: 1.5,
  stamRegenBlockMod: 0.6,
  stamRegenMoveMod: 0.75,
  healthFull: 100,
  maxPerfectBlockSlotModifier: 0.85,
  maxSpecialPerfectBlockSlotModifier: 0.6,
  dodgeWindowMod: 0.65,
  windowMinWeight: 0.5,
  minPerfectBlockSlot: 0.3,
  skillToPerfectBlockPow: 0.5,
  bigZoneDistanceSlotMod: 0.8,
  maxAttackSpeedMod: 0.4,
  autoPerfectBlock: 2.5,
  autoMasterStrike: 1.5,
  autoDodge: 1.1,
  autoBlock: 2.8,
  autoNoDefence: 0.4,
  autoUnarmedBlockProb: 1.6,
  autoMaxAttackDelay: 6,
  autoAttackDelaySigma: 4,
  blockCooldown: 0.2,
} as const;

/** Damage types, in the order they are evaluated: stab, slash, smash. */
export type DamageType = 0 | 1 | 2;
export const STAB = 0, SLASH = 1, SMASH = 2;

export interface AttackType {
  id: number;
  name: string;
  /** relative stamina cost (slash 1.2, stab 1) */
  cost: number;
  damage: DamageType;
  canKill: boolean;
}

/** The attack types (combat-overview.md section 3, combat_attack_type). */
export const ATTACK_TYPES: AttackType[] = [
  { id: 0, name: "stab", cost: 1, damage: STAB, canKill: true },
  { id: 1, name: "slash", cost: 1.2, damage: SLASH, canKill: true },
  { id: 2, name: "smash", cost: 1.2, damage: SMASH, canKill: true },
  { id: 3, name: "throw", cost: 1, damage: SMASH, canKill: false },
  { id: 4, name: "kick", cost: 1.2, damage: SMASH, canKill: false },
  { id: 5, name: "punch", cost: 1, damage: SMASH, canKill: false },
  { id: 6, name: "hook", cost: 1, damage: SMASH, canKill: false },
  { id: 7, name: "direct", cost: 1, damage: SMASH, canKill: false },
  { id: 8, name: "bite", cost: 1, damage: STAB, canKill: true },
  { id: 9, name: "backoff", cost: 1, damage: SMASH, canKill: false },
];

export interface Weapon {
  id: string;
  name: string;
  /** weapon class (1 sword, 3 axe, 4 longsword, 5 mace, 12 unarmed, …) */
  cls: number;
  attack: number;
  defence: number;
  strReq: number;
  agiReq: number;
  /** stab, slash, smash attack modifiers */
  mods: [number, number, number];
  /** relative health 0–1 */
  health: number;
}

export interface Fighter {
  name: string;
  str: number;
  agi: number;
  vit: number;
  /** skills 0–20: fencing (warfare), defence, and the weapon class's skill */
  fencing: number;
  defenceSkill: number;
  weaponSkill: number;
  /** null: unarmed */
  weapon: Weapon | null;
  unarmedBase: number;
  /** natural armour (body base armour) */
  bodyArmour: number;
  /** worn armour over the body, as one stab / slash / smash vector */
  armour: [number, number, number];
  maxStamina: number;
  /** relative armour load, −0.2 … 0.2 (dodge) */
  load: number;
}

// ---- helper curves (combat-damage.md section 4) ----

/** Stamina cost of a ratio x: 8 × ln(1 + 10x). */
export const staminaCost = (x: number): number => (x > 0 ? P.stamDamage * Math.log(1 + 10 * x) : 0);

/** A stat against a requirement: 0.5 (five below) … 1 … 1.1 (five above). */
export function statMultiplier(stat: number, req: number): number {
  const d = Math.max(-1, Math.min(1, (stat - req) / P.maxStatDiff));
  return d >= 0 ? 1 + d * (P.maxStatToAttackMult - 1) : P.minStatToAttackMult + (1 - P.minStatToAttackMult) * (d + 1);
}

export const skillMultiplier = (skill: number): number => (skill + P.skillToDmgConstA) / P.skillToDmgConstA;

/** An item's health factor: round((√h × c + 1 − c) × 100) / 100. */
export const healthFactor = (h: number, c: number): number => Math.round((Math.sqrt(Math.max(0, Math.min(1, h))) * c + 1 - c) * 100 + 1e-9) / 100;

/**
 * The energy of a swing at relative stamina x: 1 − (1 − x)², not below 0.5 (ASSUMPTION: x is the
 * attacker's relative stamina; the notes leave open whether it is stamina or swing charge).
 */
export const energy = (x: number): number => Math.max(P.attackStamModMin, Math.min(1, 1 - (1 - Math.max(0, Math.min(1, x))) ** P.attackEnergyModifier));

/** The governing stat and requirement of a weapon: agility when its agility requirement is the higher. */
function governing(f: Fighter): { stat: number; req: number } {
  const w = f.weapon;
  if (!w) return { stat: f.str, req: P.unarmedAttackReqStrBase };
  return w.agiReq > w.strReq ? { stat: f.agi, req: w.agiReq } : { stat: f.str, req: w.strReq };
}

/** The attack vector (stab, slash, smash) of a fighter's swing of this type, before energy. */
export function attackVector(f: Fighter, type: AttackType): [number, number, number] {
  const w = f.weapon;
  if (!w || !type.canKill && type.id !== 3) {
    // unarmed (and kicks, punches with a weapon in hand)
    const req = Math.round(P.unarmedAttackReqStrBase * type.cost);
    const a = f.unarmedBase * type.cost * statMultiplier(f.str, req) * skillMultiplier(w ? 0 : f.weaponSkill);
    return [a, a, a];
  }
  const g = governing(f);
  const a = w.attack * healthFactor(w.health, P.weaponStatusToAttackCoef) * statMultiplier(g.stat, g.req) * skillMultiplier(f.weaponSkill);
  return [a * w.mods[0], a * w.mods[1], a * w.mods[2]];
}

/** The defence vector: natural armour plus worn armour, each component at least 0.1. */
export function defenceVector(f: Fighter): [number, number, number] {
  return [0, 1, 2].map((i) => Math.max(0.1, f.bodyArmour + f.armour[i])) as [number, number, number];
}

/** Block defence: weapon defence × (1 + defence skill × 0.02857); unarmed 3. */
export const blockDefence = (f: Fighter): number => (f.weapon ? f.weapon.defence * (1 + f.defenceSkill * P.skillToDefense) : P.unarmedBlockDefense);

/** What an attack costs its attacker in stamina: 12 × the type's factor × the stat factor (0.8 … 2). */
export function attackStaminaCost(f: Fighter, type: AttackType): number {
  const g = governing(f);
  const d = Math.max(-1, Math.min(1, (g.stat - g.req) / P.maxStatDiff));
  const factor = d >= 0 ? 1 + d * (P.minStatToStaminaCost - 1) : 1 + -d * (P.maxStatToStaminaCost - 1);
  return P.attackStaminaCost * type.cost * factor;
}

export interface HitInput {
  /** the attack's value for its damage type (attackVector × energy × strength) */
  attack: number;
  /** the armour defence for that type */
  armour: number;
  /** block defence while the defender blocks; null when not blocking (or unblockable) */
  block: number | null;
  weakBlock?: boolean;
  /** the defender's stamina before the hit */
  stamina: number;
  /** head 1.5, torso 1, limbs 0.7 */
  bodyCoef?: number;
  fromBehind?: boolean;
}

export interface HitResult {
  block: "none" | "full" | "partial" | "broken";
  dmgR: number;
  /** stamina and health the defender loses */
  stamina: number;
  health: number;
  /** stamina the block itself cost (included in `stamina` for a full block: ASSUMPTION, below) */
  blockCost: number;
}

/**
 * One damage type of a hit (combat-damage.md, "Per damage type", sections 5 and 6).
 * ASSUMPTION: the block's own stamina cost is what the defender pays on a full block (the note
 * gives the cost as the test for the block and the stamina damage as cost(DmgR), which for a
 * full block is the same number: DmgR = attack / block defence).
 */
export function evaluateHit(h: HitInput): HitResult {
  let block: HitResult["block"] = "none", defence = h.armour, blockCost = 0;
  if (h.block !== null) {
    blockCost = staminaCost(h.attack / h.block) * (h.weakBlock ? P.weakBlockStamCoef : 1);
    if (h.attack <= h.block && h.stamina >= blockCost) { block = "full"; defence = h.block; }
    else if ((3 * h.stamina) / blockCost > 1) { block = "partial"; defence = h.armour + h.block / 3; }
    else block = "broken";
  }
  const dmgR = Math.min(P.maxDmgR, (h.attack / defence) * (h.fromBehind ? P.dmgRFromBehind : 1));
  const s = Math.min(P.maxDamage, block === "full" ? blockCost : staminaCost(dmgR));
  let health = 0;
  if (s > h.stamina) health += (s - h.stamina) * Math.max(0, Math.min(1, P.staminaToHealthMin + (P.staminaToHealthMax - P.staminaToHealthMin) * Math.sqrt(Math.min(dmgR, 1))));
  if (dmgR > 1) health += dmgR ** 3 * P.dmgRToHealthB;
  if (block === "full") health = 0;
  return { block, dmgR, stamina: s, health: Math.min(P.maxDamage, health * (h.bodyCoef ?? 1)), blockCost };
}

// ---- windows (combat-melee.md section 4) ----

/** The perfect-block slot from the defence skill; `far`: the guard is more than one zone away. */
export const perfectBlockSlot = (defenceSkill: number, far = false): number =>
  P.minPerfectBlockSlot + (1 - P.minPerfectBlockSlot) * (Math.max(0, Math.min(1, defenceSkill / P.skillCap)) ** P.skillToPerfectBlockPow) * (far ? P.bigZoneDistanceSlotMod : 1);

/** The dodge slot from agility and armour load. */
export const dodgeSlot = (agi: number, load = 0): number => Math.sqrt(Math.max(0, Math.min(1, (agi / P.skillCap + (0.2 - Math.max(-0.2, Math.min(0.2, load))) / 0.4) * 0.5)));

/** A window's effective length: W × (s + (1 − s) × 0.5). */
export const windowLength = (base: number, slot: number): number => base * (slot + (1 - slot) * P.windowMinWeight);

export interface AttackRow {
  /** 0 light, 1 heavy, 2 special */
  input: number;
  type: number;
  zone: number;
  weaponClass: number;
  weaponGroup: number;
  start: number;
  hit: number;
  withdraw: number;
  end: number;
  perfectBlockWindow: number;
  dodgeWindow: number;
  riposteWindow: number;
  hitDistance: number;
  fragment: string;
  tags: string;
}

/** The seconds before contact in which each answer works, for this defender against this row. */
export function windows(row: AttackRow, defender: Fighter, far = false): { perfectBlock: number; masterStrike: number; dodge: number } {
  const s = perfectBlockSlot(defender.defenceSkill, far);
  return {
    perfectBlock: windowLength(row.perfectBlockWindow * P.maxPerfectBlockSlotModifier, s),
    masterStrike: windowLength(row.perfectBlockWindow * P.maxSpecialPerfectBlockSlotModifier, s),
    dodge: windowLength(row.dodgeWindow * P.dodgeWindowMod, dodgeSlot(defender.agi, defender.load)),
  };
}

// ---- the NPC's choices (combat-ai.md sections 2 and 3) ----

/** The S-curve of a skill difference: 0.5 + 0.5 × sign(x) × x², x = (a − b) × scale / 20. */
export function sCurve(a: number, b: number, scale = 1): number {
  const x = ((a - b) * scale) / P.skillCap;
  return Math.max(0, Math.min(1, 0.5 + 0.5 * Math.sign(x) * x * x));
}

/** Attack speed, 0–1: 0.5 for equal fighters of agility 5. */
export const attackSpeed = (fencing: number, opponentFencing: number, agi: number): number =>
  0.5 * Math.sqrt(Math.max(0, Math.min(2, 1 + 0.1 * (fencing - opponentFencing))) * Math.max(0, Math.min(2, 1 + 0.2 * (agi - 5))));

/** The chance term of a normal block from the weapon's defence: the quadratic through (1, 0.067), (4.5, 0.67), (20, 1). */
export function blockProbability(f: Fighter): number {
  if (!f.weapon) return P.autoUnarmedBlockProb;
  const pts: [number, number][] = [[1, 0.067], [4.5, 0.67], [20, 1]];
  const v = f.weapon.defence;
  let y = 0;
  for (let i = 0; i < 3; i++) { let l = pts[i][1]; for (let j = 0; j < 3; j++) if (j !== i) l *= (v - pts[j][0]) / (pts[i][0] - pts[j][0]); y += l; }
  // (weapon health is 0–1 here; the note's ratio is health / 20 of the item's points, floored at 0.8)
  return Math.max(0, Math.min(1, y)) * Math.max(Math.max(0, Math.min(1, f.weapon.health)) ** 2, 0.8);
}

export type Answer = "perfectBlock" | "masterStrike" | "dodge" | "block" | "none";

/** The five weights of the defence automation against an attacker. */
export function defenceWeights(defender: Fighter, attacker: Fighter, far = false): Record<Answer, number> {
  const f = 1 - attackSpeed(attacker.fencing, defender.fencing, attacker.agi) * P.maxAttackSpeedMod;
  const slot = perfectBlockSlot(defender.defenceSkill, far);
  return {
    perfectBlock: f * slot * P.autoPerfectBlock,
    masterStrike: f * slot * P.autoMasterStrike,
    dodge: f * dodgeSlot(defender.agi, defender.load) * P.autoDodge,
    block: blockProbability(defender) * P.autoBlock,
    none: sCurve(attacker.fencing, defender.defenceSkill, 1) * P.autoNoDefence,
  };
}

/** Pick an answer in proportion to the weights; `roll` is uniform in [0, 1). */
export function pickAnswer(w: Record<Answer, number>, roll: number): Answer {
  const order: Answer[] = ["perfectBlock", "masterStrike", "dodge", "block", "none"];
  let t = roll * order.reduce((s, k) => s + w[k], 0);
  for (const k of order) { t -= w[k]; if (t < 0) return k; }
  return "none";
}

/** Aggression: S(own fencing − own defence, scale 2). */
export const aggression = (f: Fighter): number => sCurve(f.fencing, f.defenceSkill, 2);

/** The mean delay between an NPC's attacks: 6 × (1 − aggression) × (1 − (1 − target stamina)² × r_fencing). */
export const attackDelay = (f: Fighter, targetRelStamina: number): number =>
  P.autoMaxAttackDelay * (1 - aggression(f)) * (1 - (1 - Math.max(0, Math.min(1, targetRelStamina))) ** 2 * (f.fencing / P.skillCap));

/** The normal CDF (Abramowitz–Stegun 7.1.26). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), z = Math.abs(x) / Math.SQRT2;
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + Math.sign(x) * erf);
}

/** The chance the NPC attacks at a check, `t` seconds after its last attack: Φ((t − T) / 4) × willingness. */
export const attackChance = (t: number, meanDelay: number, willingness = 1): number => normalCdf((t - meanDelay) / P.autoAttackDelaySigma) * willingness;

// ---- data ----

const num = (s: string | undefined, d = 0) => (s === undefined || s === "" || !Number.isFinite(Number(s)) ? d : Number(s));

export class CombatDb {
  readonly rows: AttackRow[] = [];
  readonly weapons = new Map<string, Weapon>();
  private weaponNames = new Map<string, string>();
  private souls = new Map<string, Row>();
  private skills = new Map<string, Map<number, number>>();
  private archetypes = new Map<string, Row>();
  /** weapon class → its skill id; weapon class → the groups it belongs to */
  private classSkill = new Map<number, number>();
  private classGroups = new Map<number, number[]>();

  static async load(vfs: Vfs): Promise<CombatDb> {
    const t = (n: string) => readTable(vfs, n).catch(() => [] as Row[]);
    const [attacks, weapons, melee, classes, groups, souls, soulSkills, archetypes, items] = await Promise.all([
      t("combat/combat_action_attack"), t("item/weapon"), t("item/melee_weapon"), t("item/weapon_class"), t("combat/combat_weapon_group_to_class"),
      t("rpg/soul"), t("rpg/soul2skill"), t("rpg/soul_archetype"), t("item/item"),
    ]);
    return CombatDb.from({ attacks, weapons, melee, classes, groups, souls, soulSkills, archetypes, items });
  }

  static from(t: { attacks: Row[]; weapons?: Row[]; melee?: Row[]; classes?: Row[]; groups?: Row[]; souls?: Row[]; soulSkills?: Row[]; archetypes?: Row[]; items?: Row[] }): CombatDb {
    const db = new CombatDb();
    for (const r of t.attacks) {
      // regular attacks on foot (action type 3); mercy, free and rider attacks are other types
      if (num(r.action_type_id) !== 3 || r.mounted === "True") continue;
      db.rows.push({
        input: num(r.input_class_id), type: num(r.attack_type_id), zone: num(r.attack_zone_id, -1), weaponClass: num(r.r_weapon_class_id, -1), weaponGroup: num(r.r_weapon_group_id, -1),
        start: num(r.attack_time_to_start), hit: num(r.attack_time_to_hit), withdraw: num(r.attack_time_to_withdraw), end: num(r.attack_time_to_end),
        perfectBlockWindow: num(r.perfect_block_window), dodgeWindow: num(r.dodge_window), riposteWindow: num(r.sync_riposte_window), hitDistance: num(r.hit_distance),
        fragment: r.mn_fragment_id ?? "", tags: r.mn_tags ?? "",
      });
    }
    const names = new Map((t.items ?? []).map((r) => [r.item_id, r.item_name ?? ""]));
    const melee = new Map((t.melee ?? []).map((r) => [r.item_id, r]));
    for (const r of t.weapons ?? []) {
      const m = melee.get(r.item_id);
      if (!m) continue;
      const w: Weapon = { id: r.item_id, name: names.get(r.item_id) ?? "", cls: num(r.weapon_class_id, -1), attack: num(m.attack), defence: num(r.defense), strReq: num(r.str_req), agiReq: num(r.agi_req), mods: [num(m.stab_att_mod, 1), num(m.slash_att_mod, 1), num(m.smash_att_mod, 1)], health: 1 };
      db.weapons.set(w.id, w);
      if (w.name) db.weaponNames.set(w.name.toLowerCase(), w.id);
    }
    for (const r of t.classes ?? []) db.classSkill.set(num(r.weapon_class_id, -1), num(r.skill_id, -1));
    for (const r of t.groups ?? []) { const c = num(r.weapon_class_id, -1); db.classGroups.set(c, [...(db.classGroups.get(c) ?? []), num(r.combat_weapon_group_id, -1)]); }
    for (const r of t.souls ?? []) db.souls.set(r.soul_name, r);
    const bySoul = new Map<string, Map<number, number>>();
    for (const r of t.soulSkills ?? []) { const m = bySoul.get(r.soul_id) ?? new Map(); m.set(num(r.skill_id), num(r.value)); bySoul.set(r.soul_id, m); }
    db.skills = bySoul;
    for (const r of t.archetypes ?? []) db.archetypes.set(r.soul_archetype_id, r);
    return db;
  }

  weaponByName(name: string): Weapon | undefined {
    const id = this.weaponNames.get(name.toLowerCase());
    return id ? this.weapons.get(id) : undefined;
  }

  /**
   * A soul as a fighter with this weapon (null: unarmed). Skills: fencing 2, defence 15, the
   * weapon class's own skill (unarmed 24). ASSUMPTION: maximum stamina is the archetype's
   * `base_stamina` (how vitality enters, `relative_vitality_to_stamina`, is not in the notes).
   */
  fighter(soulName: string, weapon: Weapon | null, armour: [number, number, number] = [0, 0, 0]): Fighter | undefined {
    const s = this.souls.get(soulName);
    if (!s) return undefined;
    const a = this.archetypes.get(s.soul_archetype_id ?? "0") ?? this.archetypes.get("0");
    const skills = this.skills.get(s.soul_id);
    const skill = (id: number) => skills?.get(id) ?? 0;
    const cls = weapon?.cls ?? 12;
    return {
      name: soulName, str: num(s.str, 1), agi: num(s.agi, 1), vit: num(s.vit, 1),
      fencing: skill(2), defenceSkill: skill(15), weaponSkill: skill(this.classSkill.get(cls) ?? 24),
      weapon: weapon ? { ...weapon } : null, unarmedBase: num(a?.unarmed_attack_base, 2.6), bodyArmour: num(a?.body_base_armor, 1.3), armour,
      maxStamina: num(a?.base_stamina, 110), load: 0,
    };
  }

  /**
   * The attack row for a weapon class, input (0 light, 1 heavy, 2 special) and zone: a row keyed
   * by the class, else by one of its groups, else any; the wanted zone, else the row's first.
   */
  attackRow(weaponClass: number, input: number, zone: number): AttackRow | undefined {
    const groups = this.classGroups.get(weaponClass) ?? [];
    const pools = [this.rows.filter((r) => r.weaponClass === weaponClass), this.rows.filter((r) => r.weaponClass < 0 && groups.includes(r.weaponGroup))];
    for (const pool of pools) {
      const fit = pool.filter((r) => r.input === input);
      if (fit.length) return fit.find((r) => r.zone === zone) ?? fit.find((r) => r.zone < 0) ?? fit[0];
    }
    return undefined;
  }
}

// ---- a fight ----

export interface FighterState {
  f: Fighter;
  health: number;
  stamina: number;
  /** seconds since stamina was last spent */
  rested: number;
  /** holding block */
  blocking: boolean;
  /** the swing in progress */
  action: { row: AttackRow; type: AttackType; zone: number; t: number; resolved: boolean; answer: Answer | null } | null;
  /** when the player last pressed perfect block / dodge (fight time), for the windows */
  pressed: { perfectBlock: number; dodge: number };
  /** the NPC's attack clock: seconds since its last attack */
  sinceAttack: number;
  out: "" | "dead" | "knockedOut";
  /** an NPC's moves are chosen by the automations; the player's by input */
  auto: boolean;
}

export type FightEvent =
  | { kind: "attack"; by: number; input: number; zone: number; type: string; row: AttackRow }
  | { kind: "hit"; by: number; answer: Answer; block: HitResult["block"]; dmgR: number; health: number; stamina: number }
  | { kind: "counter"; by: number; health: number; stamina: number }
  | { kind: "out"; who: number; how: "dead" | "knockedOut" };

/** Two fighters, stepped in real seconds. `random` is uniform in [0, 1). */
export class Fight {
  readonly a: FighterState[];
  time = 0;
  events: FightEvent[] = [];
  private readonly db: CombatDb;
  private readonly random: () => number;
  /** the fighters are within reach (the view says; a headless fight stands in reach) */
  inReach = true;

  constructor(db: CombatDb, one: Fighter, two: Fighter, o: { random?: () => number; auto?: [boolean, boolean] } = {}) {
    this.db = db;
    this.random = o.random ?? Math.random;
    this.a = [one, two].map((f, i) => ({ f, health: P.healthFull, stamina: f.maxStamina, rested: 99, blocking: false, action: null, pressed: { perfectBlock: -99, dodge: -99 }, sinceAttack: 0, out: "" as const, auto: o.auto?.[i] ?? i === 1 }));
  }

  get over(): boolean {
    return this.a.some((s) => s.out !== "");
  }

  private spend(s: FighterState, amount: number): void {
    s.stamina = Math.max(0, s.stamina - amount);
    s.rested = 0;
  }

  /** Start an attack (player input, or the offence automation). False when the fighter is busy or out. */
  attack(who: number, input: number, zone: number): boolean {
    const s = this.a[who];
    if (s.out || s.action || this.over) return false;
    const row = this.db.attackRow(s.f.weapon?.cls ?? 12, input, zone);
    const type = row && ATTACK_TYPES[row.type];
    if (!row || !type) return false;
    this.spend(s, attackStaminaCost(s.f, type));
    s.action = { row, type, zone: row.zone >= 0 ? row.zone : zone, t: 0, resolved: false, answer: null };
    s.sinceAttack = 0;
    s.blocking = false;
    this.events.push({ kind: "attack", by: who, input, zone: s.action.zone, type: type.name, row });
    // the defending NPC chooses its answer when the attack comes
    const d = this.a[1 - who];
    if (d.auto && !d.out) s.action.answer = d.action ? "none" : pickAnswer(defenceWeights(d.f, s.f), this.random());
    return true;
  }

  /** The player holds or releases block. */
  block(who: number, on: boolean): void {
    const s = this.a[who];
    if (!s.out && !s.action) s.blocking = on;
  }

  /** The player presses perfect block (with block) or dodge (a move input) now. */
  press(who: number, what: "perfectBlock" | "dodge"): void {
    this.a[who].pressed[what] = this.time;
  }

  private damage(who: number, health: number, stamina: number, canKill: boolean): void {
    const s = this.a[who];
    this.spend(s, stamina);
    if (health <= 0) return;
    if (s.health - health <= 0) {
      // a non-lethal attack that would kill knocks out instead, with no health damage
      s.out = canKill ? "dead" : "knockedOut";
      if (canKill) s.health = 0;
      this.events.push({ kind: "out", who, how: s.out });
    } else s.health -= health;
  }

  /** Contact: the defender's answer decides what the swing does. */
  private resolve(who: number): void {
    const s = this.a[who], d = this.a[1 - who], act = s.action!;
    act.resolved = true;
    if (d.out || !this.inReach) return;
    const w = windows(act.row, d.f);
    let answer: Answer;
    if (d.auto) answer = act.answer ?? "none";
    else {
      // the player's presses count inside their windows before contact; a held block otherwise
      const since = (t: number) => this.time - t;
      answer = d.action ? "none" : since(d.pressed.perfectBlock) <= w.perfectBlock ? "perfectBlock" : since(d.pressed.dodge) <= w.dodge ? "dodge" : d.blocking ? "block" : "none";
    }
    const strength = energy(s.stamina / s.f.maxStamina);
    if (answer === "perfectBlock" || answer === "dodge") {
      this.events.push({ kind: "hit", by: who, answer, block: "none", dmgR: 0, health: 0, stamina: 0 });
      return;
    }
    if (answer === "masterStrike") {
      // the block turns into a paired counter: the defender's own strike lands unanswered
      // (ASSUMPTION: at the strength of an ordinary swing of the defender's primary type)
      this.events.push({ kind: "hit", by: who, answer, block: "none", dmgR: 0, health: 0, stamina: 0 });
      const row = this.db.attackRow(d.f.weapon?.cls ?? 12, 1, -1), type = row ? ATTACK_TYPES[row.type] : ATTACK_TYPES[5];
      const r = evaluateHit({ attack: attackVector(d.f, type)[type.damage] * energy(d.stamina / d.f.maxStamina), armour: defenceVector(s.f)[type.damage], block: null, stamina: s.stamina });
      this.damage(who, r.health, r.stamina, type.canKill);
      this.events.push({ kind: "counter", by: 1 - who, health: r.health, stamina: r.stamina });
      s.action = null;
      return;
    }
    const r = evaluateHit({ attack: attackVector(s.f, act.type)[act.type.damage] * strength, armour: defenceVector(d.f)[act.type.damage], block: answer === "block" ? blockDefence(d.f) : null, stamina: d.stamina });
    this.damage(1 - who, r.health, r.stamina, act.type.canKill);
    this.events.push({ kind: "hit", by: who, answer, block: r.block, dmgR: r.dmgR, health: r.health, stamina: r.stamina });
  }

  /** Advance the fight by `dt` seconds. Returns the events of this step. */
  step(dt: number): FightEvent[] {
    const from = this.events.length;
    if (this.over) return [];
    this.time += dt;
    for (let i = 0; i < 2; i++) {
      const s = this.a[i];
      if (s.out) continue;
      // stamina: 22 a second after 1.5 s of rest, ±15 % with vitality, ×0.6 while blocking
      s.rested += dt;
      if (s.rested >= P.stamRegenCooldown) s.stamina = Math.min(s.f.maxStamina, s.stamina + dt * P.stamRegenBase * (0.85 + 0.3 * Math.min(1, s.f.vit / P.skillCap)) * (s.blocking || s.action ? P.stamRegenBlockMod : 1));
      s.sinceAttack += dt;
      if (s.action) {
        s.action.t += dt;
        if (!s.action.resolved && s.action.t >= s.action.row.hit) this.resolve(i);
        if (s.action && s.action.t >= s.action.row.end) s.action = null;
        if (this.over) break;
      } else if (s.auto && this.inReach) {
        // the offence automation. ASSUMPTION: the note gives the chance "each check" without the
        // check's rate; here it is a chance per second
        const o = this.a[1 - i];
        const p = attackChance(s.sinceAttack, attackDelay(s.f, o.stamina / o.f.maxStamina));
        if (!o.out && this.random() < p * dt) {
          // a low-skill fighter favours the easy zones (upper left 1, upper right 2) with weight 0.8;
          // ASSUMPTION: "low skill" is fencing below half the cap, and a skilled one picks evenly
          const lame = s.f.fencing < P.skillCap / 2;
          const zone = lame && this.random() < 0.8 ? (this.random() < 0.5 ? 1 : 2) : lame ? [0, 3, 4, 5][Math.floor(this.random() * 4)] : Math.floor(this.random() * 6);
          this.attack(i, this.random() < 0.5 ? 1 : 0, zone);
        }
      }
    }
    return this.events.slice(from);
  }
}
