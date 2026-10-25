// Node test for src/navmesh.ts on Rataje (read-only): indexes the level's
// navmesh, finds a few routes and checks that every path segment stays on the
// mesh (midpoints over a walkable polygon, or a doorway hop), climbs no steeper than stairs and
// is no shorter than the straight line.
// First, whole-mesh checks from the format note: every tile decodes, indices are
// in range, and every internal neighbour shares its edge in reverse.
// usage: node scripts/test-navmesh.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { EXTERNAL_LINK, NavMesh, type Vec3 } from "../src/navmesh.ts";
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

let fails = 0;
{
  t0 = performance.now();
  let tiles = 0, polys = 0, verts = 0, shared = 0, bad = 0;
  for (const t of nav.allTiles()) {
    tiles++; polys += t.polyCount; verts += t.verts.length / 3;
    for (let k = 0; k < t.polyCount; k++) {
      const n = t.polyN[k];
      if (n === 2) continue; // off-mesh connection
      const vi = (q: number, j: number) => t.polyVerts[q * 6 + j];
      if (n < 3 || n > 6) { bad++; continue; }
      for (let j = 0; j < n; j++) {
        if (vi(k, j) * 3 >= t.verts.length) { bad++; continue; }
        const code = t.polyNeis[k * 6 + j];
        if (code === 0 || code & EXTERNAL_LINK) continue;
        const q = code - 1, m = t.polyN[q];
        const a = vi(k, j), b = vi(k, (j + 1) % n);
        let ok = false;
        for (let i = 0; i < m && !ok; i++) ok = vi(q, i) === b && vi(q, (i + 1) % m) === a;
        if (ok) shared++; else bad++;
      }
    }
  }
  const ok = bad === 0 && tiles === nav.tileCount;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} whole mesh: ${tiles} tiles, ${polys} polys, ${verts} verts, ${shared} internal edges shared, ${bad} bad (${Math.round(performance.now() - t0)} ms)`);
}

const level = await openAsBlob(join(root, "Data/Levels/rataje/level.pak"));
const tdat = (await readCentralDirectory(level)).find((e) => e.name.toLowerCase() === "terrain/terrain.dat")!;
const terrain = parseTerrain(await readEntry(level, tdat));
const at = (x: number, y: number): Vec3 => [x, y, heightAt(terrain, x, y)];

const routes: [string, Vec3, Vec3][] = [
  ["guard 8: home → garrison (Rataje)", at(2597, 565), at(2698, 600)],
  ["Rataje market → bakery", at(2578, 563), at(2603, 569)],
  ["across Rataje (west gate area → east)", at(2520, 600), at(2660, 590)],
  // through the house door (an off-mesh connection) and up the stairs, to a room on a layer of its own
  ["Rataje: the tailor's table → his home upstairs", [2520.83, 543.95, 77.76], [2525.28, 536.67, 81.6]],
];
/** Whether segment p–q is one of the mesh's off-mesh connections (a doorway hop), either way. */
const doorway = (p: Vec3, q: Vec3) => {
  const close = (u: Vec3, v: Vec3) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]) < 0.05;
  const tx = Math.floor(p[0] / nav.tileSize), ty = Math.floor(p[1] / nav.tileSize);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const t of nav.tilesAt(tx + dx, ty + dy)) {
    if (t.offMesh.some((c) => (close(c.a, p) && close(c.b, q)) || (close(c.a, q) && close(c.b, p)))) return true;
  }
  return false;
};
for (const [name, a, b] of routes) {
  t0 = performance.now();
  const path = nav.findPath(a, b, 200000);
  const ms = performance.now() - t0;
  if (!path) {
    console.log(`${name}: NO PATH (${Math.round(ms)} ms)`);
    fails++;
    continue;
  }
  let len = 0, off = 0, doors = 0, steep = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1], q = path[i];
    len += Math.hypot(q[0] - p[0], q[1] - p[1]);
    const mid: Vec3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    // no climbing steeper than stairs (a straight line up through a ceiling)
    if (Math.abs(q[2] - p[2]) > Math.hypot(q[0] - p[0], q[1] - p[1]) + 0.4) steep++;
    if (doorway(p, q)) doors++;
    else if (!nav.findPoly(mid, 0.3)) {
      off++;
      const near = nav.findPoly(mid, 50);
      console.log(`   off-mesh segment ${i}: ${p.map((v) => v.toFixed(1))} → ${q.map((v) => v.toFixed(1))} (${Math.hypot(q[0] - p[0], q[1] - p[1]).toFixed(1)} m); a poly within 50 m: ${near ? `tile ${near.tile.x},${near.tile.y} L${near.tile.layer}` : "none"}`);
    }
  }
  const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ok = off === 0 && steep === 0 && len >= straight - 0.5 && Math.abs(path[path.length - 1][2] - (nav.findPoly(b)?.point?.[2] ?? b[2])) < 0.5;
  if (!ok) fails++;
  console.log(`${name}: ${path.length} corners, ${len.toFixed(1)} m (straight ${straight.toFixed(1)} m), ${off} segment midpoints off the mesh, ${doors} doorways, ${steep} too steep, ${Math.round(ms)} ms ${ok ? "" : "FAIL"}`);
  console.log(`   ${path.slice(0, 8).map((p) => p.map((v) => v.toFixed(1)).join(",")).join("  ")}${path.length > 8 ? "  …" : ""}`);
}
console.log(fails ? `FAIL (${fails})` : "OK");
if (fails) process.exit(1);
