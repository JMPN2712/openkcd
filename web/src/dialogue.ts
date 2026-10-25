// The game's dialogue data (Libs/Tables/text/*.xml) as a graph of sequences, read as the tables
// give it; docs/GAMELOGIC.md has the table map.
//
//   topic ─topic2sequence (entry conditions)→ sequence ─sequence_line (order_by)→ lines
//
// A line is one of:
//   - a response (`response`): a role says a localisation key (text_ui_dialog), recorded per voice
//     in `v_response_wave_file_recorded` as Dialog/<path, six digits>/<wave_file>.ogg, where every
//     wave_file is the voice's abbreviation (`v_voice_abbreviation`), "_" and the key;
//   - a command (`v_dialogue_commands`): who, target, a type and its parameters, e.g. type 1 sets a
//     mood (int_param = dialogue_mood id), type 3 plays an animation fragment (char_param ADLG_*);
//   - other kinds (sequence_line_type 2 and 4) have no table of their own.
//
// The cast comes from the souls: soul → roles (`soul2role`), soul → voice
// (`v_soul_character_data`), soul → starting metaroles (`soul2metarole`). Conversations start at
// branches (`v_branch`: a start topic, a type and a priority); a sequence's `next` is the topic
// that follows. dialogueFlow.ts runs conversations over this data; this module only reads it.

import { groupBy, readTable, type Row } from "./tables.ts";
import type { Vfs } from "./vfs.ts";

/** sequence_line_type values backed by a table */
export const LINE_RESPONSE = 1;
export const LINE_COMMAND = 5;

/** dialogue_command_type values whose meaning the tables show (see the header) */
export const COMMAND_MOOD = 1;
export const COMMAND_FRAGMENT = 3;

/** The role id the player (Henry) speaks as (role table: HENRY, metarole PLAYER). */
export const ROLE_HENRY = 3;

export interface DialogueCommand {
  type: number;
  /** role ids (0: none) */
  who: number;
  target: number;
  int?: number;
  char: string;
  /** seconds, when given */
  delay?: number;
}

export interface DialogueLine {
  id: number;
  order: number;
  /** sequence_line_type */
  type: number;
  /** response: the speaking role, the text key (text_ui_dialog), camera mode and volume */
  role?: number;
  text?: string;
  camera?: number;
  volume?: number;
  /** response: the voices it is recorded in, and their folder (Dialog/<six digits>/) */
  voices?: number[];
  folder?: number;
  command?: DialogueCommand;
}

export interface Sequence {
  id: number;
  /** the topic that follows (0: none) */
  next: number;
  /** non-zero on 29 rows: the menu's "exhausted" marker */
  group: number;
  /** rpg/skill_check_difficulty id (0 AutoSuccess … 6 AutoFail), when set */
  difficulty?: number;
  type: number;
  flags: number;
  priority: number;
  /** seconds (0: none, -1 as given) */
  timeout: number;
  speechCoef: number;
  script: string;
  uiPrompt: string;
  lines: DialogueLine[];
}

export interface TopicEntry {
  sequence: number;
  /** expressions in the dialogue condition language ("var('3') AND var('4')"); not evaluated here */
  entryCondition: string;
  npcEntryCondition: string;
}

export interface Role {
  id: number;
  name: string;
  metarole: number;
}

/** A conversation entry point (v_branch). */
export interface Branch {
  startTopic: number;
  /** 0 normal, 1 rare, 2 greeting, 3 farewell, 4 reaction, 5 NPC↔NPC, 6 bark, 7 refusal */
  type: number;
  /** 0: offered on the menu; 1–3: the NPC starts it by itself */
  priority: number;
  allowGreeting: boolean;
  test: boolean;
  reputation?: number;
}

export interface Topic {
  id: number;
  /** menu order across topics (mostly 7) */
  priority: number;
  /** the speaking role (0: none) */
  role: number;
  /** alias behaviour trees request it by */
  label: string;
  /** seconds for a timed choice (0: none) */
  timeLimit: number;
}

/** A role a topic needs, under the metarole its holder must have. */
export interface RolePair {
  metarole: number;
  role: number;
}

const TABLES = {
  sequence: "text/sequence",
  line: "text/sequence_line",
  response: "text/response",
  command: "text/v_dialogue_commands",
  wave: "text/v_response_wave_file_recorded",
  topic2sequence: "text/topic2sequence",
  topicToRole: "text/topictorole",
  role: "rpg/role",
  soulRole: "rpg/soul2role",
  soulCharacter: "rpg/v_soul_character_data",
  mood: "text/dialogue_mood",
  voiceAbbreviation: "text/v_voice_abbreviation",
  branch: "text/v_branch",
  topic: "text/topic",
  functions: "text/dialogue_functions",
  soulMetarole: "rpg/soul2metarole",
  metarole: "rpg/metarole",
};

const int = (s: string | undefined) => (s ? Number(s) : 0);
const optNum = (s: string | undefined) => (s ? Number(s) : undefined);

export class DialogueDb {
  private sequences = new Map<number, Sequence>();
  private topics = new Map<number, TopicEntry[]>();
  private topicRoles = new Map<number, number[]>();
  private topicPairs = new Map<number, RolePair[]>();
  private topicInfo = new Map<number, Topic>();
  private owners = new Map<number, number>();
  private soulMetaroles = new Map<string, number[]>();
  private metaroleIds = new Map<string, number>();
  private metaroleNames = new Map<number, string>();
  /** every branch, in table order */
  readonly branches: Branch[] = [];
  /** branches by start topic */
  private branchAt = new Map<number, Branch>();
  /** named conditions (dialogue_functions): name → expression */
  readonly functions = new Map<string, string>();
  private roles = new Map<number, Role>();
  private soulRoles = new Map<string, number[]>();
  private soulVoices = new Map<string, number>();
  private soulNames = new Map<string, string>();
  private moods = new Map<number, string>();
  private abbreviations = new Map<number, string>();
  /** the voice Henry's lines are recorded in (the most common among them) */
  playerVoice: number | undefined;

  private constructor() {}

  /** Read the dialogue tables (about 100 MB of XML). */
  static async load(vfs: Vfs): Promise<DialogueDb> {
    const db = new DialogueDb();
    const read = (k: keyof typeof TABLES) => readTable(vfs, TABLES[k]);
    const [seqs, lines, responses, commands, waves, t2s, t2r, roles, soulRoles, soulChars, moods, abbrs, branches, topics, functions, soulMetaroles, metaroles] = await Promise.all([
      read("sequence"), read("line"), read("response"), read("command"), read("wave"),
      read("topic2sequence"), read("topicToRole"), read("role"), read("soulRole"), read("soulCharacter"), read("mood"), read("voiceAbbreviation"),
      read("branch"), read("topic"), read("functions"), read("soulMetarole"), read("metarole"),
    ]);
    for (const r of seqs) {
      const id = int(r.sequence_id);
      db.sequences.set(id, {
        id, next: int(r.next), group: int(r.group), difficulty: optNum(r.skill_check_difficulty_id), type: int(r.type), flags: int(r.flags), priority: int(r.priority), timeout: int(r.timeout),
        speechCoef: r.speech_coef ? Number(r.speech_coef) : 1, script: r.script ?? "", uiPrompt: r.ui_prompt ?? "", lines: [],
      });
    }
    const byLine = (rows: Row[]) => groupBy(rows, "sequence_line_id");
    const resp = byLine(responses), cmds = byLine(commands), recs = byLine(waves);
    for (const l of lines) {
      const seq = db.sequences.get(int(l.sequence_id));
      if (!seq) continue;
      const line: DialogueLine = { id: int(l.sequence_line_id), order: int(l.order_by), type: int(l.sequence_line_type) };
      const r = resp.get(l.sequence_line_id)?.[0];
      if (r) {
        line.role = int(r.role_id);
        line.text = r.string_name;
        line.camera = int(r.camera_mode);
        line.volume = int(r.response_volume_id);
        const w = recs.get(l.sequence_line_id);
        if (w) {
          line.voices = w.map((x) => int(x.voice_id));
          line.folder = int(w[0].path);
        }
      }
      const c = cmds.get(l.sequence_line_id)?.[0];
      if (c) line.command = { type: int(c.dialogue_command_type), who: int(c.who), target: int(c.target), int: optNum(c.int_param), char: c.char_param ?? "", delay: optNum(c.delay) };
      seq.lines.push(line);
    }
    const henry = new Map<number, number>();
    for (const s of db.sequences.values()) {
      s.lines.sort((a, b) => a.order - b.order);
      for (const l of s.lines) if (l.role === ROLE_HENRY && l.voices) for (const v of l.voices) henry.set(v, (henry.get(v) ?? 0) + 1);
    }
    db.playerVoice = [...henry].sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const r of t2s) {
      const t = int(r.topic_id);
      const list = db.topics.get(t) ?? [];
      list.push({ sequence: int(r.sequence_id), entryCondition: r.entry_condition ?? "", npcEntryCondition: r.npc_entry_condition ?? "" });
      db.topics.set(t, list);
    }
    for (const r of t2r) {
      const t = int(r.topic_id);
      const list = db.topicRoles.get(t) ?? [];
      list.push(int(r.role_id));
      db.topicRoles.set(t, list);
      const pairs = db.topicPairs.get(t) ?? [];
      pairs.push({ metarole: int(r.metarole_id), role: int(r.role_id) });
      db.topicPairs.set(t, pairs);
    }
    for (const r of topics) db.topicInfo.set(int(r.topic_id), { id: int(r.topic_id), priority: int(r.priority), role: int(r.role_id), label: r.label ?? "", timeLimit: r.time_limit ? Number(r.time_limit) : 0 });
    for (const r of branches) {
      const b: Branch = { startTopic: int(r.start_topic), type: int(r.branch_type_id), priority: int(r.priority), allowGreeting: r.allow_greeting !== "False", test: r.is_test === "True", reputation: optNum(r.reputation_condition_id) };
      db.branches.push(b);
      if (!db.branchAt.has(b.startTopic)) db.branchAt.set(b.startTopic, b);
    }
    for (const r of functions) db.functions.set(r.function_name, r.expression ?? "");
    for (const r of soulMetaroles) {
      const list = db.soulMetaroles.get(r.soul_id) ?? [];
      list.push(int(r.metarole_id));
      db.soulMetaroles.set(r.soul_id, list);
    }
    for (const r of metaroles) { db.metaroleIds.set(r.metarole_name, int(r.metarole_id)); db.metaroleNames.set(int(r.metarole_id), r.metarole_name); }
    // each topic's owning start topic: walk every branch from its start topic along its sequences'
    // `next` topics; the first branch to reach a topic owns it (the research note leaves the
    // engine's walk untraced and suggests this)
    for (const b of db.branches) {
      const queue = [b.startTopic];
      while (queue.length) {
        const t = queue.shift()!;
        if (db.owners.has(t)) continue;
        db.owners.set(t, b.startTopic);
        for (const e of db.topics.get(t) ?? []) {
          const n = db.sequences.get(e.sequence)?.next;
          if (n && !db.owners.has(n)) queue.push(n);
        }
      }
    }
    for (const r of roles) db.roles.set(int(r.role_id), { id: int(r.role_id), name: r.role_name, metarole: int(r.metarole_id) });
    for (const r of soulRoles) {
      const list = db.soulRoles.get(r.soul_id) ?? [];
      list.push(int(r.role_id));
      db.soulRoles.set(r.soul_id, list);
    }
    for (const r of soulChars) {
      if (r.voice_id) db.soulVoices.set(r.soul_id, int(r.voice_id));
      if (r.name_string_id) db.soulNames.set(r.soul_id, r.name_string_id);
    }
    for (const r of moods) db.moods.set(int(r.dialogue_mood_id), r.dialogue_mood_name);
    for (const r of abbrs) db.abbreviations.set(int(r.voice_id), r.abbreviation);
    return db;
  }

  get sequenceCount(): number {
    return this.sequences.size;
  }

  sequence(id: number): Sequence | undefined {
    return this.sequences.get(id);
  }

  /** The sequences a topic may play, with their (unevaluated) entry conditions, in table order. */
  topicSequences(topic: number): TopicEntry[] {
    return this.topics.get(topic) ?? [];
  }

  /** The roles taking part in a topic (topictorole). */
  topicCast(topic: number): number[] {
    return this.topicRoles.get(topic) ?? [];
  }

  role(id: number): Role | undefined {
    return this.roles.get(id);
  }

  /** The roles a soul (uuid) can play. */
  rolesOf(soul: string): number[] {
    return this.soulRoles.get(soul) ?? [];
  }

  /** The soul's voice id (v_voice_abbreviation gives its file prefix). */
  voiceOf(soul: string): number | undefined {
    return this.soulVoices.get(soul);
  }

  /** The soul's shown name, as a text_ui_soul key ("soul_ui_name_tailor"). */
  nameKey(soul: string): string | undefined {
    return this.soulNames.get(soul);
  }

  /** A response's recording in `voice` as a path in the voice paks ("dialog/000323/mcra_….ogg"), if recorded. */
  voicePath(line: DialogueLine, voice: number): string | undefined {
    const abbr = this.abbreviations.get(voice);
    if (!abbr || !line.text || line.folder === undefined || !line.voices?.includes(voice)) return undefined;
    return `dialog/${String(line.folder).padStart(6, "0")}/${abbr}_${line.text}.ogg`.toLowerCase();
  }

  /** A topic's own fields (priority, speaking role, label, time limit). */
  topic(id: number): Topic {
    return this.topicInfo.get(id) ?? { id, priority: 7, role: 0, label: "", timeLimit: 0 };
  }

  /** The role pairs a topic needs (topictorole), in table order. */
  rolePairs(topic: number): RolePair[] {
    return this.topicPairs.get(topic) ?? [];
  }

  /** The start topic of the branch a topic belongs to (itself for a start topic). */
  owner(topic: number): number {
    return this.owners.get(topic) ?? topic;
  }

  /** The branch starting at a topic, if any. */
  branch(startTopic: number): Branch | undefined {
    return this.branchAt.get(startTopic);
  }

  /** A soul's starting metaroles (soul2metarole). */
  metarolesOf(soul: string): number[] {
    return this.soulMetaroles.get(soul) ?? [];
  }

  /** A metarole's id by name (MERCHANT, REPAIRMAN, …). */
  metaroleId(name: string): number | undefined {
    return this.metaroleIds.get(name);
  }

  metaroleName(id: number): string | undefined {
    return this.metaroleNames.get(id);
  }

  moodName(id: number): string | undefined {
    return this.moods.get(id);
  }

  /** The topics any of these roles take part in. */
  topicsFor(roles: Iterable<number>): number[] {
    const want = new Set(roles);
    const out: number[] = [];
    for (const [t, rs] of this.topicRoles) if (rs.some((r) => want.has(r))) out.push(t);
    return out;
  }
}
