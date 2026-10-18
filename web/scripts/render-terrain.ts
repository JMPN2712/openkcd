// Headless terrain render through Dawn: decodes Rataje's terrain.dat and
// renders views to PNG.
// usage: node scripts/render-terrain.ts OUT_DIR [x,y,z,yawDeg,pitchDeg ...] [--root GAME_ROOT]

import { openAsBlob } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { create, globals } from "webgpu";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { parseTerrain, heightAt } from "../src/terrain.ts";
import { TerrainRenderer } from "../src/terrainRenderer.ts";

Object.assign(globalThis, globals);
const args = process.argv.slice(2);
const root = args.includes("--root") ? args.splice(args.indexOf("--root"), 2)[1] : join(homedir(), "kcd1");
const [outDir, ...views] = args;
if (!outDir) throw new Error("usage: render-terrain.ts OUT_DIR [x,y,z,yaw,pitch ...]");
const W = 1280, H = 720;

const blob = await openAsBlob(join(root, "Data/Levels/rataje/level.pak"));
const entry = (await readCentralDirectory(blob)).find((e) => e.name.toLowerCase() === "terrain/terrain.dat")!;
const terrain = parseTerrain(await readEntry(blob, entry));

// keep the GPU object referenced: if it is garbage-collected while the device lives, Dawn aborts
const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no WebGPU adapter");
const device = await adapter.requestDevice();
device.addEventListener("uncapturederror", (e) => console.log("GPU ERROR:", (e as GPUUncapturedErrorEvent).error.message));
const renderer = new TerrainRenderer(device, "rgba8unorm", terrain);
const target = device.createTexture({ size: [W, H], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
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

const list = views.length ? views : ["2048,-600,900,90,-35", "1500,1800,0,30,-8"];
for (const [i, v] of list.entries()) {
  let [x, y, z, yaw, pitch] = v.split(",").map(Number);
  if (!z) z = heightAt(terrain, x, y) + 25; // 0 = 25 m above ground
  renderer.render(target, { pos: [x, y, z], yaw: (yaw * Math.PI) / 180, pitch: (pitch * Math.PI) / 180 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: stride }, [W, H]);
  device.queue.submit([enc.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const m = new Uint8Array(readback.getMappedRange());
  const rgba = new Uint8Array(W * H * 4);
  for (let r = 0; r < H; r++) rgba.set(m.subarray(r * stride, r * stride + W * 4), r * W * 4);
  readback.unmap();
  const file = join(outDir, `terrain_${i}.png`);
  await writeFile(file, png(W, H, rgba));
  console.log(`${file}: camera ${[x, y, z].map((n) => n.toFixed(0))} yaw ${yaw} pitch ${pitch}; patches per LOD ${renderer.stats.patches.join("/")}, ${(renderer.stats.triangles / 1e6).toFixed(2)}M triangles`);
}
renderer.destroy();
device.destroy();
