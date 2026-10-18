// Node test for character assembly against a real install (read-only):
// resolves every soul and clothing preset in the database, checks that their
// .skin/.mtl files exist, and fully loads a random sample.
// usage: node scripts/test-characters.ts [GAME_ROOT] [--sample N]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { ASSET_RE } from "../src/assets.ts";
import { CharacterDb, loadCharacter, type CharacterSpec } from "../src/character.ts";

const args = process.argv.slice(2);
const root = args[0] && !args[0].startsWith("--") ? args[0] : join(homedir(), "kcd1");
const sample = args.includes("--sample") ? Number(args[args.indexOf("--sample") + 1]) : 150;

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
const vfs = await Vfs.build(sources, { filter: (n) => ASSET_RE.test(n), includeHd: true });
let t0 = performance.now();
const db = await CharacterDb.load(vfs);
console.log(`database: ${db.souls.length} souls, ${db.presets.length} presets (${Math.round(performance.now() - t0)} ms)`);

const missing = new Map<string, number>();
const tally = (k: string) => missing.set(k, (missing.get(k) ?? 0) + 1);
let parts = 0, resolveErrors = 0;
const specs: CharacterSpec[] = [];
for (const [kind, ids] of [["soul", db.souls.map((s) => s.id)], ["preset", db.presets.map((p) => p.id)]] as const) {
  for (const id of ids) {
    try {
      const spec = kind === "soul" ? db.soul(id) : db.preset(id);
      specs.push(spec);
      for (const n of spec.notes) tally(`${kind} note: ${n.replace(/[0-9a-f-]{36}/g, "<id>")}`);
      for (const p of spec.parts) {
        parts++;
        if (!vfs.lookup(p.skin)) tally(`${p.kind} skin missing`);
        if (p.material && !vfs.lookup(p.material)) tally(`${p.kind} material missing`);
      }
    } catch (err) {
      resolveErrors++;
      tally(`${kind} resolve error: ${(err as Error).message.replace(/[0-9a-f-]{36}/g, "<id>")}`);
    }
  }
}
console.log(`resolved ${specs.length} characters, ${parts} parts, ${resolveErrors} resolve errors`);
for (const [k, v] of [...missing].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(v).padStart(6)}  ${k}`);

// full load (geometry + textures at 256 px to keep it quick) for a random sample
t0 = performance.now();
let loaded = 0, loadedParts = 0, failedParts = 0;
const failKinds = new Map<string, number>();
for (let i = 0; i < Math.min(sample, specs.length); i++) {
  const spec = specs[Math.floor(Math.random() * specs.length)];
  const ch = await loadCharacter(vfs, spec, { maxTextureDim: 256 });
  loaded++;
  loadedParts += ch.parts.length;
  failedParts += spec.parts.length - ch.parts.length;
  for (const n of ch.notes) {
    const k = n.replace(/^[^:]*: /, "").replace(/[\w/.-]+\.(skin|mtl|dds)/g, "<file>").replace(/[0-9a-f-]{36}/g, "<id>").slice(0, 90);
    failKinds.set(k, (failKinds.get(k) ?? 0) + 1);
  }
}
console.log(`loaded ${loaded} random characters: ${loadedParts} parts ok, ${failedParts} failed (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
for (const [k, v] of [...failKinds].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(v).padStart(6)}  ${k}`);
