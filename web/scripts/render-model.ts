// Headless render of a model to PNG using Dawn (the `webgpu` npm package),
// to check the renderer without a browser.
// usage: node scripts/render-model.ts OUT_DIR MODEL_PATH... [--root GAME_ROOT] [--size WxH]

import { openAsBlob } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, basename } from "node:path";
import { deflateSync } from "node:zlib";
import { create, globals } from "webgpu";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { ASSET_RE } from "../src/assets.ts";
import { loadModel } from "../src/model.ts";
import { ModelRenderer } from "../src/renderer.ts";

Object.assign(globalThis, globals);

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const [W, H] = opt("--size", "800x600").split("x").map(Number);
const view = opt("--view", ""); // yaw,pitch,zoom e.g. -1.9,0.35,1
const noTex = args.includes("--notex") ? (args.splice(args.indexOf("--notex"), 1), true) : false;
const flat = args.includes("--flat") ? (args.splice(args.indexOf("--flat"), 1), true) : false;
const [outDir, ...models] = args;
if (!outDir || !models.length) throw new Error("usage: render-model.ts OUT_DIR MODEL_PATH...");

async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak")) out.push(p);
  }
  return out;
}

function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no WebGPU adapter");
const info = adapter.info;
console.log(`adapter: ${info.vendor} ${info.architecture} ${info.description}`);
const device = await adapter.requestDevice();
device.addEventListener("uncapturederror", (e) => console.log("GPU ERROR:", (e as GPUUncapturedErrorEvent).error.message));

const sources: PakSource[] = [];
for (const p of await findPaks(root)) {
  const blob = await openAsBlob(p);
  sources.push({ path: relative(root, p), size: blob.size, open: async () => blob });
}
const vfs = await Vfs.build(sources, { filter: (n) => ASSET_RE.test(n), includeHd: true });
await mkdir(outDir, { recursive: true });

const renderer = new ModelRenderer(device, "rgba8unorm", 4);
const target = device.createTexture({ size: [W, H], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
const stride = Math.ceil((W * 4) / 256) * 256;
const readback = device.createBuffer({ size: stride * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

for (const path of models) {
  const t0 = performance.now();
  const model = await loadModel(vfs, path.toLowerCase(), { maxTextureDim: 1024 });
  if (noTex) model.diffuse = model.diffuse.map(() => null);
  renderer.setModel(model);
  const cam = renderer.defaultCamera();
  cam.flat = flat;
  if (view) {
    const [yaw, pitch, zoom] = view.split(",").map(Number);
    Object.assign(cam, { yaw, pitch, distance: cam.distance / (zoom || 1) });
  }
  renderer.render(target, cam);
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: stride }, [W, H]);
  device.queue.submit([enc.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(readback.getMappedRange());
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) rgba.set(mapped.subarray(y * stride, y * stride + W * 4), y * W * 4);
  readback.unmap();
  const file = join(outDir, basename(path).replace(/\.\w+$/, "") + (noTex ? "_notex" : "") + (view ? "_v" : "") + ".png");
  await writeFile(file, png(W, H, rgba));
  console.log(`${path}: ${JSON.stringify(renderer.stats)} materials=${model.materials.length} ${Math.round(performance.now() - t0)}ms -> ${file}`);
  for (const n of model.notes) console.log("   note:", n);
}
renderer.destroy();
device.destroy();
