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
import { buildWorldScene, lodItems, newWorldCaches, selectLods } from "../src/world.ts";
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
const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, [ax, ay], radius, { maxModels: 20000, caches: newWorldCaches(), props: lvl.props, hiddenLayers: lvl.hiddenLayers, normalMaps: !args.includes("--no-normal") });
const items = lodItems(scene);
models.setModels(items);
models.setShadow(shadowMap);
if (shadowMap) casters.setScene(scene, items.map((it) => it.capacity), shadowMap.cascades);
const lodOut = items.map((it) => new Float32Array(it.capacity * 16));
const lodCounts = items.map(() => 0);
console.log(`world: ${scene.models.length} models, ${scene.instances} instances within ${radius} m (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

const avatar = await PlayerAvatar.load(lvl.vfs);
const surroundings = new CollisionWorld((x, y) => heightAt(lvl.terrain, x, y));
if (!args.includes("--no-collision")) surroundings.setScene(scene);
const session = new PlayerSession(surroundings, avatar, [ax, ay, 0], (ayaw * Math.PI) / 180);
session.pitch = (pitch0 * Math.PI) / 180;
session.setView(view === "first" ? "first" : "third");
playerR.setModels(avatar.renderItems());
playerR.setShadow(shadowMap);
terrainR.setShadow(shadowMap);

const profile = lvl.tod ? pickProfile(lvl.tod) : null;
async function render(name: string): Promise<void> {
  session.avatar.upload(playerR);
  const cam: FlyCamera = session.camera(1);
  const g = heightAt(lvl.terrain, cam.pos[0], cam.pos[1]);
  if (session.viewMode === "third" && cam.pos[2] < g + 0.3) cam.pos[2] = g + 0.3;
  const vp = TerrainRenderer.viewProj(cam, W / H, { reversed: true, near: session.viewMode === "first" ? 0.01 : 0.1 });
  const st = selectLods(scene, cam.pos, vp, lodOut, lodCounts);
  lodCounts.forEach((n, k) => models.setInstances(k, lodOut[k], n));
  const state = profile ? skyAt(profile, clock[0] + clock[1] / 60) : null;
  if (state) {
    models.lighting = playerR.lighting = state.lighting;
    sky.update(invert(vp), cam.pos, state);
  }
  terrainR.prepare(cam, vp, { lighting: state?.lighting });
  models.setCamera(vp, cam.pos);
  playerR.setCamera(vp, cam.pos);
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
  models.draw(pass);
  playerR.draw(pass);
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
