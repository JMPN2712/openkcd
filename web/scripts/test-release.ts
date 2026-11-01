// The world renderer drops its meshes' CPU vertex data once uploaded (releaseVertexData), and the
// world caches then forget models whose geometry the renderer let go, so they load anew. Streams
// the market, a spot 1 km away and the market again (Potato's radius), as the world view does.
// usage: node scripts/test-release.ts [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRenderer } from "../src/renderer.ts";
import { buildWorldScene, lodItems, newWorldCaches, sceneMatrices, trimWorldCaches, type WorldScene } from "../src/world.ts";
import { PRESETS } from "../src/quality.ts";
import { gpuDevice, openRataje } from "./lib.ts";

const args = process.argv.slice(2);
const root = args.includes("--root") ? args[args.indexOf("--root") + 1] : join(homedir(), "kcd1");
const q = PRESETS.potato;

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
// (Dawn's onSubmittedWorkDone doesn't keep Node's event loop alive)
setInterval(() => {}, 1000);

const lvl = await openRataje(root, { cover: false });
const device = await gpuDevice();
const models = new ModelRenderer(device, "rgba8unorm", 1, { reversedZ: true, instanceIndices: true, releaseVertexData: true });
const caches = newWorldCaches();

async function stream(at: [number, number]): Promise<WorldScene> {
  const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, at, q.streamRadius, { maxModels: 20000, maxTextureDim: q.maxTextureDim, caches, props: lvl.props, hiddenLayers: lvl.hiddenLayers, normalMaps: q.normalMaps });
  const items = lodItems(scene);
  await models.prepare(items);
  models.setModels(items, models.indexed ? sceneMatrices(scene) : undefined);
  trimWorldCaches(caches, 4, (m) => models.holds(m));
  return scene;
}
const unskinned = (s: WorldScene) => lodItems(s).flatMap((it) => it.model.cgf.meshes.filter((m) => !(m.boneIds && m.boneWeights)));

const market = await stream([2577.8, 574]);
const first = unskinned(market);
check(first.length > 1000 && first.every((m) => m.released), `the market's ${first.length} unskinned meshes are released once uploaded`);
check(first.every((m) => m.normals === null || m.normals.length === 0) && first.every((m) => m.positions.length > 0 && m.indices.length > 0), "only positions and indices are left");
check(first.every((m) => m.positions.buffer.byteLength === m.positions.byteLength), "positions don't keep a larger buffer");

const away = await stream([2577.8, 1574]);
const kept = new Set(unskinned(away));
const gone = first.filter((m) => !kept.has(m));
check(gone.length > 0, `${gone.length} of the market's meshes left the scene`);
const cached = new Set([...caches.loaded.values()].flatMap((m) => m?.cgf.meshes ?? []));
check(gone.every((m) => !cached.has(m)), "their models are no longer cached");
check([...caches.loaded.values()].every((m) => !m || models.holds(m)), "every cached model's released geometry is still on the GPU");

// back: what left loads again (new mesh objects with their vertex data) and uploads
let threw: unknown = null;
const again = await stream([2577.8, 574]).catch((err) => { threw = err; return null; });
check(!threw, `the market streams in again${threw ? `: ${(threw as Error).message}` : ""}`);
if (again) {
  const back = unskinned(again);
  check(back.length === first.length, `the same number of meshes (${back.length})`);
  check(back.some((m) => !first.includes(m)), "the ones that had left were loaded anew");
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
