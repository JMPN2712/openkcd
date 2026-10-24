// Node test for the compact install's part-by-part staging (src/compactInstall.ts): with two
// slices at a time, as the page asks for them (last to first), each deleted once the page is done
// with it, the staging copy is checked against the whole installer:
// - the file store planned from it keeps exactly the entries the one planned from the whole
//   game keeps (nothing the package or store needs was left out, nothing extra is kept);
// - a sample of textures picks the same header version and the same mips (phantoms standing in
//   for the mips left out);
// - no slice is asked for after it was said to be done with.
// The staging copy goes to ~/.cache (about 13 GiB for Potato); the installer is only read.
// usage: node scripts/test-part-compact.ts INSTALLER_DIR [--full] [--root=GAME_ROOT] [--keep]

import { openAsBlob } from "node:fs";
import { mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { nodeOpfs } from "./opfsNode.ts";
import { DEFAULT_OPTIONS, findInstallers, SliceNeeded, wanted, type InstallOptions } from "../src/install.ts";
import { sliceName } from "../src/inno.ts";
import { readRecord, stage, stagedPaks } from "../src/compactInstall.ts";
import { planFileStore } from "../src/slimStore.ts";
import { Vfs } from "../src/vfs.ts";
import { openTexture, TEXTURE_RE, textureStem } from "../src/texture.ts";
import type { PakSource } from "../src/paks.ts";
import type { SlimIndex } from "../src/slim.ts";

const [srcDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!srcDir) throw new Error("usage: test-part-compact.ts INSTALLER_DIR [--full]");
const potato = !process.argv.includes("--full");
const root = process.argv.find((a) => a.startsWith("--root="))?.slice(7) ?? join(homedir(), "kcd1");
const work = join(homedir(), ".cache", "openkcd-part-compact");
const G = (n: number) => `${(n / 2 ** 30).toFixed(2)} GiB`;

let failures = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } };

// a folder of links: the base game's installer with its last two slices, and the DLC's (not the
// HD packs) with theirs
await rm(work, { recursive: true, force: true });
const dir = join(work, "installer"), stagingDir = join(work, "staging");
await mkdir(join(dir, "DLC"), { recursive: true });
await mkdir(stagingDir);
const exe = (await readdir(srcDir)).find((n) => n.startsWith("setup_") && n.endsWith(".exe"))!;
await symlink(join(srcDir, exe), join(dir, exe));
const where = new Map<string, string>(); // slice name -> its folder ("" or "DLC")
for (const n of await readdir(srcDir)) if (n.endsWith(".bin")) where.set(n, "");
for (const n of await readdir(join(srcDir, "DLC"))) {
  if (/hd_(texture|voice|sound)/.test(n)) continue;
  if (n.endsWith(".exe")) await symlink(join(srcDir, "DLC", n), join(dir, "DLC", n));
  else where.set(n, "DLC");
}
const add = (n: string) => symlink(join(srcDir, where.get(n)!, n), join(dir, where.get(n)!, n));
let last = 0;
while (where.has(sliceName(exe, last + 1))) last++;
await add(sliceName(exe, last));
await add(sliceName(exe, last - 1));

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
async function du(path: string): Promise<number> {
  let n = 0;
  for (const d of await readdir(path, { withFileTypes: true })) n += d.isDirectory() ? await du(join(path, d.name)) : (await stat(join(path, d.name))).size;
  return n;
}

const opts: InstallOptions = { ...DEFAULT_OPTIONS, videos: false, repack: false };
const staging = nodeOpfs(stagingDir);
const deleted = new Set<string>();
let peak = 0, stops = 0;
const t0 = performance.now();
for (;;) {
  const installers = (await findInstallers(nodeDir(dir))).filter((f) => f.problems.length === 0 && !/hd_/i.test(f.name));
  try {
    await stage(installers, opts, staging, potato, () => {});
    break;
  } catch (e) {
    if (!(e instanceof SliceNeeded)) throw e;
    stops++;
    const size = await du(stagingDir);
    peak = Math.max(peak, size);
    console.log(`stop ${stops} (${((performance.now() - t0) / 1000).toFixed(0)} s): staged ${G(size)}; next ${e.slice}; done with ${e.progress.doneSlices.join(", ") || "none"}`);
    check(!deleted.has(e.slice), `${e.slice} asked for after it was done with`);
    for (const n of e.progress.doneSlices) {
      await rm(join(dir, where.get(n)!, n), { force: true });
      deleted.add(n);
    }
    await add(e.slice);
    if (stops > 40) throw new Error("too many stops");
  }
}
const staged = await stagedPaks(staging, await readRecord(staging));
const size = await du(stagingDir);
peak = Math.max(peak, size);
console.log(`staged ${staged.length} paks in ${((performance.now() - t0) / 1000).toFixed(0)} s, ${G(size)} (peak ${G(peak)}), ${stops} stops`);

// the same paks, whole, from the installed game
const installers = await findInstallers(nodeDir(srcDir));
const whole: PakSource[] = [];
for (const ins of installers) for (const f of ins.installer.files.filter((f) => wanted(f, opts))) whole.push({ path: f.path, size: f.size, open: () => openAsBlob(join(root, f.path)) });
check(whole.length === staged.length, `${staged.length} paks staged, ${whole.length} wanted`);

// the store either way (with no package: every file it would keep)
const index = { models: {}, textures: {} } as unknown as SlimIndex;
const cap = { textureCap: potato ? 512 : undefined, language: opts.language };
const kept = async (paks: PakSource[]) => {
  const plan = await planFileStore(paks, index, cap);
  const out = new Map<string, Set<string>>();
  for (const p of plan.plans) out.set(p.pak.path.toLowerCase(), new Set(p.entries.filter((e) => !p.dead.has(e)).map((e) => `${e.name.toLowerCase()} ${e.usize}`)));
  return { out, bytes: plan.keptBytes };
};
const [a, b] = [await kept(staged), await kept(whole)];
console.log(`store from the staging copy ${G(a.bytes)}, from the whole game ${G(b.bytes)}`);
let missing = 0, extra = 0;
for (const [pak, want] of b.out) {
  const have = a.out.get(pak) ?? new Set();
  for (const e of want) if (!have.has(e)) { if (missing++ < 5) console.log(`  missing ${pak}: ${e}`); }
  for (const e of have) if (!want.has(e)) { if (extra++ < 5) console.log(`  extra ${pak}: ${e}`); }
}
for (const pak of a.out.keys()) if (!b.out.has(pak)) extra += a.out.get(pak)!.size;
check(missing === 0 && extra === 0, `store entries: ${missing} missing, ${extra} extra`);

// texture choices: the same header version and mips up to the cap
const filter = (n: string) => TEXTURE_RE.test(n);
const [va, vb] = [await Vfs.build(staged, { filter, includeHd: false }), await Vfs.build(whole, { filter, includeHd: false })];
const stems = [...new Set([...vb.paths()].map((p) => textureStem(p)!).filter(Boolean))];
let compared = 0;
for (let i = 0; i < stems.length; i += Math.max(1, Math.floor(stems.length / 3000))) {
  const [x, y] = await Promise.all([openTexture(va, stems[i]).catch(() => null), openTexture(vb, stems[i]).catch(() => null)]);
  if (!y) continue;
  compared++;
  const same = !!x && x.headerHit.pak.path === y.headerHit.pak.path && x.splitParts === y.splitParts && x.partHits.length === y.partHits.length && x.firstLevel === y.firstLevel;
  check(same, `texture ${stems[i]}: ${x ? `${x.headerHit.pak.path} K${x.splitParts} parts ${x.partHits.length}` : "not found"} vs ${y.headerHit.pak.path} K${y.splitParts} parts ${y.partHits.length}`);
}
console.log(`${compared} textures compared`);
if (!process.argv.includes("--keep")) await rm(work, { recursive: true, force: true });
console.log(failures ? `${failures} failures` : "ok");
process.exit(failures ? 1 : 0);
