// Node test for src/navmesh.ts on Rataje (read-only): indexes the level's
// navmesh, finds a few routes and checks that every path segment stays on the
// mesh (midpoints over a walkable polygon) and is no shorter than the straight line.
// usage: node scripts/test-navmesh.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { NavMesh, type Vec3 } from "../src/navmesh.ts";
import { parseTerrain, heightAt } from "../src/terrain.ts";

const root = process.argv[2] ?? join(homedir(), "kcd1");
const pak = await openAsBlob(join(root, "Data/Levels/rataje/recast.pak"));
const entry = (await readCentralDirectory(pak)).find((e) => e.name.toLowerCase() === "recast/rdnavmesh_1.nav")!;
let t0 = performance.now();
const bytes = await readEntry(pak, entry);
const tRead = performance.now() - t0;
t0 = performance.now();
const nav = new NavMesh(bytes);
console.log(`navmesh: ${nav.tileCount} tiles of ${nav.tileSize} m (read ${Math.round(tRead)} ms, indexed ${Math.round(performance.now() - t0)} ms)`);

const level = await openAsBlob(join(root, "Data/Levels/rataje/level.pak"));
const tdat = (await readCentralDirectory(level)).find((e) => e.name.toLowerCase() === "terrain/terrain.dat")!;
const terrain = parseTerrain(await readEntry(level, tdat));
const at = (x: number, y: number): Vec3 => [x, y, heightAt(terrain, x, y)];

const routes: [string, Vec3, Vec3][] = [
  ["guard 8: home → garrison (Rataje)", at(2597, 565), at(2698, 600)],
  ["Rataje market → bakery", at(2578, 563), at(2603, 569)],
  ["across Rataje (west gate area → east)", at(2520, 600), at(2660, 590)],
];
let fails = 0;
for (const [name, a, b] of routes) {
  t0 = performance.now();
  const path = nav.findPath(a, b, 200000);
  const ms = performance.now() - t0;
  if (!path) {
    console.log(`${name}: NO PATH (${Math.round(ms)} ms)`);
    fails++;
    continue;
  }
  let len = 0, off = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1], q = path[i];
    len += Math.hypot(q[0] - p[0], q[1] - p[1]);
    const mid: Vec3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    if (!nav.findPoly(mid, 0.3)) {
      off++;
      const near = nav.findPoly(mid, 50);
      console.log(`   off-mesh segment ${i}: ${p.map((v) => v.toFixed(1))} → ${q.map((v) => v.toFixed(1))} (${Math.hypot(q[0] - p[0], q[1] - p[1]).toFixed(1)} m); a poly within 50 m: ${near ? `tile ${near.tile.x},${near.tile.y} L${near.tile.layer}` : "none"}`);
    }
  }
  const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ok = off === 0 && len >= straight - 0.5;
  if (!ok) fails++;
  console.log(`${name}: ${path.length} corners, ${len.toFixed(1)} m (straight ${straight.toFixed(1)} m), ${off} segment midpoints off the mesh, ${Math.round(ms)} ms ${ok ? "" : "FAIL"}`);
  console.log(`   ${path.slice(0, 8).map((p) => p.map((v) => v.toFixed(1)).join(",")).join("  ")}${path.length > 8 ? "  …" : ""}`);
}
console.log(fails ? `FAIL (${fails})` : "OK");
if (fails) process.exit(1);
