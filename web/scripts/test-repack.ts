// Repack check against an installed game: plans the repack (repack.ts) for the
// default install, writes every repacked pak to OUT_DIR, reads each kept file
// back (CRC-checked), then checks the engine picks the same version of every
// file from the repacked paks as from the originals: top versions, texture
// headers with their split mips, models. The texture check runs again with
// the HD packs on top, which the repack never touches.
// usage: node scripts/test-repack.ts [GAME_ROOT] [--out=DIR]   (OUT_DIR is removed afterwards)

import { openAsBlob } from "node:fs";
import { mkdir, readdir, rm, statfs } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { once } from "node:events";
import type { PakSource } from "../src/paks.ts";
import { Vfs, type VfsHit } from "../src/vfs.ts";
import { planRepack, repackable, repackedPak, repackedSize } from "../src/repack.ts";
import { DEFAULT_OPTIONS, wanted } from "../src/install.ts";
import { readEntry, readZip } from "../src/zip.ts";
import { openTexture, TEXTURE_RE, textureStem } from "../src/texture.ts";
import { MODEL_RE } from "../src/model.ts";
import { parseCgf } from "../src/cgf.ts";

const root = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? join(homedir(), "kcd1");
const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? join(homedir(), ".cache", "openkcd-test-repack");
const G = (b: number) => `${(b / 2 ** 30).toFixed(2)} GiB`;

async function find(d: string): Promise<string[]> {
  const o: string[] = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) o.push(...(await find(p)));
    else if (e.name.toLowerCase().endsWith(".pak")) o.push(p);
  }
  return o;
}

async function source(file: string, path: string): Promise<PakSource> {
  const blob = await openAsBlob(file);
  return { path, size: blob.size, open: async () => blob };
}

const all: PakSource[] = [];
for (const f of await find(root)) {
  const path = relative(root, f);
  // the default install, plus the HD texture paks for the HD check
  if (wanted({ path } as never, { ...DEFAULT_OPTIONS, hdTextures: true })) all.push(await source(f, path));
}
const installed = all.filter((p) => wanted({ path: p.path } as never, DEFAULT_OPTIONS));

let t0 = Date.now();
const plans = (await planRepack(installed)).filter((p) => p.dead.size);
const dead = plans.reduce((a, p) => a + p.deadBytes, 0);
const newSize = plans.reduce((a, p) => a + repackedSize(p), 0);
console.log(`plan: ${G(dead)} dead in ${plans.reduce((a, p) => a + p.dead.size, 0)} files, ${plans.length} paks shrink (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const free = (await statfs(dirname(out)).then((s) => s.bavail * s.bsize, () => Infinity));
if (newSize > free - 10 * 2 ** 30) throw new Error(`the repacked paks need ${G(newSize)}; ${G(free)} free at ${dirname(out)}`);

// write and verify every repacked pak
t0 = Date.now();
let failures = 0;
const repacked = new Map<string, PakSource>();
for (const plan of plans) {
  const file = join(out, plan.pak.path);
  await mkdir(dirname(file), { recursive: true });
  const ws = createWriteStream(file);
  for await (const chunk of repackedPak(await plan.pak.open(), plan)) if (!ws.write(chunk)) await once(ws, "drain");
  ws.end();
  await once(ws, "finish");
  const src = await source(file, plan.pak.path);
  repacked.set(plan.pak.path, src);
  const blob = await src.open();
  const { entries } = await readZip(blob);
  const kept = plan.entries.filter((e) => !plan.dead.has(e));
  const problems: string[] = [];
  if (blob.size !== repackedSize(plan)) problems.push(`size ${blob.size}, planned ${repackedSize(plan)}`);
  if (entries.length !== kept.length) problems.push(`${entries.length} entries, expected ${kept.length}`);
  const want = new Map(kept.map((e) => [e.name, e]));
  for (const e of entries) {
    const k = want.get(e.name);
    if (!k || k.crc !== e.crc || k.usize !== e.usize) problems.push(`${e.name}: not the kept entry`);
    else await readEntry(blob, e).catch((err: Error) => problems.push(err.message)); // CRC-checked
    if (problems.length > 5) break;
  }
  if (problems.length) failures++;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${plan.pak.path}: ${G(plan.pak.size)} -> ${G(blob.size)}${problems.length ? `\n  ${problems.join("\n  ")}` : ""}`);
}
console.log(`wrote and read back ${G(newSize)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

// the engine's choices, before and after
t0 = Date.now();
const id = (h: VfsHit | undefined | null) => (h ? `${h.entry.name}:${h.entry.crc}:${h.entry.usize}` : "none");
async function choice(vfs: Vfs, path: string): Promise<string> {
  if (TEXTURE_RE.test(path)) {
    if (textureStem(path) !== path) return ""; // split mips: checked through their headers
    const t = await openTexture(vfs, path).catch((e: Error) => null);
    return t ? `${id(t.headerHit)} ${t.partHits.map(id).join(" ")} from ${t.firstLevel}` : "error";
  }
  if (MODEL_RE.test(path)) {
    for (const h of vfs.lookupAll(path)) if (await vfs.read(h).then((b) => parseCgf(b).meshes.length > 0).catch(() => false)) return id(h);
    return "no mesh";
  }
  return id(vfs.lookup(path));
}
for (const hd of [false, true]) {
  const before = all.filter((p) => repackable(p.path) || (hd && p.path.toLowerCase().includes("_hd") && !p.path.toLowerCase().startsWith("data/levels/")));
  const after = before.map((p) => repacked.get(p.path) ?? p);
  const opts = { filter: (n: string) => !hd || TEXTURE_RE.test(n), includeHd: hd };
  const [a, b] = [await Vfs.build(before, opts), await Vfs.build(after, opts)];
  let checked = 0, diffs = 0;
  for (const path of a.paths()) {
    const [x, y] = [await choice(a, path), await choice(b, path)];
    checked++;
    if (x !== y && ++diffs <= 10) console.log(`DIFF${hd ? " (HD)" : ""} ${path}\n  before ${x}\n  after  ${y}`);
  }
  if (diffs) failures++;
  console.log(`${hd ? "with HD textures" : "default install"}: ${checked} files, ${diffs} choose differently (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

await rm(out, { recursive: true, force: true });
console.log(failures ? `${failures} failures` : "all good");
process.exit(failures ? 1 : 0);
