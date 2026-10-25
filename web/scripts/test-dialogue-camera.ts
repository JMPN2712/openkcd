// The dialogue camera rig (src/dialogueCamera.ts, read-only): the blendspace's 45 examples form a
// full 3 × 3 × 5 grid whose parameters follow their labels; between points the shots move
// smoothly; every shot looks towards the partner wherever they stand (any angle, 0.8–2.5 m,
// ±45 cm), and placing the rig on a
// character in the world turns it to the character's heading.
// usage: node scripts/test-dialogue-camera.ts [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { gameSources } from "./lib.ts";
import { Vfs } from "../src/vfs.ts";
import { DialogueCameraRig, parseBspace, RIG_BLENDSPACE, SHOTS, type Partner } from "../src/dialogueCamera.ts";

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

console.log(failures ? `${failures} failure(s)` : "all ok");
process.exit(failures ? 1 : 0);
