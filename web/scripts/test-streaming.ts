// Streaming across the whole map: a route through Rataje's settlements (the densest brush cells),
// rebuilding the streamed scene every STEP metres like the world view, reporting load time and
// memory as it goes. Fails if memory keeps growing after the caches should have levelled off.
// usage: node --expose-gc scripts/test-streaming.ts [--preset medium] [--towns 8] [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { buildWorldScene, newWorldCaches, trimWorldCaches } from "../src/world.ts";
import { PRESETS, type PresetName } from "../src/quality.ts";
import { openRataje } from "./lib.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const q = PRESETS[opt("--preset", "medium") as PresetName];
const towns = Number(opt("--towns", "8"));
const keepAll = args.includes("--no-trim");

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const lvl = await openRataje(root, { cover: false });
const { terrain, objects } = lvl;

// settlements: the densest 256 m cells of brushes, at least 600 m apart
const cells = new Map<number, number>();
for (let i = 0; i < objects.brushName.length; i++) {
  const x = objects.brushMatrix[i * 16 + 12], y = objects.brushMatrix[i * 16 + 13];
  if (x < 0 || y < 0 || x >= terrain.size || y >= terrain.size) continue;
  const k = Math.floor(x / 256) * 64 + Math.floor(y / 256);
  cells.set(k, (cells.get(k) ?? 0) + 1);
}
const stops: [number, number][] = [];
for (const [k] of [...cells].sort((a, b) => b[1] - a[1])) {
  const p: [number, number] = [(Math.floor(k / 64) + 0.5) * 256, ((k % 64) + 0.5) * 256];
  if (stops.every((s) => Math.hypot(s[0] - p[0], s[1] - p[1]) > 600)) stops.push(p);
  if (stops.length >= towns) break;
}
// visit them nearest-neighbour first, then twice round (the second lap should not grow memory)
const route: [number, number][] = [stops[0]];
const left = stops.slice(1);
while (left.length) {
  const last = route[route.length - 1];
  left.sort((a, b) => Math.hypot(a[0] - last[0], a[1] - last[1]) - Math.hypot(b[0] - last[0], b[1] - last[1]));
  route.push(left.shift()!);
}
console.log(`route: ${route.map((p) => `(${p[0]}, ${p[1]})`).join(" → ")}, twice`);
const STEP = q.streamRadius * 0.3;
const points: [number, number][] = [];
for (let lap = 0; lap < 2; lap++) for (let i = 0; i < route.length; i++) {
  const a = route[i], b = route[(i + 1) % route.length];
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / STEP));
  for (let s = 0; s < n; s++) points.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
}
console.log(`${points.length} scene rebuilds of ${q.streamRadius} m every ${STEP.toFixed(0)} m (${q.label})`);

const caches = newWorldCaches();
const gc = (globalThis as { gc?: () => void }).gc;
const mem = () => { gc?.(); const m = process.memoryUsage(); return (m.heapUsed + m.arrayBuffers) / 2 ** 20; };
const base = mem();
const samples: number[] = [];
let worst = 0, total = 0;
for (const [i, at] of points.entries()) {
  const t0 = performance.now();
  const scene = await buildWorldScene(lvl.vfs, terrain, objects, at, q.streamRadius, { maxModels: 20000, maxTextureDim: q.maxTextureDim, caches, props: lvl.props, hiddenLayers: lvl.hiddenLayers, normalMaps: q.normalMaps });
  if (!keepAll) trimWorldCaches(caches);
  const ms = performance.now() - t0;
  worst = Math.max(worst, ms);
  total += ms;
  const m = mem() - base;
  samples.push(m);
  if (i % 10 === 0 || i === points.length - 1) console.log(`     ${String(i).padStart(3)} at (${at[0].toFixed(0)}, ${at[1].toFixed(0)}): ${scene.models.length} models, ${(ms / 1000).toFixed(1)} s, memory +${m.toFixed(0)} MiB, cached models ${caches.models.size}`);
}
const half = Math.floor(samples.length / 2);
const lap1 = Math.max(...samples.slice(0, half)), lap2 = Math.max(...samples.slice(half));
console.log(`     scene rebuild: mean ${(total / points.length / 1000).toFixed(2)} s, worst ${(worst / 1000).toFixed(1)} s`);
check(lap2 <= lap1 * 1.1 + 50, `memory levels off: peak +${lap1.toFixed(0)} MiB on the first lap, +${lap2.toFixed(0)} MiB on the second`);
check(samples[samples.length - 1] < 2048, `memory after the route +${samples[samples.length - 1].toFixed(0)} MiB (under 2 GiB)`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
