// Player collision on Rataje: which collision source each model uses (by object category),
// then random runs through the town checking the capsule never ends up inside geometry or
// under the ground, and timing the controller.
// usage: node scripts/test-collision.ts [--at x,y] [--radius R] [--runs N] [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { heightAt } from "../src/terrain.ts";
import { buildWorldScene, newWorldCaches } from "../src/world.ts";
import { CollisionWorld, type CollisionSource } from "../src/collision.ts";
import { PlayerController, PLAYER, type MoveInput } from "../src/player.ts";
import { openRataje } from "./lib.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const [cx, cy] = opt("--at", "2577.8,574").split(",").map(Number);
const radius = Number(opt("--radius", "200"));
const runs = Number(opt("--runs", "150"));

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

const lvl = await openRataje(root, { cover: false });
const t0 = performance.now();
const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, [cx, cy], radius, { maxModels: 20000, caches: newWorldCaches(), props: lvl.props, hiddenLayers: lvl.hiddenLayers });
console.log(`scene: ${scene.models.length} models, ${scene.instances} instances within ${radius} m (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
const h = (x: number, y: number) => heightAt(lvl.terrain, x, y);
const world = new CollisionWorld(h);
world.setScene(scene);

// --- sources by category
const cats = new Map<string, Record<CollisionSource, number>>();
const t1 = performance.now();
for (const wm of scene.models) {
  const s = world.shapeOf(wm).source;
  const cat = wm.path.includes("|") || wm.path.endsWith(".skin") ? "doors and animated props (.cdf skins)" : wm.kind === "vegetation" ? `vegetation: ${wm.path.split("/").slice(1, 3).join("/")}` : wm.path.startsWith("brush/") ? "level brushes (designer geometry)" : wm.path.split("/").slice(0, 3).join("/");
  const c = cats.get(cat) ?? { proxy: 0, render: 0, visible: 0, none: 0 };
  c[s]++;
  cats.set(cat, c);
}
console.log(`collision shapes chosen in ${Math.round(performance.now() - t1)} ms: ${Object.entries(world.stats).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log("category | proxy | render | visible | none");
for (const [k, c] of [...cats].sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y) - Object.values(a[1]).reduce((x, y) => x + y)).slice(0, 40))
  console.log(`${k} | ${c.proxy} | ${c.render} | ${c.visible} | ${c.none}`);

// --- random runs: never inside geometry, never under the ground
let rnd = 12345;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
let worstAt = "";
let worstPen = 0, under = 0, steps = 0, stuck = 0, ms = 0;
for (let r = 0; r < runs; r++) {
  const x = cx + (rand() - 0.5) * radius, y = cy + (rand() - 0.5) * radius;
  const p = new PlayerController(world, [x, y, 0], rand() * Math.PI * 2);
  // start somewhere free: skip spawns inside geometry
  const [a0, b0] = p.capsule();
  if (world.depenetrate(a0, b0, PLAYER.radius).normal) continue;
  const input: MoveInput = { forward: 1, right: rand() < 0.3 ? (rand() < 0.5 ? -1 : 1) : 0, gait: "run", sprint: rand() < 0.4 };
  const start = [...p.pos];
  for (let t = 0; t < 6; t += 1 / 60) {
    if (Math.floor(t * 2) !== Math.floor((t - 1 / 60) * 2) && rand() < 0.3) p.yaw += (rand() - 0.5) * 2;
    const q0 = performance.now();
    p.update(1 / 60, input);
    ms += performance.now() - q0;
    steps++;
    const [a, b] = p.capsule();
    const { push, normal } = world.depenetrate(a, b, PLAYER.radius);
    const pen = Math.hypot(push[0], push[1]);
    if (pen > worstPen) { worstPen = pen; worstAt = `at ${p.pos.map((v) => v.toFixed(2))} push ${push.map((v) => v.toFixed(3))} normal ${normal?.map((v) => v.toFixed(2))} ${p.grounded ? "grounded" : "airborne"}`; }
    if (p.pos[2] < h(p.pos[0], p.pos[1]) - 0.1) under++;
  }
  if (Math.hypot(p.pos[0] - start[0], p.pos[1] - start[1]) < 1) stuck++;
}
console.log(`     ${steps} frames, controller ${(ms / steps).toFixed(3)} ms per 1/60 s frame (with collision)`);
check(worstPen < 0.05, `capsule never more than 5 cm inside geometry after a frame (worst ${(worstPen * 100).toFixed(1)} cm ${worstAt})`);
check(under === 0, `never below the terrain (${under} frames)`);
console.log(`     ${stuck} of ${runs} runs ended within 1 m of their start (boxed in by walls)`);
check(ms / steps < 2, "controller costs under 2 ms a frame");

// --- a wall stops him: run at the nearest wall-like triangle of a building in the market
{
  const p = new PlayerController(world, [2577.8, 574, 0], -Math.PI / 2);
  for (let t = 0; t < 5; t += 1 / 60) p.update(1 / 60, { forward: 1, right: 0, gait: "run", sprint: false });
  check(p.pos[1] > 558, `running south from the market spawn stops at the house (y ${p.pos[1].toFixed(2)}, free run would reach ${(574 - 5 * 3.57).toFixed(1)})`);
}

// --- camera arm: a ray from the market spawn south hits the hay pile or the house (16 m away) first; up is clear
{
  const z = h(2577.8, 574) + 1.7;
  const hit = world.raycast([2577.8, 574, z], [2577.8, 550, z]);
  check(hit !== null && hit * 24 < 16, `ray south from the spawn first hits something after ${hit === null ? "nothing" : `${(hit * 24).toFixed(1)} m`}`);
  check(world.raycast([2577.8, 574, z], [2577.8, 574, z + 30]) === null, "ray straight up is clear");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
