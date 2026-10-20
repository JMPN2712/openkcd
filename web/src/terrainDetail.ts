// Terrain detail layers: the level's surface types (leveldata.xml <SurfaceTypes>, 26 in Rataje)
// each name a Terrain.Layer material (Materials/terrain/grass/grass_default.mtl …) with a tiling
// diffuse texture (TileU 0.25: the texture repeats every 4 m). terrain.ts decodes which surface
// type each heightmap sample has; the terrain shader blends the four around a pixel.
//
// The layers are decoded to RGBA at one size so they fit one texture array, with a box-filtered
// mip chain, and each layer's average colour so the shader can use the detail as a modulation of
// the terrain colour map (cover.ctc): the large-scale colour stays, the close-up gains texture.

import { parseXml } from "./xml.ts";
import { loadMipChain } from "./model.ts";
import { textureFile } from "./mtl.ts";
import type { Vfs } from "./vfs.ts";

export interface DetailLayers {
  /** texture side (power of two) */
  size: number;
  /** per layer: mip levels (RGBA8, largest first), all layers the same size */
  layers: Uint8Array[][];
  /** per layer: metres per texture repeat, and the texture's average colour (linear) */
  metres: number[];
  average: [number, number, number][];
  /** surface type id → layer index (-1 = none: no material, "invisible", or failed) */
  layerOf: Int16Array;
  names: string[];
}

/** The level's surface types: id → detail material path (no extension). */
export function parseSurfaceTypes(levelDataXml: string): Map<number, string> {
  const m = /<SurfaceTypes[\s\S]*?<\/SurfaceTypes>/.exec(levelDataXml);
  const out = new Map<number, string>();
  if (!m) return out;
  for (const st of parseXml(m[0]).children.find((c) => c.tag === "SurfaceTypes")?.children ?? []) {
    const id = Number(st.attrs.SurfaceTypeID);
    const mat = (st.attrs.DetailMaterial || st.attrs.Name || "").replaceAll("\\", "/").toLowerCase();
    if (Number.isInteger(id) && mat) out.set(id, mat);
  }
  return out;
}

const toLinear = (v: number) => Math.pow(v / 255, 2.2);

/** Resample an RGBA image to size×size (nearest for upscaling, box for downscaling). */
function resample(src: Uint8Array | Uint8ClampedArray, w: number, h: number, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const fx = w / size, fy = h / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const x0 = Math.floor(x * fx), y0 = Math.floor(y * fy);
    const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx)), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    const acc = [0, 0, 0, 0];
    let n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const o = (yy * w + xx) * 4;
      for (let c = 0; c < 4; c++) acc[c] += src[o + c];
      n++;
    }
    for (let c = 0; c < 4; c++) out[(y * size + x) * 4 + c] = Math.round(acc[c] / n);
  }
  return out;
}

/** Box-filtered mips down to 1×1. */
function mips(top: Uint8Array, size: number): Uint8Array[] {
  const out = [top];
  for (let s = size; s > 1; s >>= 1) out.push(resample(out[out.length - 1], s, s, s >> 1));
  return out;
}

export async function loadDetailLayers(vfs: Vfs, surfaceTypes: Map<number, string>, size = 512): Promise<DetailLayers> {
  const layers: Uint8Array[][] = [], metres: number[] = [], average: [number, number, number][] = [], names: string[] = [];
  const maxId = Math.max(0, ...surfaceTypes.keys());
  const layerOf = new Int16Array(Math.max(256, maxId + 1)).fill(-1);
  for (const [id, mat] of [...surfaceTypes].sort((a, b) => a[0] - b[0])) {
    if (/\/invisible$/.test(mat)) continue;
    try {
      const hit = vfs.lookup(`${mat}.mtl`);
      if (!hit) continue;
      const root = parseXml(new TextDecoder().decode(await vfs.read(hit))).children.find((c) => c.tag === "Material");
      const tex = root?.children.find((c) => c.tag === "Textures")?.children.find((c) => c.attrs.Map === "Diffuse");
      if (!tex?.attrs.File) continue;
      const tile = Number(tex.children.find((c) => c.tag === "TexMod")?.attrs.TileU ?? 1) || 1;
      const chain = await loadMipChain(vfs, textureFile(tex.attrs.File), size, { rgba: true });
      const top = chain.levels[0];
      const img = top.w === size && top.h === size ? Uint8Array.from(top.data) : resample(top.data, top.w, top.h, size);
      const levels = mips(img, size);
      const px = levels[levels.length - 1];
      layerOf[id] = layers.length;
      layers.push(levels);
      // CryEngine texture coordinates: tile × world metres, so one repeat covers 1 / tile metres
      metres.push(1 / tile);
      average.push([toLinear(px[0]), toLinear(px[1]), toLinear(px[2])]);
      names.push(mat);
    } catch {
      // a layer that fails to load is left out (its ground keeps the colour map)
    }
  }
  return { size, layers, metres, average, layerOf, names };
}
