// Texture streaming (src/texturePool.ts), headless: textures grow to the size requested and back
// down under a small budget, a halved texture holds exactly the source's lower mips (read back
// from the GPU), and pak reads through the worker threads match reads on the main thread.
// usage: node scripts/test-texture-pool.ts [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { gpuDevice, nodeReadWorkers, openRataje } from "./lib.ts";
import { loadMipChain, type MipChain } from "../src/model.ts";
import { TexturePool, type PooledTexture } from "../src/texturePool.ts";
import { TEXTURE_RE } from "../src/texture.ts";

const args = process.argv.slice(2);
const root = args.includes("--root") ? args[args.indexOf("--root") + 1] : join(homedir(), "kcd1");
const lvl = await openRataje(root);
const device = await gpuDevice();
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

// BC diffuse maps with at least 1024² available
const stems: string[] = [];
for (const p of lvl.vfs.paths()) {
  if (!p.endsWith(".dds") || !p.startsWith("objects/") || !TEXTURE_RE.test(p) || p.includes("_ddn")) continue;
  const c = await loadMipChain(lvl.vfs, p, 64).catch(() => null);
  if (c?.bc && c.full >= 1024 && c.levels[0].w === c.levels[0].h) stems.push(p);
  if (stems.length === 6) break;
}
check(stems.length === 6, `found ${stems.length} square BC textures of 1024² or more`);

/** The bytes of one mip of a BC texture, read back from the GPU. */
async function readMip(t: GPUTexture, level: number, blockBytes: number): Promise<Uint8Array> {
  const bw = Math.max(1, Math.ceil((t.width >> level) / 4)), bh = Math.max(1, Math.ceil((t.height >> level) / 4));
  const row = bw * blockBytes, padded = Math.ceil(row / 256) * 256;
  const buf = device.createBuffer({ size: padded * bh, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: t, mipLevel: level }, { buffer: buf, bytesPerRow: padded, rowsPerImage: bh }, [bw * 4, bh * 4]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const all = new Uint8Array(buf.getMappedRange());
  const out = new Uint8Array(row * bh);
  for (let y = 0; y < bh; y++) out.set(all.subarray(y * padded, y * padded + row), y * row);
  buf.unmap();
  buf.destroy();
  return out;
}

const run = async (pool: TexturePool, frames: number) => {
  for (let f = 0; f < frames; f++) {
    pool.beginFrame();
    await new Promise((r) => setTimeout(r, 2));
  }
};

// grow: request 1024 for every texture with plenty of memory
{
  const pool = new TexturePool(device, lvl.vfs, { budget: 256 * 2 ** 20, maxDim: 1024, releaseCpu: false });
  const changes: number[] = [];
  pool.onChange((c) => changes.push(c.size));
  const chains: MipChain[] = await Promise.all(stems.map((s) => loadMipChain(lvl.vfs, s, 128)));
  const es = chains.map((c) => pool.acquire(c));
  check(es.every((e) => e.dim === 128), "acquired at the first-load size (128)");
  for (let k = 0; k < 120 && !es.every((e) => e.dim === 1024); k++) {
    for (const e of es) pool.request(e, 900);
    await run(pool, 1);
  }
  check(es.every((e) => e.dim === 1024), `grew to 1024 when 900 texels were requested (${es.map((e) => e.dim).join(", ")})`);
  check(changes.length > 0, `listeners told (${changes.reduce((a, b) => a + b, 0)} changes)`);
  // the grown texture's top mip matches the file's 1024 mip
  const full = await loadMipChain(lvl.vfs, stems[0], 1024);
  const top = await readMip(es[0].texture, 0, full.bc!.blockBytes);
  check(top.length === full.levels[0].data.byteLength && top.every((v, i) => v === full.levels[0].data[i]), "grown top mip matches the file");
  pool.destroy();
}

// shrink: a budget that holds one 1024² texture, the rest wanted small
{
  const chains = await Promise.all(stems.map((s) => loadMipChain(lvl.vfs, s, 1024)));
  const bytes = chains[0].levels.reduce((s, l) => s + l.data.byteLength, 0);
  const pool = new TexturePool(device, lvl.vfs, { budget: chains.reduce((s, c) => s + c.levels.reduce((t, l) => t + l.data.byteLength, 0), 0) + bytes, maxDim: 2048, releaseCpu: false });
  const es: PooledTexture[] = chains.map((c) => pool.acquire(c));
  // one texture wants 2048 (needs room: 3× its bytes more), the others want 64
  for (let k = 0; k < 200 && es[0].dim < 2048 && es[0].full >= 2048; k++) {
    pool.request(es[0], 4000);
    for (const e of es.slice(1)) pool.request(e, 60);
    await run(pool, 1);
  }
  if (es[0].full >= 2048) check(es[0].dim === 2048, `the wanted texture grew to 2048 (${es[0].dim})`);
  else console.log(`skip: ${stems[0]} has no 2048 mip`);
  check(es.slice(1).some((e) => e.dim < 1024), `others shrank to make room (${es.slice(1).map((e) => e.dim).join(", ")})`);
  check(pool.bytes <= pool.opts.budget, `within the budget (${(pool.bytes / 2 ** 20).toFixed(1)} of ${(pool.opts.budget / 2 ** 20).toFixed(1)} MiB)`);
  // a shrunk texture's top mip is the file's mip of that size (copied on the GPU)
  const shrunk = es.findIndex((e, i) => i > 0 && e.dim < 1024);
  if (shrunk > 0) {
    const e = es[shrunk], c = chains[shrunk], level = c.levels.find((l) => l.w === e.dim)!;
    const got = await readMip(e.texture, 0, c.bc!.blockBytes);
    check(got.length === level.data.byteLength && got.every((v, i) => v === level.data[i]), `shrunk on the GPU to ${e.dim}: its top mip is the file's ${e.dim} mip`);
  }
  pool.destroy();
}

// worker reads match main-thread reads
{
  // entries big enough to go to a worker
  const hits = [];
  for (const p of lvl.vfs.paths()) {
    const h = lvl.vfs.lookup(p)!;
    if (h.entry.csize >= 64 * 1024) hits.push(h);
    if (hits.length === 12) break;
  }
  const direct = await Promise.all(hits.map((h) => lvl.vfs.read(h)));
  lvl.vfs.workers = nodeReadWorkers(root, 2);
  const viaWorkers = await Promise.all(hits.map((h) => lvl.vfs.read(h)));
  check(hits.length > 0 && direct.every((d, i) => d.length === viaWorkers[i].length && d.every((v, j) => v === viaWorkers[i][j])), `${hits.length} reads through worker threads match`);
  lvl.vfs.workers.terminate();
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exitCode = failures ? 1 : 0;
