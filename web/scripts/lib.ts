// Shared helpers for the headless scripts: open the game's paks and Rataje, a Dawn WebGPU
// device, an offscreen render target with PNG readback.

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import { create, globals } from "webgpu";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { ASSET_RE } from "../src/assets.ts";
import { dataStart, readCentralDirectory, readEntry } from "../src/zip.ts";
import { Roads } from "../src/roads.ts";
import { Decals } from "../src/decals.ts";
import { parseTerrain, type Terrain } from "../src/terrain.ts";
import { parseLevelObjects, type LevelObjects } from "../src/levelObjects.ts";
import { parseCover, type Cover } from "../src/cover.ts";
import { parseEntityIndex, propEntities, type EntityInfo } from "../src/levelEntities.ts";
import { parseLayerNames, defaultHiddenLayers } from "../src/levelLayers.ts";
import { setGpuBlockCompression } from "../src/model.ts";
import { parseTimeOfDay, type TimeOfDay } from "../src/tod.ts";
import { parseSurfaceTypes } from "../src/terrainDetail.ts";
import { MergedMeshes } from "../src/mergedMeshes.ts";
import { Worker } from "node:worker_threads";
import { ReadWorkers, type ReadReply } from "../src/readWorkers.ts";

Object.assign(globalThis, globals);

async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak")) out.push(p);
  }
  return out;
}

export interface Level {
  sources: PakSource[];
  vfs: Vfs;
  terrain: Terrain;
  objects: LevelObjects;
  cover?: Cover;
  props: EntityInfo[];
  hiddenLayers: Set<number>;
  tod: TimeOfDay | null;
  /** surface type id → detail material (leveldata.xml) */
  surfaceTypes: Map<number, string>;
  /** grass and ground plants (merged-mesh sectors) */
  merged: MergedMeshes;
  /** roads, read from terrain.dat as they stream in, and the octree decals */
  roads: Roads;
  decals: Decals;
}

/** Rataje with the asset VFS (level files on top), like the world view. */
export async function openRataje(root: string, opts: { cover?: boolean; hd?: boolean } = {}): Promise<Level> {
  const sources: PakSource[] = [];
  for (const p of await findPaks(root)) {
    const blob = await openAsBlob(p);
    sources.push({ path: relative(root, p), size: blob.size, open: async () => blob });
  }
  const level = sources.find((s) => s.path.toLowerCase() === "data/levels/rataje/level.pak")!;
  const base = await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => ASSET_RE.test(n), includeHd: opts.hd ?? false });
  const vfs = await base.extend(level, (n) => ASSET_RE.test(n));
  const lb = await level.open();
  const entries = await readCentralDirectory(lb);
  const read = async (n: string) => {
    const e = entries.find((x) => x.name.toLowerCase() === n);
    return e ? readEntry(lb, e) : null;
  };
  const bytes = (await read("terrain/terrain.dat"))!;
  const terrain = parseTerrain(bytes);
  const objects = parseLevelObjects(bytes, terrain.objectsOffset);
  const ctc = opts.cover === false ? null : await read("terrain/cover.ctc");
  const cover = ctc ? parseCover(ctc, terrain.size) : undefined;
  const mission = await read("objects_mission0.xml");
  const props = mission ? propEntities(parseEntityIndex(new TextDecoder().decode(mission))) : [];
  const ld = await read("leveldata.xml");
  const ldText = ld ? new TextDecoder().decode(ld) : "";
  const hiddenLayers = ld ? defaultHiddenLayers(parseLayerNames(ldText)) : new Set<number>();
  const surfaceTypes = parseSurfaceTypes(ldText);
  const missionEnv = await read("mission_mission0.xml");
  const tod = missionEnv ? parseTimeOfDay(new TextDecoder().decode(missionEnv)) : null;
  return { sources, vfs, terrain, objects, cover, props, hiddenLayers, tod, surfaceTypes, merged: new MergedMeshes(lb, entries), roads: new Roads(lb, dataStart(lb, entries.find((x) => x.name.toLowerCase() === "terrain/terrain.dat")!), objects.roads), decals: new Decals(objects.decalIndex, terrain) };
}

/**
 * Pak reads on `n` worker threads (scripts/readWorker-node.ts), like the browser's: set as
 * `vfs.workers`. Unreferenced, so they don't keep a finished script alive.
 */
export function nodeReadWorkers(root: string, n = 4): ReadWorkers {
  return new ReadWorkers(Array.from({ length: n }, () => {
    const w = new Worker(new URL("./readWorker-node.ts", import.meta.url));
    w.unref();
    return { postMessage: (m) => w.postMessage(m), onReply: (fn) => w.on("message", (r: ReadReply) => fn(r)), terminate: () => void w.terminate() };
  }), (pak) => join(root, pak.path));
}

/** The Dawn instance must outlive its devices (collected, it aborts the process on the next map). */
let gpu: GPU | null = null;

export async function gpuDevice(): Promise<GPUDevice> {
  gpu ??= create([]);
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice({ requiredFeatures: (["texture-compression-bc", "indirect-first-instance"] as GPUFeatureName[]).filter((f) => adapter.features.has(f) && !(f === "indirect-first-instance" && process.env.NO_INDIRECT)) });
  setGpuBlockCompression(device.features.has("texture-compression-bc"));
  device.addEventListener("uncapturederror", (e) => console.log("GPU ERROR:", (e as GPUUncapturedErrorEvent).error.message));
  return device;
}

export function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const T = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** An offscreen colour target with a readback buffer. */
export class Offscreen {
  readonly device: GPUDevice;
  readonly width: number;
  readonly height: number;
  readonly target: GPUTexture;
  private readback: GPUBuffer;
  private stride: number;
  constructor(device: GPUDevice, width: number, height: number, format: GPUTextureFormat = "rgba8unorm") {
    this.device = device;
    this.width = width;
    this.height = height;
    this.target = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.stride = Math.ceil((width * 4) / 256) * 256;
    this.readback = device.createBuffer({ size: this.stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }

  /** Copy the target into an RGBA PNG. */
  async png(): Promise<Buffer> {
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.target }, { buffer: this.readback, bytesPerRow: this.stride }, [this.width, this.height]);
    this.device.queue.submit([enc.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);
    const m = new Uint8Array(this.readback.getMappedRange());
    const rgba = new Uint8Array(this.width * this.height * 4);
    for (let r = 0; r < this.height; r++) rgba.set(m.subarray(r * this.stride, r * this.stride + this.width * 4), r * this.width * 4);
    this.readback.unmap();
    return png(this.width, this.height, rgba);
  }
}
