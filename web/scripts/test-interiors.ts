// Interior placement on Rataje: a sample of the map's beds, each scene built as the world view
// builds it (buildWorldScene), checked against what the level designers put around them:
// - bedding: where a bedding brush (cloth_bed*) lies on a bed, the bed's long axis lines up
//   with the bedding's, and the bedding's centre is on the bed. A bed turned or moved under
//   its bedding (as when cgf.ts applied the root node's transform: beds 90° off) fails;
// - LODs: every model's LODs in those scenes, as the scene loaded them, keep its size and
//   place, length and orientation.
// usage: node scripts/test-interiors.ts [--beds N] [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { buildWorldScene, newWorldCaches, type WorldModel } from "../src/world.ts";
import { openRataje } from "./lib.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const sample = Number(opt("--beds", "60"));

let failures = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } };

const lvl = await openRataje(root, { cover: false });
const beds = lvl.props.filter((e) => e.cls === "Bed" && /furniture\/beds\//i.test(e.model!));
// beds with bedding brushed on them first (about 55 on the map), then others spread over the map
const bedding: [number, number, number][] = [];
for (let i = 0; i < lvl.objects.brushName.length; i++) {
  if (!/cloth_bed/.test(lvl.terrain.brushNames[lvl.objects.brushName[i]] ?? "")) continue;
  const m = lvl.objects.brushMatrix;
  bedding.push([m[i * 16 + 12], m[i * 16 + 13], m[i * 16 + 14]]);
}
const covered = (e: (typeof beds)[number]) => bedding.some(([x, y, z]) => Math.hypot(x - e.pos[0], y - e.pos[1]) < 1.2 && z - e.pos[2] > 0 && z - e.pos[2] < 1.2);
const withCover = beds.filter(covered).slice(0, Math.ceil(sample / 2));
const others = beds.filter((e) => !withCover.includes(e));
const picked = [...withCover, ...others.filter((_, i) => i % Math.max(1, Math.floor(others.length / (sample - withCover.length))) === 0)].slice(0, sample);
console.log(`${beds.length} beds on the map, ${picked.length} sampled (${withCover.length} with bedding brushed on them)`);

type Mesh = { positions: Float32Array; transform: Float32Array };
/** Model-space box of a model's meshes under their node transforms. */
function box(meshes: Mesh[]): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    if (m.positions.length <= 9) continue; // a one-triangle stand-in (a cabinet LOD's doors)
    const P = m.positions, t = m.transform;
    for (let v = 0; v < P.length; v += 3) for (let r = 0; r < 3; r++) {
      const w = t[r] * P[v] + t[4 + r] * P[v + 1] + t[8 + r] * P[v + 2] + t[12 + r];
      lo[r] = Math.min(lo[r], w);
      hi[r] = Math.max(hi[r], w);
    }
  }
  return { lo, hi };
}
/** An instance's footprint: world centre, long horizontal axis (degrees, mod 180), half lengths. */
function footprint(wm: WorldModel, i: number) {
  const { lo, hi } = box(wm.lods[0].cgf.meshes);
  const M = wm.matrices.subarray(i * 16, i * 16 + 16);
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const at = (x: number, y: number, z: number) => [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
  const center = at(c[0], c[1], c[2]);
  const sx = Math.hypot(M[0], M[1]), sy = Math.hypot(M[4], M[5]);
  const ex = (hi[0] - lo[0]) * sx, ey = (hi[1] - lo[1]) * sy;
  // the long side's direction in the world
  const dir = ex >= ey ? [M[0], M[1]] : [M[4], M[5]];
  return { center, axis: ((Math.atan2(dir[1], dir[0]) * 180) / Math.PI + 360) % 180, half: [Math.max(ex, ey) / 2, Math.min(ex, ey) / 2], long: Math.max(ex, ey) / Math.max(Math.min(ex, ey), 0.01), dir };
}
const angle = (a: number, b: number) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };

const caches = newWorldCaches();
let withBedding = 0;
const seen = new Set<string>();
const lodChecked = new Set<string>();
let lods = 0;
for (const e of picked) {
  const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, [e.pos[0], e.pos[1]], 6, { maxModels: 300, caches, props: lvl.props, hiddenLayers: lvl.hiddenLayers });
  const bedModel = scene.models.find((m) => m.path === e.model!.toLowerCase().replace(/\\/g, "/"));
  const bi = bedModel ? Array.from({ length: bedModel.count }, (_, i) => i).find((i) => Math.hypot(bedModel.matrices[i * 16 + 12] - e.pos[0], bedModel.matrices[i * 16 + 13] - e.pos[1]) < 0.01) : undefined;
  check(!!bedModel && bi !== undefined, `${e.name}: the bed isn't in its scene`);
  if (!bedModel || bi === undefined) continue;
  const bed = footprint(bedModel, bi);
  // bedding lying on it
  for (const wm of scene.models) {
    if (!/cloth_bed/.test(wm.path) || !wm.lods[0]) continue;
    for (let i = 0; i < wm.count; i++) {
      const b = footprint(wm, i);
      const dz = b.center[2] - e.pos[2];
      if (Math.hypot(b.center[0] - bed.center[0], b.center[1] - bed.center[1]) > 1 || dz < 0 || dz > 1.2) continue;
      if (b.long < 1.3 || bed.long < 1.3) continue; // square: no axis to compare
      const key = `${e.id}`;
      if (!seen.has(key)) { seen.add(key); withBedding++; }
      const d = angle(bed.axis, b.axis);
      // the bedding's centre in the bed's frame
      const rx = b.center[0] - bed.center[0], ry = b.center[1] - bed.center[1];
      const n = Math.hypot(bed.dir[0], bed.dir[1]);
      const along = (rx * bed.dir[0] + ry * bed.dir[1]) / n, across = (-rx * bed.dir[1] + ry * bed.dir[0]) / n;
      check(d < 15, `${e.name} @${e.pos.map((v) => v.toFixed(1))}: bed ${e.model} at ${bed.axis.toFixed(0)}°, its bedding ${wm.path.split("/").pop()} at ${b.axis.toFixed(0)}°`);
      check(Math.abs(along) <= bed.half[0] + 0.05 && Math.abs(across) <= bed.half[1] + 0.05, `${e.name}: the bedding's centre is off the bed (${along.toFixed(2)}, ${across.toFixed(2)} m from its centre)`);
    }
  }
  // LODs of what is around, as the scene loaded them (world.ts stops before stand-ins under 32
  // triangles): a LOD may simplify the model (parts left out, posts reaching into the ground) but
  // keeps its place, length and orientation: an elongated model elongated the same way, no side
  // over 1.35 times the model's, and either inside the model's box (parts left out) or centred
  // within 15% of its size and at least 0.6 times as long. A LOD turned or
  // scaled against its model (or the model against its LODs) fails.
  for (const wm of scene.models) {
    if (lodChecked.has(wm.path) || wm.lods.length < 2) continue;
    lodChecked.add(wm.path);
    const a = box(wm.lods[0].cgf.meshes);
    const ea = a.hi.map((v, k) => v - a.lo[k]);
    const size = Math.max(ea[0], ea[1]);
    for (const [k, lod] of wm.lods.slice(1).entries()) {
      const b = box(lod.cgf.meshes);
      const eb = b.hi.map((v, r) => v - b.lo[r]);
      const off = Math.hypot((a.lo[0] + a.hi[0] - b.lo[0] - b.hi[0]) / 2, (a.lo[1] + a.hi[1] - b.lo[1] - b.hi[1]) / 2);
      const ratio = Math.max(...eb) / Math.max(...ea);
      const elongated = Math.max(ea[0], ea[1]) > 1.5 * Math.min(ea[0], ea[1]);
      const sameWay = !elongated || (ea[0] > ea[1]) === (eb[0] > eb[1]);
      const pad = 0.15 * Math.max(...ea);
      const inside = [0, 1, 2].every((r) => b.lo[r] >= a.lo[r] - pad && b.hi[r] <= a.hi[r] + pad);
      lods++;
      check(sameWay && ratio <= 1.35 && (inside || (off <= 0.15 * size && ratio >= 0.6)), `${wm.path}: LOD${k + 1} ${eb.map((v) => v.toFixed(2))} m centred ${off.toFixed(2)} m off, the model ${ea.map((v) => v.toFixed(2))} m`);
    }
  }
}
console.log(`${withBedding} of the sampled beds have bedding on them to compare; ${lods} LODs compared with their models`);
check(withBedding >= 12, `only ${withBedding} beds with bedding to compare`);
console.log(failures ? `${failures} failures` : "ok");
process.exit(failures ? 1 : 0);
