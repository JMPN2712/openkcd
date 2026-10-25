// Sleepers in their beds, for every Bed entity in Rataje (read-only): the lying clip for the bed's
// kind (lyingTag), at the bed's lie-down helper (lieAt), moved by the clip's Align bone
// (alignOffset), as the world view poses them. Each sleeper's body is checked against the bed's
// own model:
// - the body (feet to head) lies along the bed's long side;
// - the pelvis is over the bed;
// - the pelvis is no higher than 0.35 m above the bed's top.
// With --no-align (the poses before the Align bone was used), sleepers lie across their beds.
// usage: node scripts/test-beds.ts [--no-align] [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { openRataje } from "./lib.ts";
import { parseCgf } from "../src/cgf.ts";
import { parseSkeleton } from "../src/skeleton.ts";
import { Dba } from "../src/dba.ts";
import { Animator } from "../src/pose.ts";
import { parseAdb } from "../src/mannequin.ts";
import { parseSmartObjectHelpers } from "../src/btWorld.ts";
import { poseMatrix } from "../src/character.ts";
import { multiply } from "../src/mat4.ts";
import { lyingTag } from "../src/schedule.ts";
import { alignOffset, lieAt } from "../src/npcs.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const noAlign = args.includes("--no-align");

const lvl = await openRataje(root, { cover: false });
const vfs = lvl.vfs;
const text = async (p: string) => new TextDecoder().decode(await vfs.read(vfs.lookup(p)!));
const helpers = parseSmartObjectHelpers(await text("libs/smartobjects.xml"));
const lyingAnims = new Map<string, string>();
for (const v of parseAdb(await text("animations/mannequin/adb/kcd_male_database.adb")).get("lying") ?? []) if (v.anims[0] && !lyingAnims.has(v.tags)) lyingAnims.set(v.tags, v.anims[0].name);
const skeleton = parseSkeleton(await vfs.read(vfs.lookup("objects/characters/humans/skeleton/male.chr")!))!;
const dba = new Dba(await vfs.read(vfs.lookup("animations/humans/male/male_general.dba")!));
const bone = (n: string) => skeleton.byName.get(n.toLowerCase())!;
const [HEAD, HIPS, LFOOT, RFOOT] = ["Head", "Hips", "LeftFoot", "RightFoot"].map(bone);

/** Per Lying tag: the body's head, pelvis and mid-feet in the character's frame, and the Align offset. */
const bodies = new Map<string, { head: number[]; hips: number[]; feet: number[]; offset: Float32Array }>();
for (const [tag, anim] of lyingAnims) {
  const name = `animations/humans/male/behavior/${anim}.caf`;
  if (!dba.anims.some((a) => a.name === name)) continue;
  const clip = dba.clip(name);
  const w = new Animator(skeleton).evaluate(clip, clip.start);
  const at = (i: number) => [w[i][12], w[i][13], w[i][14]];
  const lf = at(LFOOT), rf = at(RFOOT);
  bodies.set(tag, { head: at(HEAD), hips: at(HIPS), feet: lf.map((v, k) => (v + rf[k]) / 2), offset: noAlign ? poseMatrix([0, 0, 0], [1, 0, 0, 0]) : alignOffset(skeleton, clip) });
}
console.log(`Lying clips: ${[...bodies.keys()].join(", ")}`);

/** A model's box in its own frame (meshes under their node transforms). */
const boxes = new Map<string, { lo: number[]; hi: number[] } | null>();
async function box(model: string) {
  if (boxes.has(model)) return boxes.get(model)!;
  const hit = vfs.lookup(model);
  let b: { lo: number[]; hi: number[] } | null = null;
  if (hit) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const m of parseCgf(await vfs.read(hit)).meshes) {
      const P = m.positions, t = m.transform;
      for (let v = 0; v < P.length; v += 3) for (let r = 0; r < 3; r++) {
        const x = t[r] * P[v] + t[4 + r] * P[v + 1] + t[8 + r] * P[v + 2] + t[12 + r];
        lo[r] = Math.min(lo[r], x); hi[r] = Math.max(hi[r], x);
      }
    }
    b = { lo, hi };
  }
  boxes.set(model, b);
  return b;
}

const beds = lvl.props.filter((e) => e.cls === "Bed" && e.model);
const fails = new Map<string, { n: number; example: string }>();
const byKind = new Map<string, { n: number; bad: number }>();
let checked = 0, notes = 0;
for (const bed of beds) {
  const tag = lyingTag(bed);
  const body = bodies.get(tag) ?? bodies.get("lying")!;
  const at = lieAt(bed, tag, helpers);
  const b = await box(bed.model!);
  if (!at || !b) continue;
  checked++;
  // the body in the bed entity's frame: entity⁻¹ · helper · Align⁻¹ · point
  const M = multiply(poseMatrix(at.pos, at.rot), body.offset);
  const [w, x, y, z] = bed.rot;
  const toLocal = (p: number[]) => {
    const g = [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12] - bed.pos[0], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13] - bed.pos[1], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14] - bed.pos[2]];
    // rotate by the inverse (conjugate) of the bed's rotation, then undo its scale
    const q = [w, -x, -y, -z];
    const tx = 2 * (q[2] * g[2] - q[3] * g[1]), ty = 2 * (q[3] * g[0] - q[1] * g[2]), tz = 2 * (q[1] * g[1] - q[2] * g[0]);
    const r = [g[0] + q[0] * tx + (q[2] * tz - q[3] * ty), g[1] + q[0] * ty + (q[3] * tx - q[1] * tz), g[2] + q[0] * tz + (q[1] * ty - q[2] * tx)];
    const s = bed.scale ?? [1, 1, 1];
    return [r[0] / s[0], r[1] / s[1], r[2] / s[2]];
  };
  const head = toLocal(body.head), hips = toLocal(body.hips), feet = toLocal(body.feet);
  const ex = b.hi[0] - b.lo[0], ey = b.hi[1] - b.lo[1];
  // the body's angle to the bed's long side (0–90°); square-ish beds (straw piles) have no long side
  const bodyAng = Math.atan2(head[1] - feet[1], head[0] - feet[0]);
  const longAng = ex >= ey ? 0 : Math.PI / 2;
  let off = Math.abs(((bodyAng - longAng) % Math.PI + Math.PI) % Math.PI);
  off = Math.min(off, Math.PI - off) * 180 / Math.PI;
  const elongated = Math.max(ex, ey) > 1.3 * Math.min(ex, ey);
  const margin = 0.15;
  const over = hips[0] > b.lo[0] - margin && hips[0] < b.hi[0] + margin && hips[1] > b.lo[1] - margin && hips[1] < b.hi[1] + margin;
  const problems: string[] = [];
  if (elongated && off > 25) problems.push(`across (${off.toFixed(0)}°)`);
  if (!over) problems.push("pelvis off the bed");
  // the game's data puts a bench sleeper on three ground cloths (Bed_StrictLeft, esBedTypes "bench")
  const quirk = /^lying(Left|Right)$/.test(tag) && b.hi[2] - b.lo[2] < 0.15;
  if (hips[2] > b.hi[2] + 0.35 && !quirk) problems.push(`pelvis ${(hips[2] - b.hi[2]).toFixed(2)} m above the top`);
  if (quirk) notes++;
  const kind = `${tag} on ${bed.model!.split("/").pop()}`;
  const k = byKind.get(kind) ?? { n: 0, bad: 0 };
  k.n++;
  if (problems.length) {
    k.bad++;
    for (const p of problems) {
      const key = p.replace(/\s*\(.*\)|[\d.]+ m/g, "").trim();
      const f = fails.get(key) ?? { n: 0, example: "" };
      f.n++;
      f.example ||= `${bed.name} (${kind}) at ${bed.pos.map((v) => v.toFixed(1)).join(",")}: ${p}`;
      fails.set(key, f);
    }
  }
  byKind.set(kind, k);
}
console.log(`${checked} of ${beds.length} beds checked (with a helper and a model); ${notes} benches by their data that are ground cloths, not checked for height`);
for (const [kind, k] of [...byKind].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${kind}: ${k.n}${k.bad ? `, ${k.bad} wrong` : ""}`);
const bad = [...byKind.values()].reduce((s, k) => s + k.bad, 0);
for (const [p, f] of fails) console.log(`FAIL ${p}: ${f.n} beds, e.g. ${f.example}`);
console.log(bad ? `FAIL: ${bad} of ${checked} sleepers misplaced` : `OK: all ${checked} sleepers lie along their beds`);
if (bad) process.exit(1);
