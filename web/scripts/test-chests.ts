// Chests on Rataje (src/chests.ts, src/anm.ts, read-only): every chest model's _open.anm decodes to
// a lid turning 5–30°; in a scene around the tailor's house each chest's lid is drawn apart from
// its body, opens with E (its lid's middle rises), closes again, and an unlocked chest lists
// its contents by their English names.
// usage: node scripts/test-chests.ts [--root GAME_ROOT]

import { openAsBlob } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openRataje } from "./lib.ts";
import { buildWorldScene, newWorldCaches } from "../src/world.ts";
import { parseAnm, swing } from "../src/anm.ts";
import { Chests } from "../src/chests.ts";
import { Localization } from "../src/localization.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const lvl = await openRataje(root, { cover: false });
const chests = new Chests(lvl.vfs, lvl.props);
const all = [...chests.chests.values()];

// every chest model's opening
const models = [...new Set(all.map((c) => c.entity.model!.toLowerCase()))];
const swings: string[] = [];
let animated = 0, odd = 0;
for (const m of models) {
  const hit = lvl.vfs.lookup(m.replace(/\.cga$/, "_open.anm"));
  if (!hit) continue;
  const node = parseAnm(await lvl.vfs.read(hit))[0];
  const s = node && swing(node);
  const deg = s ? Math.abs((s.at(s.duration) * 180) / Math.PI) : 0;
  if (s && deg >= 5 && deg <= 30 && s.duration > 0.3 && s.duration < 3) animated++;
  else odd++;
  swings.push(`${m.split("/").pop()} ${node?.name} ${deg.toFixed(0)}° in ${s?.duration.toFixed(2)} s`);
}
console.log(swings.slice(0, 8).join("\n"));
check(animated >= 5 && odd === 0, `${animated} chest models open their lid by 5–30° (${odd} odd); ${all.length} chest entities`);

const text = new Localization();
const blob = await openAsBlob(join(root, "Localization/English_xml.pak"));
check(await text.load([{ path: "Localization/English_xml.pak", size: blob.size, open: async () => blob }], ["text_ui_items"]) && text.get("ui_nm_club") === "Bludgeon", "English item names load (ui_nm_club → Bludgeon)");

const centre: [number, number] = [2522, 533];
const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, centre, 60, { maxModels: 20000, caches: newWorldCaches(), props: lvl.props, hiddenLayers: lvl.hiddenLayers });
const placed = chests.attach(scene);
await chests.settle();
const lids = scene.models.filter((m) => m.path.includes("#lid:"));
const bodies = scene.models.filter((m) => m.path.includes("#body:"));
check(lids.length > 0 && lids.every((l) => l.lods[0].cgf.meshes.length > 0) && bodies.every((b) => b.lods.every((m) => m.cgf.meshes.length > 0)), `chest lids drawn apart: ${lids.length} lid and ${bodies.length} body models (${placed.length} open at start)`);

const near = all.filter((c) => Math.hypot(c.entity.pos[0] - centre[0], c.entity.pos[1] - centre[1]) < 60 && chests.action(c) === "open");
const c = near.find((x) => [...chests.matrices(x.entity.id)].length);
check(!!c, `${near.length} unlocked chests within 60 m`);
if (c) {
  const [before] = [...chests.matrices(c.entity.id)];
  const lidModel = lids.find((l) => l.entities && [...l.entities].includes(c.entity.id))!;
  const mesh = lidModel.lods[0].cgf.meshes[0];
    // the lid's middle: an opening lid (hinged at an edge) lifts it
  const corner = [0, 1, 2].map((k) => (mesh.bboxMin[k] + mesh.bboxMax[k]) / 2);
  const t = mesh.transform, lp = [0, 1, 2].map((r) => t[r] * corner[0] + t[4 + r] * corner[1] + t[8 + r] * corner[2] + t[12 + r]);
  const world = (m: Float32Array) => [0, 1, 2].map((r) => m[r] * lp[0] + m[4 + r] * lp[1] + m[8 + r] * lp[2] + m[12 + r]);
  const w0 = world(before.m), z0 = w0[2];
  check(chests.use(c), `E opens ${c.entity.name} (${c.entity.model!.split("/").pop()})`);
  let t2 = 0;
  while (c.dir !== 0 && t2 < 5) { chests.step(0.05); t2 += 0.05; }
  const [after] = [...chests.matrices(c.entity.id)];
  const w1 = world(after.m);
  const moved = Math.hypot(w1[0] - w0[0], w1[1] - w0[1], w1[2] - w0[2]);
  check(c.open && moved > 0.02 && w1[2] > z0 + 0.01, `open after ${t2.toFixed(2)} s: the lid's middle moved ${moved.toFixed(2)} m and up ${(w1[2] - w0[2]).toFixed(2)} m`);
  const items = await chests.contents(c, text);
  console.log(`   contents: ${items.slice(0, 8).map((i) => `${i.name} ×${i.amount}${i.maybe ? " (maybe)" : ""}`).join(", ")}${items.length > 8 ? ", …" : ""}`);
  check(items.length > 0 && items.some((i) => /^[A-Z]/.test(i.name)), `${items.length} items listed by name`);
  check(chests.use(c), "E closes it");
  t2 = 0;
  while (c.dir !== 0 && t2 < 5) { chests.step(0.05); t2 += 0.05; }
  const [shut] = [...chests.matrices(c.entity.id)];
  check(!c.open && Math.hypot(...world(shut.m).map((v, k) => v - w0[k])) < 1e-3, `shut again after ${t2.toFixed(2)} s`);
}
console.log(failures ? `FAIL (${failures})` : "OK");
if (failures) process.exit(1);
