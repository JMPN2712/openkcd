// CryEngine .mtl (XML) material reader. Uses a tiny tag tokenizer instead of
// DOMParser so the same code runs in Node tests and the browser.

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
}

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]);

function parseXml(text: string): XmlNode {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attrRe = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const m of text.replace(/<!--[\s\S]*?-->/g, "").matchAll(tagRe)) {
    const [, close, tag, attrText, selfClose] = m;
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(attrRe)) attrs[a[1]] = unescape(a[2] ?? a[3] ?? "");
    const node: XmlNode = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
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
    alphaTest: Number(n.attrs.AlphaTest ?? 0),
    nodraw: /^nodraw$/i.test(shader),
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
