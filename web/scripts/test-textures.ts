// Node test for the texture pipeline against a real install (read-only).
//  1. Builds the texture VFS and validates the split-mip layout of every header.
//  2. Decodes a sample of each pixel format and writes raw mip data + our decode
//     to OUT_DIR, for scripts/compare_pillow.py to check against Pillow.
//
// usage: node scripts/test-textures.ts OUT_DIR [GAME_ROOT] [--samples N]

import { openAsBlob } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { TEXTURE_RE, decodeMip, mipData, openTexture, textureStem } from "../src/texture.ts";
import { mipDims } from "../src/dds.ts";

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) throw new Error("usage: test-textures.ts OUT_DIR [GAME_ROOT] [--samples N]");
const root = args[1] && !args[1].startsWith("--") ? args[1] : join(homedir(), "kcd1");
const samplesPerFormat = args.includes("--samples") ? Number(args[args.indexOf("--samples") + 1]) : 6;

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

let t0 = performance.now();
const vfs = await Vfs.build(sources, { filter: (n) => TEXTURE_RE.test(n), includeHd: true });
console.log(`VFS: ${vfs.size} texture files from ${sources.length} paks in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// collect stems
const stems = new Set<string>();
for (const key of vfs.paths()) {
  const s = textureStem(key);
  if (s && vfs.lookup(s)) stems.add(s);
}
const orphans = [...vfs.paths()].filter((k) => {
  const s = textureStem(k);
  return !s || !vfs.lookup(s);
});

t0 = performance.now();
const byFormat = new Map<string, string[]>();
let split = 0, warned = 0, unsupported = 0, fellBack = 0;
const warnSamples: string[] = [];
const unsupportedLabels = new Map<string, number>();
for (const stem of stems) {
  try {
    const t = await openTexture(vfs, stem);
    if (t.splitParts) split++;
    if (t.skipped.length && !t.warnings.length) fellBack++;
    if (t.warnings.length) {
      warned++;
      if (warnSamples.length < 60) warnSamples.push(`${stem}: ${t.warnings.join("; ")}`);
    }
    if (!t.header.format) {
      unsupported++;
      unsupportedLabels.set(t.header.formatLabel, (unsupportedLabels.get(t.header.formatLabel) ?? 0) + 1);
      continue;
    }
    const key = `${t.header.formatLabel}${t.header.faces > 1 ? " cube" : ""}`;
    if (!byFormat.has(key)) byFormat.set(key, []);
    byFormat.get(key)!.push(stem);
  } catch (err) {
    warned++;
    if (warnSamples.length < 60) warnSamples.push(`${stem}: ERROR ${(err as Error).message}`);
  }
}
console.log(`headers: ${stems.size} (split: ${split}), fell back to an older complete version: ${fellBack}, layout warnings: ${warned}, unsupported format: ${unsupported}, orphan parts: ${orphans.length} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
for (const w of warnSamples) console.log("  WARN", w);
for (const [k, v] of unsupportedLabels) console.log("  unsupported", k, v);
for (const o of orphans.slice(0, 5)) console.log("  orphan", o);

// decode samples
await mkdir(outDir, { recursive: true });
const manifest: unknown[] = [];
let decoded = 0, decodeFailures = 0;
t0 = performance.now();
for (const [fmt, list] of [...byFormat].sort()) {
  const step = Math.max(1, Math.floor(list.length / samplesPerFormat));
  for (let i = 0, n = 0; i < list.length && n < samplesPerFormat; i += step, n++) {
    const stem = list[i];
    try {
      const t = await openTexture(vfs, stem);
      // largest mip <= 512 px; prefer a split level when there is one, to exercise assembly
      let level = t.firstLevel;
      while (level < t.header.mipCount - 1 && Math.max(...mipDims(t.header, level)) > 512) level++;
      const raw = await mipData(vfs, t, level);
      const { w, h, pixels } = await decodeMip(vfs, t, level);
      const id = `s${manifest.length}`;
      await writeFile(join(outDir, `${id}.bin`), raw);
      await writeFile(join(outDir, `${id}.out`), pixels.data instanceof Float32Array ? new Uint8Array(pixels.data.buffer) : pixels.data);
      // the header's own DX10 / FourCC block, so the comparer can rebuild a one-mip DDS
      const pf = t.headerBytes.subarray(t.headerBytes[0] === 0x44 ? 4 : 0);
      manifest.push({ id, stem, fmt, level, split: level < t.splitParts, w, h, kind: pixels.kind,
        pf: Buffer.from(pf.subarray(72, 104)).toString("hex"),
        dx10: t.header.headerSize - (t.headerBytes[0] === 0x44 ? 4 : 0) > 124 ? Buffer.from(pf.subarray(124, 144)).toString("hex") : null });
      decoded++;
    } catch (err) {
      decodeFailures++;
      console.log(`  DECODE FAIL ${fmt} ${stem}: ${(err as Error).message}`);
    }
  }
}
await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`decoded ${decoded} samples across ${byFormat.size} formats, ${decodeFailures} failures (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
console.log("formats:", [...byFormat].map(([k, v]) => `${k}=${v.length}`).join(", "));
