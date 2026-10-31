// Node test for installing part by part (src/install.ts): with only some of the installer's .bin
// slices in the folder, the install copies every file those slices hold, then stops with
// SliceNeeded naming the next slice, and lists the slices it is done with (safe to delete). A
// second run with the first slice deleted and the next one added carries on from there.
// The target is in memory (sizes only; test-install.ts checks the bytes), so nothing is written.
// usage: node scripts/test-part-install.ts INSTALLER_DIR [--slices=2]

import { openAsBlob } from "node:fs";
import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OPTIONS, findInstallers, install, SliceNeeded, type Target } from "../src/install.ts";
import { sliceName } from "../src/inno.ts";

const [srcDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!srcDir) throw new Error("usage: test-part-install.ts INSTALLER_DIR [--slices=2]");
const first = Number(process.argv.find((a) => a.startsWith("--slices="))?.slice(9) ?? 2);

/** Just enough of FileSystemDirectoryHandle for findInstallers. */
function nodeDir(path: string): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name: path,
    async *entries() {
      for (const d of await readdir(path, { withFileTypes: true })) {
        const p = join(path, d.name);
        if (d.isDirectory()) yield [d.name, nodeDir(p)];
        else yield [d.name, { kind: "file", name: d.name, getFile: async () => Object.assign(await openAsBlob(p), { name: d.name }) }];
      }
    },
  } as unknown as FileSystemDirectoryHandle;
}

const sizes = new Map<string, number>();
const target: Target = {
  size: async (p) => sizes.get(p) ?? -1,
  file: async () => null,
  list: async () => [...sizes.keys()],
  async write(p, data) {
    let n = 0;
    for await (const chunk of data) n += chunk.byteLength;
    sizes.set(p, n);
  },
};

// a folder of links to the base game's installer and its first slices (the installer itself is
// only read)
// (the one with the most slices: DLC installers may sit beside it)
const names = await readdir(srcDir);
const sliceCount = (e: string) => { let i = 0; while (names.includes(sliceName(e, i))) i++; return i; };
const exe = names.filter((n) => n.startsWith("setup_") && n.endsWith(".exe")).reduce((a, b) => (sliceCount(b) > sliceCount(a) ? b : a));
const dir = join(tmpdir(), `openkcd-part-${process.pid}`);
await mkdir(dir);
const link = (i: number) => symlink(join(srcDir, sliceName(exe, i)), join(dir, sliceName(exe, i)));
await symlink(join(srcDir, exe), join(dir, exe));
for (let i = 0; i < first; i++) await link(i);

let failures = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } };
const options = { ...DEFAULT_OPTIONS, repack: false, videos: false };
async function run(label: string): Promise<SliceNeeded | null> {
  const [found] = await findInstallers(nodeDir(dir));
  check(found.problems.length === 0, `${label}: problems ${found.problems.join("; ")}`);
  const t0 = performance.now();
  try {
    await install([found], options, target, () => {});
    console.log(`${label}: finished`);
    return null;
  } catch (err) {
    if (!(err instanceof SliceNeeded)) throw err;
    const p = err.progress;
    console.log(`${label}: ${p.filesDone - p.skipped} files copied, ${p.skipped} already there, in ${((performance.now() - t0) / 1000).toFixed(0)} s; needs ${err.slice}; done with ${p.doneSlices.join(", ") || "none"}`);
    // every wanted file whose data is only in the slices here is installed, no other one is
    for (const f of found.installer.files.filter((x) => x.path.toLowerCase().endsWith(".pak"))) {
      if (!(await target.size(f.path) >= 0)) continue;
      check(sizes.get(f.path) === f.size, `${label}: ${f.path} is ${sizes.get(f.path)} bytes, not ${f.size}`);
    }
    for (const s of p.doneSlices) {
      const i = Number(/-(\d+)\.bin$/.exec(s)![1]) - 1;
      const pending = found.installer.files.filter((f) => options.videos !== false || !/videos/i.test(f.path)).filter((f) => f.path.toLowerCase().endsWith(".pak") && f.parts.some((part) => part.slice <= i && i <= part.lastSlice) && sizes.get(f.path) !== f.size);
      check(pending.length === 0 || pending.every((f) => /videos|localization\/(?!english|ipl_english|common|.*_xml)/i.test(f.path)), `${label}: ${s} reported done, but ${pending[0]?.path} is not installed`);
    }
    return err;
  }
}

let need = await run(`slices 1-${first}`);
check(need?.slice === sliceName(exe, first), `stopped at ${need?.slice}, not ${sliceName(exe, first)}`);
// the user deletes the first slice and adds the next
await rm(join(dir, sliceName(exe, 0)));
await link(first);
const before = sizes.size;
need = await run(`slices 2-${first + 1}`);
check(sizes.size > before, "the second run installed nothing");
check(!need || need.slice === sliceName(exe, first + 1), `second run stopped at ${need?.slice}`);
await rm(dir, { recursive: true });
console.log(`${failures} failures`);
process.exit(failures ? 1 : 0);
