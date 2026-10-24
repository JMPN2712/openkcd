// Builds the compact package (src/slimBuild.ts, docs/SLIM.md) of Rataje's world from a game
// folder, into a folder (the browser builds the same into OPFS: src/slimView.ts).
// usage: node scripts/build-slim.ts OUT_DIR [--root GAME_ROOT] [--potato] [--around x,y,r] [--inline PX] [--store] [--no-characters]
//   --potato: textures capped at 512 px (the Potato preset never loads more)
//   --around: only the models with an instance within r metres of x,y (quick builds for tests)
//   --store: also the file store (slimStore.ts), OUT_DIR/store/<pak path>: with it the package
//            needs no original files (open OUT_DIR/store as the game root, with the package)
//   --no-characters: without the character parts (chars chunk)
// OUT_DIR must not be inside the repository (converted game data is never committed).

import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { buildSlim, characterParts, type SlimSink } from "../src/slimBuild.ts";
import { planFileStore } from "../src/slimStore.ts";
import { repackedPak } from "../src/repack.ts";
import { openRataje } from "./lib.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const flag = (k: string) => (args.includes(k) ? (args.splice(args.indexOf(k), 1), true) : false);
const root = opt("--root", join(homedir(), "kcd1"));
const potato = flag("--potato");
const around = opt("--around", "").split(",").filter(Boolean).map(Number) as [number, number, number];
const inline = opt("--inline", "");
const store = flag("--store");
const withCharacters = !flag("--no-characters");
const out = resolve(args[0] ?? "");
if (!args[0]) throw new Error("usage: build-slim.ts OUT_DIR [--root GAME_ROOT] [--potato] [--around x,y,r] [--inline PX]");
if (out.startsWith(resolve(join(import.meta.dirname, "..", "..")))) throw new Error("OUT_DIR is inside the repository");

const t0 = performance.now();
const lvl = await openRataje(root);
await rm(out, { recursive: true, force: true });
const sink: SlimSink = {
  async create(file) {
    await mkdir(dirname(join(out, file)), { recursive: true });
    const fh = await open(join(out, file), "w");
    return { write: async (b, at) => { await fh.write(b, 0, b.byteLength, at); }, close: () => fh.close() };
  },
  writeText: (file, text) => writeFile(join(out, file), text),
};
let last = "";
const characters = withCharacters ? await characterParts(lvl.vfs) : [];
if (characters.length) console.log(`${characters.length} character parts`);
const { index, sizes } = await buildSlim({ ...lvl, characters }, sink, {
  potato,
  around: around.length === 3 ? around : undefined,
  inlineMax: inline ? Number(inline) : undefined,
  deflate: async (b) => new Uint8Array(deflateRawSync(b, { level: 9 })),
  onProgress: (what, done, total) => {
    const line = `  ${what} ${Math.floor((done / total) * 10) * 10}%`;
    if (line !== last) console.log((last = line));
  },
});

if (store) {
  // the file store: the install's paks without what the package holds, replaced files and videos
  const plan = await planFileStore(lvl.sources, index, { textureCap: potato ? 512 : undefined }, (what, done, total) => {
    const line = `  ${what} ${Math.floor((done / total) * 10) * 10}%`;
    if (line !== last) console.log((last = line));
  });
  for (const p of plan.plans) {
    const file = join(out, "store", p.pak.path);
    await mkdir(dirname(file), { recursive: true });
    const fh = await open(file, "w");
    for await (const chunk of repackedPak(await p.pak.open(), p)) await fh.write(chunk);
    await fh.close();
  }
  console.log(`file store: ${plan.plans.length} paks, ${(plan.keptBytes / 2 ** 30).toFixed(2)} GiB (left out: ${(plan.convertedBytes / 2 ** 30).toFixed(2)} GiB the package holds converted, ${(plan.cappedBytes / 2 ** 30).toFixed(2)} GiB of mips above the cap, ${plan.skippedPaks.length} paks: videos, other voice languages, HD)`);
}

const tileSizes = Object.entries(index.tiles).filter(([k]) => !k.startsWith("common")).map(([, r]) => r.n).sort((a, b) => a - b);
const common = Object.entries(index.tiles).filter(([k]) => k.startsWith("common"));
const G = (n: number) => `${(n / 2 ** 30).toFixed(2)} GiB`, M = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;
console.log(`${index.variant}: ${Object.keys(index.models).length} models (${sizes.modelsFailed} without geometry), ${Object.keys(index.textures).length} textures (${sizes.texturesFailed} failed) in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
console.log(`  models ${G(sizes.models)} (${G(sizes.modelsRaw)} before compression), textures inline ${G(sizes.inline)} (${G(sizes.inlineRaw)}), packs ${G(sizes.packs)} (${G(sizes.packsRaw)}); total ${G(sizes.models + sizes.inline + sizes.packs)}`);
console.log(`  common chunk ${M(common.reduce((a, [, r]) => a + r.n, 0))} in ${common.length} pieces; ${tileSizes.length} tile pieces: median ${M(tileSizes[tileSizes.length >> 1] ?? 0)}, largest ${M(tileSizes[tileSizes.length - 1] ?? 0)}`);
