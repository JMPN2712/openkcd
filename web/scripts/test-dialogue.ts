// Dialogue data end to end (src/dialogue.ts, voice.ts, dialoguePlayer.ts, read-only): the tables
// load into sequences; Rataje's tailor and a second townsman are cast in a recorded gossip
// (sequence 46319); every spoken line resolves to its English subtitle and a recording in the
// speaker's voice; the timeline plays through to the end with the recordings' lengths.
// usage: node scripts/test-dialogue.ts [--root GAME_ROOT] [--sequence ID]

import { homedir } from "node:os";
import { join } from "node:path";
import { gameSources } from "./lib.ts";
import { Vfs } from "../src/vfs.ts";
import { readTable } from "../src/tables.ts";
import { DialogueDb, LINE_RESPONSE } from "../src/dialogue.ts";
import { VoiceBank, oggInfo } from "../src/voice.ts";
import { Localization } from "../src/localization.ts";
import { castFor, DialoguePlayer, prepareSequence } from "../src/dialoguePlayer.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const seqId = Number(opt("--sequence", "46319"));

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const sources = await gameSources(root);
const vfs = await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => /^libs\/tables\/.*\.xml$/.test(n), includeHd: false });
let t0 = performance.now();
const db = await DialogueDb.load(vfs);
console.log(`tables: ${db.sequenceCount} sequences in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
check(db.sequenceCount > 50000, "the sequence table loads (over 50k sequences)");
check(db.playerVoice === 108, `Henry's lines are recorded in voice ${db.playerVoice} (tmck)`);

t0 = performance.now();
const voices = await VoiceBank.open(sources, "english");
console.log(`voices: ${voices.size} English recordings indexed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
check(voices.size > 70000, "English voice paks indexed (over 70k recordings)");
const text = new Localization();
await text.load(sources, ["text_ui_dialog", "text_ui_soul"]);

// Rataje's townsfolk (soul_name rat_*), the tailor first
const chars = new Map((await readTable(vfs, "rpg/v_soul_character_data")).map((r) => [r.soul_id, r.name_string_id]));
const souls = (await readTable(vfs, "rpg/soul"))
  .filter((s) => s.soul_name.startsWith("rat_"))
  .sort((a, b) => Number(b.soul_name === "rat_tailor") - Number(a.soul_name === "rat_tailor"))
  .map((s) => ({ soul: s.soul_id, name: text.get(chars.get(s.soul_id) ?? "") ?? s.soul_name, soulName: s.soul_name }));
const tailor = souls[0];
check(tailor.soulName === "rat_tailor" && db.voiceOf(tailor.soul) === 98, `the tailor's soul has voice 98 (${tailor.name})`);
check(db.rolesOf(tailor.soul).length > 50, `the tailor plays ${db.rolesOf(tailor.soul).length} roles`);

const seq = db.sequence(seqId);
check(!!seq, `sequence ${seqId} exists`);
if (!seq) process.exit(1);
const spoken = seq.lines.filter((l) => l.type === LINE_RESPONSE);
console.log(`sequence ${seqId}: ${seq.lines.length} lines, ${spoken.length} spoken, roles ${[...new Set(spoken.map((l) => db.role(l.role!)?.name))].join(", ")}`);

// cast: only souls whose recordings cover their lines
const recorded = souls.filter((s) => { const v = db.voiceOf(s.soul); return v !== undefined && spoken.some((l) => l.voices?.includes(v)); });
const cast = castFor(db, seq, recorded);
check(cast.size === new Set(spoken.map((l) => l.role)).size, `every role is cast: ${[...cast].map(([r, a]) => `${db.role(r)?.name} = ${a.name}`).join("; ")}`);
check([...cast.values()].some((a) => a.soul === tailor.soul), "the tailor takes a part");

const tl = await prepareSequence(db, seq, cast, voices, text);
const says = tl.events.filter((e) => e.kind === "say");
check(says.every((e) => e.voice !== null), `every spoken line has a recording in its speaker's voice (${says.filter((e) => e.voice).length}/${says.length})`);
check(says.every((e) => e.line.text && text.get(e.line.text)), "every spoken line has its English subtitle");
const first = says[0]?.voice ? await voices.read(says[0].voice) : null;
const info = first ? oggInfo(first) : null;
check(!!info && info.rate === 48000 && info.channels === 1, `recordings are Ogg Vorbis (${info?.rate} Hz, ${info?.channels} ch)`);
check(tl.length > 5 && tl.length < 120, `the sequence lasts ${tl.length.toFixed(1)} s`);

// play it through on a fixed clock
const player = new DialoguePlayer(tl);
const heard: string[] = [];
let commands = 0, steps = 0;
while (!player.done && steps++ < 100000) {
  for (const e of player.advance(0.05)) {
    if (e.kind === "say") heard.push(`${e.at.toFixed(1).padStart(5)} s  ${e.actor?.name ?? "?"}: ${e.text}`);
    else commands++;
  }
}
console.log(heard.join("\n"));
check(player.done && heard.length === says.length, `the timeline plays to the end (${heard.length} lines, ${commands} commands, ${player.time.toFixed(1)} s)`);
check(commands === seq.lines.filter((l) => l.command).length, "every command line is reached");

console.log(failures ? `${failures} failure(s)` : "all ok");
process.exit(failures ? 1 : 0);
