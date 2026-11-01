// The quest system, from the research note quest-system.md: quests are graphs of objectives
// (quest_objective, quest_transition); this module keeps their state and runs the lifecycle
// (activate, start, complete, cancel, reset, the successors' AND-join, automatic completion by
// condition) and answers the predicates conditions, trees and scripts read.
//
// Behaviour trees, dialogue and Lua all change quests through QuestSystem, and all read them
// through it, so an overlay (diet.ts) can stand between them and the stored state: it can make a
// quest read as cancelled and refuse every change to it without writing anything.
//
// Not yet: tracked assets (items, NPCs, statistics), timers, paying rewards (they are announced as
// events), saving on objectives.

import { readTable, groupBy, type Row } from "./tables.ts";
import { holds, type CondValue } from "./dialogueCondition.ts";
import type { Vfs } from "./vfs.ts";

/** Objective states (quest-system.md, "Objective state"). */
export const UNCHANGED = 0, STARTED = 1, COMPLETED = 2, CANCELED = 3, TRACKING_DONE = 4;

/** The pseudo-objectives of quest_transition. */
export const START = 2, END = 3;

export interface QuestInfo {
  id: string;
  name: string;
  /** activated on a new game */
  activated: boolean;
  /** how many times it can finish (−1: unlimited) */
  counter: number;
  type: number;
  group: string;
  /** a journal subchapter and an objective that is not hidden: it shows banners */
  visible: boolean;
}

export interface Objective {
  id: number;
  name: string;
  condition: string;
  hidden: boolean;
  exclusive: boolean;
  /** shown in the journal (not hidden, with a journal element) */
  journal: boolean;
  /** an auto-complete or expiration timer (not run yet) */
  timer: boolean;
}

/** A dialogue sequence's quest change (sequence2quest_objective). */
export interface SequenceWrite {
  quest: string;
  objective: number;
  /** 1 start, 2 complete, 3 cancel */
  action: number;
  condition: string;
  order: number;
}

export const SEQ_START = 1, SEQ_COMPLETE = 2, SEQ_CANCEL = 3;

export interface QuestMarker {
  quest: string;
  objective?: number;
  /** a quest_place entity, or a tracked asset's map position */
  entity?: string;
  pos?: string;
}

const int = (s: string | undefined) => (s ? Number(s) : 0);
const yes = (s: string | undefined) => s === "True";
const blankTimer = (s: string | undefined) => !s || s === "-1" || s === "0";

/** The quest tables, by quest name. */
export class QuestDb {
  readonly quests = new Map<string, QuestInfo>();
  private names = new Map<string, string>();
  private lower = new Map<string, string>();
  private objectives = new Map<string, Map<number, Objective>>();
  private objectiveIds = new Map<string, Map<string, number>>();
  /** enabled edges, and every edge (exclusive siblings use both) */
  private next = new Map<string, number[]>();
  private prev = new Map<string, number[]>();
  private nextAll = new Map<string, number[]>();
  private prevAll = new Map<string, number[]>();
  private writes = new Map<number, SequenceWrite[]>();
  private topics = new Map<string, number[]>();
  private places = new Map<string, QuestMarker[]>();
  private rewardRows = new Map<string, boolean[]>();

  private constructor() {}

  static async load(vfs: Vfs): Promise<QuestDb> {
    const t = (n: string) => readTable(vfs, n);
    const [quests, objectives, transitions, s2q, subchapters, topics, skald, places, tracked, exp, money, item, perk] = await Promise.all([
      t("quest/quest"), t("quest/quest_objective"), t("quest/quest_transition"), t("text/sequence2quest_objective"),
      t("quest/quest2skald_subchapter"), t("text/v_topic2subchapter_id"), t("skald/skald_objective"),
      t("quest/quest_place"), t("quest/quest_tracked_asset"),
      t("quest/quest_reward_exp"), t("quest/quest_reward_money"), t("quest/quest_reward_item"), t("quest/quest_reward_perk"),
    ]);
    return QuestDb.from({ quests, objectives, transitions, s2q, subchapters, topics, skald, places, tracked, rewards: [...exp, ...money, ...item, ...perk] });
  }

  /** Build from table rows (tests build small ones by hand). */
  static from(t: { quests: Row[]; objectives: Row[]; transitions: Row[]; s2q?: Row[]; subchapters?: Row[]; topics?: Row[]; skald?: Row[]; places?: Row[]; tracked?: Row[]; rewards?: Row[] }): QuestDb {
    const db = new QuestDb();
    const sub = new Map((t.subchapters ?? []).map((r) => [r.quest_id, r.skald_subchapter_id]));
    const journalRows = new Set((t.skald ?? []).map((r) => `${r.quest_id}/${r.objective_id}`));
    for (const r of t.quests) {
      db.names.set(r.quest_id, r.quest_name);
      db.lower.set(r.quest_name.toLowerCase(), r.quest_name);
      db.quests.set(r.quest_name, { id: r.quest_id, name: r.quest_name, activated: yes(r.is_activated), counter: r.counter ? Number(r.counter) : 1, type: int(r.quest_type_id), group: r.group ?? "", visible: false });
    }
    const name = (id: string) => db.names.get(id);
    for (const r of t.objectives) {
      const q = name(r.quest_id);
      if (!q) continue;
      const o: Objective = {
        id: int(r.objective_id), name: r.objective_name, condition: r.condition ?? "", hidden: yes(r.is_hidden), exclusive: yes(r.is_exclusive),
        journal: !yes(r.is_hidden) && journalRows.has(`${r.quest_id}/${r.objective_id}`),
        timer: !blankTimer(r.autocomplete_timeout_str) || !blankTimer(r.expiration_timeout_str),
      };
      let m = db.objectives.get(q);
      if (!m) { m = new Map(); db.objectives.set(q, m); db.objectiveIds.set(q, new Map()); }
      m.set(o.id, o);
      db.objectiveIds.get(q)!.set(o.name.toLowerCase(), o.id);
    }
    for (const info of db.quests.values()) info.visible = sub.has(info.id) && [...(db.objectives.get(info.name)?.values() ?? [])].some((o) => !o.hidden);
    const push = (m: Map<string, number[]>, k: string, v: number) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
    for (const r of t.transitions) {
      const q = name(r.quest_id);
      if (!q) continue;
      const from = int(r.from_objective_id), to = int(r.to_objective_id);
      push(db.nextAll, `${q}/${from}`, to);
      push(db.prevAll, `${q}/${to}`, from);
      if (r.enabled === "False") continue;
      push(db.next, `${q}/${from}`, to);
      push(db.prev, `${q}/${to}`, from);
    }
    for (const r of t.s2q ?? []) {
      const q = name(r.quest_id);
      if (!q) continue;
      const seq = int(r.sequence_id);
      const list = db.writes.get(seq) ?? [];
      list.push({ quest: q, objective: int(r.objective_id), action: int(r.action), condition: r.condition ?? "", order: int(r.order_by) });
      db.writes.set(seq, list);
    }
    for (const l of db.writes.values()) l.sort((a, b) => a.order - b.order);
    const bySub = groupBy(t.topics ?? [], "skald_subchapter_id");
    for (const [qid, s] of sub) { const q = name(qid); if (q) db.topics.set(q, (bySub.get(s) ?? []).map((r) => int(r.start_topic))); }
    for (const r of t.places ?? []) { const q = name(r.quest_id); if (q) db.places.set(q, [...(db.places.get(q) ?? []), { quest: q, entity: r.entity }]); }
    for (const r of t.tracked ?? []) {
      const q = name(r.quest_id);
      if (q && r.on_map === "True") db.places.set(q, [...(db.places.get(q) ?? []), { quest: q, objective: int(r.objective_id), pos: r.pos }]);
    }
    for (const r of t.rewards ?? []) { const q = name(r.quest_id); if (q) { const k = `${q}/${r.objective_id}`; db.rewardRows.set(k, [...(db.rewardRows.get(k) ?? []), yes(r.is_immediate)]); } }
    return db;
  }

  /** The table's spelling of a quest name (scripts are not always careful with case). */
  canonical(quest: string): string | undefined {
    return this.quests.has(quest) ? quest : this.lower.get(quest.toLowerCase());
  }

  quest(name: string): QuestInfo | undefined {
    const c = this.canonical(name);
    return c ? this.quests.get(c) : undefined;
  }

  objectivesOf(quest: string): Objective[] {
    return [...(this.objectives.get(quest)?.values() ?? [])];
  }

  objective(quest: string, id: number): Objective | undefined {
    return this.objectives.get(quest)?.get(id);
  }

  /** An objective by name or numeric id. */
  objectiveId(quest: string, ref: string | number): number | undefined {
    if (typeof ref === "number" || /^\d+$/.test(ref)) return this.objectives.get(quest)?.has(Number(ref)) ? Number(ref) : undefined;
    return this.objectiveIds.get(quest)?.get(ref.toLowerCase());
  }

  /** Successors through enabled edges (END included). */
  successors(quest: string, id: number): number[] { return this.next.get(`${quest}/${id}`) ?? []; }
  predecessors(quest: string, id: number): number[] { return this.prev.get(`${quest}/${id}`) ?? []; }
  successorsAll(quest: string, id: number): number[] { return this.nextAll.get(`${quest}/${id}`) ?? []; }
  predecessorsAll(quest: string, id: number): number[] { return this.prevAll.get(`${quest}/${id}`) ?? []; }
  initial(quest: string): number[] { return this.successors(quest, START); }
  isFinal(quest: string, id: number): boolean { return this.successors(quest, id).includes(END); }

  /** The quest changes a dialogue sequence makes, in order. */
  sequenceWrites(sequence: number): SequenceWrite[] { return this.writes.get(sequence) ?? []; }
  /** every sequence that changes a quest */
  sequencesWriting(): IterableIterator<[number, SequenceWrite[]]> { return this.writes.entries(); }

  /** The start topics of the quest's journal entry (its own dialogue). */
  startTopics(quest: string): number[] { return this.topics.get(quest) ?? []; }

  /** Its quest_place entities and on-map tracked assets. */
  markers(quest: string): QuestMarker[] { return this.places.get(quest) ?? []; }

  /** Rewards on an objective: immediate (true) or paid when the quest completes (false). */
  rewards(quest: string, id: number): boolean[] { return this.rewardRows.get(`${quest}/${id}`) ?? []; }
}

/** What a save keeps per quest it touched. */
export interface QuestRecord {
  activated: boolean;
  started: boolean;
  completed: boolean;
  failed: boolean;
  deactivated: boolean;
  tracked: boolean;
  finishesLeft: number;
  /** objective id → state */
  objectives: Record<number, number>;
}

export type QuestEvent =
  /** quest message states: Started 0, Completed 1, Canceled 2, Reset 4, Active 5; `banner` for visible quests */
  | { kind: "quest"; quest: string; state: number; banner: boolean }
  /** objective message states: 0 started, 1 completed, 2 canceled; `journal` when it has a journal entry */
  | { kind: "objective"; quest: string; objective: number; state: number; journal: boolean }
  | { kind: "reward"; quest: string; objective: number; immediate: boolean };

/** Something that stands between the stored state and everyone who reads or changes it. */
export interface QuestOverlay {
  /** Read this quest as cancelled and refuse every change to it. `stored` is its saved record, if any. */
  cut(quest: string, stored: QuestRecord | undefined): boolean;
  /** Refuse to start this objective of a quest that is not cut (an option rewired away). */
  blocks?(quest: string, objective: string): boolean;
}

/** Objective states as the quest's predicates read them. */
const isActive = (s: number) => s === STARTED || s === TRACKING_DONE;

export class QuestSystem {
  private records = new Map<string, QuestRecord>();
  private listeners: ((e: QuestEvent) => void)[] = [];
  /** an overlay (diet mode); null reads the stored state as it is */
  overlay: QuestOverlay | null = null;
  report?: (what: string) => void;

  readonly db: QuestDb;

  constructor(db: QuestDb) {
    this.db = db;
  }

  on(listener: (e: QuestEvent) => void): void { this.listeners.push(listener); }

  // ---- reading ----

  /** Read as cancelled by the overlay. */
  isCut(quest: string): boolean {
    const q = this.db.canonical(quest);
    return !!q && !!this.overlay?.cut(q, this.records.get(q));
  }

  /** The stored record, or a new game's defaults (not stored until something changes). */
  private peek(quest: string): QuestRecord {
    return this.records.get(quest) ?? this.fresh(quest);
  }

  private fresh(quest: string): QuestRecord {
    const info = this.db.quests.get(quest)!;
    return { activated: info.activated, started: false, completed: false, failed: false, deactivated: false, tracked: false, finishesLeft: info.counter, objectives: {} };
  }

  private rec(quest: string): QuestRecord {
    let r = this.records.get(quest);
    if (!r) { r = this.fresh(quest); this.records.set(quest, r); }
    return r;
  }

  /** An objective's state as everyone reads it. */
  objectiveState(quest: string, ref: string | number): number {
    const q = this.db.canonical(quest);
    if (!q) return UNCHANGED;
    const id = this.db.objectiveId(q, ref);
    if (id === undefined) return UNCHANGED;
    if (this.isCut(q)) return CANCELED;
    return this.peek(q).objectives[id] ?? UNCHANGED;
  }

  /** Quest flags as everyone reads them: a cut quest reads as cancelled. */
  flags(quest: string): Omit<QuestRecord, "objectives"> {
    const q = this.db.canonical(quest);
    if (!q) return { activated: false, started: false, completed: false, failed: false, deactivated: false, tracked: false, finishesLeft: 0 };
    if (this.isCut(q)) return { activated: false, started: false, completed: false, failed: true, deactivated: false, tracked: false, finishesLeft: 0 };
    const { objectives: _, ...f } = this.peek(q);
    return f;
  }

  isAvailable(quest: string): boolean {
    const q = this.db.canonical(quest);
    if (!q || this.isCut(q)) return false;
    const r = this.peek(q);
    return !(r.completed || r.failed) || r.finishesLeft > 0 || r.finishesLeft === -1;
  }

  /**
   * The quest condition functions (dialogue.md, quest-system.md "Predicates"), or undefined for
   * any other function.
   */
  call(name: string, args: CondValue[]): CondValue | undefined {
    const q = String(args[0] ?? "");
    const b = (v: boolean) => (v ? 1 : 0);
    switch (name) {
      case "IsQuestActivated": return b(this.flags(q).activated);
      case "IsQuestStarted": return b(this.flags(q).started);
      case "IsQuestCompleted": return b(this.flags(q).completed);
      case "IsQuestCanceled": case "IsQuestFailed": return b(this.flags(q).failed);
      case "IsQuestAvailable": return b(this.isAvailable(q));
      case "IsQuestUnchanged": {
        const c = this.db.canonical(q);
        if (!c || this.isCut(c)) return 0;
        const r = this.peek(c);
        return b(!r.started && !r.completed && !r.failed && !r.deactivated && r.activated === this.db.quests.get(c)!.activated && Object.values(r.objectives).every((s) => s === UNCHANGED));
      }
      case "IsObjectiveStarted": return b(isActive(this.objectiveState(q, args[1] ?? "")));
      case "IsObjectiveCompleted": return b(this.objectiveState(q, args[1] ?? "") === COMPLETED);
      case "IsObjectiveCanceled": case "IsObjectiveFailed": return b(this.objectiveState(q, args[1] ?? "") === CANCELED);
      case "IsObjectiveUnchanged": return b(this.objectiveState(q, args[1] ?? "") === UNCHANGED);
      case "IsObjectiveTrackedCompleted": return b(this.objectiveState(q, args[1] ?? "") === TRACKING_DONE);
    }
    return undefined;
  }

  /** Whether a condition in the dialogue condition language holds, reading quests (other functions are 0). */
  holds(condition: string, empty = true): boolean {
    return holds(condition, { call: (n, a) => this.call(n, a) ?? 0, named: () => undefined, report: this.report }, empty);
  }

  /** Quests the journal lists: started or finished, visible, and not cut. */
  journal(): { quest: string; state: "active" | "completed" | "failed" }[] {
    const out: { quest: string; state: "active" | "completed" | "failed" }[] = [];
    for (const [q, r] of this.records) {
      if (!this.db.quests.get(q)?.visible || this.isCut(q)) continue;
      if (r.started) out.push({ quest: q, state: "active" });
      else if (r.completed) out.push({ quest: q, state: "completed" });
      else if (r.failed) out.push({ quest: q, state: "failed" });
    }
    return out;
  }

  /** Map markers of the tracked quests' active objectives (quest_place and on-map tracked assets). */
  markers(hide?: (m: QuestMarker) => boolean): QuestMarker[] {
    const out: QuestMarker[] = [];
    for (const [q, r] of this.records) {
      if (!r.tracked || !r.started || this.isCut(q)) continue;
      for (const m of this.db.markers(q)) {
        if (m.objective !== undefined && !isActive(r.objectives[m.objective] ?? UNCHANGED)) continue;
        if (!hide?.(m)) out.push(m);
      }
    }
    return out;
  }

  // ---- saving ----

  /** The stored state (only quests something changed). */
  save(): Record<string, QuestRecord> {
    return structuredClone(Object.fromEntries(this.records));
  }

  load(data: Record<string, QuestRecord>): void {
    this.records = new Map(Object.entries(structuredClone(data)));
  }

  // ---- changing ----

  private emit(e: QuestEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** The canonical name of a quest that may change, or undefined (unknown, or cut: refused). */
  private writable(quest: string, what: string): string | undefined {
    const q = this.db.canonical(quest);
    if (!q) { this.report?.(`quest ${quest} not found (${what})`); return undefined; }
    if (this.overlay?.cut(q, this.records.get(q))) return undefined;
    return q;
  }

  activate(quest: string): boolean {
    const q = this.writable(quest, "activate");
    if (!q) return false;
    const r = this.rec(q);
    if (r.deactivated) return false;
    if (!r.activated) {
      r.activated = true;
      this.emit({ kind: "quest", quest: q, state: 5, banner: false });
      this.recheck();
    }
    return true;
  }

  deactivate(quest: string): boolean {
    const q = this.writable(quest, "deactivate");
    if (!q) return false;
    const r = this.rec(q);
    r.activated = false;
    r.deactivated = true;
    return true;
  }

  startQuest(quest: string): boolean {
    const q = this.writable(quest, "start");
    if (!q || !this.isAvailable(q)) return false;
    const r = this.rec(q);
    if (!r.activated && !this.activate(q)) return false;
    if (r.started) return true;
    r.objectives = {};
    if (this.db.quests.get(q)!.visible) this.emit({ kind: "quest", quest: q, state: 0, banner: true });
    for (const id of this.db.initial(q)) if (id !== END) this.startObjectiveId(q, id);
    r.started = true;
    this.emit({ kind: "quest", quest: q, state: 0, banner: false });
    this.recheck();
    return true;
  }

  startObjective(quest: string, ref: string | number): boolean {
    const q = this.writable(quest, "start objective");
    if (!q) return false;
    const id = this.db.objectiveId(q, ref);
    if (id === undefined) { this.report?.(`objective ${quest}/${ref} not found`); return false; }
    return this.startObjectiveId(q, id);
  }

  private startObjectiveId(q: string, id: number): boolean {
    const r = this.rec(q);
    if (!r.activated) return false;
    const s = r.objectives[id] ?? UNCHANGED;
    if (isActive(s)) return true;
    if (s === COMPLETED) return false;
    const o = this.db.objective(q, id);
    if (o && this.overlay?.blocks?.(q, o.name)) return false;
    r.objectives[id] = STARTED;
    this.emit({ kind: "objective", quest: q, objective: id, state: 0, journal: !!o?.journal });
    return true;
  }

  completeObjective(quest: string, ref: string | number): boolean {
    const q = this.writable(quest, "complete objective");
    if (!q) return false;
    const id = this.db.objectiveId(q, ref);
    if (id === undefined) return false;
    const ok = this.completeObjectiveId(q, id);
    if (ok) this.recheck();
    return ok;
  }

  private completeObjectiveId(q: string, id: number): boolean {
    const r = this.rec(q);
    if (!isActive(r.objectives[id] ?? UNCHANGED)) return false;
    const o = this.db.objective(q, id);
    r.objectives[id] = COMPLETED;
    for (const immediate of this.db.rewards(q, id)) if (immediate) this.emit({ kind: "reward", quest: q, objective: id, immediate });
    if (o?.exclusive) {
      for (const succ of this.db.successorsAll(q, id)) {
        for (const p of this.db.predecessorsAll(q, succ)) {
          if (p !== id && this.db.objective(q, p)?.exclusive && (r.objectives[p] ?? UNCHANGED) !== COMPLETED) this.cancelObjectiveId(q, p);
        }
      }
    }
    this.emit({ kind: "objective", quest: q, objective: id, state: 1, journal: !!o?.journal && r.started });
    if (this.db.isFinal(q, id)) this.completeQuestRecord(q);
    for (const succ of this.db.successors(q, id)) {
      if (succ === END) continue;
      const done = this.db.predecessors(q, succ).every((p) => p === START || [COMPLETED, CANCELED].includes(r.objectives[p] ?? UNCHANGED));
      if (done) this.startObjectiveId(q, succ);
    }
    return true;
  }

  cancelObjective(quest: string, ref: string | number): boolean {
    const q = this.writable(quest, "cancel objective");
    if (!q) return false;
    const id = this.db.objectiveId(q, ref);
    if (id === undefined) return false;
    this.cancelObjectiveId(q, id);
    return true;
  }

  private cancelObjectiveId(q: string, id: number): void {
    const r = this.rec(q);
    r.objectives[id] = CANCELED;
    this.emit({ kind: "objective", quest: q, objective: id, state: 2, journal: !!this.db.objective(q, id)?.journal && r.started });
  }

  completeQuest(quest: string): boolean {
    const q = this.writable(quest, "complete");
    if (!q) return false;
    return this.completeQuestRecord(q);
  }

  private completeQuestRecord(q: string): boolean {
    if (!this.isAvailable(q)) return false;
    const r = this.rec(q);
    r.started = false;
    r.completed = true;
    r.tracked = false;
    this.emit({ kind: "quest", quest: q, state: 1, banner: this.db.quests.get(q)!.visible });
    for (const [id, s] of Object.entries(r.objectives)) {
      if (s !== COMPLETED) continue;
      for (const immediate of this.db.rewards(q, Number(id))) if (!immediate) this.emit({ kind: "reward", quest: q, objective: Number(id), immediate });
    }
    this.finish(r);
    return true;
  }

  /** Cancel (fail) a started quest. */
  cancelQuest(quest: string): boolean {
    const q = this.writable(quest, "cancel");
    if (!q) return false;
    const r = this.rec(q);
    if (!r.started) return false;
    r.started = false;
    r.failed = true;
    r.tracked = false;
    this.emit({ kind: "quest", quest: q, state: 2, banner: this.db.quests.get(q)!.visible });
    // ASSUMPTION: what is left active is cancelled (the note leaves the cleanup untraced)
    for (const [id, s] of Object.entries(r.objectives)) if (isActive(s)) r.objectives[Number(id)] = CANCELED;
    this.finish(r);
    return true;
  }

  private finish(r: QuestRecord): void {
    if (r.finishesLeft > 0) r.finishesLeft--;
    if (r.finishesLeft > 0 || r.finishesLeft === -1) r.objectives = {};
  }

  resetQuest(quest: string): boolean {
    const q = this.writable(quest, "reset");
    if (!q) return false;
    this.records.set(q, { ...this.fresh(q), activated: false });
    this.emit({ kind: "quest", quest: q, state: 4, banner: false });
    return true;
  }

  /** Make it the journal's tracked quest (its active objectives show markers). */
  track(quest: string): void {
    const q = this.writable(quest, "track");
    if (!q) return;
    for (const r of this.records.values()) r.tracked = false;
    this.rec(q).tracked = true;
  }

  /**
   * The generic re-check (quest-system.md, "Automatic completion"): an active objective with no
   * tracked asset and no timer completes when its non-blank condition holds. Repeats until nothing
   * changes. ASSUMPTION: tracked assets and timers are not run yet, so objectives with a timer wait
   * for a script.
   */
  recheck(): void {
    for (let pass = 0; pass < 100; pass++) {
      let changed = false;
      for (const [q, r] of this.records) {
        if (!r.activated || this.isCut(q)) continue;
        for (const [k, s] of Object.entries(r.objectives)) {
          if (!isActive(s)) continue;
          const o = this.db.objective(q, Number(k));
          if (!o || o.timer || !o.condition.trim()) continue;
          if (this.holds(o.condition, false) && this.completeObjectiveId(q, o.id)) changed = true;
        }
      }
      if (!changed) return;
    }
    this.report?.("quest re-check did not settle");
  }

  /** Run a dialogue sequence's quest changes (sequence2quest_objective), each if its condition holds. */
  runSequence(sequence: number, condition: (src: string) => boolean = (s) => this.holds(s)): void {
    for (const w of this.db.sequenceWrites(sequence)) {
      if (w.condition.trim() && !condition(w.condition)) continue;
      if (w.action === SEQ_START) this.startObjective(w.quest, w.objective);
      else if (w.action === SEQ_COMPLETE) this.completeObjective(w.quest, w.objective);
      else if (w.action === SEQ_CANCEL) this.cancelObjective(w.quest, w.objective);
    }
  }

  /**
   * A behaviour tree's SetQuest / SetQuestObjective, or Lua's QuestSystem call, by function name
   * (StartQuest, ActivateQuest, StartObjective, …). Returns whether it succeeded.
   */
  apply(fn: string, quest: string, objective?: string | number): boolean {
    switch (fn) {
      case "ActivateQuest": return this.activate(quest);
      case "DeactivateQuest": return this.deactivate(quest);
      case "StartQuest": return this.startQuest(quest);
      case "CompleteQuest": return this.completeQuest(quest);
      case "CancelQuest": return this.cancelQuest(quest);
      case "ResetQuest": return this.resetQuest(quest);
      case "StartObjective": return objective !== undefined && this.startObjective(quest, objective);
      case "CompleteObjective": return objective !== undefined && this.completeObjective(quest, objective);
      case "CancelObjective": return objective !== undefined && this.cancelObjective(quest, objective);
    }
    this.report?.(`quest function ${fn}`);
    return false;
  }
}

