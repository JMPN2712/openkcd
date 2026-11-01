// Diet mode: a shorter game that leaves out errand and fetch side quests (the list is
// dietConfig.ts), from the research notes' diet-mode spec. It is an overlay on the quest system
// (quests.ts), not a change to the data or to the saved quest state:
//
// - a cut quest never activates or starts, and nothing changes it, whoever asks (dialogue, trees,
//   the bookkeeping quest, the quest-giver hubs);
// - every condition reads it as cancelled: not activated, started, completed or available;
// - so it never reaches the journal, banners, rewards or markers; the hubs' markers for it are
//   hidden too;
// - its offer topics and the sequences that would start it are hidden, and its own trees don't
//   run, so what only they spawn stays unspawned;
// - a cut quest the player started before turning diet mode on keeps running;
// - the setting is read live: turned off, every cut quest reads its true stored state again.

import { DIET, cutQuests, type DietConfig, type DietGrant } from "./dietConfig.ts";
import { SEQ_START, type QuestDb, type QuestMarker, type QuestOverlay, type QuestRecord, type QuestSystem } from "./quests.ts";

// ---- the setting ----

const KEY = "openkcd.diet";
let enabled: boolean | null = null;

/** Whether diet mode is on (the default; saved per browser). */
export function dietEnabled(): boolean {
  if (enabled === null) {
    enabled = true;
    try {
      const v = globalThis.localStorage?.getItem(KEY);
      if (v === "off") enabled = false;
    } catch {
      // private windows and blocked storage
    }
  }
  return enabled;
}

export function setDietEnabled(on: boolean): void {
  enabled = on;
  try {
    globalThis.localStorage?.setItem(KEY, on ? "on" : "off");
  } catch {
    // not saved; the choice still applies until reload
  }
}

// ---- the overlay ----

/** Nothing stored for it, or nothing has happened to it beyond its activation. */
const untouched = (r: QuestRecord | undefined) => !r || (!r.started && !r.completed && !r.failed && Object.values(r.objectives).every((s) => s === 0));

const START_CALL_RE = /QuestSystem\.(?:StartQuest|ActivateQuest|StartObjective)\(\s*['"]([^'"]+)['"]/g;

/** What diet mode needs from the dialogue tables. */
export interface DietDialogue {
  /** the start topic of the branch a topic belongs to */
  owner(topic: number): number;
  sequence(id: number): { script: string } | undefined;
}

export class DietMode implements QuestOverlay {
  /** config names the quest tables don't have (the tests require none) */
  readonly missing: string[] = [];
  private cutSet = new Set<string>();
  /** quest → objectives never started while `when` is cut */
  private rewired = new Map<string, { objectives: Set<string>; when: string }>();
  /** sequence → the cut quest it waits on */
  private rewiredSequences = new Map<number, string>();
  /** offer start topic → the cut quests it belongs to */
  private offerTopics = new Map<number, string[]>();
  /** sequence → cut quests it starts (and no kept quest it changes) */
  private startingSequences = new Map<number, string[]>();
  /** "hub/objective id" → the cut quest the hub objective follows */
  private hubLinks = new Map<string, string>();
  private system: QuestSystem | null = null;
  readonly db: QuestDb;
  readonly config: DietConfig;
  private dialogue?: DietDialogue;
  private on: () => boolean;

  constructor(db: QuestDb, dialogue?: DietDialogue, config: DietConfig = DIET, on: () => boolean = dietEnabled) {
    this.db = db;
    this.dialogue = dialogue;
    this.config = config;
    this.on = on;
    for (const name of [...cutQuests(config), ...config.bookkeeping, ...Object.keys(config.rewire)]) if (!db.canonical(name)) this.missing.push(name);
    for (const name of cutQuests(config)) { const c = db.canonical(name); if (c) this.cutSet.add(c); }
    for (const [q, r] of Object.entries(config.rewire)) {
      const c = db.canonical(q);
      if (!c) continue;
      const when = db.canonical(r.when);
      if (!when) { this.missing.push(r.when); continue; }
      this.rewired.set(c, { objectives: new Set(r.objectives.map((o) => o.toLowerCase())), when });
      for (const o of r.objectives) if (db.objectiveId(c, o) === undefined) this.missing.push(`${q}/${o}`);
      for (const s of r.sequences) this.rewiredSequences.set(s, when);
    }
    for (const q of this.cutSet) for (const t of db.startTopics(q)) this.offerTopics.set(t, [...(this.offerTopics.get(t) ?? []), q]);
    for (const [seq, writes] of db.sequencesWriting()) {
      const starts = writes.filter((w) => w.action === SEQ_START && this.cutSet.has(w.quest)).map((w) => w.quest);
      if (starts.length && writes.every((w) => this.cutSet.has(w.quest))) this.startingSequences.set(seq, [...new Set(starts)]);
    }
    const lower = new Map([...this.cutSet].map((q) => [q.toLowerCase(), q]));
    for (const hub of config.bookkeeping) {
      const h = db.canonical(hub);
      if (!h) continue;
      for (const o of db.objectivesOf(h)) {
        const named = [...lower].find(([l]) => o.name.toLowerCase().startsWith(l) || o.condition.toLowerCase().includes(`'${l}'`));
        if (named) this.hubLinks.set(`${h}/${o.id}`, named[1]);
      }
    }
  }

  /** Make this the system's overlay. */
  attach(system: QuestSystem): this {
    this.system = system;
    system.overlay = this;
    return this;
  }

  get enabled(): boolean {
    return this.on();
  }

  /** In the cut list (whether or not the player had already started it). */
  listed(quest: string): boolean {
    const c = this.db.canonical(quest);
    return !!c && this.cutSet.has(c);
  }

  cut(quest: string, stored: QuestRecord | undefined): boolean {
    return this.on() && this.cutSet.has(quest) && untouched(stored);
  }

  blocks(quest: string, objective: string): boolean {
    const r = this.rewired.get(quest);
    return this.on() && !!r?.objectives.has(objective.toLowerCase()) && this.isCut(r.when);
  }

  private isCut(quest: string): boolean {
    return this.system ? this.system.isCut(quest) : this.cut(quest, undefined);
  }

  /**
   * Whether a dialogue sequence is hidden: it belongs to a cut quest's offer topics, it only starts
   * cut quests (a script call or its quest changes), or a rewire hides it.
   */
  hidesSequence(sequence: number, topic: number): boolean {
    if (!this.on()) return false;
    const waits = this.rewiredSequences.get(sequence);
    if (waits && this.isCut(waits)) return true;
    const owner = this.dialogue?.owner(topic) ?? topic;
    if (this.offerTopics.get(owner)?.some((q) => this.isCut(q))) return true;
    if (this.startingSequences.get(sequence)?.some((q) => this.isCut(q))) return true;
    const script = this.dialogue?.sequence(sequence)?.script;
    if (script) for (const m of script.matchAll(START_CALL_RE)) if (this.listed(m[1]) && this.isCut(this.db.canonical(m[1])!)) return true;
    return false;
  }

  /** Hidden markers: a cut quest's own, and a hub's marker for a giver of a cut quest. */
  hidesMarker(m: QuestMarker): boolean {
    if (!this.on()) return false;
    if (this.isCut(m.quest)) return true;
    const linked = m.objective !== undefined ? this.hubLinks.get(`${m.quest}/${m.objective}`) : undefined;
    return !!linked && this.isCut(linked);
  }

  /** The cut quest a hub objective follows, if any. */
  hubLink(hub: string, objective: number): string | undefined {
    return this.hubLinks.get(`${hub}/${objective}`);
  }

  /** Whether a quest's own behaviour trees run (a cut quest's don't, so nothing only they spawn appears). */
  treeRuns(quest: string): boolean {
    return !this.isCut(quest);
  }

  /** Items stocked in a shop in place of a cut quest's unlock. */
  shopGrants(shop: number): DietGrant[] {
    return this.on() ? this.config.grants.filter((g) => g.shop === shop) : [];
  }
}
