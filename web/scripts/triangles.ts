// Where a frame's triangles come from: the streamed scene around a view, LODs selected as the
// world view does at a preset, then the triangles drawn per model (instances × the chosen LOD's
// triangles), the largest first, with totals by kind and by LOD. No GPU needed.
// usage: node scripts/triangles.ts [--preset medium] [--at 2577.8,574,yaw°] [--top 30] [--shadow]
//   --shadow: the first shadow cascade's selection instead (casters within its split, half the LOD scale)

import { homedir } from "node:os";
import { join } from "node:path";
import { heightAt } from "../src/terrain.ts";
import { TerrainRenderer } from "../src/terrainRenderer.ts";
import { buildWorldScene, newWorldCaches, selectLods } from "../src/world.ts";
import { PRESETS, type PresetName } from "../src/quality.ts";
import { openRataje } from "./lib.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const preset = opt("--preset", "medium") as PresetName;
const [x, y, yawDeg] = opt("--at", "2577.8,574,-124").split(",").map(Number);
const top = Number(opt("--top", "30"));
const shadow = args.includes("--shadow");
const q = PRESETS[preset];

const lvl = await openRataje(root);
const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, [x, y], q.streamRadius, { maxModels: 20000, maxTextureDim: 16, caches: newWorldCaches(), props: lvl.props, hiddenLayers: lvl.hiddenLayers, normalMaps: false });
const eye: [number, number, number] = [x, y, heightAt(lvl.terrain, x, y) + 1.7];
const cam = { pos: eye, yaw: (yawDeg * Math.PI) / 180, pitch: -0.05 };
const vp = TerrainRenderer.viewProj(cam, 16 / 9, { reversed: true, near: 0.01 });
const capacities = scene.models.flatMap((m) => m.lods.map(() => m.count));
const out = capacities.map((c) => new Float32Array(c * 16)), counts = capacities.map(() => 0);
// (the shadow cascade's own view isn't rebuilt here: the camera's frustum, the cascade's distance)
const st = selectLods(scene, eye, vp, out, counts, shadow ? { lodScale: q.lodScale * 0.5, maxDistance: q.shadows.splits[q.shadows.cascades - 1] ?? 0, minRadius: 0.25 } : { lodScale: q.lodScale, distanceScale: q.distanceScale });

const tris = (m: { cgf: { meshes: { indices: Uint32Array }[] } }) => m.cgf.meshes.reduce((a, s) => a + s.indices.length / 3, 0);
const rows: { path: string; kind: string; tris: number; inst: number; lods: string }[] = [];
const byKind = new Map<string, number>(), byLod = new Map<number, number>();
let item = 0, total = 0;
for (const wm of scene.models) {
  let t = 0, n = 0;
  const lods: string[] = [];
  wm.lods.forEach((lod, l) => {
    const c = counts[item + l];
    if (!c) return;
    const tt = c * tris(lod);
    t += tt; n += c;
    lods.push(`${c}×L${l} (${tris(lod).toLocaleString()})`);
    byLod.set(l, (byLod.get(l) ?? 0) + tt);
  });
  item += wm.lods.length;
  if (!n) continue;
  total += t;
  byKind.set(wm.kind, (byKind.get(wm.kind) ?? 0) + t);
  rows.push({ path: wm.path, kind: wm.kind, tris: t, inst: n, lods: lods.join(", ") });
}
rows.sort((a, b) => b.tris - a.tris);
const M = (v: number) => `${(v / 1e6).toFixed(2)}M`;
console.log(`${q.label}${shadow ? " (shadow cascade casters)" : ""} at ${x},${y} facing ${yawDeg}°: ${M(total)} triangles in ${st.drawn.toLocaleString()} instances of ${rows.length} models (${scene.models.length} streamed)`);
console.log(`by kind: ${[...byKind].map(([k, v]) => `${k} ${M(v)}`).join(", ")}`);
console.log(`by LOD: ${[...byLod].sort((a, b) => a[0] - b[0]).map(([k, v]) => `L${k} ${M(v)}`).join(", ")}`);
for (const r of rows.slice(0, top)) console.log(`${M(r.tris).padStart(7)} ${(r.tris / total * 100).toFixed(1).padStart(5)}%  ${r.kind.padEnd(10)} ${r.path}  [${r.lods}]`);
lvl.vfs.workers?.terminate();
