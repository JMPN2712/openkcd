// Walls for the crowd (src/navBlockers.ts, navmesh.ts findPath; read-only): Skalitz's palisade
// pieces joined into walls; the crowd's steering walked NPCs through it.
// - The shown walls load; a route out through Skalitz's west gate still goes through the gate.
// - The navmesh's routes around Skalitz don't cross them (the walls agree with the mesh).
// - A step straight through the palisade beside the west gate is a crossing (the crowd refuses it),
//   one through the gateway is not.
// usage: node scripts/test-walls.ts [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { openRataje } from "./lib.ts";
import { NavMesh } from "../src/navmesh.ts";
import { heightAt } from "../src/terrain.ts";
import { wallBlockers, Blockers } from "../src/navBlockers.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { defaultGameRoot } from "./paths.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", defaultGameRoot);

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const L = await openRataje(root, { cover: false });
const rb = await L.sources.find((s) => s.path.toLowerCase() === "data/levels/rataje/recast.pak")!.open();
const nav = new NavMesh(await readEntry(rb, (await readCentralDirectory(rb)).find((e) => e.name.toLowerCase() === "recast/rdnavmesh_1.nav")!));
let t0 = performance.now();
const walls = new Blockers(await wallBlockers(L.vfs, L.objects, L.terrain.brushNames, L.hiddenLayers));
const kinds = new Map<string, number>();
for (const b of walls.list) kinds.set(b.kind ?? "?", (kinds.get(b.kind ?? "?") ?? 0) + 1);
check(walls.list.length > 1000 && (kinds.get("wall") ?? 0) > 0 && (kinds.get("join") ?? 0) > 0, `${walls.list.length} walls in ${(performance.now() - t0).toFixed(0)} ms (${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")})`);

const at = (x: number, y: number): [number, number, number] => [x, y, heightAt(L.terrain, x, y)];
const crosses = (p: number[][]) => { for (let i = 1; i < p.length; i++) if (walls.crosses(p[i - 1], p[i], 0)) return true; return false; };
nav.blockers = walls;
// out of the village through the west gate (750, 3530)
const out = nav.findPath(at(760, 3515), at(738, 3548), 60000);
const nearGate = !!out && out.some((p, i) => i > 0 && Math.hypot((p[0] + out[i - 1][0]) / 2 - 750, (p[1] + out[i - 1][1]) / 2 - 3531) < 4);
check(!!out && !crosses(out) && nearGate, `out of the village through the west gate (${out?.map((p) => p.slice(0, 2).map((v) => v.toFixed(0)).join(",")).join(" → ")})`);

// random routes around Skalitz
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
let n = 0, meshCross = 0, around = 0, ms = 0;
for (let k = 0; k < 300; k++) {
  const a = at(700 + rnd() * 200, 3380 + rnd() * 200), b = at(700 + rnd() * 200, 3380 + rnd() * 200);
  if (walls.inside(a, 0.3) || walls.inside(b, 0.3)) continue;
  nav.blockers = null;
  const p = nav.findPath(a, b, 60000);
  if (!p) continue;
  n++;
  if (!crosses(p)) continue;
  meshCross++;
  nav.blockers = walls;
  t0 = performance.now();
  const q = nav.findPath(a, b, 60000);
  ms += performance.now() - t0;
  if (q && !crosses(q)) around++;
}
check(n > 200 && meshCross <= n * 0.02, `${n} routes around Skalitz on the navmesh: ${meshCross} cross a wall${meshCross ? ` (${around} go around with the walls known)` : ""}`);
// beside the west gate (750, 3530): the palisade runs east-west at about y 3533 west of the tower
check(walls.crosses(at(740, 3530), at(740, 3538)), "a step through the palisade beside the west gate crosses a wall");
check(!walls.crosses(at(750.5, 3528), at(749.5, 3535)), "a step through the gateway does not");
console.log(failures ? `${failures} FAILED` : "OK");
process.exit(failures ? 1 : 0);
