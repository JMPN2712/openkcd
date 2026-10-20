// Player controller checks on Rataje's terrain (and, with --objects, its static objects):
// ground following, the climb limit, sliding, jumping, speeds; then Henry's avatar and clips.
// usage: node scripts/test-player.ts [--root GAME_ROOT]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { ASSET_RE } from "../src/assets.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { parseTerrain, heightAt } from "../src/terrain.ts";
import { PlayerController, terrainSurroundings, targetSpeed, PLAYER, GAIT_SPEED, type MoveInput } from "../src/player.ts";
import { PlayerAvatar, SimpleLocomotion } from "../src/playerAvatar.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak")) out.push(p);
  }
  return out;
}
const sources: PakSource[] = [];
for (const p of await findPaks(root)) {
  const blob = await openAsBlob(p);
  sources.push({ path: relative(root, p), size: blob.size, open: async () => blob });
}
const level = sources.find((s) => s.path.toLowerCase() === "data/levels/rataje/level.pak")!;
const lb = await level.open();
const tdat = (await readCentralDirectory(lb)).find((e) => e.name.toLowerCase() === "terrain/terrain.dat")!;
const terrain = parseTerrain(await readEntry(lb, tdat));
const h = (x: number, y: number) => heightAt(terrain, x, y);
const world = terrainSurroundings(h);

// --- speeds
const run: MoveInput = { forward: 1, right: 0, gait: "run", sprint: false };
check(Math.abs(targetSpeed(run).speed - GAIT_SPEED.run) < 1e-6, `run forwards ${targetSpeed(run).speed.toFixed(2)} m/s`);
check(Math.abs(targetSpeed({ ...run, sprint: true }).speed - GAIT_SPEED.run * 1.5) < 1e-6 && targetSpeed({ ...run, sprint: true }).gait === "sprint", `sprint ×1.5 = ${targetSpeed({ ...run, sprint: true }).speed.toFixed(2)} m/s`);
check(Math.abs(targetSpeed({ ...run, forward: 0, right: 1 }).speed - GAIT_SPEED.run * 0.75) < 1e-6, "strafe ×0.75");
check(Math.abs(targetSpeed({ ...run, forward: -1 }).speed - GAIT_SPEED.run * 0.7) < 1e-6, "backward ×0.7");
check(targetSpeed({ ...run, forward: -1, sprint: true }).gait !== "sprint", "no sprinting backwards");

// --- ground following: run 30 s across Rataje's fields south of the town
{
  const p = new PlayerController(world, [2192, 1000, 0], Math.PI / 2);
  let maxErr = 0, airborne = 0, maxSpeed = 0;
  for (let t = 0; t < 30; t += 1 / 60) {
    p.update(1 / 60, run);
    if (p.grounded) maxErr = Math.max(maxErr, Math.abs(p.pos[2] - h(p.pos[0], p.pos[1])));
    else airborne++;
    maxSpeed = Math.max(maxSpeed, p.speed());
  }
  check(maxErr < 0.02, `stays on the terrain while running (max error ${maxErr.toFixed(3)} m, ${airborne} airborne frames of 1800)`);
  check(Math.abs(maxSpeed - GAIT_SPEED.run) < 0.05, `reaches run speed (${maxSpeed.toFixed(2)} m/s)`);
  const d = Math.hypot(p.pos[0] - 2192, p.pos[1] - 1000);
  check(d > 30 * GAIT_SPEED.run * 0.8, `covers ${d.toFixed(0)} m in 30 s`);
}

// --- acceleration: inertia 11 reaches 95% of run speed in about 0.3 s
{
  const p = new PlayerController(world, [2192, 1000, 0], Math.PI / 2);
  let t95 = 0;
  for (let t = 0; t < 2; t += 1 / 120) {
    p.update(1 / 120, run);
    if (!t95 && p.speed() >= 0.95 * GAIT_SPEED.run) t95 = t;
  }
  check(t95 > 0.15 && t95 < 0.5, `speeds up to 95% in ${t95.toFixed(2)} s (inertia ${PLAYER.inertia})`);
}

// --- the climb limit: find the steepest terrain near the town and try to run up it
{
  const slope = (x: number, y: number) => {
    const gx = (h(x + 1, y) - h(x - 1, y)) / 2, gy = (h(x, y + 1) - h(x, y - 1)) / 2;
    return { deg: (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI, up: Math.atan2(gy, gx) };
  };
  let best = { x: 0, y: 0, deg: 0, up: 0 };
  for (let y = 400; y < 2400; y += 4) for (let x = 1400; x < 3200; x += 4) {
    const s = slope(x, y);
    if (s.deg > best.deg) best = { x, y, ...s };
  }
  console.log(`     steepest terrain sample: ${best.deg.toFixed(1)}° at (${best.x}, ${best.y})`);
  if (best.deg > 60) {
    // start a few metres downhill of it, run uphill for 8 s
    const sx = best.x - Math.cos(best.up) * 6, sy = best.y - Math.sin(best.up) * 6;
    const p = new PlayerController(world, [sx, sy, 0], best.up);
    const z0 = p.pos[2];
    let steepest = 0;
    for (let t = 0; t < 8; t += 1 / 60) {
      p.update(1 / 60, run);
      if (p.grounded) {
        const s = slope(p.pos[0], p.pos[1]).deg;
        // the slope he is standing on after the start (allow the 1 m sampling to smooth the edge)
        if (t > 1) steepest = Math.max(steepest, s);
      }
    }
    check(steepest < 62, `can't run up a ${best.deg.toFixed(0)}° face (steepest ground stood on ${steepest.toFixed(0)}°, climbed ${(p.pos[2] - z0).toFixed(1)} m)`);
  }
  // gentle hill: climbs fine
  let gentle: { x: number; y: number; up: number } | null = null;
  for (let y = 800; y < 2000 && !gentle; y += 7) for (let x = 1600; x < 3000 && !gentle; x += 7) {
    const s = slope(x, y);
    if (s.deg > 25 && s.deg < 35 && slope(x + Math.cos(s.up) * 5, y + Math.sin(s.up) * 5).deg > 20) gentle = { x, y, up: s.up };
  }
  if (gentle) {
    const p = new PlayerController(world, [gentle.x, gentle.y, 0], gentle.up);
    const z0 = p.pos[2];
    for (let t = 0; t < 2; t += 1 / 60) p.update(1 / 60, { ...run, gait: "walk" });
    check(p.pos[2] - z0 > 0.6, `walks up a ~30° slope (rose ${(p.pos[2] - z0).toFixed(2)} m in 2 s)`);
  }
}

// --- jump: 1 m apex, lands back on the ground
{
  const p = new PlayerController(world, [2192, 1000, 0], Math.PI / 2);
  for (let t = 0; t < 0.5; t += 1 / 60) p.update(1 / 60, { ...run, forward: 0 });
  const z0 = p.pos[2];
  p.update(1 / 60, { ...run, forward: 0, jump: true });
  let apex = 0, landed = -1;
  for (let t = 0; t < 2; t += 1 / 60) {
    p.update(1 / 60, { ...run, forward: 0 });
    apex = Math.max(apex, p.pos[2] - z0);
    if (landed < 0 && t > 0.1 && p.grounded) landed = t;
  }
  check(Math.abs(apex - 1) < 0.08, `jump apex ${apex.toFixed(2)} m (jump height 1 m)`);
  check(landed > 0.6 && landed < 0.9, `lands after ${landed.toFixed(2)} s`);
}

// --- falling: dropped from 20 m lands, gravity 13
{
  const x = 2192, y = 1000;
  const p = new PlayerController(world, [x, y, 0], 0);
  p.pos[2] = h(x, y) + 20;
  p.grounded = false;
  let t = 0;
  while (!p.grounded && t < 5) { p.update(1 / 60, { ...run, forward: 0 }); t += 1 / 60; }
  const expect = Math.sqrt((2 * 20) / PLAYER.gravity);
  check(p.grounded && Math.abs(t - expect) < 0.05, `falls 20 m in ${t.toFixed(2)} s (expected ${expect.toFixed(2)} s at 13 m/s²)`);
}

// --- Henry: soul, skeleton, clips, camera bone
{
  const vfs = await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => ASSET_RE.test(n), includeHd: false });
  const t0 = performance.now();
  const avatar = await PlayerAvatar.load(vfs, { maxTextureDim: 64 });
  console.log(`     Henry loaded in ${Math.round(performance.now() - t0)} ms: ${avatar.character.parts.map((p) => p.part.label).join(", ")}`);
  check(avatar.character.parts.some((p) => p.part.kind === "head"), "Henry has a head part");
  for (const n of ["relaxed_idle_both", "relaxed_walk_medium_player", "relaxed_run_medium_player", "relaxed_sprint_fast_player"]) {
    const c = avatar.clip(n);
    check(!!c?.motion, `${n}: ${c ? `${((c.end - c.start) / c.fps).toFixed(2)} s, ${c.motion!.moveSpeed.toFixed(2)} m/s, travel ${c.motion!.travel.map((v) => v.toFixed(2))}` : "missing"}`);
  }
  const loco = new SimpleLocomotion(avatar);
  avatar.place([0, 0, 0], Math.PI / 2);
  loco.update(0.1, 3.57, "run");
  const cam = avatar.bonePos("camera");
  check(!!cam && Math.abs(cam[2] - PLAYER.eyeHeight) < 0.15, `camera bone while running at ${cam?.map((v) => v.toFixed(2))} (stance eye height ${PLAYER.eyeHeight})`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
