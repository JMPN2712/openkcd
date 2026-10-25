// Doors on Rataje (src/doors.ts, read-only): the doors in a scene around the tailor's house, as
// the world view streams them.
// - The doors of the editor layers shown at game start load too (Skalitz, Rattay castle's hall).
// - Every door has its leaf box, and its open pose (the end of its front clip) swings the leaf
//   80–100° about its hinge: the box's hinge edge stays within 0.15 m, the far edge moves.
// - Using the tailor's house door from inside (its front: the door's −Y side, by the door script's
//   test) plays door_r_f_o_player to the end (open), and using it again door_r_f_c_player back to
//   the closed pose.
// - Collision: a ray through the doorway at 1 m height hits the closed leaf and passes the open one.
// usage: node scripts/test-doors.ts [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { openRataje } from "./lib.ts";
import { buildWorldScene, newWorldCaches } from "../src/world.ts";
import { CollisionWorld } from "../src/collision.ts";
import { heightAt } from "../src/terrain.ts";
import { Doors, type Door } from "../src/doors.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const lvl = await openRataje(root, { cover: false });
const doors = new Doors(lvl.vfs, lvl.props);
const all = [...doors.doors.values()];
console.log(`${all.length} doors in Rataje: ${all.filter((d) => d.right).length} right, ${all.filter((d) => !d.right).length} left, ${all.filter((d) => d.locked).length} locked`);
// the mission's 866 and the visible layers' (levelLayers.ts layerDoors): Skalitz around Henry's
// home, Rattay castle's hall door
const skalitz = all.find((d) => Math.hypot(d.entity.pos[0] - 793.4, d.entity.pos[1] - 3459.6) < 0.3);
const hall = all.find((d) => Math.hypot(d.entity.pos[0] - 2700.3, d.entity.pos[1] - 664.1) < 0.3);
check(all.length > 866 && !!skalitz && !!hall && !hall.locked, `doors from the visible editor layers: ${all.length - 866} more, among them Skalitz's by Henry's home and Rattay castle's hall door (unlocked)`);
doors.preload();
await doors.ready();

const centre: [number, number] = [2522, 533];
const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, centre, 60, { maxModels: 20000, caches: newWorldCaches(), props: lvl.props, hiddenLayers: lvl.hiddenLayers });
doors.attach(scene);
const here = doors.near([centre[0], centre[1], 80], 60).map((id) => doors.doors.get(id)!);
console.log(`${here.length} doors in the scene within 60 m`);

/** The leaf's matrix applied to a model-space point (entity frame left out: leaf only). */
const apply = (m: Float32Array, p: number[]) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
let swung = 0;
const bad: string[] = [];
for (const d of here) {
  const box = (doors as unknown as { boxes: Map<number, Float32Array> }).boxes.get(d.entity.id);
  if (!box) { bad.push(`${d.entity.name}: no leaf box`); continue; }
  if (!doors.set(d, true)) { bad.push(`${d.entity.name}: no clip`); continue; }
  const angle = (Math.atan2(d.leaf[1], d.leaf[0]) * 180) / Math.PI;
  // the hinge is the box's vertical edge nearer the pivot (model x = 0)
  const hx = Math.abs(box[0]) < Math.abs(box[3]) ? box[0] : box[3], fx = hx === box[0] ? box[3] : box[0];
  const ym = (box[1] + box[4]) / 2, zm = (box[2] + box[5]) / 2;
  const move = (x: number) => { const q = apply(d.leaf, [x, ym, zm]); return Math.hypot(q[0] - x, q[1] - ym, q[2] - zm); };
  if (Math.abs(Math.abs(angle) - 90) > 10) bad.push(`${d.entity.name}: opens ${angle.toFixed(0)}°`);
  else if (move(hx) > 0.15 || move(fx) < 0.8) bad.push(`${d.entity.name}: hinge edge moves ${move(hx).toFixed(2)} m, far edge ${move(fx).toFixed(2)} m`);
  else swung++;
  doors.set(d, false);
}
check(here.length > 20 && bad.length === 0, `${swung} of ${here.length} doors swing about their hinge by 80–100°${bad.length ? `; ${bad.slice(0, 4).join("; ")}` : ""}`);

// the tailor's house door, used from inside the house: in front, the side its +Y axis points away from
const door: Door | undefined = here.find((d) => d.entity.name === "AnimDoor_494ae3b1-cb0f-0ef8-c489-91230c05008c");
check(!!door, "the tailor's house door is in the scene");
if (door) {
  const [w, x, y, z] = door.entity.rot;
  const fwd = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z)];
  const inside: [number, number, number] = [door.entity.pos[0] - fwd[0] * 1.2, door.entity.pos[1] - fwd[1] * 1.2, door.entity.pos[2]];
  const world = new CollisionWorld((px, py) => heightAt(lvl.terrain, px, py));
  world.setScene(scene);
  // through the middle of the leaf's box (shut: its model x runs along the door's x axis, from the hinge)
  const box = (doors as unknown as { boxes: Map<number, Float32Array> }).boxes.get(door.entity.id)!;
  const along = (box[0] + box[3]) / 2, xa = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z)];
  const c = door.entity.pos, mid = [c[0] + xa[0] * along, c[1] + xa[1] * along, c[2] + 1];
  // from 0.8 m outside to 0.3 m inside (further in, the rooms begin)
  const ray = () => world.raycast([mid[0] - fwd[0] * 0.8, mid[1] - fwd[1] * 0.8, mid[2]], [mid[0] + fwd[0] * 0.3, mid[1] + fwd[1] * 0.3, mid[2]]);
  check(ray() === null, "without the leaf the doorway is open (the house's collision leaves it free)");
  world.setDynamic(1, doors.collider(door.entity.id));
  check(ray() !== null, "the shut door blocks the doorway");
  // the game's user spots (DoorRight helpers Front / Back: 0.6 m along the leaf, 0.7 m out)
  const at = (lx: number, ly: number): [number, number, number] => [c[0] + xa[0] * lx + fwd[0] * ly, c[1] + xa[1] * lx + fwd[1] * ly, c[2]];
  const front = at(-0.6, -0.7), back = at(-0.6, 0.7);
  check(doors.action(door) === "open" && doors.use(door, inside), "E from inside starts door_r_f_o_player");
  const spot = doors.clearSpot(door, front);
  const reach = spot && Math.hypot(spot[0] - c[0], spot[1] - c[1]);
  check(!!spot && reach! > 1.4 && doors.clearSpot(door, back) === null, `opening towards Henry at the Front helper steps him ${spot ? Math.hypot(spot[0] - front[0], spot[1] - front[1]).toFixed(2) : "?"} m out of the swing (to ${reach?.toFixed(2)} m from the hinge); from the Back helper it swings away`);
  let t = 0;
  while (door.clip && t < 10) { doors.step(0.1); t += 0.1; }
  check(door.open && Math.abs(Math.abs((Math.atan2(door.leaf[1], door.leaf[0]) * 180) / Math.PI) - 90) < 10, `open after ${t.toFixed(1)} s`);
  world.setDynamic(1, doors.collider(door.entity.id));
  check(ray() === null, "the open door leaves the doorway clear");
  check(doors.action(door) === "close" && doors.use(door, inside), "E again starts closing it");
  t = 0;
  while (door.clip && t < 10) { doors.step(0.1); t += 0.1; }
  check(!door.open && door.leaf[0] === 1 && door.leaf[12] === 0, `shut after ${t.toFixed(1)} s`);
}
console.log(failures ? `FAIL (${failures})` : "OK");
if (failures) process.exit(1);
