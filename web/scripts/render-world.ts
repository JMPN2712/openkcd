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
import { TerrainRenderer, type FlyCamera } from "../src/terrainRenderer.ts";
import { ModelRenderer } from "../src/renderer.ts";
import { buildWorldScene, lodItems, newWorldCaches, selectLods } from "../src/world.ts";

Object.assign(globalThis, globals);
const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const radius = Number(opt("--radius", "500"));
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
  const scene = await buildWorldScene(vfs, terrain, objects, [x, y], radius, { maxModels: 1500, caches });
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
  models.setCamera(vp, cam.pos, [0.45, 0.25, 0.85]);
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: msaa.createView(), resolveTarget: target.createView(), clearValue: { r: 0.55, g: 0.62, b: 0.70, a: 1 }, loadOp: "clear", storeOp: "discard" }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
  });
  terrainR.draw(pass);
  models.draw(pass);
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
