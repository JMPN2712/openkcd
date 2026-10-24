// Builds the compact package (src/slimBuild.ts, docs/SLIM.md) of Rataje's world from a game
// folder, into a folder (the browser builds the same into OPFS: src/slimView.ts).
// usage: node scripts/build-slim.ts OUT_DIR [--root GAME_ROOT] [--potato] [--around x,y,r] [--inline PX]
//   --potato: textures capped at 512 px (the Potato preset never loads more)
//   --around: only the models with an instance within r metres of x,y (quick builds for tests)
// OUT_DIR must not be inside the repository (converted game data is never committed).

import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { buildSlim, type SlimSink } from "../src/slimBuild.ts";
import { openRataje } from "./lib.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const flag = (k: string) => (args.includes(k) ? (args.splice(args.indexOf(k), 1), true) : false);
const root = opt("--root", join(homedir(), "kcd1"));
const potato = flag("--potato");
const around = opt("--around", "").split(",").filter(Boolean).map(Number) as [number, number, number];
const inline = opt("--inline", "");
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
const { index, sizes } = await buildSlim(lvl, sink, {
  potato,
  around: around.length === 3 ? around : undefined,
  inlineMax: inline ? Number(inline) : undefined,
  deflate: async (b) => new Uint8Array(deflateRawSync(b, { level: 9 })),
  onProgress: (what, done, total) => {
    const line = `  ${what} ${Math.floor((done / total) * 10) * 10}%`;
    if (line !== last) console.log((last = line));
  },
});

const tileSizes = Object.entries(index.tiles).filter(([k]) => !k.startsWith("common")).map(([, r]) => r.n).sort((a, b) => a - b);
const common = Object.entries(index.tiles).filter(([k]) => k.startsWith("common"));
const G = (n: number) => `${(n / 2 ** 30).toFixed(2)} GiB`, M = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;
console.log(`${index.variant}: ${Object.keys(index.models).length} models (${sizes.modelsFailed} without geometry), ${Object.keys(index.textures).length} textures (${sizes.texturesFailed} failed) in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
console.log(`  models ${G(sizes.models)} (${G(sizes.modelsRaw)} before compression), textures inline ${G(sizes.inline)}, packs ${G(sizes.packs)}; total ${G(sizes.models + sizes.inline + sizes.packs)}`);
console.log(`  common chunk ${M(common.reduce((a, [, r]) => a + r.n, 0))} in ${common.length} pieces; ${tileSizes.length} tile pieces: median ${M(tileSizes[tileSizes.length >> 1] ?? 0)}, largest ${M(tileSizes[tileSizes.length - 1] ?? 0)}`);
