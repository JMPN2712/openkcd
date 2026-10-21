// CryEngine .mtl (XML) material reader.

import { parseXml, type XmlNode } from "./xml.ts";

export interface Material {
  name: string;
  shader: string;
  /** texture slot -> path as written in the .mtl (usually .tif) */
  textures: Map<string, string>;
  diffuse: [number, number, number];
  /** specular reflectance colour (PBR: dark for dielectrics, bright for metals) */
  specular: [number, number, number];
  opacity: number;
  alphaTest: number;
  nodraw: boolean;
  /** shader feature flags, e.g. "%COLORIZING%NORMAL_MAP" */
  genMask: string;
  /** <PublicParams> shader parameters */
  params: Record<string, string>;
}

/** KCD colorizing shader (%COLORIZING / %COLORIZING_WITH_MASK) parameters, hue in degrees. */
export interface Colorize {
  withMask: boolean;
  global: [number, number, number]; // hue, saturation, brightness
  masks: [number, number, number][]; // per mask channel R, G, B
}

export function colorizeOf(m: Material): Colorize | null {
  if (!m.genMask.includes("%COLORIZING")) return null;
  const num = (k: string, d: number) => (m.params[k] === undefined ? d : Number(m.params[k]));
  const hsb = (pre: string, suf = ""): [number, number, number] => [num(`${pre}Hue${suf}`, 0), num(`${pre}Saturation${suf}`, 1), num(`${pre}Brightness${suf}`, 1)];
  return {
    withMask: m.genMask.includes("%COLORIZING_WITH_MASK"),
    global: hsb("Colorizing"),
    masks: [hsb("Mask", "1"), hsb("Mask", "2"), hsb("Mask", "3")],
  };
}

function toMaterial(n: XmlNode): Material {
  const textures = new Map<string, string>();
  for (const t of n.children.find((c) => c.tag === "Textures")?.children ?? []) {
    if (t.tag === "Texture" && t.attrs.Map && t.attrs.File) textures.set(t.attrs.Map, t.attrs.File);
  }
  const rgb = (n.attrs.Diffuse ?? "1,1,1").split(",").map(Number);
  const spec = (n.attrs.Specular ?? "0.04,0.04,0.04").split(",").map(Number);
  const shader = n.attrs.Shader ?? "";
  return {
    name: n.attrs.Name ?? "",
    shader,
    textures,
    diffuse: [rgb[0] ?? 1, rgb[1] ?? 1, rgb[2] ?? 1],
    specular: [spec[0] ?? 0.04, spec[1] ?? 0.04, spec[2] ?? 0.04],
    opacity: Number(n.attrs.Opacity ?? 1),
    // (%DECAL sub-materials are drawn blended by the renderer, not alpha-tested)
    alphaTest: Number(n.attrs.AlphaTest ?? 0),
    // hidden: Nodraw shader, the NODRAW flag (0x400), helper textures, physics/shadow proxy
    // sub-materials (proxy_mat_*, shadowproxy: present in render meshes, never
    // drawn), EYE_AO_OVERLAY (a blended shadow shell over the eyeballs), and volumetric
    // light-shaft shaders (Geometrybeam, Templbeamproc: additive beams, black when drawn opaque)
    nodraw: /^(nodraw|geometrybeam|templbeamproc)$/i.test(shader) || (Number(n.attrs.MtlFlags ?? 0) & 0x400) !== 0 ||
      // Materials/special/: collision/barrier/raycast proxies, replace-me placeholders
      /^materials[\\/]special[\\/]/i.test(textures.get("Diffuse") ?? "") ||
      /(^|_)proxy|shadowproxy/i.test(n.attrs.Name ?? "") || (n.attrs.StringGenMask ?? "").includes("%EYE_AO_OVERLAY"),
    genMask: n.attrs.StringGenMask ?? "",
    params: { ...(n.children.find((c) => c.tag === "PublicParams")?.attrs ?? {}) },
  };
}

/**
 * Returns the materials indexed by sub-material id. A .mtl without
 * <SubMaterials> is a single material (index 0).
 */
export function parseMtl(text: string): Material[] {
  const top = parseXml(text).children.find((c) => c.tag === "Material");
  if (!top) throw new Error("no <Material> element");
  const subs = top.children.find((c) => c.tag === "SubMaterials");
  if (!subs) return [toMaterial(top)];
  return subs.children.filter((c) => c.tag === "Material" || c.tag === "MaterialRef").map(toMaterial);
}

/** Resolve a material name from a CGF's MtlName chunk to a .mtl path. */
export function mtlPath(materialName: string, modelPath: string): string {
  let n = materialName.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!/\.mtl$/i.test(n)) n += ".mtl";
  if (n.includes("/")) return n.toLowerCase();
  const dir = modelPath.slice(0, modelPath.lastIndexOf("/") + 1);
  return (dir + n).toLowerCase();
}

/** Texture path in a .mtl (usually .tif) to the .dds header path in the paks. */
export function textureFile(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\.(tif|tga|png|dds|bmp|jpg)$/i, "").toLowerCase() + ".dds";
}
