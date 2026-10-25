// Headless walk as Henry: runs the player session on Rataje with scripted input and renders
// the view at the end of each input segment.
// usage: node scripts/render-player.ts OUT_DIR [--at x,y,yawDeg] [--walk "SECONDS:KEYS;…"]
//          [--view third|first] [--pitch DEG] [--radius R] [--clock HH:MM] [--root GAME_ROOT]
//          [--textures MAXDIM,BUDGET_MIB | --no-pool] (streamed textures; default 2048,768 like Medium)
// KEYS: w a s d, shift (sprint), walk (walk gait), jump; e.g. --walk "1:;2:w;1.5:w+shift;1:"

import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { heightAt } from "../src/terrain.ts";
import { FOV_Y, TerrainRenderer, type FlyCamera } from "../src/terrainRenderer.ts";
import { TexturePool } from "../src/texturePool.ts";
import { ModelRenderer } from "../src/renderer.ts";
import { WaterRenderer } from "../src/waterRenderer.ts";
import { Doors } from "../src/doors.ts";
import { buildGrassScene, buildWorldScene, isUberLod, lodItems, newWorldCaches, sceneMatrices, selectLods, type WorldScene } from "../src/world.ts";
import { PlayerAvatar } from "../src/playerAvatar.ts";
import { PlayerSession } from "../src/playerSession.ts";
import { type MoveInput } from "../src/player.ts";
import { CollisionWorld } from "../src/collision.ts";
import { openRataje, gpuDevice, Offscreen, nodeSlimFiles } from "./lib.ts";
import { SlimPackage } from "../src/slim.ts";
import { setAssetPackage } from "../src/model.ts";
import { loadDetailLayers } from "../src/terrainDetail.ts";
import { ShadowMap } from "../src/shadow.ts";
import { ShadowCasters } from "../src/shadowPass.ts";
import { depthClear, depthFormat, type PassSetup } from "../src/mat4.ts";
import { SkyRenderer, skyAt, pickProfile, invert } from "../src/sky.ts";
import { FarTrees } from "../src/farTrees.ts";
import { DEFAULT_LIGHTING } from "../src/mat4.ts";
import { NpcWorld, npcItems, animateNpcs, type WorldNpc } from "../src/npcs.ts";
import { parseNpcEntities, parseEntityIndex } from "../src/levelEntities.ts";
import { Schedules } from "../src/schedule.ts";
import { NavMesh } from "../src/navmesh.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";

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
const atNpc = opt("--at-npc", ""); // with --npcs: the camera in front of this NPC (by name), facing them
const npcDist = Number(opt("--npc-dist", "3")); // metres from that NPC; --npc-yaw turns the camera around them (degrees)
const npcYaw = (Number(opt("--npc-yaw", "0")) * Math.PI) / 180;
const withNpcs = args.includes("--npcs") ? (args.splice(args.indexOf("--npcs"), 1), true) : false; // NPCs within 120 m, by their schedules
const [outDir] = args;
if (!outDir) throw new Error("usage: render-player.ts OUT_DIR [options]");
await mkdir(outDir, { recursive: true });
const W = 1280, H = 720;
const [poolDim, poolMiB] = opt("--textures", "2048,768").split(",").map(Number);
// --old-water: the water as it was (no material, no scene depth)
const oldWater = args.includes("--old-water") ? (args.splice(args.indexOf("--old-water"), 1), true) : false;
const noPool = args.includes("--no-pool") ? (args.splice(args.indexOf("--no-pool"), 1), true) : false;

const lvl = await openRataje(root);
// --slim DIR: models and textures from a compact package (scripts/build-slim.ts), set before
// anything loads (with --root DIR/store, the package's file store, nothing else is read)
const slimDir = opt("--slim", "");
const slim = slimDir ? await SlimPackage.open(nodeSlimFiles(slimDir)) : null;
setAssetPackage(slim);
const device = await gpuDevice();
// streamed textures: each view renders until they have loaded (--no-pool: the first-load sizes only)
const pool = noPool ? undefined : new TexturePool(device, lvl.vfs, { budget: poolMiB * 2 ** 20, maxDim: poolDim });
const format: GPUTextureFormat = "rgba8unorm";
const passSetup: PassSetup = { sampleCount: 4, reversedZ: true };
const detail = args.includes("--no-detail") ? undefined : await loadDetailLayers(lvl.vfs, lvl.surfaceTypes, 512);
if (detail) console.log(`terrain detail: ${detail.layers.length} layers (${detail.names.map((n) => n.split("/").pop()).join(", ")})`);
const terrainR = new TerrainRenderer(device, format, lvl.terrain, lvl.cover, passSetup, detail);
const models = new ModelRenderer(device, format, 4, { ...passSetup, pool, instanceIndices: !process.env.MATRICES });
const shadowMap = args.includes("--no-shadows") ? null : new ShadowMap(device, 2048, 2, [20, 120]);
const casters = new ShadowCasters();
const water = new WaterRenderer(device, format, lvl.objects.water, passSetup);
if (!oldWater) await water.loadMaterials(lvl.vfs, lvl.terrain.materials);
const playerR = new ModelRenderer(device, format, 4, { ...passSetup, pool });
const sky = new SkyRenderer(device, format, passSetup);
const off = new Offscreen(device, W, H, format);
const msaa = device.createTexture({ size: [W, H], format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
const depth = device.createTexture({ size: [W, H], format: depthFormat(passSetup), sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });

const t0 = performance.now();
const worldCaches = newWorldCaches();
if (slim) worldCaches.slim = slim;
const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, [ax, ay], radius, { maxModels: 20000, caches: worldCaches, props: lvl.props, hiddenLayers: lvl.hiddenLayers, normalMaps: !args.includes("--no-normal"), ground: args.includes("--no-roads") ? undefined : [lvl.roads, lvl.decals] });
// debug: HIDE=regex leaves matching models out (e.g. HIDE='^road:|road_side')
if (process.env.HIDE) scene.models = scene.models.filter((m) => !new RegExp(process.env.HIDE!).test(m.path));
const items = lodItems(scene);
// --open-doors: every door in the scene open (doors.ts), as after pressing E at each
if (args.includes("--open-doors")) {
  args.splice(args.indexOf("--open-doors"), 1);
  const doors = new Doors(lvl.vfs, lvl.props);
  doors.preload();
  await doors.ready();
  doors.attach(scene);
  let opened = 0;
  for (const d of doors.doors.values()) if (doors.near(d.entity.pos, 0.01).length && doors.set(d, true)) { [...doors.matrices(d.entity.id)]; opened++; }
  console.log(`doors: ${opened} opened`);
}
models.setModels(items, models.indexed ? sceneMatrices(scene) : undefined);
models.setShadow(shadowMap);
if (shadowMap) casters.setScene(scene, items.map((it) => it.capacity), shadowMap.cascades, models.indexed);
const lodOut = items.map((it) => (models.indexed ? new Uint32Array(it.capacity) : new Float32Array(it.capacity * 16)));
const lodCounts = items.map(() => 0);
console.log(`world: ${scene.models.length} models, ${scene.instances} instances within ${radius} m (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

// the far field: every uber-LOD, drawn beyond the streamed radius
const farR = new ModelRenderer(device, format, 4, { ...passSetup, pool });
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
const grassR = new ModelRenderer(device, format, 4, { ...passSetup, pool });
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

// NPCs as in the world view: placed by their schedules (navmesh routes), stepped by the crowd, standing
// on the collision surfaces
const npcR = new ModelRenderer(device, format, 4, { ...passSetup, pool });
let npcWorld: NpcWorld | null = null;
let npcs: WorldNpc[] = [];
if (withNpcs) {
  const lb = await lvl.sources.find((x) => x.path.toLowerCase() === "data/levels/rataje/level.pak")!.open();
  const xml = new TextDecoder().decode(await readEntry(lb, (await readCentralDirectory(lb)).find((e) => e.name.toLowerCase() === "objects_mission0.xml")!));
  const ents = parseNpcEntities(xml);
  const schedules = new Schedules(ents, parseEntityIndex(xml));
  const rb = await lvl.sources.find((x) => x.path.toLowerCase() === "data/levels/rataje/recast.pak")?.open();
  const ne = rb && (await readCentralDirectory(rb)).find((e) => e.name.toLowerCase() === "recast/rdnavmesh_1.nav");
  if (rb && ne) schedules.setNavMesh(new NavMesh(await readEntry(rb, ne)));
  npcWorld = new NpcWorld(lvl.vfs, ents, schedules, (x, y) => heightAt(lvl.terrain, x, y));
  npcWorld.surface = (x, y, z) => (surroundings.ground(x, y, z + 0.5, z - 1.5) ?? surroundings.ground(x, y, z + 1, z - 1.5))?.z ?? null;
}
// --npc-clock HH:MM: the NPCs' time of day, when it should differ from the light's (night scenes in daylight)
const npcClock = opt("--npc-clock", "").split(":").map(Number);
const minuteOfDay = npcClock.length === 2 ? npcClock[0] * 60 + npcClock[1] : clock[0] * 60 + clock[1];
let simSeconds = 0;

// trees beyond the real ones, as cards (--no-far-trees leaves them out)
const farTrees = new FarTrees(device, format, passSetup);
if (!args.includes("--no-far-trees")) {
  const t = performance.now();
  await farTrees.build(lvl.vfs, lvl.terrain, lvl.objects);
  console.log(`far trees: ${farTrees.count} cards of ${farTrees.types} types (${((performance.now() - t) / 1000).toFixed(1)} s)`);
}

const profile = lvl.tod ? pickProfile(lvl.tod) : null;
async function render(name: string): Promise<void> {
  session.avatar.upload(playerR);
  let cam: FlyCamera = session.camera(1);
  if (fly) {
    const [fx, fy, fz, fyaw, fpitch] = fly.split(",").map(Number);
    cam = { pos: [fx, fy, fz || heightAt(lvl.terrain, fx, fy) + 2], yaw: (fyaw * Math.PI) / 180, pitch: (fpitch * Math.PI) / 180 };
  }
  if (npcWorld) {
    if (!npcs.length) {
      npcs = await npcWorld.near([cam.pos[0], cam.pos[1], cam.pos[2]], 120, 40, minuteOfDay);
      npcR.setModels(npcItems(npcs));
      npcR.setShadow(shadowMap);
      console.log(`NPCs: ${npcs.length}, ${npcs.filter((n) => n.placement.pose === "walk").length} walking: ${npcs.filter((n) => n.placement.pose === "walk").concat(npcs).slice(0, 12).map((n) => `${n.entity.name}@${n.placement.pos.map((v) => v.toFixed(0)).join(",")} ${n.placement.pose}`).join("; ")}`);
    }
    // two seconds of crowd at 30 steps a second (people start walking, settle on their spots)
    for (let k = 0; k < 60; k++) { npcWorld.stepCrowd(npcs, minuteOfDay, 1 / 30); simSeconds += 1 / 30; }
    animateNpcs(npcs, npcWorld, minuteOfDay, simSeconds, npcR); // (no eye: every NPC posed, not every few frames)
    const target = atNpc ? npcs.find((n) => n.entity.name === atNpc) : null;
    if (atNpc && !target) console.log(`no NPC ${atNpc} in view; NPCs: ${npcs.map((n) => n.entity.name).join(", ")}`);
    const p = target && npcWorld.drawn(target.entity.id);
    if (p) {
      // the model faces +Y turned by its rotation (a yaw quaternion)
      const yaw = 2 * Math.atan2(p.rot[3], p.rot[0]) + Math.PI / 2 + npcYaw;
      const ex = p.pos[0] + Math.cos(yaw) * npcDist, ey = p.pos[1] + Math.sin(yaw) * npcDist;
      cam = { pos: [ex, ey, p.pos[2] + Number(process.env.NPC_EYE ?? 1.5)], yaw: yaw + Math.PI, pitch: Number(process.env.NPC_PITCH ?? -0.12) };
      console.log(`framing ${atNpc}: ${p.activity} at ${p.where}, ${p.pose}, feet at z ${p.pos[2].toFixed(2)} (terrain ${heightAt(lvl.terrain, p.pos[0], p.pos[1]).toFixed(2)})`);
    }
  }
  const g = heightAt(lvl.terrain, cam.pos[0], cam.pos[1]);
  if (session.viewMode === "third" && cam.pos[2] < g + 0.3) cam.pos[2] = g + 0.3;
  const vp = TerrainRenderer.viewProj(cam, W / H, { reversed: true, near: session.viewMode === "first" ? 0.01 : 0.1 });
  const st = selectLods(scene, cam.pos, vp, lodOut, lodCounts, { indices: models.indexed });
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
    models.lighting = playerR.lighting = farR.lighting = grassR.lighting = npcR.lighting = state.lighting;
    sky.update(invert(vp), cam.pos, state);
  }
  terrainR.prepare(cam, vp, { lighting: state?.lighting });
  models.setCamera(vp, cam.pos);
  playerR.setCamera(vp, cam.pos);
  farR.setCamera(vp, cam.pos);
  grassR.setCamera(vp, cam.pos);
  npcR.setCamera(vp, cam.pos);
  farTrees.setCamera(vp, cam.pos, state?.lighting ?? DEFAULT_LIGHTING, { center: [ax, ay], radius, distanceScale: 1 });
  water.time = simSeconds;
  water.setCamera(vp, cam.pos, [0.45, 0.25, 0.85], undefined, state?.lighting, state?.horizon);
  // until the streamed textures settle (idle for a few frames), then once more for the picture
  pool?.setViewport(H, FOV_Y);
  for (let f = 0, quiet = 0; pool && f < 600 && quiet < 6; f++) {
    pool.beginFrame();
    drawFrame();
    await device.queue.onSubmittedWorkDone();
    quiet = pool.idle ? quiet + 1 : 0;
    await new Promise((r) => setTimeout(r, 1));
  }
  pool?.beginFrame();
  drawFrame();
  if (pool) console.log(`  ${pool.summary()}`);
  function drawFrame(): void {
  const enc = device.createCommandEncoder();
  if (shadowMap && state) {
    const f = [Math.cos(cam.pitch) * Math.cos(cam.yaw), Math.cos(cam.pitch) * Math.sin(cam.yaw), Math.sin(cam.pitch)] as [number, number, number];
    casters.render(enc, shadowMap, cam.pos, f, state.lighting.sunDir, models, npcWorld ? [playerR, npcR] : [playerR]);
  }
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: msaa.createView(), clearValue: { r: 0.55, g: 0.62, b: 0.7, a: 1 }, loadOp: "clear", storeOp: "store" }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: depthClear(passSetup), depthLoadOp: "clear", depthStoreOp: "store" },
  });
  if (state) sky.draw(pass);
  terrainR.draw(pass);
  models.drawGround(pass);
  farR.draw(pass);
  models.draw(pass);
  grassR.draw(pass);
  farTrees.draw(pass);
  if (npcWorld) npcR.draw(pass);
  playerR.draw(pass);
  pass.end();
  // see-through surfaces in a second pass that holds the depth read-only: the water reads it
  const blend = enc.beginRenderPass({
    colorAttachments: [{ view: msaa.createView(), resolveTarget: off.target.createView(), loadOp: "load", storeOp: "discard" }],
    depthStencilAttachment: { view: depth.createView(), depthReadOnly: true },
  });
  water.setDepth(oldWater ? null : depth.createView(), session.viewMode === "first" ? 0.01 : 0.1);
  models.drawBlended(blend);
  grassR.drawBlended(blend);
  if (npcWorld) npcR.drawBlended(blend);
  playerR.drawBlended(blend);
  water.draw(blend);
  blend.end();
  device.queue.submit([enc.finish()]);
  }
  const file = join(outDir, `${name}.png`);
  await writeFile(file, await off.png());
  const c = session.controller;
  if (npcWorld) console.log(`  NPC triangles drawn: ${npcR.stats.triangles}`);
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
