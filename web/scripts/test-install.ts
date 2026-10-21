// Node test for src/install.ts: find the installers in a folder, install
// their .pak files into a scratch folder (standing in for OPFS), compare
// them with ~/kcd1, then run again to check that finished files are skipped.
// Also reports paths that more than one installer ships.
// usage: node scripts/test-install.ts INSTALLER_DIR OUT_DIR [--root=GAME_ROOT] [--only=substring]

import { openAsBlob } from "node:fs";
import { mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_OPTIONS, findInstallers, install, isPak, wanted, type Target } from "../src/install.ts";

const [srcDir, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!srcDir || !outDir) throw new Error("usage: test-install.ts INSTALLER_DIR OUT_DIR");
const root = process.argv.find((a) => a.startsWith("--root="))?.slice(7) ?? join(homedir(), "kcd1");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

/** Just enough of FileSystemDirectoryHandle for findInstallers. */
function nodeDir(path: string): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name: path,
    async *entries() {
      for (const d of await readdir(path, { withFileTypes: true })) {
        if (d.isDirectory()) yield [d.name, nodeDir(join(path, d.name))];
        else if (!only || !d.name.endsWith(".exe") || d.name.includes(only)) {
          const p = join(path, d.name);
          yield [d.name, { kind: "file", name: d.name, getFile: async () => Object.assign(await openAsBlob(p), { name: d.name }) }];
        }
      }
    },
  } as unknown as FileSystemDirectoryHandle;
}

// like OPFS: write to a temporary name, rename when complete
const target: Target = {
  size: (p) => stat(join(outDir, p)).then((s) => s.size, () => -1),
  async write(p, data) {
    const dest = join(outDir, p);
    await mkdir(dirname(dest), { recursive: true });
    const fh = await open(`${dest}.part`, "w");
    for await (const chunk of data) await fh.write(chunk);
    await fh.close();
    await rename(`${dest}.part`, dest);
  },
};

const found = await findInstallers(nodeDir(srcDir));
for (const f of found) console.log(`${f.name}: ${f.label}, ${(f.size / 2 ** 20).toFixed(0)} MiB${f.problems.length ? ` PROBLEMS: ${f.problems.join("; ")}` : ""}`);

const owners = new Map<string, string[]>();
for (const f of found) for (const file of f.installer.files.filter(isPak)) {
  const k = file.path.toLowerCase();
  owners.set(k, [...(owners.get(k) ?? []), f.name]);
}
const shared = [...owners].filter(([, o]) => o.length > 1);
console.log(`${owners.size} paths, ${shared.length} shipped by more than one installer${shared.length ? ": " + shared.slice(0, 5).map(([p]) => p).join(", ") : ""}`);

let last = 0;
const t0 = performance.now();
const p = await install(found, DEFAULT_OPTIONS, target, (pr) => {
  const now = performance.now();
  if (now - last > 5000) {
    last = now;
    console.log(`  ${(pr.done / 2 ** 30).toFixed(2)} / ${(pr.total / 2 ** 30).toFixed(2)} GiB  ${pr.file}`);
  }
});
const secs = (performance.now() - t0) / 1000;
console.log(`installed ${p.files - p.skipped} files, skipped ${p.skipped}, ${(p.total / 2 ** 30).toFixed(2)} GiB in ${secs.toFixed(1)} s`);

// byte-compare with the installed game where it has the file
let failures = 0;
let compared = 0;
for (const f of found) for (const file of f.installer.files.filter((x) => wanted(x, DEFAULT_OPTIONS))) {
  const a = await open(join(outDir, file.path));
  const b = await open(join(root, file.path)).catch(() => null);
  if (!b) {
    await a.close();
    continue;
  }
  const ba = Buffer.alloc(8 << 20);
  const bb = Buffer.alloc(8 << 20);
  for (let pos = 0; pos < file.size; pos += ba.length) {
    const { bytesRead } = await a.read(ba, 0, ba.length, pos);
    await b.read(bb, 0, bb.length, pos);
    if (!ba.subarray(0, bytesRead).equals(bb.subarray(0, bytesRead))) {
      console.log(`FAIL ${file.path} differs near ${pos}`);
      failures++;
      break;
    }
  }
  compared++;
  await a.close();
  await b.close();
}

const again = await install(found, DEFAULT_OPTIONS, target, () => {});
if (again.skipped !== again.files) {
  console.log(`FAIL second run reinstalled ${again.files - again.skipped} files`);
  failures++;
}
console.log(`compared ${compared} files with ${root}; second run skipped ${again.skipped}/${again.files}; ${failures} failures`);
process.exit(failures ? 1 : 0);
