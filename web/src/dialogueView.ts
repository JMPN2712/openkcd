// Dialogue in the world view: plays a sequence with the NPCs around Henry as its cast, their
// recorded voices (Web Audio) and subtitles over the view. How a conversation starts waits for a
// research note, so for now a sequence is started by id from the debug control.

import { DialogueDb } from "./dialogue.ts";
import { castFor, DialoguePlayer, prepareSequence, type Actor, type SayEvent } from "./dialoguePlayer.ts";
import { Localization } from "./localization.ts";
import type { PakSource } from "./paks.ts";
import type { Vfs } from "./vfs.ts";
import { VoiceBank } from "./voice.ts";

interface Loaded {
  db: DialogueDb;
  voices: VoiceBank;
  text: Localization;
}

export class DialogueHost {
  /** the subtitle line over the view */
  readonly subtitle: HTMLDivElement;
  private vfs: Vfs;
  private paks: PakSource[];
  private loaded: Promise<Loaded> | null = null;
  private audio: AudioContext | null = null;
  private player: DialoguePlayer | null = null;
  private buffers = new Map<SayEvent, AudioBuffer>();
  private playing: AudioBufferSourceNode | null = null;
  private shown: SayEvent | undefined;

  constructor(vfs: Vfs, paks: PakSource[]) {
    this.vfs = vfs;
    this.paks = paks;
    this.subtitle = document.createElement("div");
    this.subtitle.className = "level-subtitle";
    this.subtitle.hidden = true;
  }

  get active(): boolean {
    return !!this.player;
  }

  /** The NPC (soul) who spoke last in the playing sequence: whom the dialogue camera frames. */
  partner: string | null = null;

  private load(): Promise<Loaded> {
    return (this.loaded ??= (async () => {
      const text = new Localization();
      const [db, voices] = await Promise.all([DialogueDb.load(this.vfs), VoiceBank.open(this.paks, "english"), text.load(this.paks, ["text_ui_dialog", "text_ui_soul"])]);
      return { db, voices, text };
    })());
  }

  /**
   * Play sequence `id` with these souls (nearest first) as its cast; Henry takes the player's
   * roles. Call from a user gesture (it starts the audio context). Returns what happened, for the HUD.
   */
  async play(id: number, souls: string[]): Promise<string> {
    this.stop();
    this.audio ??= new AudioContext();
    void this.audio.resume();
    const { db, voices, text } = await this.load();
    const seq = db.sequence(id);
    if (!seq) return `No dialogue sequence ${id}`;
    const named = souls.map((soul) => ({ soul, name: text.get(db.nameKey(soul) ?? "") ?? "?" }));
    const henry: Actor = { soul: "", voice: db.playerVoice, name: "Henry" };
    const cast = castFor(db, seq, named, henry);
    const tl = await prepareSequence(db, seq, cast, voices, text);
    const ctx = this.audio;
    this.buffers.clear();
    await Promise.all(tl.events.map(async (e) => {
      if (e.kind !== "say" || !e.audio) return;
      const b = await ctx.decodeAudioData(e.audio.slice().buffer).catch(() => null);
      if (b) this.buffers.set(e, b);
    }));
    this.player = new DialoguePlayer(tl);
    const roles = [...new Set(tl.events.flatMap((e) => (e.kind === "say" ? [e.role] : [])))];
    const missing = roles.filter((r) => !cast.has(r)).map((r) => db.role(r)?.name ?? r);
    return `Dialogue ${id}: ${tl.events.filter((e) => e.kind === "say").length} lines (${this.buffers.size} voiced), ${tl.length.toFixed(0)} s${missing.length ? ` (nobody near plays ${missing.join(", ")})` : ""}`;
  }

  stop(): void {
    this.playing?.stop();
    this.playing = null;
    this.player = null;
    this.partner = null;
    this.shown = undefined;
    this.subtitle.hidden = true;
  }

  /** Advance by `dt` real seconds: start each line's recording and show its subtitle. */
  update(dt: number): void {
    const p = this.player;
    if (!p) return;
    for (const e of p.advance(dt)) {
      if (e.kind !== "say") continue;
      if (e.actor?.soul) this.partner = e.actor.soul;
      this.playing?.stop();
      this.playing = null;
      const b = this.buffers.get(e);
      if (b && this.audio) {
        const src = this.audio.createBufferSource();
        src.buffer = b;
        src.connect(this.audio.destination);
        src.start();
        this.playing = src;
      }
    }
    const cur = p.current;
    if (cur !== this.shown) {
      this.shown = cur;
      this.subtitle.hidden = !cur;
      if (cur) {
        const who = document.createElement("b");
        who.textContent = `${cur.actor?.name ?? "?"}: `;
        this.subtitle.replaceChildren(who, cur.text);
      }
    }
    if (p.done) this.stop();
  }
}
