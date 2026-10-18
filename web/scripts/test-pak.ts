// Node smoke test for src/zip.ts against a real install (read-only).
// usage: node scripts/test-pak.ts [GAME_ROOT]   (default ~/kcd1)

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { buildTree } from "../src/tree.ts";

const root = process.argv[2] ?? join(homedir(), "kcd1");

async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak")) out.push(p);
  }
  return out;
}

const paks = (await findPaks(root)).sort();
let totalEntries = 0;
let checked = 0;
let failures = 0;
const t0 = performance.now();
for (const p of paks) {
  const rel = relative(root, p);
  const blob = await openAsBlob(p);
  try {
    const entries = await readCentralDirectory(blob);
    totalEntries += entries.length;
    const tree = buildTree(entries);
    if (tree.fileCount !== entries.length) throw new Error("tree count mismatch");
    // full read + CRC on a spread of small entries, plus a 64-byte preview read of the largest
    const small = entries.filter((e) => e.usize < 4 << 20);
    for (let i = 0; i < small.length; i += Math.max(1, Math.floor(small.length / 5))) {
      await readEntry(blob, small[i]);
      checked++;
    }
    const big = entries.reduce((a, b) => (b.usize > a.usize ? b : a), entries[0]);
    if (big) await readEntry(blob, big, 64);
  } catch (err) {
    failures++;
    console.log(`FAIL ${rel}: ${(err as Error).message}`);
  }
}
const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`${paks.length} paks, ${totalEntries} entries, ${checked} entries CRC-verified, ${failures} failures, ${secs}s`);
process.exit(failures ? 1 : 0);
