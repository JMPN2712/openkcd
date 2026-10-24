// Frame rates per quality preset, headless (Dawn), on each GPU Dawn finds: Henry runs in first
// person through Rataje's market (NPCs placed by their schedules at noon, collision, sky) and
// across the fields towards the town. Each frame is timed from the start of its CPU work (player,
// LOD selection, NPC animation, encoding) until the GPU has finished it, so CPU and GPU time add
// up (a browser overlaps them: this is the pessimistic figure). The output is 1920×1080 scaled by
// the preset's render scale; nothing is presented to a screen.
// usage: node scripts/bench-presets.ts [--gpu high-performance|low-power|both] [--frames N] [--presets potato,low,…]

import { homedir } from "node:os";
import { join } from "node:path";
import { create } from "webgpu";
import { heightAt } from "../src/terrain.ts";
import { FOV_Y, TerrainRenderer } from "../src/terrainRenderer.ts";
import { TexturePool } from "../src/texturePool.ts";
import { ModelRenderer } from "../src/renderer.ts";
import { WaterRenderer } from "../src/waterRenderer.ts";
import { FarTrees } from "../src/farTrees.ts";
import { buildGrassScene, buildWorldScene, lodItems, newWorldCaches, selectLods } from "../src/world.ts";
import { PlayerAvatar } from "../src/playerAvatar.ts";
import { PlayerSession } from "../src/playerSession.ts";
import { CollisionWorld } from "../src/collision.ts";
import { depthClear, depthFormat, type PassSetup } from "../src/mat4.ts";
import { SkyRenderer, skyAt, pickProfile, invert } from "../src/sky.ts";
import { PRESETS, type PresetName } from "../src/quality.ts";
import { setGpuBlockCompression } from "../src/model.ts";
import { NpcWorld, npcItems, animateNpcs } from "../src/npcs.ts";
import { parseNpcEntities, parseEntityIndex } from "../src/levelEntities.ts";
import { Schedules } from "../src/schedule.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import type { MoveInput } from "../src/player.ts";
import { nodeReadWorkers, openRataje } from "./lib.ts";
import { loadDetailLayers } from "../src/terrainDetail.ts";
import { ShadowMap } from "../src/shadow.ts";
import { ShadowCasters } from "../src/shadowPass.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const gpus = opt("--gpu", "both") === "both" ? ["high-performance", "low-power"] as const : [opt("--gpu", "high-performance")] as GPUPowerPreference[];
const FRAMES = Number(opt("--frames", "240"));
const presets = opt("--presets", "potato,low,medium,high").split(",") as PresetName[];
const W = 1920, H = 1080;

const lvl = await openRataje(root);
// pak reads on worker threads, as in the browser (NO_WORKERS=1: on the main thread)
if (!process.env.NO_WORKERS) lvl.vfs.workers = nodeReadWorkers(root);
const lb = await lvl.sources.find((s) => s.path.toLowerCase() === "data/levels/rataje/level.pak")!.open();
const missionEntry = (await readCentralDirectory(lb)).find((e) => e.name.toLowerCase() === "objects_mission0.xml")!;
const missionXml = new TextDecoder().decode(await readEntry(lb, missionEntry));
const npcEnts = parseNpcEntities(missionXml);
const schedules = new Schedules(npcEnts, parseEntityIndex(missionXml));
const h = (x: number, y: number) => heightAt(lvl.terrain, x, y);
const profile = pickProfile(lvl.tod!);
const avatar = await PlayerAvatar.load(lvl.vfs);
const cachesByDim = new Map<string, ReturnType<typeof newWorldCaches>>();

const SCENES = [
  // the market: run south-west, turning, among stalls and NPCs
  { name: "market", at: [2577.8, 574] as [number, number], yaw: -Math.PI / 2 - 0.6, pitch: -0.05, turn: 0.35 },
  // the fields south of the town, running north with the town ahead
  { name: "fields", at: [2192, 1000] as [number, number], yaw: Math.PI / 2, pitch: 0.02, turn: 0.05 },
  // the river by the bridge west of the town, looking across the water
  { name: "river", at: [2352, 668] as [number, number], yaw: (20 * Math.PI) / 180, pitch: -0.12, turn: 0.1 },
];

const results: string[] = [];
for (const pp of gpus) {
  const gpu = create([]);
  const adapter = await gpu.requestAdapter({ powerPreference: pp as GPUPowerPreference });
  if (!adapter) { console.log(`no ${pp} adapter`); continue; }
  const gpuName = `${adapter.info.vendor} ${adapter.info.device}`.replace(/-/g, " ");
  const device = await adapter.requestDevice({ requiredFeatures: (["texture-compression-bc", "indirect-first-instance"] as GPUFeatureName[]).filter((f) => adapter.features.has(f)) });
  setGpuBlockCompression(device.features.has("texture-compression-bc"));
  device.addEventListener("uncapturederror", (e) => console.log("GPU ERROR:", (e as GPUUncapturedErrorEvent).error.message));
  const format: GPUTextureFormat = "rgba8unorm";
  for (const name of presets) {
    const q = PRESETS[name];
    const pass: PassSetup = { sampleCount: q.msaa, reversedZ: true };
    const w = Math.round(W * q.renderScale), hgt = Math.round(H * q.renderScale);
    const terrainR = new TerrainRenderer(device, format, lvl.terrain, lvl.cover, pass, await loadDetailLayers(lvl.vfs, lvl.surfaceTypes, q.terrainDetail), { detailFade: q.detailFade });
    // streamed textures (NO_POOL=1: every renderer uploads its own at the preset's first size)
    const pool = process.env.NO_POOL ? undefined : new TexturePool(device, lvl.vfs, { budget: Number(process.env.POOL_MIB ?? q.textures.budgetMiB) * 2 ** 20, maxDim: q.textures.maxDim });
    const models = new ModelRenderer(device, format, q.msaa, { ...pass, pool });
    const water = new WaterRenderer(device, format, lvl.objects.water, pass);
    // OLD_WATER=1: the water as it was, in the opaque pass (no material, no scene depth)
    const oldWater = !!process.env.OLD_WATER;
    if (!oldWater) await water.loadMaterials(lvl.vfs, lvl.terrain.materials);
    const playerR = new ModelRenderer(device, format, q.msaa, { ...pass, pool });
    const npcR = new ModelRenderer(device, format, q.msaa, { ...pass, pool });
    const grassR = new ModelRenderer(device, format, q.msaa, { ...pass, pool });
    const farTrees = new FarTrees(device, format, pass);
    if (!process.env.NO_FAR_TREES) await farTrees.build(lvl.vfs, lvl.terrain, lvl.objects, { maxTextureDim: q.maxTextureDim });
    const sky = new SkyRenderer(device, format, pass);
    const shadowMap = q.shadows.cascades ? new ShadowMap(device, q.shadows.size, q.shadows.cascades, q.shadows.splits) : null;
    const casters = new ShadowCasters();
    terrainR.setShadow(shadowMap);
    const target = device.createTexture({ size: [w, hgt], format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const msaa = q.msaa > 1 ? device.createTexture({ size: [w, hgt], format, sampleCount: q.msaa, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : null;
    const depth = device.createTexture({ size: [w, hgt], format: depthFormat(pass), sampleCount: q.msaa, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const depthView = depth.createView();
    if (!oldWater) water.setDepth(depthView, 0.1);
    // per preset: the pool drops the cached models' texture data once it is on the GPU, so a cache
    // shared with an earlier preset's run comes back with stand-ins (a preset switch, not a start)
    let caches = cachesByDim.get(`${name}:${q.maxTextureDim}`);
    if (!caches) cachesByDim.set(`${name}:${q.maxTextureDim}`, (caches = newWorldCaches()));
    for (const sc of SCENES) {
      const scene = await buildWorldScene(lvl.vfs, lvl.terrain, lvl.objects, sc.at, q.streamRadius, { maxModels: 20000, maxTextureDim: q.maxTextureDim, caches, props: lvl.props, hiddenLayers: lvl.hiddenLayers, normalMaps: q.normalMaps && !process.env.NO_NORMAL, ground: process.env.NO_ROADS ? undefined : [lvl.roads, lvl.decals] });
      const items = lodItems(scene);
      models.setModels(items);
      models.setShadow(shadowMap);
      if (shadowMap) casters.setScene(scene, items.map((it) => it.capacity), shadowMap.cascades);
      const lodOut = items.map((it) => new Float32Array(it.capacity * 16));
      const lodCounts = items.map(() => 0);
      // grass around the start (NO_GRASS=1 leaves it out); the run stays well inside its radius
      const grass = process.env.NO_GRASS || !q.grass ? null : await buildGrassScene(lvl.vfs, lvl.terrain, lvl.merged, sc.at, q.grass, { caches, maxTextureDim: Math.min(1024, q.maxTextureDim * 4), normalMaps: q.normalMaps });
      const grassItems = grass ? lodItems(grass) : [];
      grassR.setModels(grassItems);
      grassR.setShadow(shadowMap);
      const grassOut = grassItems.map((it) => new Float32Array(it.capacity * 16)), grassCounts = grassItems.map(() => 0);
      const world = new CollisionWorld(h, lvl.terrain.size);
      world.setScene(scene);
      const session = new PlayerSession(world, avatar, [sc.at[0], sc.at[1], 0], sc.yaw);
      session.pitch = sc.pitch;
      playerR.setModels(avatar.renderItems());
      playerR.setShadow(shadowMap);
      const npcWorld = new NpcWorld(lvl.vfs, npcEnts, schedules, h);
      const npcs = await npcWorld.near([sc.at[0], sc.at[1], h(sc.at[0], sc.at[1])], 120, q.npcMax, 720);
      npcR.setModels(npcItems(npcs));
      npcR.setShadow(shadowMap);
      const input: MoveInput = { forward: 1, right: 0, gait: "run", sprint: false };
      const times: number[] = [];
      const phase: Record<string, number> = { player: 0, lods: 0, npcs: 0, encode: 0, gpu: 0 };
      let tp = 0;
      const mark = (k: string) => { const n = performance.now(); phase[k] += n - tp; tp = n; };
      let tris = 0, drawn = 0, calls = 0;
      // the streamed textures load first (frames until the pool has been idle for 30 frames, at most
      // 1,200): the run then measures the settled scene, and the ramp is reported on its own
      let ramp = 0, ms = 0;
      if (pool) {
        let quiet = 0;
        const t = performance.now();
        for (; ramp < 1200 && quiet < 30; ramp++) {
          // (standing at the start: the run's first frames see the same textures)
          session.update(1 / 60, { forward: 0, right: 0, gait: "run", sprint: false });
          const cam = session.camera(1 / 60);
          const vp = TerrainRenderer.viewProj(cam, w / hgt, { reversed: true, near: 0.01 });
          pool.setViewport(hgt, FOV_Y);
          pool.beginFrame();
          const enc = device.createCommandEncoder();
          selectLods(scene, cam.pos, vp, lodOut, lodCounts, { lodScale: q.lodScale, distanceScale: q.distanceScale });
          lodCounts.forEach((n, k) => models.setInstances(k, lodOut[k], n));
          models.setCamera(vp, cam.pos);
          const p = enc.beginRenderPass({ colorAttachments: [msaa ? { view: msaa.createView(), resolveTarget: target.createView(), loadOp: "clear", storeOp: "discard" } : { view: target.createView(), loadOp: "clear", storeOp: "store" }], depthStencilAttachment: { view: depth.createView(), depthClearValue: depthClear(pass), depthLoadOp: "clear", depthStoreOp: "discard" } });
          models.draw(p);
          p.end();
          device.queue.submit([enc.finish()]);
          await device.queue.onSubmittedWorkDone();
          quiet = pool.idle ? quiet + 1 : 0;
          if (!pool.idle) await new Promise((r) => setTimeout(r, 0));
        }
        ms = performance.now() - t;
      }
      // PROFILE_RUN=file: a CPU profile of this run's measured frames (first scene only)
      const prof = process.env.PROFILE_RUN && sc === SCENES[0] ? new (await import("node:inspector/promises")).Session() : null;
      if (prof) { prof.connect(); await prof.post("Profiler.enable"); await prof.post("Profiler.start"); }
      for (let f = 0; f < FRAMES + 30; f++) {
        const t0 = performance.now();
        tp = t0;
        const dt = 1 / 60;
        session.look(Math.sin(f / 40) * sc.turn * dt, 0);
        session.update(dt, input);
        session.avatar.upload(playerR);
        const cam = session.camera(dt);
        const vp = TerrainRenderer.viewProj(cam, w / hgt, { reversed: true, near: 0.01 });
        pool?.setViewport(hgt, FOV_Y);
        pool?.beginFrame();
        const state = skyAt(profile, 12);
        models.lighting = npcR.lighting = playerR.lighting = grassR.lighting = state.lighting;
        sky.update(invert(vp), cam.pos, state);
        mark("player");
        const st = selectLods(scene, cam.pos, vp, lodOut, lodCounts, { lodScale: q.lodScale, distanceScale: q.distanceScale });
        lodCounts.forEach((n, k) => models.setInstances(k, lodOut[k], n));
        if (grass) {
          selectLods(grass, cam.pos, vp, grassOut, grassCounts, { maxDistance: q.grass, fade: [q.grass * 0.67, q.grass] });
          grassCounts.forEach((n, k) => grassR.setInstances(k, grassOut[k], n));
        }
        mark("lods");
        npcWorld.stepCrowd(npcs, 720, dt);
        animateNpcs(npcs, npcWorld, 720, f * dt, npcR, session.controller.pos);
        mark("npcs");
        terrainR.prepare(cam, vp, { lighting: state.lighting, lodDistance: q.terrainLod });
        models.setCamera(vp, cam.pos);
        npcR.setCamera(vp, cam.pos);
        playerR.setCamera(vp, cam.pos);
        grassR.setCamera(vp, cam.pos);
        farTrees.setCamera(vp, cam.pos, state.lighting, { center: sc.at, radius: q.streamRadius, distanceScale: q.distanceScale });
        water.setCamera(vp, cam.pos, state.lighting.sunDir, undefined, state.lighting, state.horizon);
        const enc = device.createCommandEncoder();
        if (shadowMap) casters.render(enc, shadowMap, cam.pos, [Math.cos(cam.pitch) * Math.cos(cam.yaw), Math.cos(cam.pitch) * Math.sin(cam.yaw), Math.sin(cam.pitch)], state.lighting.sunDir, models, [npcR, playerR], { lodScale: q.lodScale });
        // (as the level view: blended surfaces and water in a second pass, unless OLD_WATER)
        const colour = (msaa ?? target).createView();
        const resolve = msaa ? target.createView() : undefined;
        const p = enc.beginRenderPass({
          colorAttachments: [{ view: colour, resolveTarget: oldWater ? resolve : undefined, loadOp: "clear", storeOp: oldWater && msaa ? "discard" : "store", clearValue: [0, 0, 0, 1] }],
          depthStencilAttachment: { view: depthView, depthClearValue: depthClear(pass), depthLoadOp: "clear", depthStoreOp: oldWater ? "discard" : "store" },
        });
        sky.draw(p);
        terrainR.draw(p);
        models.drawGround(p);
        models.draw(p);
        grassR.draw(p);
        farTrees.draw(p);
        npcR.draw(p);
        playerR.draw(p);
        let b = p;
        if (!oldWater) {
          p.end();
          b = enc.beginRenderPass({
            colorAttachments: [{ view: colour, resolveTarget: resolve, loadOp: "load", storeOp: msaa ? "discard" : "store" }],
            depthStencilAttachment: { view: depthView, depthReadOnly: true },
          });
        }
        models.drawBlended(b);
        npcR.drawBlended(b);
        playerR.drawBlended(b);
        water.draw(b);
        b.end();
        device.queue.submit([enc.finish()]);
        mark("encode");
        await device.queue.onSubmittedWorkDone();
        mark("gpu");
        if (f >= 30) {
          times.push(performance.now() - t0);
          tris += terrainR.stats.triangles + models.stats.triangles + npcR.stats.triangles + grassR.stats.triangles;
          drawn += st.drawn;
          calls += models.stats.drawCalls + npcR.stats.drawCalls + playerR.stats.drawCalls;
        }
      }
      if (prof) {
        const { profile } = await prof.post("Profiler.stop");
        (await import("node:fs")).writeFileSync(`${process.env.PROFILE_RUN}-${name}.cpuprofile`, JSON.stringify(profile));
        prof.disconnect();
      }
      times.sort((a, b) => a - b);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      const p95 = times[Math.floor(times.length * 0.95)];
      const line = `${gpuName} | ${q.label} | ${sc.name} | ${w}×${hgt}${q.msaa > 1 ? ` ${q.msaa}× MSAA` : ""} | ${(1000 / mean).toFixed(0)} fps | ${mean.toFixed(1)} ms | ${p95.toFixed(1)} ms | ${(tris / times.length / 1e6).toFixed(2)}M | ${Math.round(drawn / times.length)} | ${Math.round(calls / times.length)} | ${npcs.length} | ${scene.models.length}`;
      console.log(line);
      results.push(line);
      console.log(`     per frame: ${Object.entries(phase).map(([k, v]) => `${k} ${(v / (FRAMES + 30)).toFixed(2)} ms`).join(", ")}`);
      console.log(`     draw calls (camera, cascades): world ${models.viewCalls().join("/")}, NPCs ${npcR.viewCalls().join("/")}, grass ${grassR.viewCalls().join("/")}`);
      if (pool) console.log(`     ${pool.summary()}; settled in ${ramp} frames (${(ms / 1000).toFixed(1)} s); ${pool.stats.loads} loads, ${pool.stats.shrinks} shrinks, ${pool.stats.evicted} evicted`);
    }
    for (const r of [terrainR, models, water, playerR, npcR, grassR, farTrees, sky]) r.destroy();
    pool?.destroy();
    shadowMap?.destroy();
    for (const t of [target, msaa, depth]) t?.destroy();
  }
  device.destroy();
}
console.log("\nGPU | preset | scene | resolution | fps (mean) | frame (mean) | frame (p95) | triangles | instances drawn | draw calls | NPCs | models streamed");
console.log(results.join("\n"));
lvl.vfs.workers?.terminate();
