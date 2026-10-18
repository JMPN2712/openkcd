// Texture preview panel: resolves a texture across all paks (via the VFS),
// decodes a chosen mip on the CPU and draws it to a canvas.

import { mipDims, type Pixels } from "./dds.ts";
import { decodeMip, openTexture, type Texture } from "./texture.ts";
import type { Vfs } from "./vfs.ts";
import { formatSize } from "./format.ts";

export interface TextureContext {
  /** Asset VFS over all paks, built on first use; cached per HD setting. */
  vfs(includeHd: boolean, onProgress: (done: number, total: number) => void): Promise<Vfs>;
  hasHd: boolean;
  includeHd: boolean;
  setIncludeHd(v: boolean): void;
}

type Channel = "rgba" | "rgb" | "r" | "g" | "b" | "a" | "normal";
const FACE_NAMES = ["+X", "−X", "+Y", "−Y", "+Z", "−Z"];
const DEFAULT_MAX_DIM = 2048;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function select<T extends string | number>(label: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLLabelElement {
  const wrap = el("label", "ctl");
  wrap.append(el("span", "dim", label));
  const s = el("select");
  for (const [v, text] of options) {
    const o = el("option", undefined, text);
    o.value = String(v);
    if (v === value) o.selected = true;
    s.append(o);
  }
  s.addEventListener("change", () => {
    const opt = options.find(([v]) => String(v) === s.value);
    if (opt) onChange(opt[0]);
  });
  wrap.append(s);
  return wrap;
}

const srgbEncode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

/** Convert decoded pixels to displayable RGBA8 for the chosen channel view. */
function toRgba8(px: Pixels, channel: Channel, exposure: number): Uint8ClampedArray {
  const n = px.data.length;
  const out = new Uint8ClampedArray(n);
  if (px.kind === "hdr") {
    const k = Math.pow(2, exposure);
    for (let i = 0; i < n; i += 4) {
      for (let c = 0; c < 3; c++) out[i + c] = 255 * srgbEncode(Math.min(1, Math.max(0, px.data[i + c] * k)));
      out[i + 3] = 255;
    }
  } else {
    out.set(px.data);
  }
  if (channel === "rgba") return out;
  for (let i = 0; i < n; i += 4) {
    switch (channel) {
      case "rgb": out[i + 3] = 255; break;
      case "r": case "g": case "b": case "a": {
        const v = out[i + "rgba".indexOf(channel)];
        out[i] = out[i + 1] = out[i + 2] = v;
        out[i + 3] = 255;
        break;
      }
      case "normal": {
        const x = out[i] / 127.5 - 1, y = out[i + 1] / 127.5 - 1;
        out[i + 2] = (Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255;
        out[i + 3] = 255;
        break;
      }
    }
  }
  return out;
}

let generation = 0;

/**
 * Show the texture whose header path is `stem`. `openOther` lets the panel
 * jump to the attached alpha texture.
 */
export async function showTexture(host: HTMLElement, ctx: TextureContext, stem: string, openOther: (stem: string) => void): Promise<void> {
  const gen = ++generation;
  host.replaceChildren(el("p", "note", "Indexing assets across all archives…"));
  let vfs: Vfs;
  let tex: Texture;
  try {
    vfs = await ctx.vfs(ctx.includeHd, (done, total) => {
      if (gen === generation) host.replaceChildren(el("p", "note", `Indexing assets across all archives… ${done}/${total}`));
    });
    if (gen !== generation) return;
    tex = await openTexture(vfs, stem);
  } catch (err) {
    if (gen === generation) host.replaceChildren(el("p", "error", (err as Error).message));
    return;
  }
  if (gen !== generation) return;

  const h = tex.header;
  const fmt = h.format;
  // state
  let level = tex.firstLevel;
  while (level < h.mipCount - 1 && Math.max(...mipDims(h, level)) > DEFAULT_MAX_DIM) level++;
  let channel: Channel = fmt?.twoChannelNormal ? "normal" : "rgba";
  let face: number | "cross" = h.faces > 1 ? "cross" : 0;
  let exposure = 0;

  host.replaceChildren();
  // ---- info
  const info = el("dl", "meta tex-meta");
  const rows: [string, string][] = [
    ["Format", `${h.formatLabel}${h.srgb ? " · sRGB" : ""}`],
    ["Size", `${h.width}×${h.height}${h.faces > 1 ? " · cubemap" : ""}${h.isVolume ? ` · volume ×${h.depth}` : ""}`],
    ["Mips", `${h.mipCount} (${tex.splitParts ? `${tex.splitParts} split into .dds.N files` : "all in header file"})`],
    ["Header from", tex.headerHit.pak.path],
  ];
  const partPaks = [...new Set(tex.partHits.map((p) => p.pak.path))];
  if (partPaks.length) rows.push(["Mips from", partPaks.join(", ")]);
  for (const [k, v] of rows) info.append(el("dt", undefined, k), el("dd", undefined, v));
  host.append(info);
  for (const s of tex.skipped) host.append(el("p", "note", `Skipped newer version in ${s}`));
  for (const w of tex.warnings) host.append(el("p", "note warn", w));

  // ---- controls
  const controls = el("div", "tex-controls");
  const levels: [number, string][] = [];
  for (let l = tex.firstLevel; l < h.mipCount; l++) {
    const [w, hh] = mipDims(h, l);
    levels.push([l, `${l}: ${w}×${hh}`]);
  }
  controls.append(select("Mip", levels, level, (v) => { level = v; void draw(); }));
  const chans: [Channel, string][] = [["rgba", "RGBA"], ["rgb", "RGB"], ["r", "R"], ["g", "G"], ["b", "B"], ["a", "A"]];
  if (fmt?.twoChannelNormal) chans.unshift(["normal", "Normal (rebuild Z)"]);
  controls.append(select("Channels", chans, channel, (v) => { channel = v; void draw(); }));
  if (h.faces > 1) {
    const faces: [number | "cross", string][] = [["cross", "All (cross)"], ...FACE_NAMES.map((n, i): [number, string] => [i, n])];
    controls.append(select("Face", faces, face, (v) => { face = v; void draw(); }));
  }
  if (fmt && /BC6H|16F|FLOAT/.test(h.formatLabel)) {
    const wrap = el("label", "ctl");
    const out = el("span", "dim", "Exposure 0 EV");
    const r = el("input");
    r.type = "range"; r.min = "-6"; r.max = "6"; r.step = "0.5"; r.value = "0";
    r.addEventListener("input", () => { exposure = Number(r.value); out.textContent = `Exposure ${exposure} EV`; void draw(); });
    wrap.append(out, r);
    controls.append(wrap);
  }
  if (ctx.hasHd) {
    const wrap = el("label", "ctl check");
    const cb = el("input");
    cb.type = "checkbox"; cb.checked = ctx.includeHd;
    cb.addEventListener("change", () => { ctx.setIncludeHd(cb.checked); void showTexture(host, ctx, stem, openOther); });
    wrap.append(cb, el("span", undefined, "HD texture pack"));
    controls.append(wrap);
  }
  if (tex.attached) {
    const b = el("button", "link", "Open attached alpha (.dds.a) →");
    b.type = "button";
    const target = tex.attached;
    b.addEventListener("click", () => openOther(target));
    controls.append(b);
  }
  if (stem.endsWith(".dds.a")) {
    const b = el("button", "link", "← Open main texture");
    b.type = "button";
    b.addEventListener("click", () => openOther(stem.slice(0, -2)));
    controls.append(b);
  }
  host.append(controls);

  const status = el("p", "note");
  const canvas = el("canvas", "tex-canvas");
  const stage = el("div", "tex-stage");
  stage.append(canvas);
  host.append(status, stage);

  if (!fmt) {
    status.textContent = `Pixel format ${h.formatLabel} is not supported yet.`;
    return;
  }
  if (h.isVolume) {
    status.textContent = "Volume textures: showing the first slice only.";
  }

  async function draw(): Promise<void> {
    const myGen = generation;
    const [w, hh] = mipDims(h, level);
    const faces = face === "cross" ? [0, 1, 2, 3, 4, 5] : [face];
    status.textContent = `Decoding mip ${level} (${w}×${hh}${faces.length > 1 ? " ×6" : ""})…`;
    await new Promise((r) => setTimeout(r, 0)); // let the status paint
    try {
      const t0 = performance.now();
      const decoded = [];
      for (const f of faces) decoded.push(await decodeMip(vfs, tex, level, f));
      if (myGen !== generation) return;
      // cubemap cross: column/row of each face in a 4×3 grid
      const CROSS: [number, number][] = [[2, 1], [0, 1], [1, 0], [1, 2], [1, 1], [3, 1]];
      const cw = faces.length > 1 ? w * 4 : w;
      const ch = faces.length > 1 ? hh * 3 : hh;
      canvas.width = cw;
      canvas.height = ch;
      const g = canvas.getContext("2d")!;
      g.clearRect(0, 0, cw, ch);
      decoded.forEach((d, i) => {
        const img = new ImageData(toRgba8(d.pixels, channel, exposure) as Uint8ClampedArray<ArrayBuffer>, d.w, d.h);
        const [cx, cy] = faces.length > 1 ? CROSS[faces[i]] : [0, 0];
        g.putImageData(img, cx * w, cy * hh);
      });
      const bytes = decoded.reduce((s, d) => s + d.w * d.h * 4, 0);
      status.textContent = `Mip ${level}: ${w}×${hh}${faces.length > 1 ? " per face" : ""}, decoded ${formatSize(bytes)} in ${Math.round(performance.now() - t0)} ms.`;
      canvas.classList.toggle("pixelated", w <= 256);
    } catch (err) {
      if (myGen === generation) status.textContent = (err as Error).message;
    }
  }
  await draw();
}
