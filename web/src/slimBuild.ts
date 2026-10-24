// Building a compact package (slim.ts, docs/SLIM.md) of a level's world from its game data: in
// Node (scripts/build-slim.ts, files in a folder) and in the browser (slimView.ts, OPFS).
//
// What the level places (brushes, vegetation, entity props) goes into region chunks of TILE
// metres, each model in the tile holding most of its instances, or the common chunk when it is
// spread over more than COMMON_TILES tiles; its LODs with it; textures where most of their
// users' instances are. Pass 1 reads every model's materials to place the textures; pass 2
// writes tile by tile, each model followed by the textures of its tile it is the first to use,
// in pieces of at most PIECE bytes.

import type { EntityInfo } from "./levelEntities.ts";
import type { LevelObjects } from "./levelObjects.ts";
import { gpuBlockCompression, loadMipChain, loadModelParts, setGpuBlockCompression } from "./model.ts";
import { COMMON_TILES, INLINE_MAX, SLIM_VERSION, TILE, encodeEntry, textureKeys, tileKey, type SlimIndex, type SlimTexture } from "./slim.ts";
import { encodeModel, encoderReady } from "./slimWrite.ts";
import type { Terrain } from "./terrain.ts";
import type { Vfs } from "./vfs.ts";
import { resolveLevelPath } from "./world.ts";
import { CharacterDb } from "./character.ts";
import { parseMtl } from "./mtl.ts";

/** Largest piece of a region chunk read at once (bytes). */
const PIECE = 64 * 2 ** 20;
/** Editor-only geometry the game never draws (as world.ts). */
const HIDDEN_BRUSH = /^objects\/editor\/|_nodraw\.cgf$|\/sky\//;

/** Where a package is written. */
export interface SlimSink {
  /** a file to write, at any position */
  create(file: string): Promise<{ write(bytes: Uint8Array, at: number): Promise<void>; close(): Promise<void> }>;
  writeText(file: string, text: string): Promise<void>;
}

export interface SlimBuildInput {
  vfs: Vfs;
  terrain: Terrain;
  objects: LevelObjects;
  props: EntityInfo[];
  hiddenLayers: Set<number>;
  /** character parts (characterParts): their models and textures go in the "chars" chunk */
  characters?: { skin: string; material: string | null }[];
}

/** Every character part the database's souls and clothing presets use (skin and material, once each). */
export async function characterParts(vfs: Vfs): Promise<{ skin: string; material: string | null }[]> {
  const db = await CharacterDb.load(vfs);
  const out = new Map<string, { skin: string; material: string | null }>();
  const add = (spec: { parts: { skin: string; material: string | null }[] }) => {
    for (const p of spec.parts) out.set(`${p.skin}|${p.material ?? ""}`, { skin: p.skin, material: p.material });
  };
  for (const s of db.souls) { try { add(db.soul(s.id)); } catch { /* unresolved soul */ } }
  for (const p of db.presets) { try { add(db.preset(p.id)); } catch { /* unresolved preset */ } }
  return [...out.values()];
}

export interface SlimBuildOptions {
  /** textures capped at 512 px (the Potato preset never loads more) */
  potato?: boolean;
  /** texture levels up to this size stored with the texture (default INLINE_MAX) */
  inlineMax?: number;
  /** only models with an instance within r metres of x, y (quick builds for tests) */
  around?: [number, number, number];
  deflate: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** what is being done, and how far (models read in pass 1, chunks written in pass 2) */
  onProgress?: (what: string, done: number, total: number) => void;
}

export interface SlimBuildResult {
  index: SlimIndex;
  sizes: { models: number; modelsRaw: number; inline: number; inlineRaw: number; packs: number; packsRaw: number; texturesFailed: number; modelsFailed: number };
}

export async function buildSlim(input: SlimBuildInput, sink: SlimSink, opts: SlimBuildOptions): Promise<SlimBuildResult> {
  await encoderReady;
  const bc = gpuBlockCompression();
  // (the package stores BC blocks as the GPU takes them)
  setGpuBlockCompression(true);
  try {
    return await build(input, sink, opts);
  } finally {
    setGpuBlockCompression(bc);
  }
}

async function build({ vfs, terrain: T, objects: O, props, hiddenLayers, characters = [] }: SlimBuildInput, sink: SlimSink, opts: SlimBuildOptions): Promise<SlimBuildResult> {
  const cap = opts.potato ? 512 : Infinity;
  const inlineMax = opts.inlineMax ?? INLINE_MAX;
  const around = opts.around;
  const progress = opts.onProgress ?? (() => {});

  // ---------------------------------------------------------------- what the level places, and where
  const tilesOf = new Map<string, Map<string, number>>();
  const place = (path: string, x: number, y: number) => {
    if (around && Math.hypot(x - around[0], y - around[1]) > around[2]) return;
    const k = tileKey(x, y);
    const m = tilesOf.get(path) ?? tilesOf.set(path, new Map()).get(path)!;
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (let i = 0; i < O.vegGroup.length; i++) {
    const m = T.vegetation[O.vegGroup[i]]?.model;
    if (m) place(m.toLowerCase(), O.vegPos[i * 3], O.vegPos[i * 3 + 1]);
  }
  for (let i = 0; i < O.brushName.length; i++) {
    if (hiddenLayers.has(O.brushLayer[i])) continue;
    const n = T.brushNames[O.brushName[i]];
    if (n && !HIDDEN_BRUSH.test(n)) place(resolveLevelPath(n), O.brushMatrix[i * 16 + 12], O.brushMatrix[i * 16 + 13]);
  }
  for (const e of props) {
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
  // character parts the world doesn't place: the "chars" chunk (read entry by entry as NPCs come)
  for (const c of characters) if (!home.has(c.skin) && vfs.lookup(c.skin)) home.set(c.skin, "chars");
  const weight = (p: string) => [...(tilesOf.get(p.replace(/_lod\d\.(cgf|cga)$/, ".$1"))?.values() ?? [])].reduce((a, b) => a + b, 0) || 1;

  // ---------------------------------------------------------------- pass 1: textures, and their homes
  const texUsers = new Map<string, { stem: string; normalMap: boolean; homes: Map<string, number> }>();
  let modelsFailed = 0;
  const paths = [...home.keys()];
  for (const [n, p] of paths.entries()) {
    const parts = await loadModelParts(vfs, p).catch(() => null);
    if (!parts) { modelsFailed++; home.delete(p); continue; }
    for (const key of textureKeys(parts.materials)) {
      const [stem, nm] = key.split("|");
      const u = texUsers.get(key) ?? texUsers.set(key, { stem, normalMap: nm === "n", homes: new Map() }).get(key)!;
      const h = home.get(p)!;
      u.homes.set(h, (u.homes.get(h) ?? 0) + weight(p));
    }
    if (n % 100 === 99) progress("Reading models", n + 1, paths.length);
  }
  // the textures of the materials character parts are given instead of their models' own
  const overrides = new Set(characters.map((c) => c.material).filter((m): m is string => !!m));
  for (const mtl of overrides) {
    const hit = vfs.lookup(mtl);
    if (!hit) continue;
    const materials = await vfs.read(hit).then((b) => parseMtl(new TextDecoder().decode(b))).catch(() => null);
    for (const key of textureKeys(materials ?? [])) {
      const [stem, nm] = key.split("|");
      const u = texUsers.get(key) ?? texUsers.set(key, { stem, normalMap: nm === "n", homes: new Map() }).get(key)!;
      u.homes.set("chars", (u.homes.get("chars") ?? 0) + 1);
    }
  }
  // a texture lives where most of its users' instances are; used by common models or across many tiles: common
  const texHome = new Map<string, string>();
  for (const [k, u] of texUsers) texHome.set(k, u.homes.has("common") || u.homes.size > COMMON_TILES ? "common" : [...u.homes].sort((a, b) => b[1] - a[1])[0][0]);

  // ---------------------------------------------------------------- pass 2: the chunks, tile by tile
  const index: SlimIndex = { version: SLIM_VERSION, variant: opts.potato ? "potato" : "full", textureCap: opts.potato ? cap : 0, tile: TILE, inlineMax, built: new Date().toISOString(), models: {}, textures: {}, tiles: {} };
  const byTile = new Map<string, { models: string[]; textures: string[] }>();
  for (const [p, h] of home) (byTile.get(h) ?? byTile.set(h, { models: [], textures: [] }).get(h)!).models.push(p);
  for (const [k, h] of texHome) (byTile.get(h) ?? byTile.set(h, { models: [], textures: [] }).get(h)!).textures.push(k);
  const sizes = { models: 0, modelsRaw: 0, inline: 0, inlineRaw: 0, packs: 0, packsRaw: 0, texturesFailed: 0, modelsFailed };
  let done = 0;
  for (const [key, list] of [...byTile].sort((a, b) => (a[0] === "common" ? -1 : b[0] === "common" ? 1 : a[0].localeCompare(b[0])))) {
    const f = `tiles/${key}.bin`, pf = `packs/${key}.bin`;
    const fh = await sink.create(f), ph = await sink.create(pf);
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
      await fh.write(bytes, at);
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
      // (each large level deflated on its own: the pool reads and inflates the ones it grows into)
      for (const l of chain.levels) {
        if (Math.max(l.w, l.h) > inlineMax) {
          const raw = l.data as Uint8Array;
          const data = await opts.deflate(raw);
          await ph.write(data, pat);
          levels.push({ w: l.w, h: l.h, po: pat - packStart, pn: data.byteLength, pu: raw.byteLength });
          pat += data.byteLength;
          sizes.packs += data.byteLength;
          sizes.packsRaw += raw.byteLength;
        } else levels.push({ w: l.w, h: l.h, data: l.data });
      }
      const tex: SlimTexture = { stem: u.stem, srgb: chain.srgb, bc: chain.bc ?? null, full: chain.full, normalMap: chain.normalMap, levels, pack: big.length ? { f: pf, o: packStart, n: pat - packStart } : null };
      const raw = encodeEntry(tex);
      const bytes = await opts.deflate(raw);
      index.textures[k] = { ...(await put(bytes)), z: raw.byteLength };
      sizes.inline += bytes.byteLength;
      sizes.inlineRaw += raw.byteLength;
    };
    // each model, then the textures of this tile it is the first to use (a piece then holds a
    // model and its textures together); the tile's other textures at the end
    const written = new Set<string>();
    const own = new Set(list.textures);
    for (const p of list.models) {
      const parts = await loadModelParts(vfs, p).catch(() => null);
      if (!parts) continue;
      const { bytes, raw } = await encodeModel(parts, opts.deflate);
      index.models[p] = { ...(await put(bytes)), z: raw };
      sizes.models += bytes.byteLength;
      sizes.modelsRaw += raw;
      for (const k of textureKeys(parts.materials)) {
        if (own.has(k) && !written.has(k)) { written.add(k); await putTexture(k); }
      }
    }
    for (const k of list.textures) if (!written.has(k)) await putTexture(k);
    await fh.close();
    await ph.close();
    index.tiles[pieceKey()] = { f, o: pieceStart, n: at - pieceStart };
    progress("Writing region chunks", ++done, byTile.size);
  }
  // (last: a package without its index is incomplete, and is not used)
  await sink.writeText("index.json", JSON.stringify(index));
  return { index, sizes };
}
