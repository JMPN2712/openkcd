// Preview of a single pak entry: text for script/config formats, otherwise a
// format guess from magic bytes plus a hex dump.

import { readEntry, type PakEntry } from "./zip.ts";
import { formatSize } from "./format.ts";
import { textureStem } from "./texture.ts";
import { showTexture, type TextureContext } from "./textureView.ts";
import { showModel } from "./modelView.ts";
import { MODEL_RE } from "./model.ts";

const TEXT_EXTS = new Set([
  "xml", "lua", "cfg", "txt", "json", "ini", "mtl", "cdf", "adb", "chrparams", "animevents",
  "bspace", "ent", "cfi", "cfx", "lyr", "csv", "def", "ext", "comb", "cgfx", "fxh", "cfr",
]);
const TEXT_LIMIT = 2 << 20;
const HEX_LIMIT = 1024;

const MAGICS: [Uint8Array | string, string][] = [
  ["DDS ", "DirectDraw Surface (texture header + smallest mips)"],
  ["CrChF", "CryEngine chunk file (geometry / skeleton / animation)"],
  ["CryXmlB", "CryEngine binary XML"],
  ["OggS", "Ogg Vorbis audio"],
  ["CRID", "CRI Sofdec video (.usm)"],
  ["RIFF", "RIFF container (FMOD Studio bank if 'FEV ')"],
  ["CFX", "Scaleform GFx movie (zlib-compressed SWF)"],
  ["GFX", "Scaleform GFx movie (uncompressed)"],
  ["SQC MUSIC ENGINE", "Warhorse SQC music data"],
  ["STAR", "Sky star catalogue"],
  [new Uint8Array([0xb6, 0xba, 0xfe, 0xca]), "Terrain / merged-mesh sector data"],
  [new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "PNG image"],
];

export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  if (/\.dds\.\d+a?$/.test(base)) return "dds.N";
  if (base.endsWith(".dds.a")) return "dds.a";
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1);
}

function guessFormat(b: Uint8Array, ext: string): string {
  for (const [sig, label] of MAGICS) {
    const s = typeof sig === "string" ? new TextEncoder().encode(sig) : sig;
    if (s.every((v, i) => b[i] === v)) return label;
  }
  if (ext === "dds.N") return "Split DDS mip level (raw block data, no header)";
  if (ext === "dds.a") return "Split DDS attached alpha/gloss surface";
  if (ext === "tbl") return "Warhorse binary database table";
  return "Unknown binary";
}

function hexDump(b: Uint8Array): string {
  const lines: string[] = [];
  for (let o = 0; o < b.length; o += 16) {
    const row = b.subarray(o, o + 16);
    const hex = [...row].map((v) => v.toString(16).padStart(2, "0")).join(" ");
    const asc = [...row].map((v) => (v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : ".")).join("");
    lines.push(`${o.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${asc}`);
  }
  return lines.join("\n");
}

function decodeText(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  // TextDecoder strips a UTF-8 BOM by default; fall back to latin-1 for legacy files
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("windows-1252").decode(b);
  }
}

function looksTextual(b: Uint8Array): boolean {
  const n = Math.min(b.length, 512);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const v = b[i];
    if (v === 0) return false;
    if (v < 9 || (v > 13 && v < 32)) bad++;
  }
  return n > 0 && bad / n < 0.02;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let generation = 0;

export interface PreviewHooks {
  textures: TextureContext;
  /** show a texture by header path (used for the attached-alpha link) */
  openTexture(stem: string): void;
}

export async function showPreview(host: HTMLElement, blob: Blob, e: PakEntry, hooks?: PreviewHooks): Promise<void> {
  const gen = ++generation;
  host.replaceChildren();
  const head = el("div", "preview-head");
  head.append(el("div", "preview-path", e.name));
  const meta = el("dl", "meta");
  const ratio = e.usize ? ` (${Math.round((e.csize / e.usize) * 100)}%)` : "";
  for (const [k, v] of [
    ["Size", formatSize(e.usize)],
    ["Stored", formatSize(e.csize) + ratio],
    ["Method", e.method === 0 ? "stored" : e.method === 8 ? "deflate" : String(e.method)],
    ["CRC32", e.crc.toString(16).padStart(8, "0")],
  ]) {
    meta.append(el("dt", undefined, k), el("dd", undefined, v));
  }
  head.append(meta);
  host.append(head);
  const body = el("div", "preview-body", "Loading…");
  host.append(body);

  if (hooks && MODEL_RE.test(e.name.toLowerCase())) {
    body.replaceChildren();
    const view = el("div");
    body.append(view);
    await showModel(view, hooks.textures, e.name.toLowerCase(), hooks.openTexture);
    return;
  }

  const stem = textureStem(e.name);
  if (stem && hooks) {
    body.replaceChildren();
    if (stem !== e.name.toLowerCase()) body.append(el("p", "note", `Part of ${stem.slice(stem.lastIndexOf("/") + 1)}; showing the assembled texture.`));
    const view = el("div");
    body.append(view);
    await showTexture(view, hooks.textures, stem, hooks.openTexture);
    return;
  }

  try {
    const ext = extOf(e.name);
    const probe = await readEntry(blob, e, Math.min(e.usize, 512));
    if (gen !== generation) return;
    const isText = TEXT_EXTS.has(ext) || (ext !== "tbl" && looksTextual(probe));
    if (isText) {
      const full = e.usize <= TEXT_LIMIT;
      const data = await readEntry(blob, e, full ? undefined : TEXT_LIMIT);
      if (gen !== generation) return;
      const pre = el("pre", "text", decodeText(data));
      body.replaceChildren(pre);
      if (!full) body.prepend(el("p", "note", `Showing the first ${formatSize(TEXT_LIMIT)} of ${formatSize(e.usize)}.`));
      else body.prepend(el("p", "note ok", "CRC verified."));
    } else {
      const data = await readEntry(blob, e, Math.min(e.usize, HEX_LIMIT));
      if (gen !== generation) return;
      body.replaceChildren(
        el("p", "format", guessFormat(data, ext)),
        el("pre", "hex", hexDump(data)),
      );
      if (e.usize > HEX_LIMIT) body.append(el("p", "note", `First ${formatSize(HEX_LIMIT)} shown.`));
    }
  } catch (err) {
    if (gen === generation) body.replaceChildren(el("p", "error", (err as Error).message));
  }
}
