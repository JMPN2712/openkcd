// Node test for src/installerPak.ts: paks read in place from the GOG installer give the same
// central directories and entries as the installed game, and a repack plan (repack.ts) works out
// straight from the installer, so an install can copy the paks without replaced files and never
// hold them whole (compactInstall.ts).
// usage: node scripts/test-installer-pak.ts INSTALLER_DIR [--root=GAME_ROOT] [--sample=N]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OPTIONS, findInstallers, wanted } from "../src/install.ts";
import { installerPak, PartCache } from "../src/installerPak.ts";
import { readEntry, readZip } from "../src/zip.ts";
import { planRepack, repackedSize } from "../src/repack.ts";

const [srcDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!srcDir) throw new Error("usage: test-installer-pak.ts INSTALLER_DIR [--root=GAME_ROOT]");
const root = process.argv.find((a) => a.startsWith("--root="))?.slice(7) ?? join(homedir(), "kcd1");
const sample = Number(process.argv.find((a) => a.startsWith("--sample="))?.slice(9) ?? 20);

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

let failures = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } };
const found = await findInstallers(nodeDir(srcDir));
const cache = new PartCache();
const options = { ...DEFAULT_OPTIONS, videos: false };
const paks = found.flatMap((ins) => ins.installer.files.filter((f) => wanted(f, options)).map((f) => installerPak(f, ins.slice, cache)));

// central directories and a sample of entries against the installed paks
let t0 = performance.now();
let entries = 0;
for (const pak of paks) {
  const real = await openAsBlob(join(root, pak.path)).catch(() => null);
  if (!real) continue;
  const [a, b] = await Promise.all([readZip(await pak.open()), readZip(real)]);
  check(a.cdOffset === b.cdOffset && a.entries.length === b.entries.length, `${pak.path}: central directory`);
  const step = Math.max(1, Math.floor(a.entries.length / sample));
  for (let i = 0; i < a.entries.length; i += step) {
    const [x, y] = await Promise.all([readEntry(await pak.open(), a.entries[i]), readEntry(real, b.entries[i])]);
    check(Buffer.from(x).equals(Buffer.from(y)), `${pak.path}: ${a.entries[i].name}`);
    entries++;
  }
}
console.log(`${paks.length} paks, ${entries} entries compared with ${root} in ${((performance.now() - t0) / 1000).toFixed(0)} s`);

// the repack plan, from the installer alone
t0 = performance.now();
const plans = await planRepack(paks);
const G = (n: number) => (n / 2 ** 30).toFixed(2);
const all = paks.reduce((a, p) => a + p.size, 0);
const planned = new Set(plans.map((p) => p.pak));
const kept = plans.reduce((a, p) => a + repackedSize(p), 0) + paks.filter((p) => !planned.has(p)).reduce((a, p) => a + p.size, 0);
console.log(`repack plan from the installer in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${G(all)} GiB of paks, ${G(kept)} GiB without replaced files`);
console.log(`${failures} failures`);
process.exit(failures ? 1 : 0);
