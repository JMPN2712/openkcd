// What a streaming step costs on the main thread, headless (Dawn): from Rataje's market, steps of
// the world view's rebuild distance (0.3 × the preset's streaming radius) along a line; for each
// step, the scene build (model loads and decoding), the world renderer's rebuild (setModels,
// shadows, collision) and the first frame drawn after it (render bundles are recorded then).
// usage: node scripts/bench-streaming.ts [--preset high] [--steps 4] [--heading DEG] [--root GAME_ROOT] [--slim PACKAGE_DIR]
//   --slim: models from a compact package (scripts/build-slim.ts), the rest from the paks
//   PROFILE=file: a CPU profile of each rebuild and the frame after it (not the scene builds) to file-N.cpuprofile

import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { create } from "webgpu";
import { heightAt } from "../src/terrain.ts";
import { TerrainRenderer } from "../src/terrainRenderer.ts";
import { TexturePool } from "../src/texturePool.ts";
import { ModelRenderer } from "../src/renderer.ts";
import { buildWorldScene, lodItems, newWorldCaches, sceneMatrices, selectLods, trimWorldCaches } from "../src/world.ts";
import { CollisionWorld } from "../src/collision.ts";
import { depthClear, depthFormat, type PassSetup } from "../src/mat4.ts";
import { PRESETS, type PresetName } from "../src/quality.ts";
import { setGpuBlockCompression } from "../src/model.ts";
import { ShadowMap } from "../src/shadow.ts";
import { ShadowCasters } from "../src/shadowPass.ts";
import { nodeReadWorkers, nodeSlimFiles, openRataje } from "./lib.ts";
import { SlimPackage } from "../src/slim.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const q = PRESETS[opt("--preset", "high") as PresetName];
const steps = Number(opt("--steps", "4"));
// --back: walk back to the start after the steps (the kept geometry should not keep growing)
const back = args.includes("--back") ? (args.splice(args.indexOf("--back"), 1), true) : false;
const heading = (Number(opt("--heading", "200")) * Math.PI) / 180;

const lvl = await openRataje(root);
lvl.vfs.workers = nodeReadWorkers(root);
const gpu = create([]);
const adapter = (await gpu.requestAdapter({ powerPreference: "high-performance" }))!;
const device = await adapter.requestDevice({ requiredFeatures: (["texture-compression-bc", "indirect-first-instance"] as GPUFeatureName[]).filter((f) => adapter.features.has(f)) });
setGpuBlockCompression(device.features.has("texture-compression-bc"));
device.addEventListener("uncapturederror", (e) => console.log("GPU ERROR:", (e as GPUUncapturedErrorEvent).error.message));

const format: GPUTextureFormat = "rgba8unorm";
const pass: PassSetup = { sampleCount: q.msaa, reversedZ: true };
const W = Math.round(1920 * q.renderScale), H = Math.round(1080 * q.renderScale);
const pool = new TexturePool(device, lvl.vfs, { budget: q.textures.budgetMiB * 2 ** 20, maxDim: q.textures.maxDim });
const models = new ModelRenderer(device, format, q.msaa, { ...pass, pool, instanceIndices: true });
const shadowMap = q.shadows.cascades ? new ShadowMap(device, q.shadows.size, q.shadows.cascades, q.shadows.splits) : null;
const casters = new ShadowCasters();
const target = device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
const msaa = q.msaa > 1 ? device.createTexture({ size: [W, H], format, sampleCount: q.msaa, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : null;
const depth = device.createTexture({ size: [W, H], format: depthFormat(pass), sampleCount: q.msaa, usage: GPUTextureUsage.RENDER_ATTACHMENT });
const world = new CollisionWorld((x, y) => heightAt(lvl.terrain, x, y), lvl.terrain.size);
const caches = newWorldCaches();
const slimDir = opt("--slim", "");
if (slimDir) caches.slim = await SlimPackage.open(nodeSlimFiles(slimDir));
const step = q.streamRadius * 0.3;

const prof = process.env.PROFILE ? new (await import("node:inspector/promises")).Session() : null;
if (prof) { prof.connect(); await prof.post("Profiler.enable"); }
console.log(`${q.label}: radius ${q.streamRadius} m, a rebuild every ${step.toFixed(0)} m`);
console.log("step | at | models | instances | scene build | geometry (longest slice) | rebuild | first frame | next frame");
const route = [...Array(steps + 1).keys(), ...(back ? [...Array(steps).keys()].reverse() : [])];
for (const [k, s] of route.entries()) {
  const at: [number, number] = [2577.8 + Math.cos(heading) * step * s, 574 + Math.sin(heading) * step * s];
  let t = performance.now();
  const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, at, q.streamRadius, { maxModels: 20000, maxTextureDim: q.maxTextureDim, caches, props: lvl.props, hiddenLayers: lvl.hiddenLayers, normalMaps: q.normalMaps, ground: [lvl.roads, lvl.decals] });
  const build = performance.now() - t;
  // as the world view's stream(): new meshes' geometry in slices first
  t = performance.now();
  const longest = await models.prepare(lodItems(scene));
  const prepare = performance.now() - t;
  if (prof && k > 0) await prof.post("Profiler.start");
  t = performance.now();
  // as the world view's stream()
  const parts: string[] = [];
  let tp = performance.now();
  const lap = (k: string) => { const now = performance.now(); parts.push(`${k} ${(now - tp).toFixed(0)}`); tp = now; };
  const items = lodItems(scene);
  const mats = models.indexed ? sceneMatrices(scene) : undefined;
  lap("matrices");
  models.setModels(items, mats);
  lap("setModels");
  models.setShadow(shadowMap);
  lap("setShadow");
  if (shadowMap) casters.setScene(scene, items.map((it) => it.capacity), shadowMap.cascades, models.indexed);
  world.setScene(scene);
  lap("casters+collision");
  const lodOut = items.map((it) => (models.indexed ? new Uint32Array(it.capacity) : new Float32Array(it.capacity * 16)));
  const lodCounts = items.map(() => 0);
  trimWorldCaches(caches, 4);
  lap("trim");
  const rebuild = performance.now() - t;
  if (k === 0) console.log(`world geometry: ${(models.stats.vertices * 64 / 2 ** 20).toFixed(0)} MiB of vertices, ${models.stats.meshes} meshes, ${models.stats.draws} draws`);
  const frame = async () => {
    const t0 = performance.now();
    const eye: [number, number, number] = [at[0], at[1], heightAt(lvl.terrain, at[0], at[1]) + 1.7];
    const cam = { pos: eye, yaw: heading, pitch: -0.05 } as never;
    const vp = TerrainRenderer.viewProj(cam, W / H, { reversed: true, near: 0.01 });
    pool.setViewport(H, 1);
    pool.beginFrame();
    selectLods(scene, eye, vp, lodOut, lodCounts, { lodScale: q.lodScale, distanceScale: q.distanceScale, indices: models.indexed });
    lodCounts.forEach((n, i) => models.setInstances(i, lodOut[i], n));
    models.setCamera(vp, eye);
    const enc = device.createCommandEncoder();
    const sun: [number, number, number] = [0.4, 0.3, 0.86];
    if (shadowMap) casters.render(enc, shadowMap, eye, [Math.cos(heading), Math.sin(heading), 0], sun, models, [], { lodScale: q.lodScale });
    const p = enc.beginRenderPass({
      colorAttachments: [msaa ? { view: msaa.createView(), resolveTarget: target.createView(), loadOp: "clear", storeOp: "discard" } : { view: target.createView(), loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: depthClear(pass), depthLoadOp: "clear", depthStoreOp: "discard" },
    });
    models.drawGround(p);
    models.draw(p);
    p.end();
    device.queue.submit([enc.finish()]);
    const cpu = performance.now() - t0;
    await device.queue.onSubmittedWorkDone();
    return cpu;
  };
  const first = await frame();
  if (prof && k > 0) {
    const { profile } = await prof.post("Profiler.stop");
    writeFileSync(`${process.env.PROFILE}-${k}.cpuprofile`, JSON.stringify(profile));
  }
  const next = await frame();
  console.log(`${k} | ${at.map((v) => v.toFixed(0)).join(",")} | ${scene.models.length} | ${scene.instances} | ${(build / 1000).toFixed(2)} s | ${prepare.toFixed(0)} ms (${longest.toFixed(1)}) | ${rebuild.toFixed(0)} ms | ${first.toFixed(0)} ms | ${next.toFixed(1)} ms`);
  if (caches.slim) {
    const st = caches.slim.stats;
    parts.push(`slim: ${st.chunkReads} chunks ${(st.chunkBytes / 2 ** 20).toFixed(0)} MiB, ${st.singleReads} single (${st.singleModels} models) ${(st.singleBytes / 2 ** 20).toFixed(0)} MiB, ${st.packReads} pack ${(st.packBytes / 2 ** 20).toFixed(0)} MiB (so far)`);
  }
  parts.push(`rss ${(process.memoryUsage().rss / 2 ** 30).toFixed(1)} GiB`);
  const g = models.geometryBytes();
  console.log(`     rebuild: ${parts.join(", ")} ms; geometry ${(g.used / 2 ** 20).toFixed(0)} of ${(g.held / 2 ** 20).toFixed(0)} MiB held`);
}
process.exit(0);
