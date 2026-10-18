// Loads a model with its materials and diffuse textures from the asset VFS.

import { parseCgf, type Cgf } from "./cgf.ts";
import { parseSkeleton, type Skeleton } from "./skeleton.ts";
import { parseMtl, mtlPath, textureFile, type Material } from "./mtl.ts";
import { decodeMip, mipData, openTexture } from "./texture.ts";
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
}

/** Raw BC upload (no CPU decode) when the GPU supports texture-compression-bc: set by the renderer's owner. */
let gpuBc = false;
export function setGpuBlockCompression(on: boolean): void {
  gpuBc = on;
}

/** DDS format name → WebGPU block format (sRGB variants are chosen at upload). */
const BC_FORMATS: Record<string, string> = { BC1: "bc1-rgba-unorm", BC2: "bc2-rgba-unorm", BC3: "bc3-rgba-unorm", BC7: "bc7-rgba-unorm" };

export interface LoadedModel {
  path: string;
  hit: VfsHit;
  cgf: Cgf;
  /** bones the mesh is weighted to (.skin/.chr), indexed by the bone-mapping stream */
  skeleton: Skeleton | null;
  mtlPath: string | null;
  materials: Material[];
  /** diffuse texture per material index (null = none / failed) */
  diffuse: (MipChain | null)[];
  /** specular-colour map per material index; the mtl Specular attribute multiplies it */
  specular: (MipChain | null)[];
  notes: string[];
}

/** Decode a texture's mip chain from the largest level <= maxDim down to 1×1-ish. */
export async function loadMipChain(vfs: Vfs, stem: string, maxDim: number): Promise<MipChain> {
  const t = await openTexture(vfs, stem);
  if (!t.header.format) throw new Error(`unsupported format ${t.header.formatLabel}`);
  let level = t.firstLevel;
  while (level < t.header.mipCount - 1 && Math.max(...mipDims(t.header, level)) > maxDim) level++;
  const levels: MipChain["levels"] = [];
  const bcFormat = BC_FORMATS[t.header.format.name];
  if (gpuBc && bcFormat && !t.attached) {
    // the GPU decodes BCn itself: keep the blocks (4–8× smaller than RGBA, no CPU decode)
    for (let l = level; l < t.header.mipCount; l++) {
      const [w, h] = mipDims(t.header, l);
      levels.push({ w, h, data: await mipData(vfs, t, l) });
    }
    return { stem, srgb: t.header.srgb, levels, bc: { format: bcFormat, blockBytes: t.header.format.bytes } };
  }
  for (let l = level; l < t.header.mipCount; l++) {
    const { w, h, pixels } = await decodeMip(vfs, t, l);
    if (pixels.kind !== "ldr") throw new Error("HDR textures are not used as diffuse maps");
    levels.push({ w, h, data: pixels.data });
  }
  return { stem, srgb: t.header.srgb, levels };
}

export async function loadModel(
  vfs: Vfs,
  path: string,
  opts: {
    maxTextureDim?: number;
    onStatus?: (s: string) => void;
    /** .mtl path overriding the model's own (CDF / database) */
    material?: string | null;
    /** shared across models (e.g. a model's LODs reuse its textures); keyed by texture and size */
    textureCache?: Map<string, Promise<MipChain | null>>;
  } = {},
): Promise<LoadedModel> {
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
      const key = `${stem}@${maxDim}`;
      let p = cache.get(key);
      if (!p) {
        opts.onStatus?.(`Decoding ${stem.slice(stem.lastIndexOf("/") + 1)}…`);
        p = loadMipChain(vfs, stem, maxDim).catch((err) => {
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
  return { path, hit, cgf, skeleton, mtlPath: mpath, materials, diffuse, specular, notes };
}
