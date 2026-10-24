// Builds the compact package (src/slim.ts, docs/SLIM.md) of Rataje's world from a game folder:
// the models the level places (brushes, vegetation, entity props) with their LODs, materials
// and textures, in region chunks of TILE metres.
// usage: node scripts/build-slim.ts OUT_DIR [--root GAME_ROOT] [--potato] [--around x,y,r] [--inline PX]
//   --potato: textures capped at 512 px (the Potato preset never loads more)
//   --around: only the models with an instance within r metres of x,y (quick builds for tests)
// OUT_DIR must not be inside the repository (converted game data is never committed).

import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadMipChain, loadModelParts, setGpuBlockCompression, type ModelParts } from "../src/model.ts";
import { textureFile } from "../src/mtl.ts";
import { resolveLevelPath } from "../src/world.ts";
import { COMMON_TILES, INLINE_MAX, SLIM_VERSION, TILE, encodeEntry, tileKey, type SlimIndex, type SlimTexture } from "../src/slim.ts";
import { openRataje } from "./lib.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const flag = (k: string) => (args.includes(k) ? (args.splice(args.indexOf(k), 1), true) : false);
const root = opt("--root", join(homedir(), "kcd1"));
const potato = flag("--potato");
const around = opt("--around", "").split(",").filter(Boolean).map(Number);
const out = resolve(args[0] ?? "");
if (!args[0]) throw new Error("usage: build-slim.ts OUT_DIR [--root GAME_ROOT] [--potato] [--around x,y,r]");
if (out.startsWith(resolve(join(import.meta.dirname, "..", "..")))) throw new Error("OUT_DIR is inside the repository");
const cap = potato ? 512 : Infinity;
// --inline N: texture levels up to N px stored with the texture (default INLINE_MAX)
const inlineMax = Number(opt("--inline", String(INLINE_MAX)));
/** Largest piece of a region chunk read at once (bytes). */
const PIECE = 64 * 2 ** 20;

const t0 = performance.now();
setGpuBlockCompression(true);
const lvl = await openRataje(root);
const { vfs, terrain: T, objects: O } = lvl;

// ---------------------------------------------------------------- what the level places, and where
const tilesOf = new Map<string, Map<string, number>>();
const place = (path: string, x: number, y: number) => {
  if (around.length && Math.hypot(x - around[0], y - around[1]) > around[2]) return;
  const k = tileKey(x, y);
  const m = tilesOf.get(path) ?? tilesOf.set(path, new Map()).get(path)!;
  m.set(k, (m.get(k) ?? 0) + 1);
};
for (let i = 0; i < O.vegGroup.length; i++) {
  const m = T.vegetation[O.vegGroup[i]]?.model;
  if (m) place(m.toLowerCase(), O.vegPos[i * 3], O.vegPos[i * 3 + 1]);
}
const HIDDEN_BRUSH = /^objects\/editor\/|_nodraw\.cgf$|\/sky\//;
for (let i = 0; i < O.brushName.length; i++) {
  if (lvl.hiddenLayers.has(O.brushLayer[i])) continue;
  const n = T.brushNames[O.brushName[i]];
  if (n && !HIDDEN_BRUSH.test(n)) place(resolveLevelPath(n), O.brushMatrix[i * 16 + 12], O.brushMatrix[i * 16 + 13]);
}
for (const e of lvl.props) {
  const p = e.model?.toLowerCase().replace(/\\/g, "/");
  if (p && !p.endsWith(".cdf")) place(p, e.pos[0], e.pos[1]);
}
// home tile: the one with most instances; spread over more than COMMON_TILES: the common chunk
const home = new Map<string, string>();
for (const [p, m] of tilesOf) home.set(p, m.size > COMMON_TILES ? "common" : [...m].sort((a, b) => b[1] - a[1])[0][0]);
// LODs live with their model
for (const [p, h] of [...home]) {
  for (let k = 1; k < 6; k++) {
    const l = p.replace(/\.(cgf|cga)$/, `_lod${k}.$1`);
    if (l === p || !vfs.lookup(l)) break;
    home.set(l, h);
  }
}
const weight = (p: string) => [...(tilesOf.get(p.replace(/_lod\d\.(cgf|cga)$/, ".$1"))?.values() ?? [])].reduce((a, b) => a + b, 0);
console.log(`${tilesOf.size} models placed (${home.size} with LODs) in ${new Set(home.values()).size} chunks, ${[...home.values()].filter((h) => h === "common").length} in the common one`);

// ---------------------------------------------------------------- pass 1: textures, and their homes
const texUsers = new Map<string, { stem: string; normalMap: boolean; homes: Map<string, number> }>();
const slots = (parts: ModelParts) => {
  const out: { stem: string; normalMap: boolean }[] = [];
  for (const m of parts.materials) {
    if (m.nodraw) continue;
    for (const [slot, normalMap] of [["Diffuse", false], ["Specular", false], ["Bumpmap", true]] as const) {
      const f = m.textures.get(slot);
      if (f) out.push({ stem: textureFile(f), normalMap });
    }
  }
  return out;
};
let failed = 0;
const paths = [...home.keys()];
for (const [n, p] of paths.entries()) {
  const parts = await loadModelParts(vfs, p).catch(() => null);
  if (!parts) { failed++; home.delete(p); continue; }
  for (const s of slots(parts)) {
    const key = `${s.stem}${s.normalMap ? "|n" : ""}`;
    const u = texUsers.get(key) ?? texUsers.set(key, { ...s, homes: new Map() }).get(key)!;
    const h = home.get(p)!;
    u.homes.set(h, (u.homes.get(h) ?? 0) + weight(p));
  }
  if (n % 1000 === 999) console.log(`  read ${n + 1}/${paths.length} models`);
}
// a texture lives where most of its users' instances are; used by common models or across many tiles: common
const texHome = new Map<string, string>();
for (const [k, u] of texUsers) texHome.set(k, u.homes.has("common") || u.homes.size > COMMON_TILES ? "common" : [...u.homes].sort((a, b) => b[1] - a[1])[0][0]);
console.log(`${home.size} models (${failed} without geometry), ${texUsers.size} textures (${[...texHome.values()].filter((h) => h === "common").length} common), pass 1 in ${((performance.now() - t0) / 1000).toFixed(0)} s`);

// ---------------------------------------------------------------- pass 2: the chunks, tile by tile
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "tiles"), { recursive: true });
await mkdir(join(out, "packs"), { recursive: true });
const index: SlimIndex = { version: SLIM_VERSION, variant: potato ? "potato" : "full", textureCap: potato ? cap : 0, tile: TILE, inlineMax, built: new Date().toISOString(), models: {}, textures: {}, tiles: {} };
const byTile = new Map<string, { models: string[]; textures: string[] }>();
for (const [p, h] of home) (byTile.get(h) ?? byTile.set(h, { models: [], textures: [] }).get(h)!).models.push(p);
for (const [k, h] of texHome) (byTile.get(h) ?? byTile.set(h, { models: [], textures: [] }).get(h)!).textures.push(k);
const sizes = { models: 0, inline: 0, packs: 0, texturesFailed: 0 };
let done = 0;
for (const [key, list] of [...byTile].sort((a, b) => (a[0] === "common" ? -1 : b[0] === "common" ? 1 : a[0].localeCompare(b[0])))) {
  const f = `tiles/${key}.bin`, pf = `packs/${key}.bin`;
  const fh = await open(join(out, f), "w"), ph = await open(join(out, pf), "w");
  // the chunk in pieces of at most PIECE bytes, each read on its own ("<key>#<n>")
  let at = 0, pat = 0, pieceStart = 0, piece = 0;
  const pieceKey = () => (piece ? `${key}#${piece}` : key);
  const put = async (bytes: Uint8Array) => {
    at = Math.ceil(at / 8) * 8;
    if (at > pieceStart && at - pieceStart + bytes.byteLength > PIECE) {
      index.tiles[pieceKey()] = { f, o: pieceStart, n: at - pieceStart };
      pieceStart = at;
      piece++;
    }
    await fh.write(bytes, 0, bytes.byteLength, at);
    const ref = { f, o: at, n: bytes.byteLength, t: pieceKey() };
    at += bytes.byteLength;
    return ref;
  };
  const putTexture = async (k: string) => {
    const u = texUsers.get(k)!;
    const chain = await loadMipChain(vfs, u.stem, cap, { normalMap: u.normalMap }).catch(() => null);
    if (!chain) { sizes.texturesFailed++; return; }
    // large levels to the pack (largest first, next to each other), small ones inline
    const big = chain.levels.filter((l) => Math.max(l.w, l.h) > inlineMax);
    const packStart = pat;
    const levels: SlimTexture["levels"] = [];
    for (const l of chain.levels) {
      if (Math.max(l.w, l.h) > inlineMax) {
        const data = l.data as Uint8Array;
        await ph.write(data, 0, data.byteLength, pat);
        levels.push({ w: l.w, h: l.h, po: pat - packStart, pn: data.byteLength });
        pat += data.byteLength;
        sizes.packs += data.byteLength;
      } else levels.push({ w: l.w, h: l.h, data: l.data });
    }
    const tex: SlimTexture = { stem: u.stem, srgb: chain.srgb, bc: chain.bc ?? null, full: chain.full, normalMap: chain.normalMap, levels, pack: big.length ? { f: pf, o: packStart, n: pat - packStart } : null };
    const bytes = encodeEntry(tex);
    index.textures[k] = await put(bytes);
    sizes.inline += bytes.byteLength;
  };
  // each model, then the textures of this tile it is the first to use (a piece then holds a
  // model and its textures together); the tile's other textures at the end
  const written = new Set<string>();
  const own = new Set(list.textures);
  for (const p of list.models) {
    const parts = await loadModelParts(vfs, p).catch(() => null);
    if (!parts) continue;
    const bytes = encodeEntry({ path: parts.path, cgf: { ...parts.cgf, chunks: [] }, skeleton: parts.skeleton, mtlPath: parts.mtlPath, materials: parts.materials });
    index.models[p] = await put(bytes);
    sizes.models += bytes.byteLength;
    for (const s of slots(parts)) {
      const k = `${s.stem}${s.normalMap ? "|n" : ""}`;
      if (own.has(k) && !written.has(k)) { written.add(k); await putTexture(k); }
    }
  }
  for (const k of list.textures) if (!written.has(k)) await putTexture(k);
  await fh.close();
  await ph.close();
  index.tiles[pieceKey()] = { f, o: pieceStart, n: at - pieceStart };
  if (++done % 20 === 0) console.log(`  ${done}/${byTile.size} chunks, ${((sizes.models + sizes.inline + sizes.packs) / 2 ** 30).toFixed(2)} GiB`);
}
await writeFile(join(out, "index.json"), JSON.stringify(index));

const tileSizes = Object.entries(index.tiles).filter(([k]) => !k.startsWith("common")).map(([, r]) => r.n).sort((a, b) => a - b);
const G = (n: number) => `${(n / 2 ** 30).toFixed(2)} GiB`, M = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;
console.log(`${index.variant}: ${Object.keys(index.models).length} models, ${Object.keys(index.textures).length} textures (${sizes.texturesFailed} failed) in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
console.log(`  models ${G(sizes.models)}, textures inline ${G(sizes.inline)}, packs ${G(sizes.packs)}; total ${G(sizes.models + sizes.inline + sizes.packs)}`);
console.log(`  common chunk ${M(Object.entries(index.tiles).filter(([k]) => k.startsWith("common")).reduce((a, [, r]) => a + r.n, 0))} in ${Object.keys(index.tiles).filter((k) => k.startsWith("common")).length} pieces; ${tileSizes.length} tile pieces: median ${M(tileSizes[tileSizes.length >> 1] ?? 0)}, largest ${M(tileSizes[tileSizes.length - 1] ?? 0)}`);
