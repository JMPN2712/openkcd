// The compact web package (docs/SLIM.md): the level's models, materials and textures already
// parsed and converted, grouped in region chunks so streaming an area reads a few large blocks
// instead of thousands of pak entries.
//
// Layout (a folder: OPFS in the browser, a directory in Node):
//   index.json          what is where (SlimIndex)
//   tiles/<key>.bin     one region chunk per TILE m tile ("x_y"), plus "common" for models used
//                       across many tiles: model and texture entries, one after another
//   packs/<key>.bin     the texture levels larger than INLINE_MAX of the textures in that tile
//
// An entry is [u32 JSON length][JSON][padding to 8][binary]: typed arrays (and Maps) in the
// value are written to the binary part and come back as views into the bytes read, without
// copying. Entries start at multiples of 8 in their file, so the views are aligned.

import { textureFile } from "./mtl.ts";
import { withTextures, type LoadedModel, type LoadOptions, type MipChain, type ModelParts, type TextureLoader } from "./model.ts";

export const SLIM_VERSION = 1;
/** Region chunk size (metres): chosen by measuring the reads per area, docs/SLIM.md. */
export const TILE = 256;
/** Texture levels up to this size are stored with the texture in its tile; larger ones in the tile's pack. */
export const INLINE_MAX = 256;
/** Models whose instances fall in more tiles than this go in the common chunk, read once. */
export const COMMON_TILES = 6;

/** A byte range: file, offset, length. */
export interface SlimRef { f: string; o: number; n: number }

export interface SlimIndex {
  version: number;
  /** "full": textures as the install has them; "potato": capped at textureCap */
  variant: "full" | "potato";
  textureCap: number;
  tile: number;
  inlineMax: number;
  built: string;
  /** model path -> its entry and home tile key */
  models: Record<string, SlimRef & { t: string }>;
  /** texture key (stem, "|n" for normal maps) -> its entry and home tile key */
  textures: Record<string, SlimRef & { t: string }>;
  /** tile key -> the whole chunk */
  tiles: Record<string, SlimRef>;
}

/** A stored texture: every level, largest first; small ones inline, large ones in the pack. */
export interface SlimTexture {
  stem: string;
  srgb: boolean;
  bc: { format: string; blockBytes: number } | null;
  full: number;
  normalMap: boolean;
  levels: { w: number; h: number; data?: Uint8Array | Uint8ClampedArray; po?: number; pn?: number }[];
  /** where the large levels are (po / pn are relative to it) */
  pack: SlimRef | null;
}

// ---------------------------------------------------------------- the entry codec

const ARRAYS: Record<string, new (b: ArrayBuffer, o: number, n: number) => ArrayBufferView> = {
  Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array, Uint8ClampedArray,
} as never;

export function encodeEntry(value: unknown): Uint8Array {
  const parts: ArrayBufferView[] = [];
  let bin = 0;
  const json = JSON.stringify(value, (_k, v) => {
    if (ArrayBuffer.isView(v)) {
      bin = Math.ceil(bin / 8) * 8;
      const ref = { $a: v.constructor.name, o: bin, n: (v as unknown as { length: number }).length };
      parts.push(v);
      bin += v.byteLength;
      return ref;
    }
    if (v instanceof Map) return { $m: [...v] };
    return v;
  });
  const text = new TextEncoder().encode(json);
  const start = Math.ceil((4 + text.byteLength) / 8) * 8;
  const out = new Uint8Array(start + bin);
  new DataView(out.buffer).setUint32(0, text.byteLength, true);
  out.set(text, 4);
  let at = 0;
  for (const p of parts) {
    at = Math.ceil(at / 8) * 8;
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), start + at);
    at += p.byteLength;
  }
  return out;
}

/** `copy`: arrays are copied out (bytes from a whole chunk, which views would keep in memory). */
export function decodeEntry<T>(bytes: Uint8Array, copy = false): T {
  const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const start = bytes.byteOffset + Math.ceil((4 + len) / 8) * 8;
  return JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)), (_k, v) => {
    if (v && typeof v === "object" && "$a" in v) {
      const T = ARRAYS[v.$a];
      const size = (T as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
      const at = start + v.o;
      // (aligned: a view; otherwise a copy)
      return at % size === 0 && !copy ? new T(bytes.buffer as ArrayBuffer, at, v.n) : new T(bytes.buffer.slice(at, at + v.n * size) as ArrayBuffer, 0, v.n);
    }
    if (v && typeof v === "object" && "$m" in v) return new Map(v.$m);
    return v;
  }) as T;
}

// ---------------------------------------------------------------- reading a package

/** Reading a package's files (OPFS in the browser, the file system in Node). */
export interface SlimFiles {
  read(file: string, at: number, size: number): Promise<Uint8Array>;
  text(file: string): Promise<string>;
}

export const tileKey = (x: number, y: number) => `${Math.floor(x / TILE)}_${Math.floor(y / TILE)}`;

/** The texture keys (stem, "|n" for normal maps) a model's materials use, as the converter stores them. */
export function textureKeys(materials: ModelParts["materials"]): string[] {
  const out: string[] = [];
  for (const m of materials) {
    if (m.nodraw) continue;
    for (const [slot, n] of [["Diffuse", ""], ["Specular", ""], ["Bumpmap", "|n"]] as const) {
      const f = m.textures.get(slot);
      if (f) out.push(`${textureFile(f)}${n}`);
    }
  }
  return out;
}

export class SlimPackage {
  readonly index: SlimIndex;
  private files: SlimFiles;
  readonly stats = { chunkReads: 0, chunkBytes: 0, singleReads: 0, singleBytes: 0, singleModels: 0, packReads: 0, packBytes: 0 };

  private constructor(files: SlimFiles, index: SlimIndex) {
    this.files = files;
    this.index = index;
  }

  static async open(files: SlimFiles): Promise<SlimPackage> {
    const index = JSON.parse(await files.text("index.json")) as SlimIndex;
    if (index.version !== SLIM_VERSION) throw new Error(`package format ${index.version}, this engine reads ${SLIM_VERSION}`);
    return new SlimPackage(files, index);
  }

  hasModel(path: string): boolean {
    return path in this.index.models;
  }

  /**
   * Before loading `paths` (models not loaded yet; their LODs are included): read whole the
   * pieces of region chunks that hold much of them (a quarter of the piece's bytes, or 64 models
   * except in the common chunk), two at a time, and decode the wanted models and the textures
   * they use from each as it arrives, so that no piece stays in memory; the rest is read entry
   * by entry when loaded. What was decoded is let go with release().
   */
  async prefetch(paths: string[]): Promise<void> {
    const byPiece = new Map<string, { paths: string[]; bytes: number }>();
    const add = (p: string) => {
      const r = this.index.models[p];
      if (!r) return false;
      const n = byPiece.get(r.t) ?? byPiece.set(r.t, { paths: [], bytes: 0 }).get(r.t)!;
      n.paths.push(p);
      n.bytes += r.n;
      return true;
    };
    for (const p of paths) {
      if (!add(p)) continue;
      for (let k = 1; k < 6 && add(p.replace(/\.(cgf|cga)$/, `_lod${k}.$1`)); k++);
    }
    // (the common chunk is large and mostly not needed at once: only by the bytes rule)
    const pieces = [...byPiece].filter(([k, n]) => {
      const r = this.index.tiles[k];
      return r && (n.bytes >= r.n / 4 || (n.paths.length >= 64 && !k.startsWith("common")));
    });
    const textures = new Set<string>();
    const decode = async ([k, n]: [string, { paths: string[] }]) => {
      const r = this.index.tiles[k];
      const bytes = await this.files.read(r.f, r.o, r.n);
      this.stats.chunkReads++;
      this.stats.chunkBytes += r.n;
      const at = (ref: SlimRef) => bytes.subarray(ref.o - r.o, ref.o - r.o + ref.n);
      for (const p of n.paths) {
        const parts = decodeEntry<ModelParts>(at(this.index.models[p]), true);
        this.ready.models.set(p, parts);
        for (const t of textureKeys(parts.materials)) textures.add(t);
      }
      for (const t of textures) {
        const ref = this.index.textures[t];
        if (ref?.t === k && !this.ready.textures.has(t)) this.ready.textures.set(t, decodeEntry<SlimTexture>(at(ref), true));
      }
    };
    let next = 0;
    await Promise.all([0, 1].map(async () => { while (next < pieces.length) await decode(pieces[next++]); }));
  }

  /** Let go of what prefetch decoded (a scene has been built from it). */
  release(): void {
    this.ready.models.clear();
    this.ready.textures.clear();
  }

  /** Decoded by prefetch, waiting to be loaded. */
  private ready = { models: new Map<string, ModelParts>(), textures: new Map<string, SlimTexture>() };

  /** An entry read on its own. */
  private async entry<T>(ref: SlimRef): Promise<T> {
    this.stats.singleReads++;
    this.stats.singleBytes += ref.n;
    return decodeEntry<T>(await this.files.read(ref.f, ref.o, ref.n));
  }

  async modelParts(path: string): Promise<ModelParts> {
    const ref = this.index.models[path];
    if (!ref) throw new Error(`${path} not in the package`);
    let parts = this.ready.models.get(path);
    if (parts) this.ready.models.delete(path);
    else {
      this.stats.singleModels++;
      parts = await this.entry<ModelParts>(ref);
    }
    return { ...parts, hit: null, notes: [] };
  }

  /** A model with its textures, as loadModel gives it. */
  async model(path: string, opts: LoadOptions = {}): Promise<LoadedModel> {
    return withTextures(await this.modelParts(path), opts, this.textures);
  }

  /** Mip chains from the package (TextureLoader). */
  readonly textures: TextureLoader = (stem, maxDim, normalMap) => this.chain(`${stem}${normalMap ? "|n" : ""}`, maxDim, 0);

  /** A texture's levels no larger than maxDim and larger than `above`, largest first. */
  private async chain(key: string, maxDim: number, above: number): Promise<MipChain> {
    const ref = this.index.textures[key];
    if (!ref) throw new Error(`texture ${key} not in the package`);
    const tex = this.ready.textures.get(key) ?? (await this.entry<SlimTexture>(ref));
    const want = tex.levels.filter((l) => Math.max(l.w, l.h) <= Math.max(maxDim, 1) && Math.max(l.w, l.h) > above);
    // (the smallest level at least, whatever maxDim)
    if (!want.length && !above) want.push(tex.levels[tex.levels.length - 1]);
    const packed = want.filter((l) => !l.data);
    let pack: Uint8Array | null = null, from = 0;
    if (packed.length && tex.pack) {
      // the needed large levels are next to each other in the pack: one read
      from = Math.min(...packed.map((l) => l.po!));
      const to = Math.max(...packed.map((l) => l.po! + l.pn!));
      pack = await this.files.read(tex.pack.f, tex.pack.o + from, to - from);
      this.stats.packReads++;
      this.stats.packBytes += to - from;
    }
    const levels = want.map((l) => ({ w: l.w, h: l.h, data: l.data ?? pack!.subarray(l.po! - from, l.po! - from + l.pn!) }));
    return {
      stem: tex.stem, srgb: tex.srgb, levels, bc: tex.bc ?? undefined, full: tex.full, normalMap: tex.normalMap,
      // (looked up again: keeping `tex` would keep what it was read from)
      more: (dim, above2) => this.chain(key, dim, above2),
    };
  }
}
