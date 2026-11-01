// The dialogue camera rig (src/dialogueCamera.ts, read-only): the blendspace's 45 examples form a
// full 3 × 3 × 5 grid whose parameters follow their labels; between points the shots move
// smoothly; every shot looks towards the partner wherever they stand (any angle, 0.8–2.5 m,
// ±45 cm), and placing the rig on a
// character in the world turns it to the character's heading. In a conversation each line's shot
// (ShotPlanner) frames its speaker over the listener's shoulder; camera cuts and camera modes win.
// usage: node scripts/test-dialogue-camera.ts [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { gameSources } from "./lib.ts";
import { Vfs } from "../src/vfs.ts";
import { DialogueCameraRig, frame, parseBspace, RIG_BLENDSPACE, ShotPlanner, SHOTS, type Framing, type Partner, type Stand } from "../src/dialogueCamera.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V) => Math.hypot(...a);
const angleDeg = (a: V, b: V) => (Math.acos(Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b)))) * 180) / Math.PI;

const sources = await gameSources(root);
const vfs = await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => /dialog_cameras/.test(n), includeHd: false });
const rig = await DialogueCameraRig.load(vfs);
const L = rig.labels;
check(L.angle.join() === "-180,-90,0,90,180" && L.distance.join() === "80,140,250" && L.height.join() === "-45,0,45", `grid: angles ${L.angle.join("/")}°, distances ${L.distance.join("/")} cm, heights ${L.height.join("/")} cm`);

// the examples' parameters rise with their labels (para0 angle, para1 distance, para2 height)
const ex = parseBspace(new TextDecoder().decode(await vfs.read(vfs.lookup(RIG_BLENDSPACE)!)));
const lab = (c: string) => { const m = /_y(minus)?(\d+)_z(\d+)_x(minus)?(\d+)$/.exec(c)!; return [(m[4] ? -1 : 1) * +m[5], +m[3], (m[1] ? -1 : 1) * +m[2]]; };
let monotone = true;
for (const a of ex) for (const b of ex) for (let k = 0; k < 3; k++) if (lab(a.clip)[k] < lab(b.clip)[k] && !(a.params[k] < b.params[k])) monotone = false;
check(ex.length === 45 && monotone, `${ex.length} examples; each parameter rises with its label`);

// every shot looks towards the partner (horizontally within 40°), on the grid and between it
const worst = new Map<string, [number, string]>();
for (const angle of [-180, -135, -90, -45, -20, 0, 20, 45, 90, 135, 180]) for (const distance of [80, 110, 140, 200, 250]) for (const height of [-45, -20, 0, 20, 45]) {
  const pose = rig.pose({ angle, distance, height });
  const a = (angle * Math.PI) / 180;
  const partner = [(-Math.sin(a) * distance) / 100, (Math.cos(a) * distance) / 100];
  for (const s of SHOTS) {
    const { eye, target } = pose[s];
    let d = Math.abs(Math.atan2(target[1] - eye[1], target[0] - eye[0]) - Math.atan2(partner[1] - eye[1], partner[0] - eye[0])) * 180 / Math.PI;
    if (d > 180) d = 360 - d;
    if (d > (worst.get(s)?.[0] ?? -1)) worst.set(s, [d, `${angle}° ${distance} cm ${height} cm`]);
  }
}
check([...worst.values()].every(([d]) => d < 40), `every shot looks towards the partner: ${[...worst].map(([s, [d, at]]) => `${s} within ${d.toFixed(0)}° (worst at ${at})`).join(", ")}`);

// smooth between grid points: 1° or 1 cm moves no eye more than 5 cm
let jump = 0;
const base: Partner = { angle: 0, distance: 80, height: 0 };
for (let i = 0; i < 360; i++) for (const k of ["angle", "distance"] as const) {
  const p = { ...base, angle: -180 + i, distance: 80 + (i * 170) / 360 };
  const q = { ...p, [k]: p[k] + 1 };
  const a = rig.pose(p), b = rig.pose(q);
  for (const s of SHOTS) jump = Math.max(jump, len(sub(a[s].eye, b[s].eye)));
}
check(jump < 0.05, `shots move smoothly (at most ${(jump * 100).toFixed(1)} cm per degree or cm)`);

// in the world: Henry at (100, 200, 10) facing +X, the partner 1.4 m ahead
const w = rig.place([100, 200, 10], 0, [101.4, 200, 10]);
const look = sub(w.close_up.target, w.close_up.eye);
check(Math.abs(w.partner.angle) < 1e-6 && Math.abs(w.partner.distance - 140) < 1e-6, `the partner is straight ahead at 140 cm (${w.partner.angle.toFixed(1)}°)`);
check(look[0] > 0 && Math.abs(Math.atan2(look[1], look[0])) < 0.7 && w.close_up.eye[2] > 11.3 && w.close_up.eye[2] < 11.8, `in the world the close-up looks along +X from head height (heading ${(Math.atan2(look[1], look[0]) * 180 / Math.PI).toFixed(0)}°, eye z ${w.close_up.eye[2].toFixed(2)})`);
for (const s of SHOTS) console.log(`  ${s.padEnd(10)} eye ${w[s].eye.map((v) => v.toFixed(2)).join(", ")}  → ${w[s].target.map((v) => v.toFixed(2)).join(", ")}`);

// conversations (ShotPlanner, frame): Henry (0) at (100, 200, 10) facing +X, the NPC (1) 1.3 m
// ahead facing him. Each line frames its speaker over the listener's shoulder: the camera sits
// on the listener's side and looks at the speaker's head.
const at = (i: number): Stand => (i === 0 ? { feet: [100, 200, 10], yaw: 0 } : { feet: [101.3, 200, 10], yaw: Math.PI });
const framesHead = (f: Framing) => {
  const p = frame(rig, f, at)!, head: V = [at(f.speaker).feet[0], at(f.speaker).feet[1], 11.6];
  const off = angleDeg(sub(p.target, p.eye), sub(head, p.eye));
  const nearListener = len(sub(p.eye, at(f.listener).feet)) < len(sub(p.eye, at(f.speaker).feet));
  return { ok: off < 25 && nearListener, off };
};
const plan = new ShotPlanner();
const turns: [number, string][] = [[1, "the NPC greets"], [0, "Henry answers"], [1, "the NPC"], [1, "the NPC goes on"], [0, "Henry"]];
const seen = turns.map(([who, what]) => { const f = plan.say(who, 1 - who); return { f, what, ...framesHead(f) }; });
for (const x of seen) console.log(`  ${x.what}: ${x.f.shot} on ${x.f.speaker === 0 ? "Henry" : "the NPC"}, looking ${x.off.toFixed(0)}° off their head`);
check(seen.every((x, i) => x.f.speaker === turns[i][0] && x.ok), "every line frames its speaker, Henry's lines Henry, from the listener's side");
check(seen.map((x) => x.f.shot).join() === "medium,close_shot,close_shot,close_up,close_shot", `shots: medium first, a close shot at each change of speaker, a close-up when one goes on (${seen.map((x) => x.f.shot).join(", ")})`);
// the data's choices win: a camera-cut command (type 3 on Henry), then a line's camera_mode
plan.cut(3, 0);
const cut = plan.say(1, 0);
const mode = plan.say(1, 0, 1);
check(cut.from === "cut" && cut.speaker === 0 && cut.shot === "close_shot" && framesHead(cut).ok, `a camera cut frames whom it names with its shot (${cut.shot} on ${cut.speaker === 0 ? "Henry" : "the NPC"})`);
check(mode.from === "line" && mode.shot === "master" && mode.speaker === 1, `a line's camera_mode picks the shot (${mode.shot})`);
plan.cut(5, null);
check(plan.say(0, 1).from === "auto", "a named level camera (type 5) isn't placed yet: the line keeps our rule");
const m = plan.menu(0, 1);
check(m.speaker === 1 && m.listener === 0 && framesHead(m).ok, "at the menu the camera shows the NPC over Henry's shoulder");

console.log(failures ? `${failures} failure(s)` : "all ok");
process.exit(failures ? 1 : 0);
