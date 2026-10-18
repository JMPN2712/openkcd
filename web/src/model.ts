// Loads a model with its materials and diffuse textures from the asset VFS.

import { parseCgf, type Cgf } from "./cgf.ts";
import { parseMtl, mtlPath, textureFile, type Material } from "./mtl.ts";
import { decodeMip, openTexture } from "./texture.ts";
import { mipDims } from "./dds.ts";
import type { Vfs, VfsHit } from "./vfs.ts";

export const MODEL_RE = /\.(cgf|cga|skin|chr)$/;
export const MTL_RE = /\.mtl$/;

export interface MipChain {
  stem: string;
  srgb: boolean;
  /** RGBA8 levels, largest first */
  levels: { w: number; h: number; data: Uint8ClampedArray }[];
}

export interface LoadedModel {
  path: string;
  hit: VfsHit;
  cgf: Cgf;
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
  opts: { maxTextureDim?: number; onStatus?: (s: string) => void } = {},
): Promise<LoadedModel> {
  const notes: string[] = [];
  // The fast-load paks hold stub copies without geometry: take the highest-
  // priority version that actually has a mesh.
  const versions = vfs.lookupAll(path);
  if (!versions.length) throw new Error(`${path} not found in any pak`);
  let hit: VfsHit | null = null;
  let cgf: Cgf | null = null;
  for (const v of versions) {
    const c = parseCgf(await vfs.read(v));
    if (c.meshes.length) {
      hit = v;
      cgf = c;
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
  if (cgf.material) {
    mpath = mtlPath(cgf.material, path);
    const mh = vfs.lookup(mpath);
    if (mh) {
      try {
        materials = parseMtl(new TextDecoder().decode(await vfs.read(mh)));
      } catch (err) {
        notes.push(`material ${mpath}: ${(err as Error).message}`);
      }
    } else {
      notes.push(`material ${mpath} not found`);
    }
  }

  const cache = new Map<string, Promise<MipChain | null>>();
  const slot = async (slotName: string, maxDim: number): Promise<(MipChain | null)[]> => {
    const out: (MipChain | null)[] = [];
    for (const [i, m] of materials.entries()) {
      const file = m.textures.get(slotName);
      if (!file || m.nodraw) {
        out.push(null);
        continue;
      }
      const stem = textureFile(file);
      let p = cache.get(stem);
      if (!p) {
        opts.onStatus?.(`Decoding ${stem.slice(stem.lastIndexOf("/") + 1)}…`);
        p = loadMipChain(vfs, stem, maxDim).catch((err) => {
          notes.push(`material ${i} (${m.name}) ${slotName} ${stem}: ${(err as Error).message}`);
          return null;
        });
        cache.set(stem, p);
      }
      out.push(await p);
    }
    return out;
  };
  const maxDim = opts.maxTextureDim ?? 1024;
  const diffuse = await slot("Diffuse", maxDim);
  const specular = await slot("Specular", Math.min(512, maxDim));
  return { path, hit, cgf, mtlPath: mpath, materials, diffuse, specular, notes };
}
