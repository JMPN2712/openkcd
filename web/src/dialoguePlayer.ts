// Plays one dialogue sequence (dialogue.ts) as a timeline: each response line in order, as long as
// its recording in the speaker's voice, with its subtitle; command lines are reported when reached
// (moods and animation fragments wait for the dialogue animations). Which sequence plays, and the
// choices between them, come later from a research note.

import { LINE_COMMAND, LINE_RESPONSE, type DialogueCommand, type DialogueDb, type DialogueLine, type Sequence } from "./dialogue.ts";
import type { Localization } from "./localization.ts";
import { oggInfo, type VoiceBank } from "./voice.ts";

/** Who plays a role: a soul (uuid), its voice id and shown name. */
export interface Actor {
  soul: string;
  voice?: number;
  name: string;
}

export interface SayEvent {
  kind: "say";
  at: number;
  duration: number;
  line: DialogueLine;
  role: number;
  actor?: Actor;
  /** the subtitle (the key itself when the text tables lack it) */
  text: string;
  /** voice path in the voice paks, null when the line isn't recorded in this actor's voice */
  voice: string | null;
  /** the recording (.ogg), when there is one */
  audio?: Uint8Array;
}

export interface CommandEvent {
  kind: "command";
  at: number;
  line: DialogueLine;
  command: DialogueCommand;
}

export type DialogueEvent = SayEvent | CommandEvent;

export interface Timeline {
  sequence: Sequence;
  events: DialogueEvent[];
  /** seconds */
  length: number;
}

/**
 * Reading time (s) for a line with no recording in the speaker's voice. Ours, not the game's: a
 * subtitle-only line stays up long enough to read.
 */
export function readingTime(text: string): number {
  return Math.max(1.5, text.length * 0.06);
}

/** The cast of a sequence from souls near the player: the first soul that can play each role. */
export function castFor(db: DialogueDb, seq: Sequence, souls: { soul: string; name: string }[], player?: Actor): Map<number, Actor> {
  const cast = new Map<number, Actor>();
  const used = new Set<string>();
  for (const role of new Set(seq.lines.flatMap((l) => (l.type === LINE_RESPONSE && l.role !== undefined ? [l.role] : [])))) {
    if (db.role(role)?.metarole === 1 && player) {
      cast.set(role, player);
      continue;
    }
    const s = souls.find((x) => !used.has(x.soul) && db.rolesOf(x.soul).includes(role));
    if (!s) continue;
    used.add(s.soul);
    cast.set(role, { soul: s.soul, voice: db.voiceOf(s.soul), name: s.name });
  }
  return cast;
}

/** Lay out a sequence: each response's length is its recording's (read from the voice paks). */
export async function prepareSequence(db: DialogueDb, seq: Sequence, cast: Map<number, Actor>, voices: VoiceBank | null, text: Localization | null): Promise<Timeline> {
  const events: DialogueEvent[] = [];
  let t = 0;
  for (const line of seq.lines) {
    if (line.type === LINE_COMMAND && line.command) {
      events.push({ kind: "command", at: t, line, command: line.command });
      continue;
    }
    if (line.type !== LINE_RESPONSE || line.role === undefined) continue;
    const actor = cast.get(line.role);
    const subtitle = (line.text && text?.get(line.text)) || line.text || "";
    const path = actor?.voice !== undefined ? db.voicePath(line, actor.voice) : undefined;
    const bytes = path && voices ? await voices.read(path) : null;
    const info = bytes ? oggInfo(bytes) : null;
    const duration = info ? info.seconds : readingTime(subtitle);
    events.push({ kind: "say", at: t, duration, line, role: line.role, actor, text: subtitle, voice: info ? path! : null, audio: info ? bytes! : undefined });
    t += duration;
  }
  return { sequence: seq, events, length: t };
}

/** Steps through a timeline; `advance` returns the events reached since the last call. */
export class DialoguePlayer {
  time = 0;
  private next = 0;

  readonly timeline: Timeline;

  constructor(timeline: Timeline) {
    this.timeline = timeline;
  }

  get done(): boolean {
    return this.time >= this.timeline.length && this.next >= this.timeline.events.length;
  }

  /** The line being said now, if any. */
  get current(): SayEvent | undefined {
    for (let i = this.next - 1; i >= 0; i--) {
      const e = this.timeline.events[i];
      if (e.kind === "say") return this.time < e.at + e.duration ? e : undefined;
    }
    return undefined;
  }

  advance(dt: number): DialogueEvent[] {
    this.time += dt;
    const out: DialogueEvent[] = [];
    const ev = this.timeline.events;
    while (this.next < ev.length && ev[this.next].at <= this.time) out.push(ev[this.next++]);
    return out;
  }

  /** Jump to the end of the current line (a skip key). */
  skip(): void {
    const c = this.current;
    if (c) this.time = c.at + c.duration;
  }
}
