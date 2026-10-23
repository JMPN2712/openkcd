// Loads a model with its materials and diffuse textures from the asset VFS.

import { parseCgf, type Cgf, type CgfMesh } from "./cgf.ts";
import { parseSkeleton, type Skeleton } from "./skeleton.ts";
import { parseMtl, mtlPath, textureFile, type Material } from "./mtl.ts";
import { decodeMip, mipData, openTexture, type Texture } from "./texture.ts";
import { mipDims } from "./dds.ts";
import type { Vfs, VfsHit } from "./vfs.ts";

export const MODEL_RE = /\.(cgf|cga|skin|chr)$/;
export const MTL_RE = /\.mtl$/;

export interface MipChain {
  stem: string;
  srgb: boolean;
  /** RGBA8 levels, largest first (or raw BC blocks when `bc` is set) */
  levels: { w: number; h: number; data: Uint8ClampedArray | Uint8Array }[];
  /** raw block-compressed levels: the WebGPU format family (e.g. "bc1-rgba-unorm") and bytes per 4×4 block */
  bc?: { format: string; blockBytes: number };
  /** largest side the texture has (its top complete mip), and whether it was loaded as a normal map:
   *  what texturePool.ts needs to load it again at another size */
  full: number;
  normalMap: boolean;
  /** the opened texture (header and part list), to load more of it without opening it again */
  texture: Texture;
  /** the level data went to a TexturePool's GPU texture and was dropped here (the sizes stay) */
  released?: boolean;
}

/** Raw BC upload (no CPU decode) when the GPU supports texture-compression-bc: set by the renderer's owner. */
let gpuBc = false;
export function setGpuBlockCompression(on: boolean): void {
  gpuBc = on;
}

/** DDS format name → WebGPU block format (sRGB variants are chosen at upload). */
const BC_FORMATS: Record<string, string> = { BC1: "bc1-rgba-unorm", BC2: "bc2-rgba-unorm", BC3: "bc3-rgba-unorm", BC5: "bc5-rg-unorm", BC7: "bc7-rgba-unorm" };

export interface LoadedModel {
  path: string;
  /** where the model came from (null for meshes built in code: roads) */
  hit: VfsHit | null;
  cgf: Cgf;
  /** bones the mesh is weighted to (.skin/.chr), indexed by the bone-mapping stream */
  skeleton: Skeleton | null;
  mtlPath: string | null;
  materials: Material[];
  /** diffuse texture per material index (null = none / failed) */
  diffuse: (MipChain | null)[];
  /** specular-colour map per material index; the mtl Specular attribute multiplies it */
  specular: (MipChain | null)[];
  /** tangent-space normal map per material index (Bumpmap slot, _ddn/_ddna: BC5, X and Y), when loaded */
  normal: (MipChain | null)[];
  notes: string[];
}

/**
 * Decode a texture's mip chain from the largest level <= maxDim down to 1×1-ish, or with `above`
 * only the levels larger than that (the top of a chain whose lower levels are already loaded).
 */
/**
 * Whether a BC5 normal map's blocks hold unsigned values after all, judged by its smallest mip
 * (nearly flat in any normal map): flat is 128 unsigned, 0 signed. Read as signed, an unsigned
 * map's near-flat small mips wrap between -1 and +1: noise at a distance.
 */
function bc5Unsigned(smallest: Uint8Array): boolean {
  let s = 0, n = 0;
  for (let b = 0; b + 16 <= smallest.length; b += 8, n++) s += Math.abs((smallest[b] << 24) >> 24) + Math.abs((smallest[b + 1] << 24) >> 24);
  return n > 0 && s / (2 * n) > 64;
}

/**
 * Unsigned BC5 blocks as signed ones: each channel's two endpoint bytes shifted by 128 (the top bit
 * flipped). The order of the endpoints, which picks the block's mode, is kept.
 */
function toSigned(data: Uint8Array): Uint8Array {
  const out = data.slice();
  for (let b = 0; b + 8 <= out.length; b += 8) { out[b] ^= 0x80; out[b + 1] ^= 0x80; }
  return out;
}

export async function loadMipChain(vfs: Vfs, stem: string, maxDim: number, opts: { rgba?: boolean; normalMap?: boolean; texture?: Texture; above?: number } = {}): Promise<MipChain> {
  const t = opts.texture ?? await openTexture(vfs, stem);
  const above = opts.above ?? 0;
  if (!t.header.format) throw new Error(`unsupported format ${t.header.formatLabel}`);
  let level = t.firstLevel;
  const full = Math.max(...mipDims(t.header, level));
  const normalMap = !!opts.normalMap;
  while (level < t.header.mipCount - 1 && Math.max(...mipDims(t.header, level)) > maxDim) level++;
  const levels: MipChain["levels"] = [];
  let bcFormat = BC_FORMATS[t.header.format.name];
  if (opts.normalMap) {
    // KCD's _ddn/_ddna normal maps say BC5_UNORM, but their blocks hold signed values (decoded as
    // unsigned, a flat normal's X and Y fall at 0 or 255: 20% of texels below 20 and 20% above
    // 235). Upload them as BC5 SNORM; their attached alpha (gloss) isn't needed. Without BC
    // support they are skipped.
    if (t.header.format.name !== "BC5" || !gpuBc) throw new Error(`normal map ${stem}: ${t.header.formatLabel} not supported`);
    bcFormat = "bc5-rg-snorm";
  }
  // a few (the water's wave map) really are unsigned: see bc5Unsigned
  const flipSign = normalMap && bcFormat === "bc5-rg-snorm" && bc5Unsigned(await mipData(vfs, t, t.header.mipCount - 1));
  if (gpuBc && bcFormat && (!t.attached || opts.normalMap) && !opts.rgba) {
    // the GPU decodes BCn itself: keep the blocks (4–8× smaller than RGBA, no CPU decode)
    for (let l = level; l < t.header.mipCount; l++) {
      const [w, h] = mipDims(t.header, l);
      if (Math.max(w, h) <= above) break;
      const data = await mipData(vfs, t, l);
      levels.push({ w, h, data: flipSign ? toSigned(data) : data });
    }
    return { stem, srgb: t.header.srgb, levels, bc: { format: bcFormat, blockBytes: t.header.format.bytes }, full, normalMap, texture: t };
  }
  for (let l = level; l < t.header.mipCount; l++) {
    if (Math.max(...mipDims(t.header, l)) <= above) break;
    const { w, h, pixels } = await decodeMip(vfs, t, l);
    if (pixels.kind !== "ldr") throw new Error("HDR textures are not used as diffuse maps");
    levels.push({ w, h, data: pixels.data });
  }
  return { stem, srgb: t.header.srgb, levels, full, normalMap, texture: t };
}

interface LoadOptions {
  maxTextureDim?: number;
  onStatus?: (s: string) => void;
  /** .mtl path overriding the model's own (CDF / database) */
  material?: string | null;
  /** shared across models (e.g. a model's LODs reuse its textures); keyed by texture and size */
  textureCache?: Map<string, Promise<MipChain | null>>;
  /** load the materials' normal maps (default true) */
  normalMaps?: boolean;
}

/** A mesh built in code (a road) with a material from the VFS, as a model. */
export function meshModel(vfs: Vfs, name: string, mesh: CgfMesh, material: string, opts: LoadOptions = {}): Promise<LoadedModel> {
  const cgf: Cgf = { chunks: [], meshes: [mesh], material: null, skippedNodes: [], physics: [] };
  return withMaterials(vfs, name, null, cgf, null, { ...opts, material }, []);
}

export async function loadModel(vfs: Vfs, path: string, opts: LoadOptions = {}): Promise<LoadedModel> {
  const notes: string[] = [];
  // The fast-load paks hold stub copies without geometry: take the highest-
  // priority version that actually has a mesh.
  const versions = vfs.lookupAll(path);
  if (!versions.length) throw new Error(`${path} not found in any pak`);
  let hit: VfsHit | null = null;
  let cgf: Cgf | null = null;
  let skeleton: Skeleton | null = null;
  for (const v of versions) {
    const bytes = await vfs.read(v);
    const c = parseCgf(bytes);
    if (c.meshes.length) {
      hit = v;
      cgf = c;
      if (c.meshes.some((m) => m.boneIds)) {
        try {
          skeleton = parseSkeleton(bytes);
        } catch (err) {
          notes.push(`skeleton: ${(err as Error).message}`);
        }
      }
      break;
    }
  }
  if (!hit || !cgf) {
    const c = parseCgf(await vfs.read(versions[0]));
    throw new Error(`no renderable geometry (skipped nodes: ${c.skippedNodes.join(", ") || "none"})`);
  }
  if (hit !== versions[0]) notes.push(`using ${hit.pak.path}; higher-priority ${versions[0].pak.path} has no geometry`);
  return withMaterials(vfs, path, hit, cgf, skeleton, opts, notes);
}

/** Load a model's materials and their textures. */
async function withMaterials(vfs: Vfs, path: string, hit: VfsHit | null, cgf: Cgf, skeleton: Skeleton | null, opts: LoadOptions, notes: string[]): Promise<LoadedModel> {
  let materials: Material[] = [];
  let mpath: string | null = null;
  if (opts.material || cgf.material) {
    mpath = opts.material ?? mtlPath(cgf.material!, path);
    const mh = vfs.lookup(mpath);
    if (mh) {
      try {
        materials = parseMtl(new TextDecoder().decode(await vfs.read(mh)));
        // a whole material from Materials/special/ is a helper (collision proxy, …)
        if (mpath.startsWith("materials/special/")) for (const m of materials) m.nodraw = true;
      } catch (err) {
        notes.push(`material ${mpath}: ${(err as Error).message}`);
      }
    } else {
      notes.push(`material ${mpath} not found`);
    }
  }

  const cache = opts.textureCache ?? new Map<string, Promise<MipChain | null>>();
  const slot = async (slotName: string, maxDim: number): Promise<(MipChain | null)[]> => {
    const out: (MipChain | null)[] = [];
    for (const [i, m] of materials.entries()) {
      const file = m.textures.get(slotName);
      if (!file || m.nodraw) {
        out.push(null);
        continue;
      }
      const stem = textureFile(file);
      // decals (road strips, puddles, mud) use ground tiles seen up close, and grass and leaves thin
      // shapes in an atlas (blobs at 256 px): 4× the size, like the terrain's layers and the merged grass
      const dim = /%DECAL|%GRASS|%LEAVES/.test(m.genMask) ? Math.min(1024, maxDim * 4) : maxDim;
      const key = `${stem}@${dim}`;
      let p = cache.get(key);
      if (!p) {
        opts.onStatus?.(`Decoding ${stem.slice(stem.lastIndexOf("/") + 1)}…`);
        p = loadMipChain(vfs, stem, dim, { normalMap: slotName === "Bumpmap" }).catch((err) => {
          notes.push(`material ${i} (${m.name}) ${slotName} ${stem}: ${(err as Error).message}`);
          return null;
        });
        cache.set(key, p);
      }
      out.push(await p);
    }
    return out;
  };
  const maxDim = opts.maxTextureDim ?? 1024;
  const diffuse = await slot("Diffuse", maxDim);
  const specular = await slot("Specular", Math.min(512, maxDim));
  const normal = opts.normalMaps === false ? materials.map(() => null) : await slot("Bumpmap", maxDim);
  return { path, hit, cgf, skeleton, mtlPath: mpath, materials, diffuse, specular, normal, notes };
}
