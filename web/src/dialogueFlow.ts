// Conversations over the dialogue data (dialogue.ts), from the research note dialogue.md: which
// branch starts, the greeting, the topic menu in the game's order, timed choices, follow-up topics,
// the return to the menu, "end topic" and the farewell bark.
//
// A Conversation is a state machine the caller drives: each step is a sequence to play, a menu to
// show, the price panel (a placeholder for now) or a farewell line to bark. The caller plays the
// sequence (dialoguePlayer.ts) and calls `played()`, or shows the menu and calls `choose(i)`.
// Sequence availability, local variables (per pair of participants) and the random generator live
// in a DialogueState shared by all conversations of a game.

import { LINE_RESPONSE, type DialogueDb, type DialogueLine, type Sequence } from "./dialogue.ts";
import { ConditionFails, holds, type CondValue } from "./dialogueCondition.ts";

/** Someone in a conversation. */
export interface Participant {
  /** soul uuid (rpg/soul) */
  soul: string;
  /** soul name (rat_tailor; Henry's is "dude") */
  name: string;
  /** soul2role */
  roles: Set<number>;
  /** what the soul holds now: soul2metarole plus what behaviours have granted (MERCHANT while a shop is open) */
  metaroles: Set<number>;
  player: boolean;
}

/** One sequence of one topic that the conversation can play next. */
export interface Candidate {
  topic: number;
  sequence: Sequence;
  npcEntryCondition: string;
  /** of the branch it came from (0 for follow-up topics) */
  branchType: number;
  branchPriority: number;
  topicPriority: number;
  /** the topic's owning start topic */
  owner: number;
  /** it came from a topic a behaviour tree asked for */
  requested: boolean;
}

export interface MenuOption {
  /** what choose() takes */
  index: number;
  /** localisation key of the label ("ui_back_prompt" for a Back choice) */
  label: string;
  /** sequence type (icons: 1 Strength, 2 Speech, 3 Charisma, 4 Bribe, …) and skill-check difficulty */
  type: number;
  difficulty?: number;
  /** no real choice left under it (the `group` marker) */
  exhausted: boolean;
  candidate?: Candidate;
}

export type Step =
  /** play a sequence; `cast` maps its roles to participant indices */
  | { kind: "play"; candidate: Candidate; cast: Map<number, number>; greeting: boolean }
  /** show the player menu; options end with "end topic" when `endTopic`; `timeLimit` seconds (0: none) */
  | { kind: "menu"; options: MenuOption[]; endTopic: boolean; timeLimit: number }
  /** the price input panel after a flag-2 sequence (haggling, bribes): not built yet; call played() */
  | { kind: "haggle"; prices: Record<string, CondValue> }
  /** the farewell: one line barked by a participant, then the conversation is over */
  | { kind: "bark"; sequence: Sequence; line: DialogueLine; participant: number }
  | { kind: "end"; reason: string };

/** The eight globals the price panel reads; without any of them no panel opens. */
export const SHOP_GLOBALS = ["shop_min", "shop_max", "shop_keeper_price", "shop_your_price", "shop_progress", "shop_original_price", "shop_title_idx", "shop_haggle_step"];

/** What a conversation reads from and does to the game. */
export interface FlowHost {
  /** play time in seconds, not world time (sequence timeouts; dialogue.md) */
  now(): number;
  /**
   * A condition function on a participant (or, for a name nobody in the conversation has, on
   * `named`, the world entity of that name). Undefined: unknown (counts as 0, reported).
   */
  call(name: string, args: CondValue[], who: Participant | null, named?: string): CondValue | undefined;
  /**
   * Run a sequence's script with the dialogue's variable context and `dc` (role name → soul
   * name); it reads and writes the state's variables. Returns the price panel's globals when the
   * script left all eight set, and the metaroles it granted (true) or took (false) per soul name.
   */
  runScript?(script: string, varContext: string, dc: Record<string, string>, state: DialogueState): { prices: Record<string, CondValue> | null; metaroles?: Record<string, Record<string, boolean>> };
  report?(what: string): void;
}

/** Per game: sequence use, dialogue variables and the random generator. */
export class DialogueState {
  /** sequence id → game time of its last use */
  readonly used = new Map<number, number>();
  /** local variables per variable context (a pair of participants), and globals */
  readonly locals = new Map<string, Map<string, CondValue>>();
  readonly globals = new Map<string, CondValue>();
  seed = 1;

  /** The classic linear congruential generator the note gives: a pick in 0 … n−1. */
  random(n: number): number {
    this.seed = (Math.imul(this.seed, 214013) + 2531011) >>> 0;
    return (this.seed >>> 16) % Math.max(1, n);
  }

  /** Never used, or its cooldown (timeout ≥ 0) has passed since its last use; -1 is once only. */
  available(seq: Sequence, now: number): boolean {
    const t = this.used.get(seq.id);
    return t === undefined || (seq.timeout >= 0 && now - t >= seq.timeout);
  }

  local(context: string): Map<string, CondValue> {
    let m = this.locals.get(context);
    if (!m) { m = new Map(); this.locals.set(context, m); }
    return m;
  }
}

/** Branch types collected for a normal start or the return to the menu. */
const NORMAL = new Set([0, 1, 5, 7]);
/** for "does this NPC have something to say?" (refusals don't count) */
const SOMETHING = new Set([0, 1, 5]);
const GREETING = new Set([2]);
const FAREWELL = new Set([3]);
const npcOnlyType = (t: number) => t === 5 || t === 6;

/** Sequence flags (dialogue.md, "Flags"). */
export const FLAG_ENDS = 1, FLAG_PRICE_PANEL = 2, FLAG_DEAD_END = 4, FLAG_ENDS_ENDING = 8;
/** The "Back" choice's sequence type. */
export const TYPE_BACK = 7;

const deadEnd = (s: Sequence) => (s.flags & (FLAG_ENDS | FLAG_DEAD_END | FLAG_ENDS_ENDING)) !== 0 || s.type === TYPE_BACK;

export interface ConversationOptions {
  /** a topic a behaviour tree asked for (0: the normal start) */
  topic?: number;
  greeting?: boolean;
  farewell?: boolean;
  /** a participant is the player (default: whether one is) */
  interactive?: boolean;
  /** the dialog number scripts can set (part of the variable context's name) */
  dialogNumber?: number;
}

export class Conversation {
  readonly participants: Participant[];
  private db: DialogueDb;
  private state: DialogueState;
  private host: FlowHost;
  private requestedTopic: number;
  readonly interactive: boolean;
  private greeting: boolean;
  private farewell: boolean;
  npcOnly = false;
  /** context bits the note names: 0x10 the player chose "end topic", 0x20000 set by a flag-8 sequence */
  contextFlags = 0x10000;
  private stack: number[] = [];
  private startList: Candidate[] = [];
  private menuList: Candidate[] = [];
  private endTopicShown = false;
  private timeLimit = 0;
  private last: Sequence | null = null;
  private lastPrices: Record<string, CondValue> | null = null;
  private haggled = false;
  readonly varContext: string;
  /** the step returned last */
  step: Step | null = null;

  constructor(db: DialogueDb, state: DialogueState, participants: Participant[], host: FlowHost, o: ConversationOptions = {}) {
    this.db = db;
    this.state = state;
    this.participants = participants;
    this.host = host;
    this.requestedTopic = o.topic ?? 0;
    this.interactive = o.interactive ?? participants.some((p) => p.player);
    this.greeting = o.greeting ?? true;
    this.farewell = o.farewell ?? true;
    // named after participants 0 and 1 and the dialog number: locals persist per pair
    this.varContext = [participants[0]?.name ?? "", participants[1]?.name ?? "", o.dialogNumber ?? 0].join("|");
  }

  get done(): boolean {
    return this.step?.kind === "end" || this.step?.kind === "bark";
  }

  // ---- conditions ----

  private holds(src: string, empty: boolean): boolean {
    const locals = this.state.local(this.varContext);
    return holds(src, {
      named: (name) => this.db.functions.get(name),
      report: this.host.report,
      call: (name, args, actor) => {
        let who: Participant | null = null, named: string | undefined;
        if (typeof actor === "number") {
          who = this.participants[actor] ?? null;
          if (!who) throw new ConditionFails(`no participant ${actor}`);
        } else {
          who = this.participants.find((p) => p.name.toLowerCase() === actor.toLowerCase()) ?? null;
          if (!who) named = actor;
        }
        switch (name) {
          case "IsActor": return who ? (who.name.toLowerCase() === String(args[0]).toLowerCase() ? 1 : 0) : 0;
          case "var": return locals.get(String(args[0])) ?? 0;
          case "gvar": return this.state.globals.get(String(args[0])) ?? 0;
          case "IsSeqAvailable": {
            const s = this.db.sequence(Number(args[0]));
            return s && this.state.available(s, this.host.now()) ? 1 : 0;
          }
        }
        const v = this.host.call(name, args, who, named);
        if (v === undefined && named) throw new ConditionFails(`nobody named ${named}`);
        return v;
      },
    }, empty);
  }

  // ---- roles ----

  /**
   * Match a topic's role pairs (its owning start topic's) to the participants: each participant,
   * in order, takes the first unmatched pair it fits (has the role and holds the metarole); every
   * pair must be taken. Strict: as many pairs as participants. Two pairs of one role also try the
   * participants in reverse. Returns role → participant index, or null.
   */
  matchRoles(topic: number, strict = false): Map<number, number> | null {
    const pairs = this.db.rolePairs(this.db.owner(topic));
    if (strict && pairs.length !== this.participants.length) return null;
    const attempt = (order: number[]) => {
      const taken = new Map<number, number>(); // pair index → participant
      for (const pi of order) {
        const p = this.participants[pi];
        const k = pairs.findIndex((pair, i) => !taken.has(i) && p.roles.has(pair.role) && p.metaroles.has(pair.metarole));
        if (k >= 0) taken.set(k, pi);
      }
      if (taken.size !== pairs.length) return null;
      const out = new Map<number, number>();
      for (const [k, pi] of taken) out.set(pairs[k].role, pi);
      return out;
    };
    const order = this.participants.map((_, i) => i);
    return attempt(order) ?? (pairs.length === 2 && pairs[0].role === pairs[1].role ? attempt([...order].reverse()) : null);
  }

  // ---- collecting ----

  /**
   * One topic's candidates, in table order: available, and their entry condition true (at entry
   * points an empty condition is skipped). The topic's time limit becomes the dialog's.
   */
  private collect(topic: number, entry: boolean, branchType = 0, branchPriority = 0, requested = false): Candidate[] {
    const info = this.db.topic(topic);
    this.timeLimit = info.timeLimit;
    const out: Candidate[] = [];
    const now = this.host.now();
    for (const e of this.db.topicSequences(topic)) {
      const sequence = this.db.sequence(e.sequence);
      if (!sequence || !this.state.available(sequence, now)) continue;
      if (entry && !e.entryCondition.trim()) continue;
      if (!this.holds(e.entryCondition, true)) continue;
      out.push({ topic, sequence, npcEntryCondition: e.npcEntryCondition, branchType, branchPriority, topicPriority: info.priority, owner: this.db.owner(topic), requested });
    }
    return out;
  }

  /**
   * Every branch of these types whose start topic's roles fit, collected as an entry point.
   * ASSUMPTIONs (the note gives strict mode without saying where it applies): normal starts match
   * strictly, one role pair per participant, so Henry's one-role monologue topics stay out of a
   * talk with the tailor (the note's walkthrough counts only two-role branches); greetings and
   * farewells match loosely, as their "prefer exact role counts" step implies. Test branches
   * (is_test) are left out, as the walkthrough does.
   */
  private collectStarts(types: Set<number>, strict = true): Candidate[] {
    const out: Candidate[] = [];
    for (const b of this.db.branches) {
      if (b.test || !types.has(b.type)) continue;
      if (!this.matchRoles(b.startTopic, strict)) continue;
      out.push(...this.collect(b.startTopic, true, b.type, b.priority));
    }
    return out;
  }

  /** Narrowing (note, "Narrowing the start list"); `refusals` applies step 1 too. */
  private narrow(list: Candidate[], refusals: boolean): Candidate[] {
    let l = list;
    if (refusals) {
      const ref = l.filter((c) => c.branchType === 7);
      if (ref.length) l = ref.length === l.length ? [] : ref;
    }
    if (!l.length) return l;
    const top = Math.max(...l.map((c) => c.branchPriority));
    l = l.filter((c) => c.branchPriority === top);
    if (l.some((c) => !npcOnlyType(c.branchType))) l = l.filter((c) => !npcOnlyType(c.branchType));
    if (top > 0 && l.length > 1) l = [l[this.state.random(l.length)]];
    return l;
  }

  /** Whether the NPC has something to say (types 0, 1, 5; refusals not counted). */
  hasSomethingToSay(): boolean {
    return this.collectStarts(SOMETHING).length > 0;
  }

  // ---- flow ----

  /** Begin the conversation. */
  start(): Step {
    const greetingWasPending = this.greeting;
    let list: Candidate[];
    if (this.requestedTopic) {
      if (!this.matchRoles(this.requestedTopic)) return this.end("the requested topic's roles don't fit");
      const b = this.db.branch(this.requestedTopic);
      if (b && npcOnlyType(b.type)) this.npcOnly = true;
      if (b && !b.allowGreeting) this.greeting = false;
      list = this.collect(this.requestedTopic, true, b?.type ?? 0, b?.priority ?? 0, true);
    } else {
      list = this.narrow(this.collectStarts(NORMAL), true);
      const branchOf = (c: Candidate) => this.db.branch(c.owner);
      if (this.greeting && list.some((c) => branchOf(c)?.allowGreeting === false)) this.greeting = false;
      if (list[0] && npcOnlyType(list[0].branchType)) { this.npcOnly = true; this.greeting = this.farewell = false; }
      if (this.greeting && list[0] && list[0].branchPriority !== 0) this.greeting = this.farewell = false;
    }
    if (this.npcOnly) this.greeting = this.farewell = false;
    if (!list.length) return greetingWasPending ? this.end("nothing to say") : this.toFarewell();
    this.startList = list;
    return this.greeting ? this.greet() : this.choice(list);
  }

  /** The greeting: one type-2 branch at random, preferring exact role counts. */
  private greet(): Step {
    let list = this.narrow(this.collectStarts(GREETING, false), false);
    if (!list.length) { this.greeting = false; return this.choice(this.startList); }
    const exact = list.filter((c) => this.db.rolePairs(c.owner).length === this.participants.length);
    if (exact.length) list = exact;
    return this.play(list[this.state.random(list.length)], true);
  }

  /** Pick from a candidate list: auto-play a lone one, let the NPC pick, or show the menu. */
  private choice(list: Candidate[]): Step {
    if (!list.length) return this.toFarewell();
    if (list.length === 1) {
      const c = list[0];
      const atStart = this.db.owner(c.topic) === c.topic;
      if (!(atStart && this.stack.length === 0 && c.branchPriority === 0 && !c.requested)) return this.play(c);
    }
    if (!this.interactive || this.npcOnly) return this.npcPick(list);
    // the speaker role shared by the candidates' topics (leading zeros skipped)
    const roles = list.map((c) => this.db.topic(c.topic).role);
    const first = roles.findIndex((r) => r !== 0);
    const shared = first >= 0 && roles.slice(first).every((r) => r === roles[first]) ? roles[first] : 0;
    if (shared) {
      const holders = list.map((c) => {
        const m = this.db.owner(c.topic) === c.topic ? this.matchRoles(c.owner) : this.cast;
        return m?.get(shared);
      });
      if (holders.every((h) => h !== undefined && !this.participants[h].player)) return this.npcPick(list);
    }
    return this.menu(list);
  }

  private npcPick(list: Candidate[]): Step {
    const ok = list.filter((c) => !c.npcEntryCondition.trim() || this.holds(c.npcEntryCondition, true));
    if (!ok.length) return this.toFarewell();
    return this.play(ok[this.state.random(ok.length)]);
  }

  /** The menu: the game's stable merge sort, labels, markers, and "end topic" at the top level. */
  private menu(list: Candidate[]): Step {
    const sorted = menuOrder(list);
    this.menuList = sorted;
    const options: MenuOption[] = sorted.map((c, index) => ({
      index,
      label: c.sequence.type === TYPE_BACK ? "ui_back_prompt" : c.sequence.uiPrompt,
      type: c.sequence.type,
      difficulty: c.sequence.difficulty,
      exhausted: this.exhaustedMarker(c.sequence),
      candidate: c,
    }));
    this.endTopicShown = this.db.owner(sorted[0].topic) === sorted[0].topic && !this.requestedTopic && this.stack.length === 0;
    if (this.endTopicShown) options.push({ index: sorted.length, label: "ui_end_topic", type: 0, exhausted: false });
    return (this.step = { kind: "menu", options, endTopic: this.endTopicShown, timeLimit: this.timeLimit > 0 ? this.timeLimit : 0 });
  }

  /** The player's choice from the last menu (its option index). */
  choose(index: number): Step {
    if (this.step?.kind !== "menu") return this.step ?? this.end("no menu");
    if (this.endTopicShown && index === this.menuList.length) {
      this.contextFlags |= 0x10;
      return this.toFarewell();
    }
    const c = this.menuList[index];
    return c ? this.play(c) : this.step;
  }

  /** role → participant index for the playing sequence */
  cast: Map<number, number> = new Map();

  private play(c: Candidate, greeting = false): Step {
    const seq = c.sequence;
    this.state.used.set(seq.id, this.host.now());
    this.stack.push(seq.next);
    if (seq.flags & FLAG_ENDS_ENDING) this.contextFlags |= 0x20000;
    this.cast = this.matchRoles(c.owner) ?? this.cast;
    this.last = seq;
    this.haggled = false;
    this.lastPrices = null;
    if (seq.script.trim() && this.host.runScript) {
      const dc: Record<string, string> = {};
      for (const [role, pi] of this.cast) { const r = this.db.role(role); if (r) dc[r.name] = this.participants[pi].name; }
      const r = this.host.runScript(seq.script, this.varContext, dc, this.state);
      this.lastPrices = r.prices;
      for (const [name, changes] of Object.entries(r.metaroles ?? {})) {
        const p = this.participants.find((x) => x.name === name);
        if (!p) continue;
        for (const [m, on] of Object.entries(changes)) {
          const id = this.db.metaroleId(m);
          if (id !== undefined) { if (on) p.metaroles.add(id); else p.metaroles.delete(id); }
        }
      }
    }
    return (this.step = { kind: "play", candidate: c, cast: this.cast, greeting });
  }

  /** The sequence returned by the last step has played (or the price panel was closed). */
  played(): Step {
    const last = this.last;
    // the price panel after a flag-2 sequence, in interactive dialogs, when its globals are set
    if (last && (last.flags & FLAG_PRICE_PANEL) && this.interactive && this.lastPrices && !this.haggled) {
      this.haggled = true;
      return (this.step = { kind: "haggle", prices: this.lastPrices });
    }
    for (;;) {
      const t = this.stack.pop() ?? 0;
      if (t !== 0) {
        if (this.greeting) {
          // the greeting chain: one random available sequence per topic
          const l = this.collect(t, false);
          if (!l.length) continue;
          return this.play(l[this.state.random(l.length)], true);
        }
        return this.choice(this.collect(t, false));
      }
      if (this.greeting) {
        this.greeting = false;
        return this.choice(this.startList);
      }
      if (this.stack.length) continue; // ASSUMPTION: resume from the stack (the note leaves this untraced)
      const ended = last ? (last.flags & (FLAG_ENDS | FLAG_ENDS_ENDING)) !== 0 : true;
      if (this.interactive && !ended) return this.choice(this.narrow(this.collectStarts(NORMAL), true));
      return this.toFarewell();
    }
  }

  /** The farewell: one type-3 branch, followed until a sequence with a spoken line, barked. */
  private toFarewell(): Step {
    if (!this.farewell) return this.end("over");
    let list = this.narrow(this.collectStarts(FAREWELL, false), false);
    if (!list.length) return this.end("over (no farewell)");
    const exact = list.filter((c) => this.db.rolePairs(c.owner).length === this.participants.length);
    if (exact.length) list = exact;
    const c = list[this.state.random(list.length)];
    const cast = this.matchRoles(c.owner) ?? new Map<number, number>();
    let seq: Sequence | undefined = c.sequence;
    const seen = new Set<number>();
    while (seq && !seen.has(seq.id)) {
      seen.add(seq.id);
      this.state.used.set(seq.id, this.host.now());
      const line = seq.lines.find((l) => l.type === LINE_RESPONSE && l.role !== undefined);
      if (line) {
        const who = cast.get(line.role!) ?? this.participants.findIndex((p) => p.roles.has(line.role!));
        return (this.step = { kind: "bark", sequence: seq, line, participant: Math.max(0, who) });
      }
      if (!seq.next) break;
      const l = this.collect(seq.next, false);
      seq = l.length ? l[this.state.random(l.length)].sequence : undefined;
    }
    return this.end("over (farewell without a line)");
  }

  private end(reason: string): Step {
    return (this.step = { kind: "end", reason });
  }

  // ---- the exhausted marker ----

  private exhaustedMarker(s: Sequence): boolean {
    return !deadEnd(s) && s.group !== 0 ? this.exhausted(s.next, new Set()) : s.group !== 0;
  }

  /** No real choice left under topic `t` (visited topics count as exhausted; 0 is). */
  private exhausted(t: number, seen: Set<number>): boolean {
    if (t === 0 || seen.has(t)) return true;
    seen.add(t);
    for (const e of this.db.topicSequences(t)) {
      const s = this.db.sequence(e.sequence);
      if (!s || s.type === TYPE_BACK) continue;
      if (s.group === 0) { if (this.holds(e.entryCondition, true)) return false; }
      else if (!deadEnd(s) && !this.exhausted(s.next, seen)) return false;
    }
    return true;
  }
}

/**
 * The menu's order: a stable merge sort in which B (right run) goes before A (left run) when B's
 * topic priority is lower, or B's topic id + sequence priority is lower (a plain "or", as the note
 * gives it: within one topic it is sequence priority ascending).
 */
export function menuOrder(list: Candidate[]): Candidate[] {
  const before = (b: Candidate, a: Candidate) => b.topicPriority < a.topicPriority || b.topic + b.sequence.priority < a.topic + a.sequence.priority;
  const sort = (l: Candidate[]): Candidate[] => {
    if (l.length < 2) return l;
    const mid = l.length >> 1;
    const a = sort(l.slice(0, mid)), b = sort(l.slice(mid));
    const out: Candidate[] = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) out.push(before(b[j], a[i]) ? b[j++] : a[i++]);
    return out.concat(a.slice(i), b.slice(j));
  };
  return sort(list);
}

/**
 * A participant from the tables: its soul's roles and starting metaroles, plus metaroles behaviours
 * and scripts have granted (true) or taken (false), by name.
 */
export function participant(db: DialogueDb, soul: { id: string; name: string }, player: boolean, changes: Record<string, boolean> = {}): Participant {
  const metaroles = new Set(db.metarolesOf(soul.id));
  for (const [name, on] of Object.entries(changes)) {
    const id = db.metaroleId(name);
    if (id === undefined) continue;
    if (on) metaroles.add(id);
    else metaroles.delete(id);
  }
  return { soul: soul.id, name: soul.name, roles: new Set(db.rolesOf(soul.id)), metaroles, player };
}

/**
 * Condition functions for a world without quests, relationships, stats or items yet: quests are
 * not started, nobody is angry, tags and perks are absent, the hour is the game clock's.
 * ASSUMPTION: relationships read RELATIONSHIP (0.5, the middle reputation band) until the RPG
 * layer exists; at 0.5 nobody refuses to talk (the refusal needs < 0.1).
 */
export const RELATIONSHIP = 0.5;
export function neutralWorld(hour: () => number): FlowHost["call"] {
  return (name) => {
    switch (name) {
      case "HourOfDay": return Math.floor(hour());
      case "GetTrueRelationship": case "GetPerceivedRelationship": return RELATIONSHIP;
      case "IsQuestStarted": case "IsQuestCompleted": case "IsQuestCanceled": case "IsQuestFailed": case "IsQuestAvailable":
      case "IsObjectiveStarted": case "IsObjectiveCompleted": case "IsObjectiveCanceled": case "IsObjectiveFailed": case "IsObjectiveUnchanged":
      case "HasSoulTag": case "HasBehaviorTag": case "HasPerk": case "HasAbility": case "IsRaining": case "IsActorInside":
      case "GetActorAngriness": case "GetActorMoney": case "CountOfActorItems": case "GetBloodiness": case "GetDirtiness": case "GetArmorRating":
      case "GetPlayerRelativeCharisma": case "GetFactionReputation":
        return 0;
    }
    return undefined;
  };
}

/** Value of a Lua result as a condition value (booleans as 1 / 0). */
const condValue = (v: unknown): CondValue => (typeof v === "number" || typeof v === "string" ? v : v === true ? 1 : 0);

/**
 * Sequence scripts in the game's Lua (luaHost.ts): `entityOf` gives a participant's entity (its
 * soul keeps the metaroles scripts change). The dialogue's locals and globals go through Lua's
 * Variables and come back into the state.
 */
export function luaScripts(lua: { runDialogue(code: string, ctx: string, dc: Record<string, { id: number; name: string }>, locals: Record<string, unknown>, globals: Record<string, unknown>): { locals: Record<string, unknown>; globals: Record<string, unknown>; shop: Record<string, unknown> | null; meta: Record<string, Record<string, boolean>> } }, entityOf: (soulName: string) => number | undefined): NonNullable<FlowHost["runScript"]> {
  return (script, ctx, dc, state) => {
    const ents: Record<string, { id: number; name: string }> = {};
    const names = new Map<number, string>();
    for (const [role, name] of Object.entries(dc)) {
      const id = entityOf(name);
      if (id === undefined) continue;
      ents[role] = { id, name };
      names.set(id, name);
    }
    const locals = state.local(ctx);
    const r = lua.runDialogue(script, ctx, ents, Object.fromEntries(locals), Object.fromEntries(state.globals));
    locals.clear();
    for (const [k, v] of Object.entries(r.locals ?? {})) locals.set(k, condValue(v));
    state.globals.clear();
    for (const [k, v] of Object.entries(r.globals ?? {})) state.globals.set(k, condValue(v));
    const metaroles: Record<string, Record<string, boolean>> = {};
    for (const [id, changes] of Object.entries(r.meta ?? {})) { const n = names.get(Number(id)); if (n) metaroles[n] = changes; }
    const prices = r.shop ? Object.fromEntries(Object.entries(r.shop).map(([k, v]) => [k, condValue(v)])) : null;
    return { prices, metaroles };
  };
}
