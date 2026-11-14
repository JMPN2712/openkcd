// The world side of behaviour trees: the smart-object graph (level entities and
// their links), the AI database (smart-object / smart-area behaviours), and the
// world-facing nodes the interpreter delegates to its host.
//
// Chain (Rataje's tailor): NPC rat_tailor works at area rat_sa_tailory (Work
// link) → the area's template behaviour "tailor" = final/sa_tailory.xml#tailor →
// GraphSearch finds the area's linked work spots by category → CallBehavior
// "use" on the tailor's table → its smart-object type so_tailor_measuring maps
// "use" to final/so_tailor_measuring.xml#use → walk there, play TailorIn /
// Tailor / TailorOut.
//
// Movement and animation are actions reported to the caller (`act`); they
// complete after a time estimate here. Semantics are approximations
// (docs/GAMELOGIC.md); guesses are marked ASSUMPTION.

import { parseTreeFile, type BtNode, type BtTree, type BtVariable } from "./bt.ts";
import type { Vfs } from "./vfs.ts";
import { readTable } from "./tables.ts";
import { MAX_NESTING, Runner, Scope, evalExpression, initialValue, secondsOf, type Context, type Host, type Status, type Task, type Value } from "./btRuntime.ts";
import { entityProperties, type EntityInfo } from "./levelEntities.ts";
import type { Row } from "./tables.ts";
import { setTypeDefs } from "./btRuntime.ts";
import { TypeDefs } from "./typeDefs.ts";
import type { LuaHost } from "./luaHost.ts";
import { MailDb, PostOffice, typeMatches, type Mailbox, type Message } from "./mail.ts";
import { areaHolds } from "./schedule.ts";

/**
 * Smart-object classes whose helpers only make sense with the object turned 180° about Z.
 * WORKAROUND: tailorTable's "entry" helper (0, 0.5, 0) lands in the middle of the table at all three
 * Rataje tailors' tables (table_heavy160 is centred on its pivot) and clear of it when mirrored. Other
 * classes fit the plain transform: water troughs, fireplaces, pub tables and logs put their standing
 * helpers inside furniture 0 times as computed and 26 times mirrored (Rattay). How the game resolves
 * this class (animation alignment?) is unknown.
 */
const MIRRORED_HELPERS = new Set(["tailortable"]);

/** A smart-object helper (Libs/SmartObjects.xml): a spot relative to the object, for some animations. */
export interface SoHelper {
  name: string;
  pos: [number, number, number];
  /** quaternion w, x, y, z */
  rot: [number, number, number, number];
  description: string;
}

/** Helpers by class name, from Libs/SmartObjects.xml (<Helper className= name= pos= rot= description=>). */
export function parseSmartObjectHelpers(xml: string): Map<string, SoHelper[]> {
  const out = new Map<string, SoHelper[]>();
  const un = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  for (const m of xml.matchAll(/<Helper\s([^>]*)\/?>/g)) {
    const a = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(m[1])?.[1] ?? "";
    const nums = (v: string, n: number, d: number[]) => { const x = v.split(",").map(Number); return x.length === n && x.every(Number.isFinite) ? x : d; };
    const cls = a("className").toLowerCase();
    const list = out.get(cls) ?? [];
    list.push({ name: a("name"), pos: nums(a("pos"), 3, [0, 0, 0]) as [number, number, number], rot: nums(a("rot"), 4, [1, 0, 0, 0]) as [number, number, number, number], description: un(a("description")) });
    out.set(cls, list);
  }
  return out;
}

export interface Behaviour {
  name: string;
  file: string;
  tree: string;
  maxInstances: number;
  /** its behaviour tag id (sa_/so_behaviour_tag): the mailboxes an NPC running it has */
  tagId?: string;
  /** so_behaviour_tag initial_state: 0 for nearly all (4,911 of 4,919); ASSUMPTION: others start closed to requests */
  initialState?: number;
}

/** AI tables: behaviours of smart-object types and smart-area templates. */
export class AiDb {
  readonly so = new Map<string, Behaviour[]>();
  readonly sa = new Map<string, Behaviour[]>();
  /** per smart-object type: its brain's update tree (subbrain_smart_object), whose OnInit sets the object up */
  readonly soBrain = new Map<string, { file: string; tree: string }>();
  /** brain ids (for their mailboxes): smart-object types' and smart-area templates' */
  readonly soBrainId = new Map<string, string>();
  /** smart-object type ids by name: a quest's entity (class QuestObject) has its quest's name */
  readonly soByName = new Map<string, string>();
  readonly saBrainId = new Map<string, string>();
  /** per smart-area template: its brain's update tree (subbrain_smart_area), the area's own loop */
  readonly saBrain = new Map<string, { file: string; tree: string }>();
  /** brains whose switching subbrain (subbrain_switching) is the NPC switch (final/sb_switch.xml#switch) */
  readonly switchBrains = new Set<string>();
  /** per smart-area template: the trees its brain runs when an NPC enters, leaves or starts one of its behaviours */
  readonly saEvents = new Map<string, { file: string; enter: string; exit: string; request: string }>();
  constructor(t: { soTag: Row[]; so2tag: Row[]; saTag: Row[]; sa2tag: Row[]; so?: Row[]; brain2sub?: Row[]; subSo?: Row[]; sa?: Row[]; subSa?: Row[]; subBt?: Row[] }) {
    const soTags = new Map(t.soTag.map((r) => [r.so_behaviour_tag_id, r]));
    for (const r of t.so2tag) {
      const tag = soTags.get(r.so_behaviour_tag_id);
      if (!tag) continue;
      const list = this.so.get(r.so_smart_object_id) ?? [];
      list.push({ name: tag.so_behaviour_tag_name, tagId: tag.so_behaviour_tag_id, file: tag.tree_file.toLowerCase().replaceAll("\\", "/"), tree: tag.tree_name.toLowerCase(), maxInstances: Number(tag.max_instances || -1), initialState: Number(tag.initial_state || 0) });
      this.so.set(r.so_smart_object_id, list);
    }
    const saTags = new Map(t.saTag.map((r) => [r.sa_behaviour_tag_id, r]));
    for (const r of t.sa2tag) {
      const tag = saTags.get(r.sa_behaviour_tag_id);
      if (!tag) continue;
      const list = this.sa.get(r.sa_smart_area_id) ?? [];
      list.push({ name: tag.sa_behaviour_tag_name, tagId: tag.sa_behaviour_tag_id, file: tag.tree_file.toLowerCase().replaceAll("\\", "/"), tree: tag.tree_name.toLowerCase(), maxInstances: -1 });
      this.sa.set(r.sa_smart_area_id, list);
    }
    // smart-object type → brain → its (first) subbrain → the smart-object subbrain's update tree
    const sub = new Map<string, string>();
    for (const r of t.brain2sub ?? []) if (!sub.has(r.brain_id)) sub.set(r.brain_id, r.subbrain_id);
    const trees = new Map((t.subSo ?? []).filter((r) => r.on_update_tree).map((r) => [r.subbrain_id, { file: r.file_name.toLowerCase().replaceAll("\\", "/"), tree: r.on_update_tree.toLowerCase() }]));
    for (const r of t.so ?? []) {
      const tree = r.brain_id ? trees.get(sub.get(r.brain_id) ?? "") : undefined;
      if (tree) this.soBrain.set(r.so_smart_object_id, tree);
      if (r.brain_id) this.soBrainId.set(r.so_smart_object_id, r.brain_id);
      if (r.so_smart_object_name) this.soByName.set(r.so_smart_object_name.toLowerCase(), r.so_smart_object_id);
    }
    // smart-area template → brain → the subbrain with a smart-area update tree
    const saTrees = new Map((t.subSa ?? []).filter((r) => r.on_update_tree).map((r) => [r.subbrain_id, { file: r.file_name.toLowerCase().replaceAll("\\", "/"), tree: r.on_update_tree.toLowerCase() }]));
    const saEvents = new Map((t.subSa ?? []).filter((r) => r.on_enter_tree || r.on_exit_tree || r.on_request_tree).map((r) => [r.subbrain_id, { file: r.file_name.toLowerCase().replaceAll("\\", "/"), enter: (r.on_enter_tree ?? "").toLowerCase(), exit: (r.on_exit_tree ?? "").toLowerCase(), request: (r.on_request_tree ?? "").toLowerCase() }]));
    const subs = new Map<string, string[]>();
    for (const r of t.brain2sub ?? []) subs.set(r.brain_id, [...(subs.get(r.brain_id) ?? []), r.subbrain_id]);
    const switches = new Set((t.subBt ?? []).filter((r) => r.file_name?.toLowerCase().replaceAll("\\", "/") === "final/sb_switch.xml" && r.tree_name?.toLowerCase() === "switch").map((r) => r.subbrain_id));
    for (const r of t.brain2sub ?? []) if (switches.has(r.subbrain_id)) this.switchBrains.add(r.brain_id);
    for (const r of t.sa ?? []) {
      if (!r.brain_id) continue;
      this.saBrainId.set(r.sa_smart_area_id, r.brain_id);
      const tree = (subs.get(r.brain_id) ?? []).map((x) => saTrees.get(x)).find(Boolean);
      if (tree) this.saBrain.set(r.sa_smart_area_id, tree);
      const ev = (subs.get(r.brain_id) ?? []).map((x) => saEvents.get(x)).find(Boolean);
      if (ev) this.saEvents.set(r.sa_smart_area_id, ev);
    }
  }
  private offered = new Map<string, Set<string>>();
  /** Behaviour names (lower case) an area template offers. */
  areaBehaviours(template: string): Set<string> | undefined {
    let o = this.offered.get(template);
    if (!o) {
      const list = this.sa.get(template);
      if (!list) return undefined;
      o = new Set(list.map((b) => b.name.toLowerCase()));
      this.offered.set(template, o);
    }
    return o;
  }
  static TABLES = { soTag: "ai/so_behaviour_tag", so2tag: "ai/so_smart_object2so_behaviour_tag", saTag: "ai/sa_behaviour_tag", sa2tag: "ai/sa_smart_area2sa_behaviour_tag", so: "ai/so_smart_object", brain2sub: "ai/brain2subbrain", subSo: "ai/subbrain_smart_object", sa: "ai/sa_smart_area", subSa: "ai/subbrain_smart_area", subBt: "ai/subbrain_switching" } as const;
}

/** Something a tree asks the world to do. */
export interface Action {
  kind: "move" | "animation" | "teleport" | "turn";
  npc: number;
  /** move, teleport: target position; turn: the point to face; animation: fragment name (e.g. "TailorIn") */
  target: [number, number, number] | string;
  /** helper/smart object involved, if any */
  object?: number;
  /** move: the orientation to end in (a helper's), quaternion w, x, y, z */
  rot?: [number, number, number, number];
}

export interface WorldOptions {
  ents: Map<number, EntityInfo>;
  ai: AiDb;
  /** smart-object helpers by class (parseSmartObjectHelpers) */
  helpers?: Map<string, SoHelper[]>;
  trees: (file: string, name: string) => BtTree | undefined;
  worldTime: () => number;
  realTime: () => number;
  random?: () => number;
  /** an action starts; return its duration in real seconds (default: estimates) */
  act?: (a: Action) => number | void;
  trace?: (msg: string) => void;
  /** whether NPCs run their detailed behaviour (else the LOD branch); default true */
  detail?: boolean;
  /** Lua for ExecuteLua / LuaWrapper code (luaHost.ts); without it, Lua is skipped */
  lua?: LuaHost;
  /** brain variables (Libs/Tables/ai/brain_variable: b_dialogParameters, b_context, …) */
  brainVars?: BtVariable[];
  /** soul names of shopkeepers (shop/shopkeeper): their work opens the shop (MERCHANT, REPAIRMAN) */
  shopkeepers?: Set<string>;
  /** mailboxes (npc-messaging.md); without them messages other than daycycle:change are dropped */
  mail?: MailDb;
  /** brain id by soul name (rpg/soul): an NPC's own mailboxes */
  soulBrains?: Map<string, string>;
  /**
   * DoMonologue (a merchant crying wares, a bark): play it and return its length in real seconds.
   * Without it a monologue takes MONOLOGUE_SECONDS, silently.
   */
  monologue?: (npc: number, m: { topicId: string; label: string; metaroles: string }) => number | void;
  /** a `daycycle:change` message to an NPC (its fields: add, handle, name, priority, …), for its daily cycle */
  daycycleChange?: (npc: number, fields: Record<string, Value>) => void;
  /** a SetQuest / SetQuestObjective node (QuestSystem.apply in quests.ts); without it, they only succeed */
  quest?: (fn: string, quest: string, objective?: string) => boolean;
  /**
   * A quest predicate (IsQuestStarted, IsObjectiveCompleted, …: QuestSystem.call in quests.ts) for
   * QuestCondition, QuestObjectiveCondition, GetQuest and QuestObjectiveGate; without it they read
   * every quest as untouched.
   */
  questCall?: (fn: string, quest: string, objective?: string | number) => boolean;
  /** EnableProfile switched a level profile (a named set of editor layers) on or off */
  profile?: (name: string, on: boolean) => void;
  /** a cutscene starts (PlaySequence, PlayVideo): play it and return its length in real seconds; without it, it is skipped */
  cutscene?: (kind: "sequence" | "video", name: string) => number | void;
  /** a world effect the trees ask for that the AI world doesn't hold itself (AddBuff, SetVisibility, SetOwner, …), with its evaluated properties */
  effect?: (node: string, props: Record<string, Value>, npc: number) => void;
  /** whether the player is in a conversation (DialogGate's Condition: InAny, InDialog, InInteractiveDialog) */
  playerInDialog?: (condition: string) => boolean;
  /**
   * A message to the player (entity -1). The player's own brain (player.xml) doesn't run here, so
   * by default such a message counts as taken and handled at once; return a value to answer it.
   */
  playerMessage?: (msg: Message) => Value | void;
}

/**
 * A link's data as the trees read it: "field(value), …" as a struct, anything else as a string
 * (guardPlace[guardPlace] → "guardPlace").
 */
function linkData(data: string, scope: Scope, host: Host): Value {
  const d = data.trim();
  if (/^\w+\s*\(/.test(d)) return messageFields(d, scope, host);
  // a single value, quoted or not, sometimes in brackets: QuestActor[('father')], QuestPlace['pub']
  return d.replace(/^\(\s*(.*?)\s*\)$/, "$1").replace(/^'(.*)'$/, "$1");
}

/** A node's timeout in seconds: "-1" (none), "15", "60s #GT" (a note after #); -1 when unset. */
function timeoutOf(text: string): number {
  const t = text.replace(/#.*$/, "").trim();
  return t === "" ? -1 : secondsOf(t);
}

/** A message's `values` ("add(true), handle('x'), priority(30)") as fields, each value evaluated. */
function messageFields(values: string, scope: Scope, host: Host): Record<string, Value> {
  const out: Record<string, Value> = {};
  let depth = 0, start = 0;
  const parts: string[] = [];
  for (let i = 0; i <= values.length; i++) {
    const ch = values[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if ((ch === "," && depth === 0) || i === values.length) { parts.push(values.slice(start, i)); start = i + 1; }
  }
  for (const part of parts) {
    const m = /^\s*(\w+)\s*\(([\s\S]*)\)\s*$/.exec(part);
    if (m) out[m[1]] = evalExpression(m[2], scope, host) ?? null;
  }
  return out;
}

const wuid = (v: Value | undefined): number | null => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, Value>).id === "number") return (v as Record<string, Value>).id as number;
  return null;
};

/** A named, counted lock (bt-rules.md): holders, a waiting queue in arrival order, and a full flag. */
interface CountedLock { holders: object[]; waiting: object[]; full: boolean }

/**
 * Asks for a place: granted when the asker's place in the queue falls inside the free slots
 * (count 0: unlimited) and the lock isn't full. A lock that fills stays full until every holder
 * has left, so a count above 1 admits in batches.
 */
function acquireLock(l: CountedLock, me: object, count: number): boolean {
  if (l.holders.includes(me)) return true;
  if (!l.waiting.includes(me)) l.waiting.push(me);
  const place = l.waiting.indexOf(me);
  if (l.full || (count > 0 && place >= count - l.holders.length)) return false;
  l.waiting.splice(place, 1);
  l.holders.push(me);
  if (count > 0 && l.holders.length >= count) l.full = true;
  return true;
}

function releaseLock(l: CountedLock, me: object): void {
  const h = l.holders.indexOf(me);
  if (h >= 0) l.holders.splice(h, 1);
  const w = l.waiting.indexOf(me);
  if (w >= 0) l.waiting.splice(w, 1);
  if (!l.holders.length) l.full = false;
}

export class AiWorld {
  readonly o: WorldOptions;
  readonly runner: Runner;
  /** debugging (runner.debug): per NPC, the deepest chain of nodes running after its last tick */
  readonly stuckAt = new Map<number, string[]>();
  private brains = new Map<number, Scope>();
  /** reverse links (for "parent" edges) */
  private parents = new Map<number, { target: number; name: string }[]>();
  /** active behaviour instances per "entity/behaviour" (max_instances) */
  private reservations = new Map<string, number>();
  /** "npc|entity/behaviour" instances an NPC reserved (ReserveBehavior): its own CallBehavior uses them */
  private held = new Set<string>();
  /** per "entity/behaviour": state set by SmartObjSetBehaviorState (Enabled, Disabled, NoRequests) and max instances set by SmartObjSetBehaviorMaxInstances */
  private states = new Map<string, string>();
  private maxInstances = new Map<string, number>();
  /** smart objects whose brain's OnInit has run (initObject) */
  private initialised = new Set<number>();
  /** TryCatch handlers active during the current tick (innermost last) */
  private catchers: ((reason: string) => void)[] = [];
  private current: { npc: number } = { npc: -1 };
  /** unsupported nodes/features → the NPCs whose trees reached them */
  readonly unsupported = new Map<string, Set<number>>();
  /** NPCs whose current behaviour reached an unsupported node since it started (gapIn) */
  private gaps = new Set<number>();
  /** where each NPC is (updated by moves); starts at the entity position */
  readonly positions = new Map<number, [number, number, number]>();
  /**
   * Counted locks (Semaphore, InstantSemaphore, Synchronize) by scoped name, created free on first
   * use, and external locks' closed flags, created closed (research notes, bt-rules.md). The two
   * kinds are separate locks even under one name.
   */
  private semaphores = new Map<string, CountedLock>();
  private locks = new Map<string, boolean>();
  /** smart areas' labels (AddAreaLabel) */
  readonly labels = new Map<number, Set<string>>();
  /** queued messages (mail.ts) */
  readonly post = new PostOffice();
  /** per entity: the behaviour tags it is running (counted), for their mailboxes */
  private activeTags = new Map<number, Map<string, number>>();
  private locked(key: string): boolean {
    return this.locks.get(key) ?? true;
  }
  private counted(key: string): CountedLock {
    let l = this.semaphores.get(key);
    if (!l) { l = { holders: [], waiting: [], full: false }; this.semaphores.set(key, l); }
    return l;
  }

  constructor(o: WorldOptions) {
    this.o = o;
    // a quest's entity carries no smart-object type: it is the smart object of its own name
    for (const e of o.ents.values()) if (e.cls === "QuestObject" && !e.soType) { const t = o.ai.soByName.get(e.name.toLowerCase()); if (t) e.soType = t; }
    for (const e of o.ents.values()) for (const l of e.links ?? []) {
      const list = this.parents.get(l.target) ?? [];
      list.push({ target: e.id, name: l.name });
      this.parents.set(l.target, list);
    }
    const host: Host = {
      worldTime: o.worldTime,
      realTime: o.realTime,
      random: o.random ?? Math.random,
      tree: o.trees,
      node: (n, c) => this.node(n, c),
      lua: o.lua ? (code, scope) => {
        const npc = this.current.npc;
        const changed = o.lua!.run(code, scope.snapshot(), { id: npc, name: this.o.ents.get(npc)?.name ?? "" });
        for (const [k, v] of Object.entries(changed)) scope.set(k, v);
      } : undefined,
      report: (w) => {
        this.gaps.add(this.current.npc);
        const set = this.unsupported.get(w) ?? new Set<number>();
        if (!set.has(this.current.npc)) { set.add(this.current.npc); o.trace?.(`[unsupported] ${w}`); }
        this.unsupported.set(w, set);
      },
    };
    this.runner = new Runner(host);
    if (o.lua) {
      o.lua.entityName = (id) => o.ents.get(id)?.name ?? "";
      let byName: Map<string, number> | null = null;
      o.lua.entityId = (name) => {
        if (!byName) { byName = new Map(); for (const e of o.ents.values()) if (e.name && !byName.has(e.name)) byName.set(e.name, e.id); }
        return byName.get(name);
      };
      o.lua.entityProps = (id) => { const e = o.ents.get(id); return e ? entityProperties(e) : null; };
    }
  }

  private trace(msg: string) {
    this.o.trace?.(msg);
  }

  /**
   * System variables of a tree instance: this, __area, __object, __player, … Area behaviours
   * normally run under the NPC's daily-cycle brain (final/sb_daycycles.xml#root), which owns the
   * t_* parameters they read ($t_timeChanged, $t_nextBehavior, …): until that brain runs here, its
   * declared variables are provided with their initial values.
   */
  /**
   * An NPC's brain scope, shared by every behaviour it runs: brain variables and the daily-cycle
   * root's (sb_daycycles.xml), including the t_ ones behaviours pass to those they call
   * ($t_nextBehavior set by sa_home.xml#Eater, read in utils.xml#doNextBehavior under useItem).
   */
  private brain(npc: number): Scope {
    let g = this.brains.get(npc);
    if (!g) {
      g = new Scope();
      for (const v of this.o.brainVars ?? []) g.declare(v);
      for (const v of this.o.trees("final/sb_daycycles.xml", "root")?.variables ?? []) g.declare(v);
      g.vars.set("this", { id: npc, name: this.o.ents.get(npc)?.name ?? "" });
      g.vars.set("__player", { id: -1 });
      this.brains.set(npc, g);
    }
    return g;
  }

  /**
   * A behaviour's system variables (__area, __object, __behaviorName) over `outer`: the NPC's brain
   * scope for the behaviour of its activity, the caller's scope for a CallBehavior (names a called
   * tree does not declare resolve in its caller: sa_city.xml#CityWalk_walking reads the $points
   * and $startPoint CityWalk fills).
   */
  private globals(npc: number, extra: Record<string, Value> = {}, outer: Scope = this.brain(npc)): Scope {
    const g = new Scope(outer);
    for (const [k, v] of Object.entries(extra)) {
      // system structs (__area, __object) carry the entity's name too
      const id = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Value>).id : undefined;
      g.vars.set(k, typeof id === "number" ? { ...(v as Record<string, Value>), name: this.o.ents.get(id)?.name ?? "" } : v);
    }
    return g;
  }

  /**
   * The daycycle root's side of an activity (research note daily-cycle.md, section 4): starting one
   * locks the NPC's `timeChanged` gate and clears $t_timeChanged; when the time changes the gate
   * opens and the flag is set, and behaviours wind down and return (CityWalk ends on the gate).
   * $t_fastStart is off: NPCs join the simulation near the player, so they walk rather than
   * teleport to their places.
   */
  beginActivity(npc: number): void {
    this.locks.set(`I/${npc}/timeChanged`, true);
    const b = this.brain(npc);
    b.set("t_timeChanged", false);
    b.set("t_fastStart", false);
  }

  endActivity(npc: number): void {
    this.locks.set(`I/${npc}/timeChanged`, false);
    this.brain(npc).set("t_timeChanged", true);
  }

  /** Whether an NPC keeps a shop (the trees ask Shops.GetShopDBIdByKeeper). */
  keepsShop(npc: number): boolean {
    return !!this.o.shopkeepers?.has(this.o.ents.get(npc)?.name ?? "");
  }

  /** Whether the NPC's behaviour reached a node this interpreter doesn't support since it started. */
  gapIn(npc: number): boolean {
    return this.gaps.has(npc);
  }

  /** Whether an entity offers behaviour `name` with an instance free (searches' "Requestable"). */
  requestable(target: number, name: string): boolean {
    const b = this.behaviour(target, name);
    return !!b && this.available(target, b);
  }

  /** Start an NPC's smart-area behaviour (e.g. its workplace): the area template's behaviour `name`. */
  startAreaBehaviour(npc: number, area: number, name: string): Task | null {
    const a = this.o.ents.get(area);
    const b = a?.saTemplate ? this.o.ai.sa.get(a.saTemplate)?.find((x) => x.name.toLowerCase() === name.toLowerCase()) : undefined;
    const tree = b && this.o.trees(b.file, b.tree);
    if (!tree) { this.trace(`no area behaviour "${name}" for ${a?.name ?? area}`); return null; }
    this.trace(`npc ${npc}: area ${a!.name} behaviour "${b!.name}" → ${b!.file}#${b!.tree}`);
    this.areasInUse.set(area, this.o.realTime());
    this.areaEvent(area, "request", npc, b!.name);
    this.gaps.delete(npc);
    const { task } = this.runner.instantiate(tree, this.globals(npc, { __area: { id: area }, __behaviorName: b!.name }));
    return this.bind(npc, this.tagged(npc, b!.tagId, task));
  }

  /**
   * Smart areas whose behaviours ran recently (started or called), by AI real time: their brains
   * (the area's own update tree: a garrison handing out posts, a shop's opening) run meanwhile.
   */
  readonly areasInUse = new Map<number, number>();

  /** Start a smart area's brain: its template's update tree, run by the area itself. */
  startAreaBrain(area: number): Task | null {
    const a = this.o.ents.get(area);
    const ref = a?.saTemplate ? this.o.ai.saBrain.get(a.saTemplate) : undefined;
    const tree = ref && this.o.trees(ref.file, ref.tree);
    if (!tree) return null;
    this.trace(`area ${a!.name}: brain → ${ref!.file}#${ref!.tree}`);
    const { task } = this.runner.instantiate(tree, this.globals(area, { __area: { id: area } }));
    return this.bind(area, task);
  }

  /**
   * Start a smart object's brain: its type's update tree, run by the object itself. A quest's
   * entity runs its quest's tree this way (quest-system.md, "The quest's tree"): the subbrain is
   * always active.
   */
  startObjectBrain(object: number): Task | null {
    const e = this.o.ents.get(object);
    const ref = e?.soType ? this.o.ai.soBrain.get(e.soType) : undefined;
    const tree = ref && this.o.trees(ref.file, ref.tree);
    if (!tree) return null;
    this.initialised.add(object);
    this.trace(`object ${e!.name}: brain → ${ref!.file}#${ref!.tree}`);
    const { task } = this.runner.instantiate(tree, this.globals(object, { __object: { id: object } }));
    return this.bind(object, task);
  }

  /** Level profiles switched on (EnableProfile). */
  readonly profiles = new Set<string>();

  /**
   * A gate (QuestObjectiveGate, ProfileLoadedGate, DistanceGate, …): waits until `holds`, then
   * runs its child. ASSUMPTION, as for IfGate (bt-rules.md gives RunLogic as what happens to a
   * running child when its gate closes): Halt stops the child and waits again, KeepRunning lets
   * it finish. A gate without a child succeeds once open.
   */
  private gate(n: BtNode, c: Context, holds: () => boolean): Task {
    const kid = n.children.find((k) => k.tag !== "OutputBreakpoints");
    const negate = truthyProp(this.prop(n, "NegateTo")) || truthyProp(this.prop(n, "Negation"));
    let body: Task | null = null;
    return {
      tick: () => {
        const open = holds() !== negate;
        if (!body) {
          if (!open) return "running";
          if (!kid) return "success";
          body = this.runner.make(kid, c.scope);
        } else if (!open && this.prop(n, "RunLogic") === "Halt") {
          body.abort(); body = null;
          return "running";
        }
        const s = body.tick();
        if (s !== "running") body = null;
        return s;
      },
      abort: () => { body?.abort(); body = null; },
    };
  }

  /** A condition node's Then or Else branch as a task; a missing branch succeeds, or fails when failSubtMissing is set. */
  private branch(n: BtNode, c: Context, holds: () => boolean): Task {
    let body: Task | null = null;
    return {
      tick: () => {
        if (!body) {
          const k = n.children.find((x) => x.tag === (holds() ? "Then" : "Else"))?.children.find((x) => x.tag !== "OutputBreakpoints");
          if (!k) return truthyProp(this.prop(n, "failSubtMissing")) || truthyProp(this.prop(n, "FailSubtMissing")) ? "failure" : "success";
          body = this.runner.make(k, c.scope);
        }
        const s = body.tick();
        if (s !== "running") body = null;
        return s;
      },
      abort: () => { body?.abort(); body = null; },
    };
  }

  /** A quest node's quest: named, or the tree's own (an empty name, or $this.name). */
  private questOf(n: BtNode, c: Context, prop: string): string {
    return String(c.eval(prop, "") ?? "") || String(this.lookupValue(c.scope, "this.name") ?? "");
  }

  /**
   * An area brain's event tree, run at once (its nodes are instant: links and checks):
   * `request` when an NPC starts one of the area's behaviours (a shop links its merchant),
   * `enter` / `exit` when an NPC crosses its shape (a shop links the customer who walked in).
   * __bodyInfo is the NPC.
   */
  areaEvent(area: number, kind: "enter" | "exit" | "request", npc: number, behaviour = ""): void {
    const a = this.o.ents.get(area);
    const ev = a?.saTemplate ? this.o.ai.saEvents.get(a.saTemplate) : undefined;
    const tree = ev && ev[kind] ? this.o.trees(ev.file, ev[kind]) : undefined;
    if (!tree) return;
    const { task } = this.runner.instantiate(tree, this.globals(area, { __area: { id: area }, __bodyInfo: { id: npc }, __behaviorName: behaviour }));
    const prev = this.current;
    this.current = { npc: area };
    try {
      for (let i = 0; i < 32 && task.tick() === "running"; i++);
    } finally { this.current = prev; }
  }

  /** Whether an area's brain has enter / exit trees (NpcAi tracks who is inside only for those). */
  hasAreaEvents(area: number): boolean {
    const t = this.o.ents.get(area)?.saTemplate;
    const ev = t ? this.o.ai.saEvents.get(t) : undefined;
    return !!ev && !!(ev.enter || ev.exit);
  }

  /** An area's brain stopped (no one uses it): its mail goes. */
  stopAreaBrain(area: number): void {
    this.post.forget(area);
  }

  /**
   * The part of an NPC's switch subbrain (final/sb_switch.xml#switch) that serves its monologue
   * requests: While(true) over sb_dialog.xml#monologRequest, as in the switch (a merchant's
   * dialog:monologRequest to itself waits on it). The switch's other parts (perception, combat,
   * greetings, …) don't run yet. Null for NPCs whose brain has no switch.
   */
  startMonologServer(npc: number): Task | null {
    const brain = this.o.soulBrains?.get(this.o.ents.get(npc)?.name ?? "");
    const tree = brain && this.o.ai.switchBrains.has(brain) ? this.o.trees("final/sb_dialog.xml", "monologrequest") : undefined;
    if (!tree) return null;
    let inner: Task | null = null;
    return this.bind(npc, this.tagged(npc, undefined, {
      tick: () => {
        inner ??= this.runner.instantiate(tree, this.globals(npc)).task;
        const s = inner.tick();
        if (s !== "running") inner = null;
        return "running";
      },
      abort: () => { inner?.abort(); inner = null; },
    }));
  }

  /** Wrap a task so world nodes know which NPC is ticking. */
  private bind(npc: number, task: Task): Task {
    return {
      tick: () => {
        const prev = this.current;
        this.current = { npc };
        if (this.runner.debug) this.runner.deepest = [];
        try { return task.tick(); } finally {
          this.current = prev;
          if (this.runner.debug) this.stuckAt.set(npc, this.runner.deepest);
        }
      },
      abort: () => task.abort(),
    };
  }

  // ---- graph search ----

  private edges(id: number, pruned: Set<string>): { to: number; tags: string[] }[] {
    const out: { to: number; tags: string[] }[] = [];
    // tags are separated by commas outside the brackets (QuestLocation[ctx('a'),npc('b')],Lean)
    for (const l of this.o.ents.get(id)?.links ?? []) out.push({ to: l.target, tags: l.name.split(/,(?![^[]*\])/).map((t) => t.replace(/\[.*$/, "").trim()).filter(Boolean) });
    // ASSUMPTION: reverse links are "parent" edges (the area containing an object, …)
    if (!pruned.has("parent")) for (const l of this.parents.get(id) ?? []) out.push({ to: l.target, tags: ["parent"] });
    return out.filter((e) => !e.tags.some((t) => pruned.has(t)));
  }

  private graphSearch(n: BtNode, c: Context): Status {
    // no Origin: the entity running the tree (so_bench.xml#uInit looks for its own benchSize link)
    const origin = this.prop(n, "Origin").trim() ? wuid(this.ref(n, c, "Origin")) : this.current.npc;
    if (origin === null) { this.trace("GraphSearch: no origin"); return "failure"; }
    const depth = Number(c.eval("depth", 1));
    const pruned = new Set(String(c.eval("EdgePruning", "")).split(",").map((s) => s.trim()).filter(Boolean));
    const or = String(c.eval("SetOperationChoice", "")).startsWith("Union");
    const filters = n.children.filter((k) => k.tag !== "Nodalyzer" && k.tag !== "Datalyzer" && k.tag !== "EvaLLyzer");
    const evalyzers = n.children.filter((k) => k.tag === "EvaLLyzer");
    const nodalyzers = n.children.filter((k) => k.tag === "Nodalyzer");
    const datalyzers = n.children.filter((k) => k.tag === "Datalyzer");
    const found: { parent: number; child: number }[] = [];
    const seen = new Set<number>([origin]);
    let frontier = [origin];
    for (let d = 0; (depth < 0 || d < depth) && frontier.length; d++) {
      const next: number[] = [];
      for (const p of frontier) for (const e of this.edges(p, pruned)) {
        // a link from an entity to itself (a bench's benchSize) is a result, not a way on
        if (e.to === p && e.tags.length && !e.tags.includes("parent")) {
          const results = filters.map((f) => this.filter(f, c, p, p, e.tags));
          if (filters.length === 0 || (or ? results.some(Boolean) : results.every(Boolean))) found.push({ parent: p, child: p });
          continue;
        }
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        const results = filters.map((f) => this.filter(f, c, p, e.to, e.tags));
        const ok = filters.length === 0 || (or ? results.some(Boolean) : results.every(Boolean));
        if (ok) found.push({ parent: p, child: e.to });
        // ASSUMPTION: a failing filter with prune="true" stops the walk below that child
        if (ok || !filters.some((f, k) => !results[k] && this.prop(f, "prune") === "true")) next.push(e.to);
      }
      frontier = next;
    }
    if (truthyProp(c.eval("includeOrigin", false))) found.unshift({ parent: origin, child: origin });
    // a RangeSorter under a Nodalyzer orders the results by distance from its point
    const sorter = nodalyzers.flatMap((z) => z.children).flatMap((k) => (k.tag === "Child0" ? k.children : [k])).find((k) => k.tag === "RangeSorter");
    if (sorter) {
      const ref = this.ref(sorter, c, "point");
      const at = Array.isArray(ref) && ref.length === 3 ? (ref as number[]) : wuid(ref) !== null ? this.pos(wuid(ref)!) : null;
      if (at) {
        const d = (id: number) => { const p = this.pos(id); return p ? Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) : Infinity; };
        const sign = this.prop(sorter, "SortOrder") === "Descending" ? -1 : 1;
        found.sort((a, b) => sign * (d(a.child) - d(b.child)));
      }
    }
    for (const z of nodalyzers) {
      const childVar = this.prop(z, "Child"), all = this.prop(z, "Quantifiers") !== "Exists";
      if (childVar) {
        // an array variable takes every result; a single one the first (Guard's tempEntity under ForAll)
        const cur = c.scope.get(childVar);
        let form = "";
        for (let sc: Scope | null = c.scope; sc && !form; sc = sc.parent) form = sc.decls.get(childVar)?.form ?? "";
        const many = form ? form !== "single" : all || Array.isArray(cur);
        c.scope.set(childVar, many ? found.map((f) => f.child) : (found[0]?.child ?? null));
      }
    }
    // EvaLLyzer: its expression for each result, with $__index, $__from, $__to and each link tag
    // between them holding the link's data (preprocessWorkplaces: "$workplaces[$__index].behavior =
    // $guardPlace" over a garrison's guardPlace[guardPlace] links)
    for (const z of evalyzers) {
      const expr = this.prop(z, "Expresion");
      const list = this.prop(z, "Quantifiers") === "Exists" ? found.slice(0, 1) : found;
      list.forEach((f, i) => {
        const tmp = new Scope(c.scope);
        tmp.vars.set("__index", i);
        tmp.vars.set("__from", f.parent);
        tmp.vars.set("__to", f.child);
        for (const l of this.o.ents.get(f.parent)?.links ?? []) {
          if (l.target !== f.child) continue;
          for (const part of l.name.split(/,(?![^[]*\])/)) {
            const m = /^\s*([\w:]+)\s*(?:\[(.*)\])?\s*$/.exec(part);
            if (m) tmp.vars.set(m[1], linkData(m[2] ?? "", tmp, this.runner.host));
          }
        }
        evalExpression(expr, tmp, this.runner.host);
      });
    }
    // Datalyzer: the found children linked from their parent by link Tag, and that link's data
    // (the bracketed part: "animalSpawn[amount(2),class(Boar)]" → "amount(2),class(Boar)")
    for (const z of datalyzers) {
      const tag = this.prop(z, "Tag").replace(/^'|'$/g, "").toLowerCase(), all = this.prop(z, "Quantifiers") !== "Exists";
      const hits: { child: number; data: string }[] = [];
      for (const f of found) {
        for (const l of this.o.ents.get(f.parent)?.links ?? []) {
          if (l.target !== f.child) continue;
          const part = l.name.split(",").map((x) => x.trim()).find((x) => x.replace(/\[.*$/, "").toLowerCase() === tag);
          if (part) hits.push({ child: f.child, data: /\[(.*)\]$/.exec(part)?.[1] ?? "" });
        }
      }
      const childVar = this.prop(z, "Child"), dataVar = this.prop(z, "Data");
      if (childVar) c.scope.set(childVar, all ? hits.map((h) => h.child) : (hits[0]?.child ?? null));
      if (dataVar) c.scope.set(dataVar, all ? hits.map((h) => h.data) : (hits[0]?.data ?? null));
    }
    this.trace(`npc ${this.current.npc}: GraphSearch from ${this.name(origin)}${found.length ? "" : ` [${filters.map((f) => `${f.tag}(${Object.entries(f.props).filter(([k]) => /tag|categor|Behavior|Class|Expres/i.test(k)).map(([k, v]) => `${k}=${v}`).join(" ")})`).join(", ")}]`} → [${found.map((f) => this.name(f.child)).join(", ")}]`);
    return found.length || !truthyProp(c.eval("failOnEmpty", true)) ? "success" : "failure";
  }

  // ---- messages (npc-messaging.md) ----

  /** The mailboxes an entity has now: its brain's and its running behaviours'. */
  private mailboxesOf(id: number): Mailbox[] {
    const e = this.o.ents.get(id);
    if (!e || !this.o.mail) return [];
    const brain = e.saTemplate ? this.o.ai.saBrainId.get(e.saTemplate) : e.soType ? this.o.ai.soBrainId.get(e.soType) : this.o.soulBrains?.get(e.name);
    return this.o.mail.mailboxes(brain, this.activeTags.get(id)?.keys() ?? []);
  }

  /** Post a message; false when no mailbox of the receiver took it. */
  send(to: number, msg: Message): boolean {
    if (to === -1) {
      if (this.o.trace) this.trace(`npc ${msg.sender}: message ${msg.type} to the player ${JSON.stringify(msg.fields).slice(0, 200)}`);
      const answer = this.o.playerMessage?.(msg);
      msg.processed?.(answer === undefined ? undefined : answer);
      return true;
    }
    const ok = this.post.deliver(to, msg, this.mailboxesOf(to));
    if (this.o.trace) this.trace(`npc ${msg.sender}: message ${msg.type} to ${this.name(to)}${ok ? "" : " (dropped)"} ${JSON.stringify(msg.fields).slice(0, 300)}`);
    return ok;
  }

  /** A task that holds a behaviour tag (its mailboxes) on `npc` while it runs. */
  private tagged(npc: number, tagId: string | undefined, task: Task): Task {
    if (!tagId) return task;
    const tags = this.activeTags.get(npc) ?? new Map<string, number>();
    this.activeTags.set(npc, tags);
    tags.set(tagId, (tags.get(tagId) ?? 0) + 1);
    let held = true;
    const drop = () => {
      if (!held) return;
      held = false;
      const k = (tags.get(tagId) ?? 1) - 1;
      if (k > 0) tags.set(tagId, k); else tags.delete(tagId);
    };
    return { tick: () => { const s = task.tick(); if (s !== "running") drop(); return s; }, abort: () => { task.abort(); drop(); } };
  }

  /**
   * The senders: Instant ones post and succeed; SendMessageToNPC waits until the message is in a
   * mailbox (OnDelivery) or a handler has finished with it (OnProcessed), its reply in `answer`.
   * ASSUMPTIONs (the note: "presumably"): a waiting send fails when nothing took the message or
   * its timeout runs out; a multi send's modes count deliveries.
   */
  private sendNode(n: BtNode, c: Context): Task {
    const multi = n.tag.includes("Multi"), instant = n.tag.startsWith("Instant");
    let waiting: { done: boolean; answer: Value | undefined; until: number } | null = null;
    const clock = () => (this.prop(n, "timeType") === "WorldTime" ? this.o.worldTime() : this.o.realTime());
    const post = (): boolean[] => {
      // the message is given by type and values, or as a variable (its declared type and its value:
      // sa_city.xml#dressUp sends $override to itself)
      const varName = this.prop(n, "variable");
      let type = this.prop(n, "type"), fields = messageFields(this.prop(n, "values"), c.scope, this.runner.host);
      if (varName && !type) {
        for (let sc: Scope | null = c.scope; sc && !type; sc = sc.parent) type = sc.decls.get(varName)?.type ?? "";
        const v = c.scope.get(varName);
        fields = v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, Value>) } : {};
      }
      const raw = multi ? this.ref(n, c, "targets") : this.ref(n, c, "target");
      const targets = (multi && Array.isArray(raw) ? raw : [raw]).map((v) => wuid(v ?? null)).filter((x): x is number => x !== null);
      // patches for the NPC's daily cycle (daily-cycle.md section 4) go to the schedule store
      if (type === "daycycle:change") {
        for (const to of targets) this.o.daycycleChange?.(to, fields);
        this.trace(`npc ${this.current.npc}: message ${type} to ${targets.map((t) => this.name(t)).join(", ")}`);
        return targets.map(() => true);
      }
      return targets.map((to) => {
        const msg: Message = { type, fields, sender: this.current.npc };
        if (waiting) msg.processed = (answer) => { if (waiting) { waiting.done = true; waiting.answer = answer; } };
        return this.send(to, msg);
      });
    };
    const combine = (got: boolean[]) => {
      if (!multi) return got[0] ?? false;
      const any = got.some(Boolean), all = got.length > 0 && got.every(Boolean);
      if ((this.prop(n, "failureMode") === "All" ? !any : !all) && this.prop(n, "failureMode")) return false;
      return this.prop(n, "successMode") === "All" ? all : any;
    };
    if (instant) return { tick: () => { const got = post(); return !multi || combine(got) ? "success" : "failure"; }, abort: () => {} };
    return {
      tick: () => {
        if (!waiting) {
          const t = timeoutOf(this.prop(n, "timeout"));
          waiting = { done: false, answer: undefined, until: t < 0 ? Infinity : clock() + t };
          if (!combine(post())) { waiting = null; return "failure"; }
          if (this.prop(n, "timeoutType") === "OnDelivery") { waiting = null; return "success"; }
        }
        if (waiting.done) {
          const answer = this.prop(n, "answer");
          if (answer && waiting.answer !== undefined) assignVar(c.scope, answer, waiting.answer);
          waiting = null;
          return "success";
        }
        if (clock() >= waiting.until) { waiting = null; return "failure"; }
        return "running";
      },
      abort: () => { waiting = null; },
    };
  }

  /**
   * The readers: take the oldest message in the mailbox whose type matches the declared type of
   * `variable` and whose `condition` holds, copy it there (the sender into `senderInfo`); a
   * ProcessMessage runs its handler and ends with its result, replying with `answerVar`'s value.
   * Instant readers fail when nothing waits; the others fail when `timeout` runs out.
   * ASSUMPTION: Atomic isn't modelled (handlers already run one tree tick at a time).
   */
  private readNode(n: BtNode, c: Context): Task {
    const handles = n.tag.endsWith("ProcessMessage"), instant = n.tag.startsWith("Instant");
    const varName = this.prop(n, "variable");
    let declared = "";
    for (let s: Scope | null = c.scope; s; s = s.parent) { const d = s.decls.get(varName); if (d) { declared = d.type; break; } }
    const struct = (m: Message): Value => {
      const base = declared ? initialValue({ name: varName, type: declared, values: "", form: "single" } as BtVariable) : null;
      return { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}), ...m.fields };
    };
    const hasCondition = !!this.prop(n, "condition").trim() && this.prop(n, "condition").trim() !== "true";
    const accept = (m: Message) => {
      if (declared && !declared.startsWith("_") && declared !== "common:wuid" && !typeMatches(m.type, declared)) return false;
      if (!hasCondition) return true;
      // the condition reads the candidate as the variable, or as $__content
      const prev = c.scope.get(varName) ?? null, content = c.scope.vars.get("__content");
      assignVar(c.scope, varName, struct(m));
      c.scope.vars.set("__content", struct(m));
      const ok = truthyProp(c.eval("condition", true));
      assignVar(c.scope, varName, prev);
      if (content === undefined) c.scope.vars.delete("__content"); else c.scope.vars.set("__content", content);
      return ok;
    };
    let msg: Message | null = null;
    let body: Task | null = null;
    let until: number | null = null;
    const clock = () => (this.prop(n, "timeType") === "WorldTime" ? this.o.worldTime() : this.o.realTime());
    return {
      tick: () => {
        if (!msg) {
          const got = this.post.take(this.current.npc, String(c.eval("inbox", "")), accept);
          if (!got) {
            if (instant) return "failure";
            if (until === null) { const t = timeoutOf(this.prop(n, "timeout")); until = t < 0 ? Infinity : clock() + t; }
            if (clock() >= until) { until = null; return "failure"; }
            return "running";
          }
          until = null;
          msg = got;
          this.trace(`npc ${this.current.npc}: ${n.tag} takes ${got.type} from ${String(c.eval("inbox", ""))}`);
          assignVar(c.scope, varName, struct(got));
          const si = this.prop(n, "senderInfo");
          if (si) assignVar(c.scope, si, { id: got.sender, name: this.o.ents.get(got.sender)?.name ?? "" });
          if (!handles) { msg = null; got.processed?.(undefined); return "success"; }
          const kid = n.children.find((k) => k.tag !== "OutputBreakpoints");
          body = kid ? this.runner.make(kid, c.scope) : null;
        }
        const s = body ? body.tick() : "success";
        if (s === "running") return s;
        const answer = this.prop(n, "answerVar");
        msg.processed?.(answer ? c.scope.get(answer) ?? null : undefined);
        msg = null; body = null;
        return s;
      },
      abort: () => { body?.abort(); body = null; msg = null; until = null; },
    };
  }

  /**
   * GetType's code for an entity, from its class: the codes are the ones the trees compare
   * against (NPC 28 times, STASH 11, SO 7, TP 6, NHNPC 6, SA 5, SLT 4, ITM 2, NPC_Female 2, PP, UNK).
   * ASSUMPTIONs: beds and other smart-object classes are SO, animals NHNPC; disguises
   * (ShowTrueIdentity) aren't modelled.
   */
  private entityType(id: number, playerAsNpc: boolean): string {
    if (id === -1) return playerAsNpc ? "NPC" : "PP";
    const e = this.o.ents.get(id);
    if (!e) return "UNK";
    const byClass: Record<string, string> = { NPC: "NPC", NPC_Female: "NPC_Female", TagPoint: "TP", SmartAreaShape: "SA", Stash: "STASH", StashCorpse: "STASH", ItemSlot: "SLT", PickableItem: "ITM", Dog: "NHNPC", Horse: "NHNPC", Chickens: "NHNPC", ChickensWhite: "NHNPC", ChickensBrownLight: "NHNPC", Fish: "NHNPC" };
    return byClass[e.cls] ?? (e.soType ? "SO" : e.saTemplate ? "SA" : "UNK");
  }

  private prop(n: BtNode, k: string): string {
    const v = n.props[k];
    return v === undefined ? "" : v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
  }

  private filter(f: BtNode, c: Context, parent: number, child: number, tags: string[]): boolean {
    const evalIn = (k: string) => {
      const q = this.prop(f, k);
      return q.startsWith("$") ? String(c.scope.get(q.slice(1).split(".")[0]) !== undefined ? this.lookupPath(c.scope, q.slice(1)) : "") : q;
    };
    const subject = this.prop(f, "Source") === "Parent" ? parent : child;
    let ok: boolean;
    switch (f.tag) {
      case "CategoryFilter": {
        const cats = evalIn("categories").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        ok = cats.includes((this.o.ents.get(subject)?.category ?? "").toLowerCase());
        break;
      }
      case "LinkTagFilter": ok = tags.map((t) => t.toLowerCase()).includes(evalIn("tag").toLowerCase()); break;
      case "EntityClassFilter": {
        const want = evalIn("Class");
        const cls = this.o.ents.get(subject)?.cls ?? "";
        const aliases: Record<string, string[]> = { NPC: ["NPC", "NPC_Female"], SmartObject: ["SmartObjectHolder"], Item: ["PickableItem"], Path: ["PredefinedNavigationPath"] };
        ok = (aliases[want] ?? [want]).includes(cls);
        break;
      }
      case "WUIDFilter": {
        const q = this.prop(f, "WUID");
        const w = wuid(q.startsWith("$") ? c.eval("WUID", null) : this.lookupValue(c.scope, q));
        ok = w !== null && w === subject;
        break;
      }
      case "LinkDataFilter": {
        // a link of this tag whose data satisfies the condition, read as $<tag>: a value
        // (QuestActor[('father')]: $QuestActor == 'father') or a struct
        // (QuestLocation[ctx('x'),npc('y')]: $QuestLocation.ctx == …)
        const tag = evalIn("tag").toLowerCase(), cond = this.prop(f, "condition");
        ok = false;
        for (const l of this.o.ents.get(parent)?.links ?? []) {
          if (l.target !== child || ok) continue;
          for (const part of l.name.split(/,(?![^[]*\])/)) {
            const m = /^\s*([\w:]+)\s*(?:\[(.*)\])?\s*$/.exec(part);
            if (!m || m[1].toLowerCase() !== tag) continue;
            const tmp = new Scope(c.scope);
            tmp.vars.set(m[1], linkData(m[2] ?? "", tmp, this.runner.host));
            if (!cond.trim() || truthyProp(evalExpression(cond, tmp, this.runner.host) ?? false)) { ok = true; break; }
          }
        }
        break;
      }
      case "UnionOp": {
        // any of its filters (each is tried, so each binds what it finds)
        const kids = f.children.filter((k) => k.tag !== "OutputBreakpoints");
        ok = kids.map((k) => this.filter(k, c, parent, child, tags)).some(Boolean);
        break;
      }
      case "OrByRandomOp": {
        // its filters in a random order; the first that passes decides (ShortCircuit) and binds
        // (so_inspection.xml picks one of a point's inspection_next_<n> links at random)
        const kids = f.children.filter((k) => k.tag !== "OutputBreakpoints");
        for (let i = kids.length - 1; i > 0; i--) { const j = Math.floor(this.runner.host.random() * (i + 1)); [kids[i], kids[j]] = [kids[j], kids[i]]; }
        ok = kids.some((k) => this.filter(k, c, parent, child, tags));
        break;
      }
      case "NegationOp": {
        const inner = f.children.find((k) => k.tag === "Child0")?.children[0];
        ok = inner ? !this.filter(inner, c, parent, child, tags) : true;
        break;
      }
      // nobody dies yet: every NPC (and the player) is alive
      case "SoulIsAliveFilter": ok = subject === -1 || /^NPC/.test(this.o.ents.get(subject)?.cls ?? ""); break;
      // no inventories or item slots are modelled yet: item filters match nothing
      case "SlotClassFilter": case "ItemClassFilter": ok = false; break;
      case "HasBehaviorFilter": {
        // a smart object's type or a smart area's template (a shop's "customer"). Requestable:
        // enabled with an instance free (or this NPC reserved one); Available: not disabled;
        // Exists: offered
        const names = evalIn("BehaviorList").split(",").map((s) => s.trim().toLowerCase());
        const e = this.o.ents.get(subject);
        const bs = [...(e?.soType ? this.o.ai.so.get(e.soType) ?? [] : []), ...(e?.saTemplate ? this.o.ai.sa.get(e.saTemplate) ?? [] : [])];
        const npc = this.current.npc;
        const choice = this.prop(f, "FilterChoice");
        ok = bs.some((b) => names.includes(b.name.toLowerCase()) && (choice === "Requestable" ? this.available(subject, b) || this.held.has(`${npc}|${subject}/${b.name}`) : choice !== "Available" || this.states.get(`${subject}/${b.name}`) !== "Disabled"));
        break;
      }
      case "RangeFilter": {
        // the subject within [min, max] m of `point` (an entity or a position); excludeRef drops the point's own entity
        const ref = this.ref(f, c, "point");
        const at = Array.isArray(ref) && ref.length === 3 ? (ref as number[]) : wuid(ref) !== null ? this.pos(wuid(ref)!) : null;
        const p = this.pos(subject);
        const d = at && p ? Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) : Infinity;
        ok = d >= Number(this.prop(f, "min") || 0) && d <= Number(this.prop(f, "max") || Infinity) && !(truthyProp(this.prop(f, "excludeRef")) && wuid(ref) === subject);
        break;
      }
      default:
        this.runner.report(`graph filter ${f.tag}`);
        ok = true;
    }
    const bindChild = this.prop(f, "Child"), bindParent = this.prop(f, "Parent");
    if (ok && bindChild) c.scope.set(bindChild, child);
    if (ok && bindParent) c.scope.set(bindParent, parent);
    return ok;
  }

  private lookupValue(scope: Scope, path: string): Value | undefined {
    let v: Value | undefined = scope.get(path.split(".")[0]);
    for (const f of path.split(".").slice(1)) v = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Value>)[f] : undefined;
    return v;
  }

  private lookupPath(scope: Scope, path: string): string {
    const v = this.lookupValue(scope, path);
    return v === undefined || v === null ? "" : String(v);
  }

  /** A reference property (Origin, Target, SmartObject, …): a variable path written with or without "$". */
  private ref(n: BtNode, c: Context, prop: string): Value | undefined {
    const q = this.prop(n, prop).trim();
    if (!q) return undefined;
    if (q.startsWith("$")) return c.eval(prop, null);
    // an indexed path (t_places[skalitz], t_actors['sarka']) is read as the expression it is
    return q.includes("[") ? evalExpression("$" + q, c.scope, this.runner.host) : this.lookupValue(c.scope, q);
  }

  private name(id: number): string {
    return this.o.ents.get(id)?.name.replace(/_[0-9a-f]{8}-[0-9a-f-]{27}$/, "") ?? `#${id}`;
  }

  // ---- smart-object behaviours ----

  /** A target's behaviour by name: a smart object's type, or a smart area's template (a home's "Eater_withBowl"). */
  private behaviour(target: number, name: string): Behaviour | undefined {
    const e = this.o.ents.get(target);
    const lower = name.toLowerCase();
    const so = e?.soType ? this.o.ai.so.get(e.soType)?.find((b) => b.name.toLowerCase() === lower) : undefined;
    return so ?? (e?.saTemplate ? this.o.ai.sa.get(e.saTemplate)?.find((b) => b.name.toLowerCase() === lower) : undefined);
  }

  /** Requestable: enabled, and an instance free (max instances: the object's own, else its type's). */
  private available(target: number, b: Behaviour): boolean {
    this.initObject(target);
    const k = `${target}/${b.name}`;
    const state = this.states.get(k) ?? (b.initialState ? "NoRequests" : "Enabled");
    if (state !== "Enabled") return false;
    const max = this.maxInstances.get(k) ?? b.maxInstances;
    return max < 0 || (this.reservations.get(k) ?? 0) < max;
  }

  /**
   * A smart object's set-up, once, before its first use: the OnInit of its brain's update tree
   * (so_bench.xml#bench_onUpdate → uInit counts the bench's Sit helpers into a benchSize link and
   * sets max instances of `use`). The rest of the update tree (its message loops) doesn't run.
   */
  private initObject(id: number): void {
    if (this.initialised.has(id)) return;
    this.initialised.add(id);
    const type = this.o.ents.get(id)?.soType;
    const ref = type ? this.o.ai.soBrain.get(type) : undefined;
    const tree = ref && this.o.trees(ref.file, ref.tree);
    const init = tree?.root?.children.find((k) => k.tag === "OnInit")?.children[0];
    if (!tree || !init) return;
    const { task } = this.runner.instantiate({ ...tree, root: init }, this.globals(id, { __object: { id } }));
    const prev = this.current;
    this.current = { npc: id };
    try {
      for (let i = 0; i < 32 && task.tick() === "running"; i++);
    } finally { this.current = prev; }
  }

  private reserve(target: number, b: Behaviour, delta: number) {
    const k = `${target}/${b.name}`;
    this.reservations.set(k, Math.max(0, (this.reservations.get(k) ?? 0) + delta));
  }

  private emit(reason: string) {
    this.catchers[this.catchers.length - 1]?.(reason);
  }

  /** CallBehavior: run the target smart object's behaviour tree with __object = target. */
  private callBehaviour(n: BtNode, c: Context): Task {
    let inner: Task | null = null;
    let held: { target: number; b: Behaviour } | null = null;
    const release = () => { if (held) { this.reserve(held.target, held.b, -1); held = null; } };
    return {
      tick: () => {
        if (!inner) {
          const target = wuid(this.ref(n, c, "Target"));
          const name = String(c.eval("BehaviorName", ""));
          const b = target === null ? undefined : this.behaviour(target, name);
          const tree = b && this.o.trees(b.file, b.tree);
          if (target === null || !b || !tree) { this.trace(`npc ${this.current.npc}: CallBehavior "${name}" on ${target === null ? "nothing" : this.name(target)}: not found`); this.emit("NotFound"); return "failure"; }
          // an instance this NPC reserved (ReserveBehavior around this call) is its to use
          if (!this.held.has(`${this.current.npc}|${target}/${b.name}`)) {
            if (!this.available(target, b)) { this.emit("MaxInstance"); return "failure"; }
            this.reserve(target, b, 1);
            held = { target, b };
          }
          this.trace(`npc ${this.current.npc}: CallBehavior "${b.name}" on ${this.name(target)} → ${b.file}#${b.tree}`);
          this.emit("RequestOK");
          // a smart area's behaviour runs on that area (a shop's "customer" searches the shop); a
          // smart object's keeps the caller's area
          const area = this.o.ents.get(target)?.saTemplate ? { id: target } : c.scope.get("__area") ?? null;
          if (this.o.ents.get(target)?.saTemplate) { this.areasInUse.set(target, this.o.realTime()); this.areaEvent(target, "request", this.current.npc, b.name); }
          inner = this.tagged(this.current.npc, b.tagId, this.runner.instantiate(tree, this.globals(this.current.npc, { __object: { id: target }, __behaviorName: b.name, __area: area }, c.scope)).task);
        }
        if (this.runner.nesting > MAX_NESTING) { this.runner.report(`CallBehavior: nesting over ${MAX_NESTING} at ${String(c.eval("BehaviorName", ""))}`); inner.abort(); inner = null; release(); this.emit("BehFail"); return "failure"; }
        this.runner.nesting++;
        let s: Status;
        try { s = inner.tick(); } finally { this.runner.nesting--; }
        if (s !== "running") { inner = null; release(); this.emit(s === "success" ? "BehSucces" : "BehFail"); }
        return s;
      },
      abort: () => { inner?.abort(); inner = null; release(); },
    };
  }

  // ---- host nodes ----

  /** Whether an entity (the player: -1) stands inside an area's shape. */
  private inArea(who: number | null, area: number | null): boolean {
    const a = area === null ? undefined : this.o.ents.get(area), p = who === null ? null : this.pos(who);
    return !!a && !!p && !!a.points && areaHolds(a, p);
  }

  private pos(id: number): [number, number, number] | null {
    return this.positions.get(id) ?? this.o.ents.get(id)?.pos ?? null;
  }

  /**
   * Scope a lock/semaphore name: Global; Intellect (this NPC); Local, the smart object or area
   * whose behaviour runs, shared by the NPCs using it: CityWalk_walking's per-point locks keep two
   * walkers from one point, and so_bench.xml#use's `<npc>_kickFromBench` lock is how another sitter
   * moves this one on (bt-rules.md: Local is the hosting smart area or object instance).
   * ASSUMPTION: a Local lock in a tree with neither (none seen in the data) is the tree instance's.
   */
  private lockKey(n: BtNode, c: Context, nameProp: string): string {
    const kind = this.prop(n, "LockManagerType");
    const name = String(c.eval(nameProp, ""));
    if (kind === "Global") return `G/${name}`;
    if (kind !== "Local") return `I/${this.current.npc}/${name}`;
    const owner = wuid(c.scope.get("__object")) ?? wuid(c.scope.get("__area"));
    return `L/${owner ?? `s${scopeId(c.scope)}`}/${name}`;
  }

  /** ActionHelperMapper: the object's helper offering `animation`, as a world transform. */
  private helperFor(object: number, animation: string, index?: number): { id: number; pos: [number, number, number]; rot: [number, number, number, number] } | null {
    const e = this.o.ents.get(object);
    if (!e) return null;
    const list = this.o.helpers?.get((e.soHelpers ?? "").toLowerCase()) ?? [];
    // a helper given by index (GetHelper: a bench's Place<n>), else the one offering the animation
    const k = index !== undefined && index >= 0 && index < list.length ? index : Math.max(0, list.findIndex((h) => animation && h.description.includes(`'${animation}'`)));
    const h = list[k];
    if (!h) return { id: -1, pos: e.pos, rot: e.rot };
    // the object's rotation, turned half round for classes whose markers face the other way
    const [w, x, y, z] = MIRRORED_HELPERS.has((e.soHelpers ?? "").toLowerCase()) ? [-e.rot[3], e.rot[2], -e.rot[1], e.rot[0]] : e.rot;
    const [px, py, pz] = h.pos;
    // rotate the helper offset by the object's rotation: v + 2w(q×v) + 2q×(q×v), then translate
    const tx = 2 * (y * pz - z * py), ty = 2 * (z * px - x * pz), tz = 2 * (x * py - y * px);
    const pos: [number, number, number] = [
      e.pos[0] + px + w * tx + (y * tz - z * ty),
      e.pos[1] + py + w * ty + (z * tx - x * tz),
      e.pos[2] + pz + w * tz + (x * ty - y * tx),
    ];
    const [hw, hx, hy, hz] = h.rot;
    const rot: [number, number, number, number] = [w * hw - x * hx - y * hy - z * hz, w * hx + x * hw + y * hz - z * hy, w * hy - x * hz + y * hw + z * hx, w * hz + x * hy - y * hx + z * hw];
    return { id: k, pos, rot };
  }

  /** Links between entities as the trees change them: AddLink / RemoveLink edit the level's graph. */
  private hasLink(from: number | null, to: number | null, tag: string): boolean {
    const t = tag.toLowerCase();
    // any source: the target's incoming links (reverse index) instead of scanning every entity
    if (from === null && to !== null) return (this.parents.get(to) ?? []).some((l) => l.name.split(",").some((x) => x.replace(/\[.*$/, "").trim().toLowerCase() === t));
    const sources = from !== null ? [from] : [...this.o.ents.keys()];
    for (const f of sources) for (const l of this.o.ents.get(f)?.links ?? []) {
      if ((to === null || l.target === to) && l.name.split(",").some((x) => x.replace(/\[.*$/, "").trim().toLowerCase() === t)) return true;
    }
    return false;
  }

  private node(n: BtNode, c: Context): Task | undefined {
    const kids = n.children;
    const leaf = (f: () => Status): Task => ({ tick: f, abort: () => {} });
    const setVar = (prop: string, v: Value) => { const name = this.prop(n, prop); if (name) assignVar(c.scope, name, v); };
    switch (n.tag) {
      case "SetQuest": case "SetQuestObjective":
        return leaf(() => {
          const obj = n.tag === "SetQuestObjective";
          // an empty quest name is the tree's own quest (research notes: the tree's entity name)
          const quest = String(c.eval(obj ? "quest" : "questName", "") ?? "") || String(this.lookupValue(c.scope, "this.name") ?? "");
          const objective = String(c.eval(obj ? "objective" : "objectiveName", "") ?? "");
          const fn = String(c.eval("function", "") ?? "");
          const ok = this.o.quest?.(fn, quest, objective || undefined);
          this.trace(`npc ${this.current.npc}: ${fn} ${quest}${objective ? `/${objective}` : ""}${ok === false ? " (refused)" : ""}`);
          // ASSUMPTION: the node succeeds whatever the quest system answered
          return "success";
        });
      // quest reads (quest-system.md, "Behaviour-tree nodes"), answered by the quest state so that
      // quests diet mode cuts read as cancelled
      case "QuestCondition":
        return this.branch(n, c, () => !!this.o.questCall?.(String(c.eval("function", "") ?? ""), this.questOf(n, c, "quest")));
      case "QuestObjectiveCondition":
        return this.branch(n, c, () => !!this.o.questCall?.(String(c.eval("function", "") ?? ""), this.questOf(n, c, "quest"), String(c.eval("objective", "") ?? "")));
      case "GetQuest":
        return leaf(() => {
          // the objective by name ("obejctiveName" in the data) or, without one, by id (paramInt)
          const name = String(c.eval("obejctiveName", "") ?? "") || String(c.eval("objectiveName", "") ?? "");
          const objective = name || Number(c.eval("paramInt", 0) ?? 0);
          setVar("variableOut", !!this.o.questCall?.(String(c.eval("function", "") ?? ""), this.questOf(n, c, "questName"), objective));
          return "success";
        });
      case "QuestObjectiveGate": {
        const fn = ({ Started: "IsObjectiveStarted", Completed: "IsObjectiveCompleted", Canceled: "IsObjectiveCanceled", AfterReset: "IsObjectiveUnchanged", StartedTrackingDone: "IsObjectiveTrackedCompleted" } as Record<string, string>)[this.prop(n, "objectiveState")];
        if (!fn) return undefined;
        return this.gate(n, c, () => !!this.o.questCall?.(fn, this.questOf(n, c, "questName"), String(c.eval("objectiveName", "") ?? "")));
      }
      // level profiles: named sets of editor layers a quest switches on and off. ASSUMPTIONs (no
      // note yet): a profile is loaded as soon as it is enabled, and every profile can be loaded
      case "EnableProfile":
        return leaf(() => {
          for (const [prop, on] of [["profileDisable", false], ["profileEnable", true]] as const) {
            const name = String(c.eval(prop, "") ?? "").toLowerCase();
            if (!name || this.profiles.has(name) === on) continue;
            if (on) this.profiles.add(name); else this.profiles.delete(name);
            this.trace(`npc ${this.current.npc}: profile ${name} ${on ? "on" : "off"}`);
            this.o.profile?.(name, on);
          }
          return "success";
        });
      case "ProfileLoadedGate":
        return this.gate(n, c, () => this.profiles.has(String(c.eval("LayerName", "") ?? "").toLowerCase()));
      case "ProfileCanBeLoaded":
        return this.branch(n, c, () => true);
      // every DLC and all content is installed (the package holds the whole game)
      case "DLCInstallGate": case "StreamingInstallGate":
        return this.gate(n, c, () => true);
      // ASSUMPTION: the game mode is Normal (no Hardcore mode yet)
      case "GameModeCondition":
        return this.branch(n, c, () => this.prop(n, "GameMode") === "Normal");
      // sounds come with ambient audio
      case "ExecuteSoundTrigger":
        return leaf(() => "success");
      // decorators around a child whose own effect isn't modelled yet (a screen fade, random
      // events held back, a buff or a perceivable label for as long as the child runs)
      case "FaderBarrier": case "SuspendRandomEvents": case "DisableStartSituations": case "DecoratorBuff": case "AddPerceivableState":
        return kids[0] ? this.runner.make(kids[0], c.scope) : leaf(() => "success");
      // a cutscene: a level sequence or a video. The host plays it and says how long it takes;
      // without one it is skipped (ASSUMPTION: a skipped cutscene succeeds at once, as when the
      // player skips it; what follows a cutscene is the quest's own cutscene_<alias> tree)
      case "PlaySequence": case "PlayVideo": {
        let until: number | null = null;
        return {
          tick: () => {
            if (until === null) {
              const name = String(c.eval(n.tag === "PlayVideo" ? "video_file" : "sequence", "") ?? "");
              this.trace(`npc ${this.current.npc}: ${n.tag} ${name}`);
              until = this.o.realTime() + (this.o.cutscene?.(n.tag === "PlayVideo" ? "video" : "sequence", name) ?? 0);
            }
            if (this.o.realTime() < until) return "running";
            until = null;
            return "success";
          },
          abort: () => { until = null; },
        };
      }
      // world effects the simulation doesn't have yet (buffs, visibility, ownership, factions,
      // weapons in hand, fast travel, time skips): reported to the host, and they succeed
      case "AddBuff": case "RemoveBuffs": case "SetVisibility": case "SetOwner": case "SetTemporarySuperfaction": case "ClearTemporarySuperfaction":
      case "EquipItem": case "DrawWeapon": case "InstantDrawWeapon": case "StopFastTravel": case "InterruptSkipTime": case "Intermission":
      case "RemoveGameContext": case "AddGameContext": case "GameOver":
        return leaf(() => {
          this.o.effect?.(n.tag, Object.fromEntries(Object.keys(n.props).map((k) => [k, c.eval(k, null) ?? null])), this.current.npc);
          return "success";
        });
      // the player is a man (Henry); A Woman's Lot plays Theresa (not modelled)
      case "HasGenderCheck":
        return this.branch(n, c, () => this.prop(n, "Gender") === "Male");
      // ASSUMPTION: nobody is in combat or dead yet (combat comes with core gameplay)
      case "HasActiveThreats":
        return this.branch(n, c, () => false);
      case "HasActiveThreatsGate": case "DeadUnconsciousGate":
        return this.gate(n, c, () => false);
      case "StateMachineGate":
        if (this.prop(n, "State") !== "Dead") return undefined;
        return this.gate(n, c, () => false);
      // the player in a conversation (any, or one with choices): the host knows
      case "DialogGate":
        return this.gate(n, c, () => wuid(this.ref(n, c, "Who")) === -1 && !!this.o.playerInDialog?.(this.prop(n, "Condition")));
      case "IsInsideArea":
        return this.branch(n, c, () => this.inArea(wuid(this.ref(n, c, "Origin")), wuid(this.ref(n, c, "Area"))));
      case "DistanceGate": {
        // open while Origin is nearer the reference point than Low; once open it stays so until
        // High is passed (ASSUMPTION: the two bounds are a hysteresis band; most gates give both
        // the same value). No Origin: the entity running the tree
        let near = false;
        return this.gate(n, c, () => {
          const a = this.prop(n, "Origin").trim() ? wuid(this.ref(n, c, "Origin")) : this.current.npc, b = wuid(this.ref(n, c, "ReferencePt"));
          const p = a === null ? null : this.pos(a), q = b === null ? null : this.pos(b);
          if (!p || !q) return false;
          const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
          near = d < Number(c.eval("Low", 0)) || (near && d <= Number(c.eval("High", 0)));
          return near;
        });
      }
      case "AreaPresence": {
        // watches the NPCs (the player, mostly) against an area: its child runs when one comes in
        // (TrackIn) or goes out (TrackOut); Once ends with the child's result, else it watches on.
        // ASSUMPTION: where they stand when the watch starts isn't an event unless
        // ReportInitialState says so
        const kid = kids.find((k) => k.tag !== "OutputBreakpoints");
        let was: Map<number, boolean> | null = null;
        let body: Task | null = null;
        return {
          tick: () => {
            if (!body) {
              const raw = this.ref(n, c, "NPCs"), area = wuid(this.ref(n, c, "Area"));
              const who = (Array.isArray(raw) ? raw : [raw]).map((v) => wuid(v ?? null)).filter((x): x is number => x !== null);
              const first = !was;
              was ??= new Map();
              let fired = false;
              for (const id of who) {
                const now = this.inArea(id, area), before = was.get(id);
                was.set(id, now);
                if (first ? truthyProp(this.prop(n, "ReportInitialState")) && now : before !== now) {
                  if ((now && truthyProp(this.prop(n, "TrackIn"))) || (!now && !first && truthyProp(this.prop(n, "TrackOut")))) {
                    fired = true;
                    const out = this.prop(n, "OutNPC");
                    if (out) assignVar(c.scope, out, id);
                  }
                }
              }
              if (!fired) return "running";
              if (!kid) return truthyProp(this.prop(n, "Once")) ? "success" : "running";
              body = this.runner.make(kid, c.scope);
            }
            const s = body.tick();
            if (s === "running") return s;
            body = null;
            return truthyProp(this.prop(n, "Once")) ? s : "running";
          },
          abort: () => { body?.abort(); body = null; was = null; },
        };
      }
      case "InstantSendMessageToNPC": case "SendMessageToNPC": case "InstantMultiSendMessageToNPC": case "MultiSendMessageToNPC":
        return this.sendNode(n, c);
      case "ProcessMessage": case "InstantProcessMessage": case "ReadMessage": case "InstantReadMessage":
        return this.readNode(n, c);
      case "CheckWuidValid": case "EnsureWuidValid": {
        // a set reference (an entity, an animation, …): CheckWuidValid takes Then or Else; Ensure
        // runs its child while the reference is set (RunLogic Halt: fails once it isn't)
        const valid = () => { const v = this.ref(n, c, n.tag === "CheckWuidValid" ? "wuid" : "Wuid"); return v !== null && v !== undefined && v !== "" && !Array.isArray(v) && (typeof v !== "object" || wuid(v) !== null); };
        const branch = (tag: string) => n.children.find((k) => k.tag === tag)?.children[0];
        let body: Task | null = null;
        return {
          tick: () => {
            if (n.tag === "EnsureWuidValid" && body && !valid()) { body.abort(); body = null; return this.prop(n, "RunLogic") === "Halt" ? "failure" : "success"; }
            if (!body) {
              if (n.tag === "EnsureWuidValid" && !valid()) return this.prop(n, "RunLogic") === "Halt" ? "failure" : "running";
              const k = n.tag === "CheckWuidValid" ? branch(valid() ? "Then" : "Else") : kids.find((x) => x.tag !== "OutputBreakpoints");
              if (!k) return truthyProp(c.eval("FailSubtMissing", false)) ? "failure" : "success";
              body = this.runner.make(k, c.scope);
            }
            const s = body.tick();
            if (s !== "running") body = null;
            return s;
          },
          abort: () => { body?.abort(); body = null; },
        };
      }
      case "DoMonologue": {
        // the voice and subtitle come with the barks (ambient audio); until then it only takes time
        let until: number | null = null;
        return {
          tick: () => {
            if (until === null) {
              const m = { topicId: String(c.eval("TopicId", "") ?? ""), label: String(c.eval("TopicLabel", "") ?? ""), metaroles: String(c.eval("Metaroles", "") ?? "") };
              this.trace(`npc ${this.current.npc}: monologue ${m.metaroles || m.label || m.topicId}`);
              const d = this.o.monologue?.(this.current.npc, m);
              until = this.o.realTime() + (typeof d === "number" ? d : MONOLOGUE_SECONDS);
            }
            if (this.o.realTime() < until) return "running";
            until = null;
            return "success";
          },
          abort: () => { until = null; },
        };
      }
      case "GetTime":
        // now (+ Delta) on the node's clock, in seconds: WorldTime the world clock, else game time
        return leaf(() => {
          const now = this.prop(n, "TimeType") === "WorldTime" ? this.o.worldTime() : this.o.realTime();
          const delta = this.prop(n, "Delta").trim() ? secondsOf(c.eval("Delta", 0) ?? 0) : 0;
          setVar("OutVar", now + delta);
          return "success";
        });
      // animation tags around a child (not modelled: the child runs as is); looking (no head IK yet)
      case "LocalTagWrapper":
        return kids[0] ? this.runner.make(kids[0], c.scope) : leaf(() => "success");
      case "Look":
        return leaf(() => "success");
      case "AddAreaLabel": case "RemoveAreaLabel":
        // an area's labels (private, semipublic: whom it admits); kept, not read by anything yet
        return leaf(() => {
          const area = wuid(this.ref(n, c, "Area"));
          if (area === null) return "failure";
          const set = this.labels.get(area) ?? new Set<string>();
          this.labels.set(area, set);
          const label = String(c.eval("Label", ""));
          if (n.tag === "AddAreaLabel") set.add(label); else set.delete(label);
          return "success";
        });
      case "ClearInbox":
        return leaf(() => { this.post.clear(this.current.npc, String(c.eval("inbox", "")), String(c.eval("type", "") ?? "")); return "success"; });
      case "Synchronize": case "InstantSynchronize": case "InstantSemaphore": {
        // a counted lock (bt-rules.md): Synchronize waits for a place, then until SemaphoreCount
        // participants hold the lock, and runs its child with them (count 1: a first-come-first-served
        // queue, entityUtils.xml#queue, the place in OutsideQueuePosVariable, 0 = inside);
        // InstantSemaphore fails at once when there is no place (CityWalk_walking's lock per point)
        const me = {};
        let lock: CountedLock | null = null;
        let body: Task | null = null;
        const leave = () => { if (lock) releaseLock(lock, me); lock = null; };
        const instant = n.tag === "InstantSemaphore";
        return {
          tick: () => {
            if (!body) {
              const count = Number(c.eval("SemaphoreCount", instant ? 1 : 2));
              lock ??= this.counted(this.lockKey(n, c, "SemaphoreName"));
              const inside = acquireLock(lock, me, count);
              if (!instant) {
                const pos = inside ? 0 : lock.holders.length + lock.waiting.indexOf(me);
                setVar("OutsideQueuePosVariable", pos);
                setVar("InsidePosVariable", pos);
              }
              if (!inside) {
                if (instant || this.prop(n, "RunLogic") === "Halt") { leave(); return "failure"; }
                return "running";
              }
              if (!instant && count > 0 && lock.holders.length < count) return "running"; // waiting for the others
              body = kids[0] ? this.runner.make(kids[0], c.scope) : null;
              if (!body) { leave(); return "success"; }
            }
            const s = body.tick();
            if (s !== "running") { body = null; leave(); }
            return s;
          },
          abort: () => { body?.abort(); body = null; leave(); },
        };
      }
      case "GetHelper":
        // one helper of the object by name (policy Name: a bench's "Place2"), as its index
        return leaf(() => {
          const obj = wuid(this.ref(n, c, "smartObjectName"));
          const e = obj === null ? undefined : this.o.ents.get(obj);
          const want = String(c.eval("helperName", "")).toLowerCase();
          const i = (this.o.helpers?.get((e?.soHelpers ?? "").toLowerCase()) ?? []).findIndex((h) => h.name.toLowerCase() === want);
          if (i < 0) return "failure";
          setVar("targetVar", i);
          return "success";
        });
      // tags on entities (onBench, isSitting) aren't modelled: the child runs as is
      case "TagIt":
        return kids[0] ? this.runner.make(kids[0], c.scope) : leaf(() => "success");
      case "GetHelpers":
        // the object's helpers of a category (description "…;Category(Sit)"), by index
        return leaf(() => {
          const obj = wuid(this.ref(n, c, "smartObject"));
          const e = obj === null ? undefined : this.o.ents.get(obj);
          const cat = String(c.eval("categoryName", "")).toLowerCase();
          const list = this.o.helpers?.get((e?.soHelpers ?? "").toLowerCase()) ?? [];
          const out = list.map((h, i) => ({ h, i })).filter(({ h }) => !cat || h.description.toLowerCase().includes(`category(${cat})`)).map(({ i }) => i);
          setVar("targetVar", out);
          return "success";
        });
      case "SmartObjSetBehaviorState": case "SmartObjSetBehaviorMaxInstances": case "SetBehaviorState": case "SetBehaviorMaxInstances":
        // on the entity running the tree (a smart object's or smart area's own brain: a shop
        // allows one customer at a time)
        return leaf(() => {
          const id = this.current.npc;
          for (const b of String(c.eval("behaviors", "")).split(",").map((x) => x.trim()).filter(Boolean)) {
            const name = this.behaviour(id, b)?.name ?? b;
            if (n.tag.endsWith("SetBehaviorState")) this.states.set(`${id}/${name}`, String(c.eval("state", "Enabled")));
            else this.maxInstances.set(`${id}/${name}`, Number(c.eval("maxInstances", -1)));
          }
          return "success";
        });
      case "Teleport":
        return leaf(() => {
          const v = this.ref(n, c, "Position");
          const p = Array.isArray(v) && v.length === 3 ? (v as number[]) : wuid(v) !== null ? this.pos(wuid(v)!) : null;
          const npc = wuid(this.ref(n, c, "Target")) ?? this.current.npc;
          if (!p) return "failure";
          this.trace(`npc ${npc}: teleport to ${p.map((x) => x.toFixed(1)).join(",")}`);
          this.o.act?.({ kind: "teleport", npc, target: [p[0], p[1], p[2]] });
          this.positions.set(npc, [p[0], p[1], p[2]]);
          return "success";
        });
      case "TurnBody": {
        // face an entity or a point (the turn itself takes a moment: TURN_SECONDS)
        let until: number | null = null;
        return {
          tick: () => {
            if (until === null) {
              const v = this.ref(n, c, "destinationSpecification");
              const p = Array.isArray(v) && v.length === 3 ? (v as number[]) : wuid(v) !== null ? this.pos(wuid(v)!) : null;
              if (!p) return truthyProp(this.prop(n, "allowInstantSuccess")) ? "success" : "failure";
              const d = this.o.act?.({ kind: "turn", npc: this.current.npc, target: [p[0], p[1], p[2]] });
              until = this.o.realTime() + (typeof d === "number" ? d : TURN_SECONDS);
            }
            if (this.o.realTime() < until) return "running";
            until = null;
            return "success";
          },
          abort: () => { until = null; },
        };
      }
      case "Semaphore": {
        // holds a counted lock around its child; others wait in arrival order (outside timers not modelled)
        const me = {};
        let lock: CountedLock | null = null;
        let body: Task | null = null;
        const leave = () => { if (lock) releaseLock(lock, me); lock = null; };
        return {
          tick: () => {
            if (!body) {
              lock ??= this.counted(this.lockKey(n, c, "SemaphoreName"));
              if (!acquireLock(lock, me, Number(c.eval("SemaphoreCount", 1)))) return "running";
              body = kids[0] ? this.runner.make(kids[0], c.scope) : null;
              if (!body) { leave(); return "success"; }
            }
            const s = body.tick();
            if (s !== "running") { body = null; leave(); }
            return s;
          },
          abort: () => { body?.abort(); body = null; leave(); },
        };
      }
      case "AddLink": case "RemoveLink":
        return leaf(() => {
          const from = wuid(this.ref(n, c, "From")), to = wuid(this.ref(n, c, "To"));
          const tag = String(c.eval("Tag", ""));
          const e = from === null ? undefined : this.o.ents.get(from);
          if (!e || to === null || !tag) return this.prop(n, "LinkOpHandleMode") === "Fail" ? "failure" : "success";
          e.links ??= [];
          // the link's data goes in brackets, as in the level's links (benchSize[4], benchUser[0]);
          // links match by tag, whatever their data
          const data = this.prop(n, "Data").trim() ? c.eval("Data", "") : "";
          const name = data === "" || data === null || data === undefined ? tag : `${tag}[${String(data)}]`;
          const same = (l: { target: number; name: string }) => l.target === to && l.name.replace(/\[.*$/, "") === tag;
          if (n.tag === "AddLink") {
            if (!e.links.some(same)) {
              e.links.push({ target: to, name });
              const back = this.parents.get(to) ?? [];
              back.push({ target: from!, name });
              this.parents.set(to, back);
            }
          } else {
            e.links = e.links.filter((l) => !same(l));
            this.parents.set(to, (this.parents.get(to) ?? []).filter((l) => !(l.target === from && l.name.replace(/\[.*$/, "") === tag)));
          }
          this.trace(`npc ${this.current.npc}: ${n.tag} ${this.name(from!)} -${tag}-> ${this.name(to)}`);
          return "success";
        });
      case "LinkOperationBarrier": {
        // waits until the link (From -Tag-> To; Any = wildcard) exists (Exist, ExistAdd, Added) or is gone (Removed, RemovedNotThere)
        let body: Task | null = null;
        return {
          tick: () => {
            if (!body) {
              const from = c.eval("AnyFrom", false) === true || c.eval("AnyFrom", false) === "true" ? null : wuid(this.ref(n, c, "From"));
              const to = c.eval("AnyTo", false) === true || c.eval("AnyTo", false) === "true" ? null : wuid(this.ref(n, c, "To"));
              const exists = this.hasLink(from, to, String(c.eval("Tag", "")));
              const op = this.prop(n, "LinkOp");
              if ((op.startsWith("Removed") ? exists : !exists)) return "running";
              body = kids[0] ? this.runner.make(kids[0], c.scope) : null;
              if (!body) return "success";
            }
            const s = body.tick();
            if (s !== "running") body = null;
            return s;
          },
          abort: () => { body?.abort(); body = null; },
        };
      }
      case "SetExternalLock":
        return leaf(() => {
          const k = this.lockKey(n, c, "LockName"), v = c.eval("Locked", true) === true || c.eval("Locked", true) === "true";
          this.locks.set(k, v);
          this.trace(`npc ${this.current.npc}: lock ${k} ${v ? "closed" : "opened"}`);
          return "success";
        });
      // no inventories: hands are empty
      case "HandCheck":
        return leaf(() => { setVar("LeftHand", null); setVar("RightHand", null); return "success"; });
      // no player body in the viewer: everything is "not near the player"
      case "NotNearPlayer":
        return leaf(() => { setVar("result", true); return "success"; });
      case "InstantExternalLock": {
        // runs its child while the named lock is open; when the lock closes (the child or another tree
        // locking it, as entityUtils.xml#queue does when its action is done) the child is halted: success
        let body: Task | null = null;
        return {
          tick: () => {
            const locked = () => this.locked(this.lockKey(n, c, "SemaphoreName"));
            if (locked()) { body?.abort(); body = null; return this.prop(n, "RunLogic") === "Halt" ? "success" : "running"; }
            body ??= kids[0] ? this.runner.make(kids[0], c.scope) : null;
            if (!body) return "success";
            const s = body.tick();
            if (s !== "running") { body = null; return s; }
            if (locked()) { this.trace(`npc ${this.current.npc}: ${this.lockKey(n, c, "SemaphoreName")} closed: halt`); body.abort(); body = null; return "success"; }
            return s;
          },
          abort: () => { body?.abort(); body = null; },
        };
      }
      case "ExternalLock": {
        // runs its child once the named lock is free (KeepRunning waits, Halt fails)
        let body: Task | null = null;
        return {
          tick: () => {
            if (!body) {
              if (this.locked(this.lockKey(n, c, "SemaphoreName"))) return this.prop(n, "RunLogic") === "Halt" ? "failure" : "running";
              body = kids[0] ? this.runner.make(kids[0], c.scope) : null;
              if (!body) return "success";
            }
            const s = body.tick();
            if (s !== "running") body = null;
            return s;
          },
          abort: () => { body?.abort(); body = null; },
        };
      }
      case "GetType":
        // the kind of entity a WUID is, as the trees compare it: 'NPC', 'NPC_Female', 'TP', 'SO', …
        return leaf(() => {
          const id = wuid(this.ref(n, c, "WUID"));
          setVar("OutString", id === null ? "UNK" : this.entityType(id, truthyProp(this.prop(n, "TreatPlayerAsNPC"))));
          return "success";
        });
      case "GetSpatialInfo":
        return leaf(() => {
          const id = wuid(this.ref(n, c, "In"));
          const p = id === null ? null : this.pos(id);
          if (!p) return "failure";
          const what = this.prop(n, "What");
          const rot = this.o.ents.get(id!)?.rot ?? [1, 0, 0, 0];
          setVar("Out", what === "Transform" ? { pos: [...p], rot: [...rot] } : what === "Orientation" ? [...rot] : what === "Velocity" ? [0, 0, 0] : [...p]);
          return "success";
        });
      case "ActionHelperMapper":
        return leaf(() => {
          const obj = wuid(this.ref(n, c, "SmartObject"));
          const given = this.prop(n, "HelperId") ? this.lookupValue(c.scope, this.prop(n, "HelperId").replace(/^\$/, "")) : undefined;
          const h = obj === null ? null : this.helperFor(obj, String(c.eval("animation", "")), typeof given === "number" ? given : undefined);
          if (!h) return "failure";
          this.trace(`npc ${this.current.npc}: helper ${h.id} of ${this.name(obj!)} for "${String(c.eval("animation", ""))}" at ${h.pos.map((v) => v.toFixed(1)).join(",")}`);
          setVar("HelperId", h.id);
          setVar("PositionOut", { pos: h.pos, rot: h.rot });
          setVar("OutputHeleprs", h.id);
          return "success";
        });
      case "CreateItem": case "RemoveItem": case "DetachObject": case "AbortAllAnimations": case "ForceIdleState": case "SetSpatialInfo":
        return leaf(() => { this.trace(`npc ${this.current.npc}: ${n.tag}`); return "success"; });
      case "GraphSearch": return leaf(() => this.graphSearch(n, c));
      case "CallBehavior": return this.callBehaviour(n, c);
      case "LODGuardian": {
        const branch = kids.find((k) => k.tag === ((this.o.detail ?? true) ? "Detail" : "LOD"));
        return branch?.children[0] ? this.runner.make(branch.children[0], c.scope) : leaf(() => "success");
      }
      case "TryCatch": {
        const body = kids.find((k) => k.tag === "Subtree")?.children[0];
        const catches = kids.filter((k) => k.tag === "BehaviorTagCatch");
        const inner = body ? this.runner.make(body, c.scope) : null;
        // a handler's own events (its CallBehavior failing) are not caught again by this TryCatch
        let handling = false;
        const onEvent = (reason: string) => {
          if (handling) return;
          const k = catches.find((x) => this.prop(x, "Reason") === reason);
          if (k?.children[0]) {
            // ASSUMPTION: catch handlers are instant (Expression nodes in practice)
            handling = true;
            try {
              const t = this.runner.make(k.children[0], c.scope);
              for (let i = 0; i < 16 && t.tick() === "running"; i++);
            } finally { handling = false; }
          }
        };
        return {
          tick: () => {
            if (!inner) return "success";
            this.catchers.push(onEvent);
            try {
              const s = inner.tick();
              // ASSUMPTION: a caught behaviour outcome ends the TryCatch successfully
              return s === "failure" ? "success" : s;
            } finally { this.catchers.pop(); }
          },
          abort: () => inner?.abort(),
        };
      }
      case "ReserveBehavior": {
        // the search picks a target (reserveFrom) and a behaviour name; one instance of it is
        // reserved on the target while Exec runs, so others' searches see it taken (note section 8)
        const search = kids.find((k) => k.tag === "Search")?.children[0];
        const exec = kids.find((k) => k.tag === "Exec")?.children[0];
        let searchTask: Task | null = null;
        let execTask: Task | null = null;
        let held: { key: string; target: number; b: Behaviour } | null = null;
        const release = () => { if (held) { this.reserve(held.target, held.b, -1); this.held.delete(held.key); held = null; } };
        return {
          tick: () => {
            if (!execTask) {
              searchTask ??= search ? this.runner.make(search.tag === "ReserveBehaviorSearch" ? search.children[0] : search, c.scope) : null;
              const s = searchTask ? searchTask.tick() : "success";
              if (s === "running") return s;
              searchTask = null;
              if (s !== "success") return s;
              const target = wuid(this.ref(n, c, "reserveFrom"));
              const b = target === null ? undefined : this.behaviour(target, String(c.eval("behaviorName", "")));
              if (target !== null && b) {
                const key = `${this.current.npc}|${target}/${b.name}`;
                if (!this.held.has(key)) {
                  if (!this.available(target, b)) return "failure";
                  this.reserve(target, b, 1);
                  this.held.add(key);
                  held = { key, target, b };
                }
              }
              execTask = exec ? this.runner.make(exec, c.scope) : null;
              if (!execTask) { release(); return "success"; }
            }
            const s = execTask.tick();
            if (s !== "running") { execTask = null; release(); }
            return s;
          },
          abort: () => { searchTask?.abort(); searchTask = null; execTask?.abort(); execTask = null; release(); },
        };
      }
      case "Move": case "MoveAndAct": case "ExactMove": case "PlayAnimation": {
        let until: number | null = null;
        return {
          tick: () => {
            if (until === null) {
              const npc = this.current.npc;
              let a: Action;
              if (n.tag === "PlayAnimation") {
                a = { kind: "animation", npc, target: String(c.eval("animation", "")), object: wuid(this.ref(n, c, "SmartObject")) ?? undefined };
              } else {
                const dest = this.ref(n, c, "destinationSpecification");
                let p = Array.isArray(dest) && dest.length === 3 ? (dest as number[]) : wuid(dest) !== null ? this.pos(wuid(dest)!) : null;
                // MoveAndAct without a destination goes to a helper of the smart object it acts on
                const obj = wuid(c.scope.get("__object"));
                let rot: [number, number, number, number] | undefined;
                // ExactMove to an object with a helper id (destinationSpecification2): that helper
                if (n.tag === "ExactMove" && wuid(dest) !== null && this.prop(n, "destinationSpecification2")) {
                  const h = this.helperFor(wuid(dest)!, String(c.eval("destinationSpecification3", "")));
                  if (h) { p = h.pos; rot = h.rot; }
                }
                if (!p && n.tag === "MoveAndAct" && obj !== null) {
                  const h = this.helperFor(obj, String(c.eval("AnimationToPlay", "")));
                  p = h?.pos ?? null;
                  rot = h?.rot;
                }
                // a destination from ActionHelperMapper (PositionOut = {pos, rot}) carries the helper's orientation
                const spec = this.prop(n, "destinationSpecification");
                if (spec.endsWith(".pos")) {
                  const t = this.lookupValue(c.scope, spec.replace(/^\$/, "").slice(0, -4));
                  const r = t && typeof t === "object" && !Array.isArray(t) ? (t as Record<string, Value>).rot : undefined;
                  if (Array.isArray(r) && r.length === 4) rot = r as [number, number, number, number];
                }
                // ExactMove directionType="AlignWithEntity": end facing the way the target faces (a vendor's
                // merchant point faces the street)
                if (!rot && n.tag === "ExactMove" && this.prop(n, "directionType") === "AlignWithEntity") {
                  const t = wuid(this.ref(n, c, "directionSpecification"));
                  const te = t !== null ? this.o.ents.get(t) : undefined;
                  if (te) rot = [...te.rot];
                }
                if (!p) this.trace(`npc ${npc}: ${n.tag} destination "${this.prop(n, "destinationSpecification")}" unresolved`);
                a = { kind: "move", npc, target: (p ? [...p] : this.pos(npc) ?? [0, 0, 0]) as [number, number, number], object: obj ?? undefined, rot };
              }
              const t = a.target;
              this.trace(`npc ${npc}: ${a.kind} ${typeof t === "string" ? t : `to ${t.map((v) => v.toFixed(1)).join(",")}`}${a.object !== undefined ? ` (${this.name(a.object)})` : ""}`);
              // ASSUMPTION: without a world simulation, moves take distance / 1.4 m/s and animations 4 s (real time)
              const from = this.pos(npc);
              const d = this.o.act?.(a) ?? (a.kind === "move" && from && typeof t !== "string" ? Math.hypot(t[0] - from[0], t[1] - from[1]) / 1.4 : 4);
              if (a.kind === "move" && typeof t !== "string") this.positions.set(npc, t);
              until = this.o.realTime() + d;
            }
            if (this.o.realTime() < until) return "running";
            until = null;
            return "success";
          },
          abort: () => { until = null; },
        };
      }
    }
    return undefined;
  }
}

/** Real seconds a monologue takes without a player for it (DoMonologue). */
const MONOLOGUE_SECONDS = 4;

/** Real seconds a TurnBody takes. ASSUMPTION: about a half turn at the walk's turning rate. */
const TURN_SECONDS = 0.6;

const truthyProp = (v: Value | undefined) => v === true || v === "true" || (typeof v === "number" && v !== 0);

const scopeIds = new WeakMap<Scope, number>();
let nextScopeId = 1;
function scopeId(s: Scope): number {
  let id = scopeIds.get(s);
  if (!id) { id = nextScopeId++; scopeIds.set(s, id); }
  return id;
}

/** Assign to a variable named by a property: "name", "name.field" or "name['key']". */
function assignVar(scope: Scope, target: string, v: Value): void {
  const m = /^([A-Za-z_]\w*)(?:\[\s*'?([^'\]]*)'?\s*\]|\.(\w+))?$/.exec(target.trim());
  if (!m) return;
  const [, name, key, field] = m;
  const sub = key ?? field;
  if (sub === undefined) { scope.set(name, v); return; }
  let o = scope.get(name);
  if (o === null || o === undefined || typeof o !== "object" || Array.isArray(o)) { o = {}; scope.set(name, o); }
  (o as Record<string, Value>)[sub] = v;
}

/**
 * Load everything an AiWorld needs from the asset VFS: all Libs/AI behaviour trees (~1 s), the AI
 * tables and the smart-object helpers. `opts` supplies the entity index, clocks and callbacks.
 */
export async function createAiWorld(vfs: Vfs, opts: Omit<WorldOptions, "ai" | "trees" | "helpers">): Promise<AiWorld> {
  const td = vfs.lookup("libs/ai/typedefinitions.xml");
  let knownType = (_: string) => true;
  if (td) {
    const defs = new TypeDefs(new TextDecoder().decode(await vfs.read(td)));
    // a mailbox filter naming a type the definitions don't have stands for the root type
    // engine message types (hearingInfo, npcDeath, daycycle:activity, …) are declared in the savegame
    // definitions; without them their mailboxes would take every message
    const sg = vfs.lookup("libs/ai/typedefinitions_savegame.xml");
    const more = sg ? new TypeDefs(new TextDecoder().decode(await vfs.read(sg))) : null;
    knownType = (t) => defs.types.has(t.toLowerCase()) || !!more?.types.has(t.toLowerCase());
    setTypeDefs(defs);
    opts.lua?.defineEnums(defs.luaEnums());
  }
  const trees = new Map<string, BtTree>();
  for (const path of vfs.paths()) {
    if (!path.startsWith("libs/ai/") || !path.endsWith(".xml")) continue;
    const xml = new TextDecoder().decode(await vfs.read(vfs.lookup(path)!));
    if (!xml.includes("<BehaviorTree")) continue;
    const rel = path.slice("libs/ai/".length);
    for (const t of parseTreeFile(xml, rel)) trees.set(`${rel}#${t.name.toLowerCase()}`, t);
  }
  const T = AiDb.TABLES;
  const ai = new AiDb({ soTag: await readTable(vfs, T.soTag), so2tag: await readTable(vfs, T.so2tag), saTag: await readTable(vfs, T.saTag), sa2tag: await readTable(vfs, T.sa2tag), so: await readTable(vfs, T.so), brain2sub: await readTable(vfs, T.brain2sub), subSo: await readTable(vfs, T.subSo), sa: await readTable(vfs, T.sa), subSa: await readTable(vfs, T.subSa), subBt: await readTable(vfs, T.subBt) });
  const so = vfs.lookup("libs/smartobjects.xml");
  const helpers = so ? parseSmartObjectHelpers(new TextDecoder().decode(await vfs.read(so))) : new Map<string, SoHelper[]>();
  // brain variables, one declaration per name (form ids: 0 single, 1 array, 2 associative, 3 array)
  const brainVars = new Map<string, BtVariable>();
  for (const r of await readTable(vfs, "ai/brain_variable")) {
    if (brainVars.has(r.brain_variable_name)) continue;
    const form = ({ "1": "array", "2": "associative", "3": "array" } as Record<string, string>)[r.ai_variable_form_id] ?? "single";
    brainVars.set(r.brain_variable_name, { name: r.brain_variable_name, type: r.type, values: r.init_value ?? "", form, persistent: r.is_persistent === "True" });
  }
  const souls = await readTable(vfs, "rpg/soul");
  const soulNames = new Map(souls.map((r) => [r.soul_id, r.soul_name]));
  const soulBrains = new Map(souls.filter((r) => r.brain_id).map((r) => [r.soul_name, r.brain_id]));
  const shopkeepers = new Set((await readTable(vfs, "shop/shopkeeper")).map((r) => soulNames.get(r.keeper_id) ?? "").filter(Boolean));
  const M = MailDb.TABLES;
  const mail = new MailDb({ mailbox: await readTable(vfs, M.mailbox), filter: await readTable(vfs, M.filter), brain: await readTable(vfs, M.brain), saTag: await readTable(vfs, M.saTag), soTag: await readTable(vfs, M.soTag) }, (t) => knownType(t));
  return new AiWorld({ ...opts, ai, helpers, shopkeepers, mail, soulBrains, brainVars: [...brainVars.values()], trees: (f, n) => trees.get(`${f}#${n}`) });
}
