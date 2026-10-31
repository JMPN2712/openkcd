// Node test for src/inno.ts against the GOG installers (read-only): each
// file list must match the installed game, and sampled files (every file
// with --full) must inflate to the installed bytes, with each part's MD5
// checked. Without arguments it tests the base game and every DLC installer.
// usage: node scripts/test-inno.ts [--root=GAME_ROOT] [--full] [INSTALLER_EXE...]

import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { checkSlice, readFile, readInstaller, sliceName, sliceSource, type InstallerFile } from "../src/inno.ts";

const full = process.argv.includes("--full");
const root = process.argv.find((a) => a.startsWith("--root="))?.slice(7) ?? join(homedir(), "kcd1");
let exes = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!exes.length) {
  const dir = join(homedir(), "Downloads/kingdom_come_deliverance");
  // the DLC installers sit beside the base game's or in a DLC subfolder
  const inDir = async (d: string) => (await readdir(d).catch(() => [])).filter((n) => n.endsWith(".exe")).map((n) => join(d, n));
  exes = [...(await inDir(dir)), ...(await inDir(join(dir, "DLC")))];
}

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`FAIL ${msg}`);
};

let slice: (i: number) => Promise<Blob>;
let totalBytes = 0;
let totalSecs = 0;
let totalFiles = 0;

// the installed game has the same files at the same sizes (it may have extras, e.g. user/);
// a DLC that isn't installed at all is checked against its MD5s only
async function checkList(files: InstallerFile[]): Promise<number> {
  const sizes = await Promise.all(files.map((f) => stat(join(root, f.path)).then((s) => s.size, () => -1)));
  const present = sizes.filter((s) => s >= 0).length;
  files.forEach((f, i) => {
    if (sizes[i] < 0 && present > 0) fail(`${f.path}: not in ${root}`);
    else if (sizes[i] >= 0 && sizes[i] !== f.size) fail(`${f.path}: ${f.size} bytes, installed ${sizes[i]}`);
  });
  return present;
}

/**
 * Inflate a file, checking every part's MD5 and the file's, and compare it
 * with the installed copy when there is one.
 */
async function verify(f: InstallerFile): Promise<void> {
  const fh = await open(join(root, f.path)).catch(() => null);
  const whole = createHash("md5");
  let part = 0;
  let partHash = createHash("md5");
  let inPart = 0;
  let pos = 0;
  try {
    for await (const chunk of readFile(f, slice)) {
      if (fh) {
        const disk = Buffer.alloc(chunk.byteLength);
        await fh.read(disk, 0, chunk.byteLength, pos);
        if (!disk.equals(chunk)) throw new Error(`differs from the installed file near byte ${pos}`);
      }
      whole.update(chunk);
      for (let o = 0; o < chunk.byteLength; ) {
        const n = Math.min(chunk.byteLength - o, f.parts[part].size - inPart);
        partHash.update(chunk.subarray(o, o + n));
        o += n;
        inPart += n;
        if (inPart === f.parts[part].size) {
          if (partHash.digest("hex") !== f.parts[part].md5) throw new Error(`part ${part} MD5 mismatch`);
          part++;
          partHash = createHash("md5");
          inPart = 0;
        }
      }
      pos += chunk.byteLength;
    }
    if (pos !== f.size) throw new Error(`${pos} of ${f.size} bytes`);
    if (whole.digest("hex") !== f.md5) throw new Error("file MD5 mismatch");
  } catch (err) {
    fail(`${f.path}: ${(err as Error).message}`);
  } finally {
    await fh?.close();
  }
}

for (const exePath of exes) {
  const t0 = performance.now();
  const exe = await openAsBlob(exePath);
  const inst = await readInstaller(exe);
  const total = inst.files.reduce((a, f) => a + f.size, 0);
  const parts = inst.files.reduce((a, f) => a + f.parts.length, 0);
  const where = inst.dataOffset ? "data in the .exe" : `${inst.sliceCount} slice${inst.sliceCount === 1 ? "" : "s"}`;
  console.log(`${basename(exePath)}: ${inst.files.length} files in ${parts} parts, ${(total / 2 ** 30).toFixed(2)} GiB, ${where} (headers ${(performance.now() - t0).toFixed(0)} ms)`);

  const slices: Blob[] = [];
  for (let i = 0; i < inst.sliceCount; i++) {
    slices.push(await openAsBlob(join(dirname(exePath), sliceName(basename(exePath), i))));
    await checkSlice(slices[i], i);
  }
  slice = sliceSource(inst, exe, async (i) => slices[i]);
  if (!(await checkList(inst.files))) console.log("  not installed: checking MD5s only");

  // sample: every file under 64 MiB, plus the files whose parts cross into the next slice
  const sample = full ? inst.files : inst.files.filter((f) => f.size < 64 << 20 || f.parts.some((p) => p.lastSlice !== p.slice));
  const t1 = performance.now();
  for (const f of sample) await verify(f);
  totalSecs += (performance.now() - t1) / 1000;
  totalBytes += sample.reduce((a, f) => a + f.size, 0);
  totalFiles += sample.length;
}
console.log(`verified ${totalFiles} files, ${(totalBytes / 2 ** 30).toFixed(2)} GiB in ${totalSecs.toFixed(1)} s (${(totalBytes / 2 ** 20 / totalSecs).toFixed(0)} MiB/s), ${failures} failures`);
process.exit(failures ? 1 : 0);
