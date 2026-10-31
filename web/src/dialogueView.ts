// Dialogue in the world view: conversations with the NPC Henry faces (dialogueFlow.ts, from the
// research note dialogue.md): the greeting, the topic menu in the game's order (number keys, arrows
// and Enter, or a click; timed choices count down and take the highlighted option), follow-ups,
// "end topic" and the farewell bark. Each sequence plays in its speakers' recorded voices (Web
// Audio) with subtitles over the view. Haggling's price panel is a placeholder. A sequence can
// still be played by id from the debug control.

import { LINE_RESPONSE, ROLE_HENRY, DialogueDb, type Sequence } from "./dialogue.ts";
import { Conversation, DialogueState, luaScripts, neutralWorld, participant, type FlowHost, type MenuOption, type Step } from "./dialogueFlow.ts";
import { castFor, DialoguePlayer, prepareSequence, type Actor, type SayEvent } from "./dialoguePlayer.ts";
import { Localization } from "./localization.ts";
import type { LuaHost } from "./luaHost.ts";
import type { PakSource } from "./paks.ts";
import { readTable } from "./tables.ts";
import type { Vfs } from "./vfs.ts";
import { VoiceBank } from "./voice.ts";

interface Loaded {
  db: DialogueDb;
  voices: VoiceBank;
  text: Localization;
  /** soul name → soul id */
  souls: Map<string, string>;
}

/** Henry's soul (rpg/soul "dude") and the entity id his Lua soul goes by. */
const HENRY_SOUL = "dude";
const HENRY_ENTITY = -1;

/** An NPC to talk to. */
export interface TalkTarget {
  soul: string;
  /** soul name = entity name (rat_tailor) */
  name: string;
  entity: number;
}

/** Sequence types the menu marks (the game shows icons). */
const TYPE_TAGS: Record<number, string> = { 1: "Strength", 2: "Speech", 3: "Charisma", 4: "Bribe", 6: "Stealth", 8: "First aid" };

export class DialogueHost {
  /** the subtitle line over the view */
  readonly subtitle: HTMLDivElement;
  /** the choices of a conversation */
  readonly menu: HTMLDivElement;
  private vfs: Vfs;
  private paks: PakSource[];
  private loaded: Promise<Loaded> | null = null;
  private audio: AudioContext | null = null;
  private player: DialoguePlayer | null = null;
  private buffers = new Map<SayEvent, AudioBuffer>();
  private playing: AudioBufferSourceNode | null = null;
  private shown: SayEvent | undefined;
  /** the game's Lua (sequence scripts, metaroles); set once the behaviour trees have loaded */
  lua: LuaHost | null = null;
  /** play time in seconds (1× real time, stopped while paused: sequence cooldowns), and the hour of day */
  clock: () => { seconds: number; hour: number } = () => ({ seconds: 0, hour: 12 });
  /** what happened, for the HUD */
  info = "";
  private state = new DialogueState();
  private conv: Conversation | null = null;
  private with: TalkTarget | null = null;
  private afterLine: (() => void) | null = null;
  private options: MenuOption[] = [];
  private highlight = 0;
  private timer: { left: number; total: number; bar: HTMLElement } | null = null;
  private haggling = false;
  private somethingToSay = new Map<number, { at: number; yes: boolean }>();

  constructor(vfs: Vfs, paks: PakSource[]) {
    this.vfs = vfs;
    this.paks = paks;
    this.subtitle = document.createElement("div");
    this.subtitle.className = "level-subtitle";
    this.subtitle.hidden = true;
    this.menu = document.createElement("div");
    this.menu.className = "level-dialogue-menu";
    this.menu.hidden = true;
  }

  /** A sequence or a conversation is playing. */
  get active(): boolean {
    return !!this.player || !!this.conv;
  }

  /** A conversation with an NPC is on (Henry stays put, the NPC waits). */
  get talkingTo(): TalkTarget | null {
    return this.conv ? this.with : null;
  }

  /** The NPC (soul) who spoke last in the playing sequence: whom the dialogue camera frames. */
  partner: string | null = null;

  private load(): Promise<Loaded> {
    return (this.loaded ??= (async () => {
      const text = new Localization();
      const [db, voices, , souls] = await Promise.all([
        DialogueDb.load(this.vfs), VoiceBank.open(this.paks, "english"),
        text.load(this.paks, ["text_ui_dialog", "text_ui_soul", "text_ui_ingame"]),
        readTable(this.vfs, "rpg/soul"),
      ]);
      this.ready = { db, voices, text, souls: new Map(souls.map((r) => [r.soul_name, r.soul_id])) };
      return this.ready;
    })());
  }

  /** An NPC's shown name ("Tailor"), once the tables have loaded. */
  displayName(soul: string): string | undefined {
    const l = this.ready;
    return l ? l.text.get(l.db.nameKey(soul) ?? "") : undefined;
  }

  /** Start loading the dialogue tables (about 1.5 s, once). */
  preload(): void {
    void this.load();
  }

  private flowHost(l: Loaded): FlowHost {
    const entityOf = (name: string) => (name === HENRY_SOUL ? HENRY_ENTITY : name === this.with?.name ? this.with.entity : undefined);
    return {
      now: () => this.clock().seconds,
      call: neutralWorld(() => this.clock().hour),
      runScript: this.lua ? luaScripts(this.lua, entityOf) : undefined,
      report: (w) => console.debug("dialogue:", w),
    };
  }

  private people(l: Loaded, npc: TalkTarget) {
    const henry = participant(l.db, { id: l.souls.get(HENRY_SOUL) ?? "", name: HENRY_SOUL }, true, this.lua?.metaroleChanges(HENRY_ENTITY));
    const other = participant(l.db, { id: npc.soul, name: npc.name }, false, this.lua?.metaroleChanges(npc.entity));
    return [henry, other];
  }

  /**
   * Whether the NPC has something to say (the "Talk" prompt): undefined until the tables have
   * loaded. Checked at most every 2 s per NPC.
   */
  hasSomethingToSay(npc: TalkTarget): boolean | undefined {
    const l = this.ready;
    if (!l) { this.preload(); return undefined; }
    const now = performance.now();
    const c = this.somethingToSay.get(npc.entity);
    if (c && now - c.at < 2000) return c.yes;
    const yes = new Conversation(l.db, this.state, this.people(l, npc), this.flowHost(l)).hasSomethingToSay();
    this.somethingToSay.set(npc.entity, { at: now, yes });
    return yes;
  }

  private ready: Loaded | null = null;

  /** Talk to an NPC. Call from a user gesture (it starts the audio context). */
  async talk(npc: TalkTarget): Promise<void> {
    this.stop();
    this.audio ??= new AudioContext();
    void this.audio.resume();
    const l = await this.load();
    this.with = npc;
    this.conv = new Conversation(l.db, this.state, this.people(l, npc), this.flowHost(l));
    this.somethingToSay.delete(npc.entity);
    await this.run(this.conv.start());
  }

  /** The actor of participant `i` (Henry speaks in the player's voice). */
  private actor(l: Loaded, i: number): Actor {
    const p = this.conv!.participants[i];
    return p.player ? { soul: "", voice: l.db.playerVoice, name: "Henry" } : { soul: p.soul, voice: l.db.voiceOf(p.soul), name: l.text.get(l.db.nameKey(p.soul) ?? "") ?? p.name };
  }

  /** Who says each role of a sequence: the conversation's cast, else by role (Henry's roles to Henry). */
  private castOf(l: Loaded, seq: Sequence, cast: Map<number, number>): Map<number, Actor> {
    const out = new Map<number, Actor>();
    const conv = this.conv!;
    for (const line of seq.lines) {
      if (line.type !== LINE_RESPONSE || line.role === undefined || out.has(line.role)) continue;
      let i = cast.get(line.role);
      if (i === undefined) i = conv.participants.findIndex((p) => p.roles.has(line.role!));
      if (i < 0) i = l.db.role(line.role)?.metarole === 1 || line.role === ROLE_HENRY ? conv.participants.findIndex((p) => p.player) : conv.participants.findIndex((p) => !p.player);
      if (i >= 0) out.set(line.role, this.actor(l, i));
    }
    return out;
  }

  /** Carry out a conversation step. */
  private async run(s: Step): Promise<void> {
    const l = await this.load();
    const conv = this.conv;
    if (!conv) return;
    this.hideMenu();
    switch (s.kind) {
      case "play":
        await this.playTimeline(l, s.candidate.sequence, this.castOf(l, s.candidate.sequence, s.cast));
        this.afterLine = () => { if (this.conv === conv) void this.run(conv.played()); };
        return;
      case "menu":
        this.showMenu(l, s.options, s.timeLimit);
        return;
      case "haggle":
        // the price input panel isn't built yet: say so, and go on when dismissed
        this.haggling = true;
        this.menu.replaceChildren(el("p", "Haggling isn't available yet (the price panel comes with shops)."), el("p", "Press Enter to go on."));
        this.menu.hidden = false;
        return;
      case "bark": {
        const one: Sequence = { ...s.sequence, lines: [s.line] };
        await this.playTimeline(l, one, new Map([[s.line.role!, this.actor(l, s.participant)]]));
        this.afterLine = () => { if (this.conv === conv) this.endConversation("said goodbye"); };
        return;
      }
      case "end":
        this.endConversation(s.reason);
    }
  }

  private endConversation(reason: string): void {
    this.info = `Conversation ${reason}`;
    this.conv = null;
    this.with = null;
    this.partner = null;
    this.hideMenu();
  }

  private hideMenu(): void {
    this.menu.hidden = true;
    this.options = [];
    this.timer = null;
    this.haggling = false;
  }

  private showMenu(l: Loaded, options: MenuOption[], timeLimit: number): void {
    this.options = options;
    this.highlight = 0;
    const list = el("ol");
    options.forEach((o, i) => {
      const li = el("li");
      li.append(el("span", `${i + 1}.`, "n"), l.text.get(o.label) ?? (o.label || "…"));
      const tag = TYPE_TAGS[o.type];
      if (tag) li.append(el("span", `[${tag}]`, "tag"));
      if (o.exhausted) li.classList.add("exhausted");
      li.addEventListener("click", () => this.pick(i));
      li.addEventListener("mouseenter", () => this.mark(i));
      list.append(li);
    });
    const parts: HTMLElement[] = [];
    this.timer = null;
    if (timeLimit > 0) {
      const timer = el("div", undefined, "timer"), bar = el("i");
      timer.append(bar);
      parts.push(timer);
      this.timer = { left: timeLimit, total: timeLimit, bar };
    }
    this.menu.replaceChildren(...parts, list);
    this.menu.hidden = false;
    this.mark(0);
  }

  private mark(i: number): void {
    this.highlight = Math.max(0, Math.min(this.options.length - 1, i));
    this.menu.querySelectorAll("li").forEach((li, k) => li.classList.toggle("sel", k === this.highlight));
  }

  private pick(i: number): void {
    const conv = this.conv;
    if (!conv || !this.options[i]) return;
    void this.run(conv.choose(this.options[i].index));
  }

  /**
   * Keys during a conversation: 1–9 pick, arrows move the highlight, Enter picks it (or closes the
   * price panel), Space skips the line being said. Returns whether the key was used.
   */
  key(e: KeyboardEvent): boolean {
    if (!this.conv && !this.player) return false;
    if (this.haggling && (e.code === "Enter" || e.code === "Space")) {
      const conv = this.conv;
      this.hideMenu();
      if (conv) void this.run(conv.played());
      return true;
    }
    if (this.options.length) {
      const n = /^Digit([1-9])$/.exec(e.code)?.[1] ?? /^Numpad([1-9])$/.exec(e.code)?.[1];
      if (n && Number(n) <= this.options.length) { this.pick(Number(n) - 1); return true; }
      if (e.code === "ArrowDown" || e.code === "KeyS") { this.mark(this.highlight + 1); return true; }
      if (e.code === "ArrowUp" || e.code === "KeyW") { this.mark(this.highlight - 1); return true; }
      if (e.code === "Enter" || e.code === "KeyE") { this.pick(this.highlight); return true; }
    }
    if (e.code === "Space" && this.player) { this.player.skip(); return true; }
    return !!this.conv;
  }

  /** Lay out a sequence, decode its recordings and start it. */
  private async playTimeline(l: Loaded, seq: Sequence, cast: Map<number, Actor>): Promise<string> {
    const tl = await prepareSequence(l.db, seq, cast, l.voices, l.text);
    const ctx = this.audio;
    this.buffers.clear();
    if (ctx) await Promise.all(tl.events.map(async (e) => {
      if (e.kind !== "say" || !e.audio) return;
      const b = await ctx.decodeAudioData(e.audio.slice().buffer).catch(() => null);
      if (b) this.buffers.set(e, b);
    }));
    this.player = new DialoguePlayer(tl);
    const roles = [...new Set(tl.events.flatMap((e) => (e.kind === "say" ? [e.role] : [])))];
    const missing = roles.filter((r) => !cast.has(r)).map((r) => l.db.role(r)?.name ?? r);
    return `${tl.events.filter((e) => e.kind === "say").length} lines (${this.buffers.size} voiced), ${tl.length.toFixed(0)} s${missing.length ? ` (nobody near plays ${missing.join(", ")})` : ""}`;
  }

  /**
   * Debug: play sequence `id` with these souls (nearest first) as its cast; Henry takes the
   * player's roles. Call from a user gesture. Returns what happened, for the HUD.
   */
  async play(id: number, souls: string[]): Promise<string> {
    this.stop();
    this.audio ??= new AudioContext();
    void this.audio.resume();
    const l = await this.load();
    const seq = l.db.sequence(id);
    if (!seq) return `No dialogue sequence ${id}`;
    const named = souls.map((soul) => ({ soul, name: l.text.get(l.db.nameKey(soul) ?? "") ?? "?" }));
    const henry: Actor = { soul: "", voice: l.db.playerVoice, name: "Henry" };
    return `Dialogue ${id}: ${await this.playTimeline(l, seq, castFor(l.db, seq, named, henry))}`;
  }

  stop(): void {
    this.playing?.stop();
    this.playing = null;
    this.player = null;
    this.partner = null;
    this.shown = undefined;
    this.subtitle.hidden = true;
    this.afterLine = null;
    this.conv = null;
    this.with = null;
    this.hideMenu();
  }

  /**
   * Advance by `dt` real seconds: start each line's recording, show its subtitle; count a timed
   * choice down by `playDt`, seconds of play time (stopped while the game is paused; dialogue.md).
   */
  update(dt: number, playDt = dt): void {
    if (this.timer) {
      this.timer.left -= playDt;
      this.timer.bar.style.width = `${Math.max(0, (100 * this.timer.left) / this.timer.total)}%`;
      // at zero the highlighted option is taken (untouched: the first)
      if (this.timer.left <= 0) { this.timer = null; this.pick(this.highlight); }
    }
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
    if (p.done) {
      this.player = null;
      this.playing = null;
      this.shown = undefined;
      this.subtitle.hidden = true;
      const next = this.afterLine;
      this.afterLine = null;
      if (next) next();
      else if (!this.conv) this.partner = null;
    }
  }
}

function el(tag: string, text?: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
