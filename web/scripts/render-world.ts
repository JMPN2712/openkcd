// Headless render of a level area (terrain + vegetation + brushes) via Dawn.
// Without view arguments, picks the densest 128 m cell of brushes and renders
// it from two angles.
// usage: node scripts/render-world.ts OUT_DIR [x,y,z,yawDeg,pitchDeg ...] [--radius R] [--root GAME_ROOT]

import { openAsBlob } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import { create, globals } from "webgpu";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { ASSET_RE } from "../src/assets.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { parseTerrain, heightAt } from "../src/terrain.ts";
import { parseLevelObjects } from "../src/levelObjects.ts";
import { parseCover } from "../src/cover.ts";
import { WaterRenderer } from "../src/waterRenderer.ts";
import { parseNpcEntities, parseEntityIndex, propEntities } from "../src/levelEntities.ts";
import { Schedules } from "../src/schedule.ts";
import { NavMesh } from "../src/navmesh.ts";
import { createAiWorld } from "../src/btWorld.ts";
import { NpcAi } from "../src/npcAi.ts";
import { AnimLibrary } from "../src/mannequin.ts";
import { LuaHost } from "../src/luaHost.ts";
import { createRequire } from "node:module";
import { NpcWorld, npcItems, animateNpcs, updateAi } from "../src/npcs.ts";
import { TerrainRenderer, type FlyCamera } from "../src/terrainRenderer.ts";
import { ModelRenderer } from "../src/renderer.ts";
import { buildWorldScene, lodItems, newWorldCaches, selectLods } from "../src/world.ts";

Object.assign(globalThis, globals);
const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const radius = Number(opt("--radius", "500"));
const withNpcs = args.includes("--npcs") ? (args.splice(args.indexOf("--npcs"), 1), true) : false;
const animTime = Number(opt("--time", "0")); // seconds into the NPC idles
const noProps = args.includes("--no-props") ? (args.splice(args.indexOf("--no-props"), 1), true) : false;
const npcsOnly = args.includes("--npcs-only") ? (args.splice(args.indexOf("--npcs-only"), 1), true) : false; // debug: skip world geometry
const atNpc = opt("--at-npc", ""); // frame the camera on a named NPC, in front of them and facing them
const npcDist = Number(opt("--npc-dist", "4"));
const aiSeconds = Number(opt("--ai", "0")); // run workplace behaviour trees this long (real seconds) before rendering
const atEntity = opt("--at-entity", ""); // frame the camera on an entity (by name), like --at-npc
const aiTrace = args.includes("--ai-trace") ? (args.splice(args.indexOf("--ai-trace"), 1), true) : false;
const clock = opt("--clock", ""); // HH:MM: place NPCs by their schedules (default: at their spawn points)
const [clockH, clockM] = (clock || "12:00").split(":").map(Number);
const minute = clockH * 60 + clockM;
const [outDir, ...views] = args;
if (!outDir) throw new Error("usage: render-world.ts OUT_DIR [x,y,z,yaw,pitch ...]");
const W = 1280, H = 720;

async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak")) out.push(p);
  }
  return out;
}
const sources: PakSource[] = [];
for (const p of await findPaks(root)) {
  const blob = await openAsBlob(p);
  sources.push({ path: relative(root, p), size: blob.size, open: async () => blob });
}
const level = sources.find((s) => s.path.toLowerCase() === "data/levels/rataje/level.pak")!;
const base = await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => ASSET_RE.test(n), includeHd: true });
const vfs = await base.extend(level, (n) => ASSET_RE.test(n));
const levelBlob = await level.open();
const levelEntries = await readCentralDirectory(levelBlob);
const tdat = levelEntries.find((e) => e.name.toLowerCase() === "terrain/terrain.dat")!;
const ctc = levelEntries.find((e) => e.name.toLowerCase() === "terrain/cover.ctc");
const bytes = await readEntry(levelBlob, tdat);
const terrain = parseTerrain(bytes);
const objects = parseLevelObjects(bytes, terrain.objectsOffset);
const cover = ctc && !args.includes("--no-cover") ? parseCover(await readEntry(levelBlob, ctc), terrain.size) : undefined;

let list = views;
const missionXml = new TextDecoder().decode(await readEntry(levelBlob, levelEntries.find((e) => e.name.toLowerCase() === "objects_mission0.xml")!));
const entIndex = parseEntityIndex(missionXml);
const props = noProps ? [] : propEntities(entIndex);
console.log(`entity props: ${props.length}`);
let npcEnts: ReturnType<typeof parseNpcEntities> = [];
let schedules: Schedules | null = null;
if (withNpcs || atNpc) {
  npcEnts = parseNpcEntities(missionXml);
  if (clock) {
    schedules = new Schedules(npcEnts, entIndex);
    const recast = sources.find((s) => s.path.toLowerCase() === "data/levels/rataje/recast.pak");
    if (recast && !args.includes("--no-nav")) {
      const rb = await recast.open();
      const ne = (await readCentralDirectory(rb)).find((e) => e.name.toLowerCase() === "recast/rdnavmesh_1.nav");
      if (ne) {
        const nav = new NavMesh(await readEntry(rb, ne));
        schedules.setNavMesh(nav);
        console.log(`navmesh: ${nav.tileCount} tiles`);
      }
    }
  }
}
if (!list.length) {
  const cells = new Map<number, number>();
  for (let i = 0; i < objects.brushName.length; i++) {
    const x = objects.brushMatrix[i * 16 + 12], y = objects.brushMatrix[i * 16 + 13];
    if (x < 0 || y < 0 || x >= terrain.size || y >= terrain.size) continue;
    const k = Math.floor(x / 128) * 64 + Math.floor(y / 128);
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }
  const [best] = [...cells].sort((a, b) => b[1] - a[1]);
  const cx = (Math.floor(best[0] / 64) + 0.5) * 128, cy = ((best[0] % 64) + 0.5) * 128;
  console.log(`densest brush cell around (${cx}, ${cy}) with ${best[1]} brushes`);
  list = [`${cx},${cy - 140},${heightAt(terrain, cx, cy) + 70},90,-24`, `${cx - 60},${cy - 60},0,45,-4`];
}

const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no WebGPU adapter");
const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has("texture-compression-bc") ? ["texture-compression-bc"] : [] });
device.addEventListener("uncapturederror", (e) => console.log("GPU ERROR:", (e as GPUUncapturedErrorEvent).error.message));
const terrainR = new TerrainRenderer(device, "rgba8unorm", terrain, cover);
console.log(`terrain colour: ${terrainR.coverMode}`);
const water = new WaterRenderer(device, "rgba8unorm", objects.water);
console.log(`water: ${objects.water.length} volumes, ${water.triangles} triangles`);
const npcR = new ModelRenderer(device, "rgba8unorm", 4);
let npcWorld: NpcWorld | null = null;
if (withNpcs || atNpc) {
  npcWorld = new NpcWorld(vfs, npcEnts, schedules, (x, y) => heightAt(terrain, x, y));
  console.log(`NPC entities: ${npcEnts.length}`);
}
let npcAi: NpcAi | null = null;
let lua: LuaHost | null = null;
if (aiSeconds > 0 && npcWorld) {
  const t0 = performance.now();
  const clock = { now: 0 };
  lua = await LuaHost.create(vfs, createRequire(import.meta.url).resolve("wasmoon-lua5.1/dist/liblua5.1.wasm"));
  await lua!.preload();
  await lua!.preloadTables();
  const world = await createAiWorld(vfs, {
    ents: entIndex, lua: lua!, realTime: () => clock.now, gameTime: () => clock.now * 15, random: () => 0.5,
    act: (a) => npcAi!.act(a),
    trace: (m) => { if (aiTrace && !m.startsWith("[unsupported]")) console.log(`   ai ${clock.now.toFixed(1)} s: ${m}`); },
  });
  lua!.boot();
  lua!.calls.clear();
  npcAi = new NpcAi(world, { male: new AnimLibrary(vfs, "male"), female: new AnimLibrary(vfs, "female") });
  Object.defineProperty(clock, "now", { get: () => npcAi!.now });
  npcWorld.ai = npcAi;
  console.log(`behaviour trees loaded in ${Math.round(performance.now() - t0)} ms`);
}
if (atEntity) {
  const e = [...entIndex.values()].find((x) => x.name === atEntity || x.name.startsWith(atEntity));
  if (!e) throw new Error(`no entity named ${atEntity}`);
  const [w, qx, qy, qz] = e.rot;
  const fx = 2 * (qx * qy - w * qz), fy = 1 - 2 * (qx * qx + qz * qz);
  list = [`${e.pos[0] + npcDist * fx},${e.pos[1] + npcDist * fy},${e.pos[2] + 1.6 + npcDist * 0.15},${(Math.atan2(-fy, -fx) * 180) / Math.PI},-12`];
  console.log(`framing ${e.name} (${e.cls}) at ${e.pos.map((v) => v.toFixed(1))}`);
}
if (atNpc) {
  const n = npcEnts.find((e) => e.name === atNpc);
  if (!n) throw new Error(`no NPC entity named ${atNpc}`);
  // where the schedule puts them at --clock (or the spawn point)
  const sel = await npcWorld!.select(n.pos, 1e9, 1e9, minute);
  const p = sel.find((x) => x.e === n)?.p ?? { pos: n.pos, rot: n.rot, where: "spawn", activity: "" };
  // entity forward is +Y rotated by the quaternion (w,x,y,z)
  const [w, qx, qy, qz] = p.rot;
  const fx = 2 * (qx * qy - w * qz), fy = 1 - 2 * (qx * qx + qz * qz);
  const cx = p.pos[0] + npcDist * fx, cy = p.pos[1] + npcDist * fy;
  const yaw = (Math.atan2(-fy, -fx) * 180) / Math.PI;
  list = [`${cx},${cy},${p.pos[2] + 1.6 + npcDist * 0.15},${yaw},-12`];
  console.log(`framing ${atNpc} (${p.activity || "no schedule"} at ${p.where}) at ${p.pos.map((v) => v.toFixed(1))} from camera ${list[0]}`);
}
const models = new ModelRenderer(device, "rgba8unorm", 4);
const target = device.createTexture({ size: [W, H], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
const msaa = device.createTexture({ size: [W, H], format: "rgba8unorm", sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
const depth = device.createTexture({ size: [W, H], format: "depth24plus", sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
const stride = Math.ceil((W * 4) / 256) * 256;
const readback = device.createBuffer({ size: stride * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
await mkdir(outDir, { recursive: true });

function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const T = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const caches = newWorldCaches();
for (const [i, v] of list.entries()) {
  let [x, y, z, yaw, pitch] = v.split(",").map(Number);
  if (!z) z = heightAt(terrain, x, y) + 1.8;
  const cam: FlyCamera = { pos: [x, y, z], yaw: (yaw * Math.PI) / 180, pitch: (pitch * Math.PI) / 180 };
  const t0 = performance.now();
  const scene = await buildWorldScene(vfs, terrain, objects, [x, y], radius, { maxModels: 1500, caches, props });
  const items = lodItems(scene);
  models.setModels(items);
  const out = items.map((it) => new Float32Array(it.capacity * 16));
  const counts = items.map(() => 0);
  const vp = TerrainRenderer.viewProj(cam, W / H);
  for (const mode of ["lod", "full"] as const) {
  // "full": every instance at LOD 0, no culling, for comparison
  const st = selectLods(scene, cam.pos, vp, out, counts, mode === "lod" ? {} : { lodScale: 1e9, distanceScale: 1e9 });
  counts.forEach((n, k) => models.setInstances(k, out[k], n));
  terrainR.prepare(cam, vp);
  if (npcWorld) {
    const npcs = await npcWorld.near(cam.pos, 120, 40, minute);
    if (npcAi) {
      // run the behaviour trees of NPCs at work for --ai seconds (0.1 s steps)
      updateAi(npcs, npcWorld, minute);
      for (let t = 0; t < aiSeconds; t += 0.1) {
        npcAi.tick(0.1);
        if (Math.round(t * 10) % 10 === 0) await npcAi.settle(); // let fragment clips load
      }
      if (aiTrace) console.log(`  engine API called from tree Lua: ${[...lua!.calls].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, v]) => `${k}×${v}`).join(", ")}\n  Lua errors: ${[...new Set(lua!.errors)].slice(0, 6).join(" | ")}`);
      for (const id of npcAi.ids()) {
        const st = npcAi.state(id)!;
        console.log(`  behaviour tree: ${npcEnts.find((e) => e.id === id)?.name} ${st.mode}${st.fragment ? ` ${st.fragment} (${st.clip?.name ?? "loading"})` : ""} at ${st.pos.map((v) => v.toFixed(1))}`);
      }
    }
    npcR.setModels(npcItems(npcs));
    animateNpcs(npcs, npcWorld, minute, animTime, npcR);
    npcR.setCamera(vp, cam.pos, [0.45, 0.25, 0.85]);
    console.log(`  NPCs drawn: ${npcs.length} (${npcs.slice(0, 6).map((n) => `${n.entity.name} ${n.placement.activity}@${n.placement.where}`).join(", ")}${npcs.length > 6 ? ", …" : ""}); ${npcs.filter((n) => n.placement.pose === "walk").length} walking`);
  }
  models.setCamera(vp, cam.pos, [0.45, 0.25, 0.85]);
  water.setCamera(vp, cam.pos, [0.45, 0.25, 0.85]);
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: msaa.createView(), resolveTarget: target.createView(), clearValue: { r: 0.55, g: 0.62, b: 0.70, a: 1 }, loadOp: "clear", storeOp: "discard" }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
  });
  if (!npcsOnly) { terrainR.draw(pass); models.draw(pass); }
  if (npcWorld) npcR.draw(pass);
  if (!npcsOnly) water.draw(pass);
  pass.end();
  enc.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: stride }, [W, H]);
  device.queue.submit([enc.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const m = new Uint8Array(readback.getMappedRange());
  const rgba = new Uint8Array(W * H * 4);
  for (let r = 0; r < H; r++) rgba.set(m.subarray(r * stride, r * stride + W * 4), r * W * 4);
  readback.unmap();
  const file = join(outDir, `world_${i}_${mode}.png`);
  await writeFile(file, png(W, H, rgba));
  console.log(`${file}: ${scene.models.length} models (${scene.modelsSkipped} over cap, ${scene.failed.size} failed), ${scene.instances} instances; drawn ${st.drawn} (per LOD ${st.perLod.map((n) => n ?? 0).join("/")}), culled distance ${st.culledDistance} frustum ${st.culledFrustum}; ${(models.stats.triangles / 1e6).toFixed(2)}M model triangles, ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
}
models.destroy();
terrainR.destroy();
device.destroy();
