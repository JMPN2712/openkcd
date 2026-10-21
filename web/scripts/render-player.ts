// Headless walk as Henry: runs the player session on Rataje with scripted input and renders
// the view at the end of each input segment.
// usage: node scripts/render-player.ts OUT_DIR [--at x,y,yawDeg] [--walk "SECONDS:KEYS;…"]
//          [--view third|first] [--pitch DEG] [--radius R] [--clock HH:MM] [--root GAME_ROOT]
// KEYS: w a s d, shift (sprint), walk (walk gait), jump; e.g. --walk "1:;2:w;1.5:w+shift;1:"

import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { heightAt } from "../src/terrain.ts";
import { TerrainRenderer, type FlyCamera } from "../src/terrainRenderer.ts";
import { ModelRenderer } from "../src/renderer.ts";
import { WaterRenderer } from "../src/waterRenderer.ts";
import { buildGrassScene, buildWorldScene, isUberLod, lodItems, newWorldCaches, selectLods, type WorldScene } from "../src/world.ts";
import { PlayerAvatar } from "../src/playerAvatar.ts";
import { PlayerSession } from "../src/playerSession.ts";
import { type MoveInput } from "../src/player.ts";
import { CollisionWorld } from "../src/collision.ts";
import { openRataje, gpuDevice, Offscreen } from "./lib.ts";
import { loadDetailLayers } from "../src/terrainDetail.ts";
import { ShadowMap } from "../src/shadow.ts";
import { ShadowCasters } from "../src/shadowPass.ts";
import { depthClear, depthFormat, type PassSetup } from "../src/mat4.ts";
import { SkyRenderer, skyAt, pickProfile, invert } from "../src/sky.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const [ax, ay, ayaw] = opt("--at", "2577.8,574,-90").split(",").map(Number);
const walk = opt("--walk", "0.5:;2:w;1.5:w+shift;1:");
const view = opt("--view", "third");
const pitch0 = Number(opt("--pitch", "-10"));
const radius = Number(opt("--radius", "250"));
const clock = opt("--clock", "12:00").split(":").map(Number);
// a free camera instead of Henry's view: x,y,z,yawDeg,pitchDeg (z 0 = 2 m above the ground)
const fly = opt("--fly", "");
const grassRadius = Number(opt("--grass", "55")); // 0: no grass
const [outDir] = args;
if (!outDir) throw new Error("usage: render-player.ts OUT_DIR [options]");
await mkdir(outDir, { recursive: true });
const W = 1280, H = 720;

const lvl = await openRataje(root);
const device = await gpuDevice();
const format: GPUTextureFormat = "rgba8unorm";
const passSetup: PassSetup = { sampleCount: 4, reversedZ: true };
const detail = args.includes("--no-detail") ? undefined : await loadDetailLayers(lvl.vfs, lvl.surfaceTypes, 512);
if (detail) console.log(`terrain detail: ${detail.layers.length} layers (${detail.names.map((n) => n.split("/").pop()).join(", ")})`);
const terrainR = new TerrainRenderer(device, format, lvl.terrain, lvl.cover, passSetup, detail);
const models = new ModelRenderer(device, format, 4, passSetup);
const shadowMap = args.includes("--no-shadows") ? null : new ShadowMap(device, 2048, 2, [20, 120]);
const casters = new ShadowCasters();
const water = new WaterRenderer(device, format, lvl.objects.water, passSetup);
const playerR = new ModelRenderer(device, format, 4, passSetup);
const sky = new SkyRenderer(device, format, passSetup);
const off = new Offscreen(device, W, H, format);
const msaa = device.createTexture({ size: [W, H], format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
const depth = device.createTexture({ size: [W, H], format: depthFormat(passSetup), sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });

const t0 = performance.now();
const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, [ax, ay], radius, { maxModels: 20000, caches: newWorldCaches(), props: lvl.props, hiddenLayers: lvl.hiddenLayers, normalMaps: !args.includes("--no-normal"), roads: args.includes("--no-roads") ? undefined : lvl.roads });
// debug: HIDE=regex leaves matching models out (e.g. HIDE='^road:|road_side')
if (process.env.HIDE) scene.models = scene.models.filter((m) => !new RegExp(process.env.HIDE!).test(m.path));
const items = lodItems(scene);
models.setModels(items);
models.setShadow(shadowMap);
if (shadowMap) casters.setScene(scene, items.map((it) => it.capacity), shadowMap.cascades);
const lodOut = items.map((it) => new Float32Array(it.capacity * 16));
const lodCounts = items.map(() => 0);
console.log(`world: ${scene.models.length} models, ${scene.instances} instances within ${radius} m (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

// the far field: every uber-LOD, drawn beyond the streamed radius
const farR = new ModelRenderer(device, format, 4, passSetup);
const farScene = args.includes("--no-far") ? null : await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, [lvl.terrain.size / 2, lvl.terrain.size / 2], lvl.terrain.size, { maxModels: 1000, caches: newWorldCaches(), hiddenLayers: lvl.hiddenLayers, normalMaps: false, onlyBrushes: isUberLod });
const farItems = farScene ? lodItems(farScene) : [];
farR.setModels(farItems);
const farOut = farItems.map((it) => new Float32Array(it.capacity * 16)), farCounts = farItems.map(() => 0);
if (farScene) console.log(`far field: ${farScene.instances} uber-LOD instances of ${farScene.models.length} models`);
const avatar = await PlayerAvatar.load(lvl.vfs);
const surroundings = new CollisionWorld((x, y) => heightAt(lvl.terrain, x, y), lvl.terrain.size);
if (!args.includes("--no-collision")) surroundings.setScene(scene);
const session = new PlayerSession(surroundings, avatar, [ax, ay, 0], (ayaw * Math.PI) / 180);
session.pitch = (pitch0 * Math.PI) / 180;
session.setView(view === "first" ? "first" : "third");
playerR.setModels(avatar.renderItems());
playerR.setShadow(shadowMap);
terrainR.setShadow(shadowMap);

// grass around the camera, rebuilt when it has moved
const grassR = new ModelRenderer(device, format, 4, passSetup);
const grassCaches = newWorldCaches();
let grass: { at: [number, number]; scene: WorldScene; out: Float32Array[]; counts: number[] } | null = null;
async function updateGrass(at: [number, number]): Promise<void> {
  if (!grassRadius || (grass && Math.hypot(at[0] - grass.at[0], at[1] - grass.at[1]) < grassRadius / 4)) return;
  const t = performance.now();
  const scene = await buildGrassScene(lvl.vfs, lvl.terrain, lvl.merged, at, grassRadius, { caches: grassCaches, maxTextureDim: 1024, normalMaps: !args.includes("--no-normal") });
  const items = lodItems(scene);
  grassR.setModels(items);
  grassR.setShadow(shadowMap);
  grass = { at, scene, out: items.map((it) => new Float32Array(it.capacity * 16)), counts: items.map(() => 0) };
  console.log(`grass: ${scene.instances} instances of ${scene.models.length} models within ${grassRadius} m (${((performance.now() - t) / 1000).toFixed(1)} s)`);
}

const profile = lvl.tod ? pickProfile(lvl.tod) : null;
async function render(name: string): Promise<void> {
  session.avatar.upload(playerR);
  let cam: FlyCamera = session.camera(1);
  if (fly) {
    const [fx, fy, fz, fyaw, fpitch] = fly.split(",").map(Number);
    cam = { pos: [fx, fy, fz || heightAt(lvl.terrain, fx, fy) + 2], yaw: (fyaw * Math.PI) / 180, pitch: (fpitch * Math.PI) / 180 };
  }
  const g = heightAt(lvl.terrain, cam.pos[0], cam.pos[1]);
  if (session.viewMode === "third" && cam.pos[2] < g + 0.3) cam.pos[2] = g + 0.3;
  const vp = TerrainRenderer.viewProj(cam, W / H, { reversed: true, near: session.viewMode === "first" ? 0.01 : 0.1 });
  const st = selectLods(scene, cam.pos, vp, lodOut, lodCounts);
  lodCounts.forEach((n, k) => models.setInstances(k, lodOut[k], n));
  await updateGrass([cam.pos[0], cam.pos[1]]);
  if (grass) {
    const gs = grass;
    selectLods(gs.scene, cam.pos, vp, gs.out, gs.counts, { maxDistance: grassRadius, fade: [grassRadius * 0.67, grassRadius] });
    gs.counts.forEach((n, k) => grassR.setInstances(k, gs.out[k], n));
  }
  const state = profile ? skyAt(profile, clock[0] + clock[1] / 60) : null;
  if (farScene) {
    selectLods(farScene, cam.pos, vp, farOut, farCounts, { uberNear: radius * 0.9 });
    farCounts.forEach((n, k) => farR.setInstances(k, farOut[k], n));
  }
  if (state) {
    models.lighting = playerR.lighting = farR.lighting = grassR.lighting = state.lighting;
    sky.update(invert(vp), cam.pos, state);
  }
  terrainR.prepare(cam, vp, { lighting: state?.lighting });
  models.setCamera(vp, cam.pos);
  playerR.setCamera(vp, cam.pos);
  farR.setCamera(vp, cam.pos);
  grassR.setCamera(vp, cam.pos);
  water.setCamera(vp, cam.pos, [0.45, 0.25, 0.85], undefined, state?.lighting, state?.horizon);
  const enc = device.createCommandEncoder();
  if (shadowMap && state) {
    const f = [Math.cos(cam.pitch) * Math.cos(cam.yaw), Math.cos(cam.pitch) * Math.sin(cam.yaw), Math.sin(cam.pitch)] as [number, number, number];
    casters.render(enc, shadowMap, cam.pos, f, state.lighting.sunDir, models, [playerR]);
  }
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: msaa.createView(), resolveTarget: off.target.createView(), clearValue: { r: 0.55, g: 0.62, b: 0.7, a: 1 }, loadOp: "clear", storeOp: "discard" }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: depthClear(passSetup), depthLoadOp: "clear", depthStoreOp: "discard" },
  });
  if (state) sky.draw(pass);
  terrainR.draw(pass);
  models.drawGround(pass);
  farR.draw(pass);
  models.draw(pass);
  grassR.draw(pass);
  playerR.draw(pass);
  models.drawBlended(pass);
  grassR.drawBlended(pass);
  water.draw(pass);
  pass.end();
  device.queue.submit([enc.finish()]);
  const file = join(outDir, `${name}.png`);
  await writeFile(file, await off.png());
  const c = session.controller;
  console.log(`${file}: Henry at ${c.pos.map((v) => v.toFixed(2))} ${c.gait} ${c.speed().toFixed(2)} m/s ${c.grounded ? "grounded" : "airborne"} · ${st.drawn} instances drawn`);
}

const segments = walk.split(";").filter(Boolean).map((s) => {
  const [sec, keys = ""] = s.split(":");
  return { seconds: Number(sec), keys: new Set(keys.split("+").filter(Boolean)) };
});
const dt = 1 / 60;
for (const [i, seg] of segments.entries()) {
  const k = seg.keys;
  const input: MoveInput = {
    forward: (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0),
    right: (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0),
    gait: k.has("walk") ? "walk" : "run",
    sprint: k.has("shift"),
    jump: k.has("jump"),
  };
  for (let t = 0; t < seg.seconds; t += dt) session.update(dt, input);
  await render(`player_${i}_${[...k].join("+") || "idle"}`);
}
device.destroy();
