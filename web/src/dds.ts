// DDS header parsing and pixel-format table for the formats found in KCD.
// CryEngine variants: attached-alpha headers (.dds.a) omit the "DDS " magic,
// and split textures keep only the smallest mips after the header (see texture.ts).

import { decodeBC1, decodeBC2, decodeBC3, decodeBC4, decodeBC5, decodeBC6H, decodeBC7, halfToFloat } from "./bcn.ts";

/** Decoded pixels: RGBA8 for LDR formats, linear float RGBA for HDR ones. */
export type Pixels = { kind: "ldr"; data: Uint8ClampedArray } | { kind: "hdr"; data: Float32Array };

export interface Format {
  name: string;
  /** bytes per 4×4 block (block formats) or per pixel */
  bytes: number;
  block: boolean;
  /** decoder output only has meaningful R+G (normal maps): Z can be reconstructed */
  twoChannelNormal?: boolean;
  decode(src: Uint8Array, w: number, h: number): Pixels;
}

export interface DdsHeader {
  width: number;
  height: number;
  depth: number;
  mipCount: number;
  faces: number; // 6 for cubemaps
  isVolume: boolean;
  headerSize: number; // bytes before pixel data
  format: Format | null;
  formatLabel: string; // e.g. "DXGI 98 (BC7_UNORM)" or "DXT5"
  srgb: boolean;
}

const ldr = (f: (s: Uint8Array, w: number, h: number) => Uint8ClampedArray) =>
  (s: Uint8Array, w: number, h: number): Pixels => ({ kind: "ldr", data: f(s, w, h) });

const BC1: Format = { name: "BC1", bytes: 8, block: true, decode: ldr(decodeBC1) };
const BC2: Format = { name: "BC2", bytes: 16, block: true, decode: ldr(decodeBC2) };
const BC3: Format = { name: "BC3", bytes: 16, block: true, decode: ldr(decodeBC3) };
const BC4: Format = { name: "BC4", bytes: 8, block: true, decode: ldr(decodeBC4) };
const BC5: Format = { name: "BC5", bytes: 16, block: true, twoChannelNormal: true, decode: ldr(decodeBC5) };
const BC6H: Format = { name: "BC6H UF16", bytes: 16, block: true, decode: (s, w, h) => ({ kind: "hdr", data: decodeBC6H(s, w, h, false) }) };
const BC6HS: Format = { name: "BC6H SF16", bytes: 16, block: true, decode: (s, w, h) => ({ kind: "hdr", data: decodeBC6H(s, w, h, true) }) };
const BC7: Format = { name: "BC7", bytes: 16, block: true, decode: ldr(decodeBC7) };

/** Uncompressed formats described by channel bit masks (legacy DDS pixel formats). */
function masked(name: string, bytes: number, r: number, g: number, b: number, a: number, lum = false): Format {
  const chan = (m: number) => {
    if (!m) return null;
    let shift = 0;
    while (!((m >>> shift) & 1)) shift++;
    const max = m >>> shift;
    return { shift, max };
  };
  const R = chan(r), G = chan(g), B = chan(b), A = chan(a);
  return {
    name, bytes, block: false,
    decode(src, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
      for (let i = 0; i < w * h; i++) {
        const o = i * bytes;
        const v = bytes === 4 ? dv.getUint32(o, true) : bytes === 2 ? dv.getUint16(o, true) : bytes === 3 ? src[o] | (src[o + 1] << 8) | (src[o + 2] << 16) : src[o];
        const get = (c: { shift: number; max: number } | null, dflt: number) => (c ? Math.round((((v >>> c.shift) & c.max) * 255) / c.max) : dflt);
        const d = i * 4;
        if (lum) {
          out[d] = out[d + 1] = out[d + 2] = get(R, 0);
        } else if (!R && !G && !B) {
          out[d] = out[d + 1] = out[d + 2] = get(A, 0); // alpha-only: show as grey
        } else {
          out[d] = get(R, 0); out[d + 1] = get(G, 0); out[d + 2] = get(B, 0);
        }
        out[d + 3] = lum || (!R && !G && !B) ? 255 : get(A, 255);
      }
      return { kind: "ldr", data: out };
    },
  };
}

function halfFloat(name: string, channels: number): Format {
  return {
    name, bytes: channels * 2, block: false,
    decode(src, w, h) {
      const out = new Float32Array(w * h * 4);
      const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
      for (let i = 0; i < w * h; i++) {
        for (let c = 0; c < 4; c++) {
          out[i * 4 + c] = c < channels ? halfToFloat(dv.getUint16((i * channels + c) * 2, true)) : c === 3 ? 1 : 0;
        }
      }
      return { kind: "hdr", data: out };
    },
  };
}

function unorm16(name: string, channels: number): Format {
  return {
    name, bytes: channels * 2, block: false,
    decode(src, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
      for (let i = 0; i < w * h; i++) {
        for (let c = 0; c < 3; c++) out[i * 4 + c] = c < channels ? dv.getUint16((i * channels + c) * 2, true) >> 8 : 0;
        out[i * 4 + 3] = 255;
      }
      return { kind: "ldr", data: out };
    },
  };
}

const DXGI: Record<number, [string, Format, boolean]> = {
  10: ["R16G16B16A16_FLOAT", halfFloat("RGBA16F", 4), false],
  28: ["R8G8B8A8_UNORM", masked("RGBA8", 4, 0xff, 0xff00, 0xff0000, 0xff000000), false],
  29: ["R8G8B8A8_UNORM_SRGB", masked("RGBA8", 4, 0xff, 0xff00, 0xff0000, 0xff000000), true],
  34: ["R16G16_FLOAT", halfFloat("RG16F", 2), false],
  35: ["R16G16_UNORM", unorm16("RG16", 2), false],
  61: ["R8_UNORM", masked("R8", 1, 0xff, 0, 0, 0, true), false],
  65: ["A8_UNORM", masked("A8", 1, 0, 0, 0, 0xff), false],
  71: ["BC1_UNORM", BC1, false],
  72: ["BC1_UNORM_SRGB", BC1, true],
  74: ["BC2_UNORM", BC2, false],
  75: ["BC2_UNORM_SRGB", BC2, true],
  77: ["BC3_UNORM", BC3, false],
  78: ["BC3_UNORM_SRGB", BC3, true],
  80: ["BC4_UNORM", BC4, false],
  83: ["BC5_TYPELESS", BC5, false],
  84: ["BC5_UNORM", BC5, false],
  87: ["B8G8R8A8_UNORM", masked("BGRA8", 4, 0xff0000, 0xff00, 0xff, 0xff000000), false],
  91: ["B8G8R8A8_UNORM_SRGB", masked("BGRA8", 4, 0xff0000, 0xff00, 0xff, 0xff000000), true],
  95: ["BC6H_UF16", BC6H, false],
  96: ["BC6H_SF16", BC6HS, false],
  98: ["BC7_UNORM", BC7, false],
  99: ["BC7_UNORM_SRGB", BC7, true],
};

const FOURCC: Record<string, Format> = {
  DXT1: BC1, DXT2: BC2, DXT3: BC2, DXT4: BC3, DXT5: BC3,
  ATI1: BC4, BC4U: BC4, ATI2: BC5, BC5U: BC5,
};
// D3DFORMAT codes stored numerically in the FourCC field
const D3DFMT: Record<number, [string, Format]> = {
  36: ["A16B16G16R16", unorm16("RGBA16", 4)],
  111: ["R16F", halfFloat("R16F", 1)],
  112: ["G16R16F", halfFloat("RG16F", 2)],
  113: ["A16B16G16R16F", halfFloat("RGBA16F", 4)],
};

const DDSD_DEPTH = 0x800000;
const DDSCAPS2_CUBEMAP = 0x200;
const DDSCAPS2_VOLUME = 0x200000;
const DDPF_ALPHAPIXELS = 0x1, DDPF_ALPHA = 0x2, DDPF_FOURCC = 0x4, DDPF_RGB = 0x40, DDPF_LUMINANCE = 0x20000;

export function parseDdsHeader(buf: Uint8Array): DdsHeader {
  const hasMagic = buf[0] === 0x44 && buf[1] === 0x44 && buf[2] === 0x53 && buf[3] === 0x20;
  const b = hasMagic ? 4 : 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < b + 124 || dv.getUint32(b, true) !== 124) throw new Error("not a DDS header");
  const flags = dv.getUint32(b + 4, true);
  const height = dv.getUint32(b + 8, true);
  const width = dv.getUint32(b + 12, true);
  const depth = flags & DDSD_DEPTH ? Math.max(1, dv.getUint32(b + 20, true)) : 1;
  const mipCount = Math.max(1, dv.getUint32(b + 24, true));
  const pfFlags = dv.getUint32(b + 76, true);
  const fourccRaw = dv.getUint32(b + 80, true);
  const fourcc = String.fromCharCode(buf[b + 80], buf[b + 81], buf[b + 82], buf[b + 83]);
  const bitCount = dv.getUint32(b + 84, true);
  const masks = [88, 92, 96, 100].map((o) => dv.getUint32(b + o, true));
  const caps2 = dv.getUint32(b + 108, true);
  let headerSize = b + 124;
  let format: Format | null = null;
  let formatLabel: string;
  let srgb = false;

  if (pfFlags & DDPF_FOURCC && fourcc === "DX10") {
    const dxgi = dv.getUint32(b + 124, true);
    headerSize += 20;
    const known = DXGI[dxgi];
    formatLabel = `DXGI ${dxgi}${known ? ` (${known[0]})` : ""}`;
    if (known) { format = known[1]; srgb = known[2]; }
  } else if (pfFlags & DDPF_FOURCC) {
    if (FOURCC[fourcc]) { format = FOURCC[fourcc]; formatLabel = fourcc; }
    else if (D3DFMT[fourccRaw]) { format = D3DFMT[fourccRaw][1]; formatLabel = D3DFMT[fourccRaw][0]; }
    else formatLabel = /^[\x20-\x7e]{4}$/.test(fourcc) ? `FourCC ${fourcc}` : `D3DFMT ${fourccRaw}`;
  } else {
    const bytes = bitCount >> 3;
    const [r, g, bl, a] = masks;
    const alpha = pfFlags & (DDPF_ALPHAPIXELS | DDPF_ALPHA) ? a || (bytes === 1 && !r && !g && !bl ? 0xff : 0) : 0;
    const lum = !!(pfFlags & DDPF_LUMINANCE);
    if (bytes >= 1 && bytes <= 4) {
      const label = lum ? `L${bitCount}${alpha ? `A` : ""}` : !(pfFlags & DDPF_RGB) && alpha ? `A${bitCount}` : `RGB${alpha ? "A" : ""} ${bitCount}-bit`;
      format = masked(label, bytes, r, lum ? 0 : g, lum ? 0 : bl, alpha, lum);
      formatLabel = label;
    } else {
      formatLabel = `uncompressed ${bitCount}-bit (flags ${pfFlags.toString(16)})`;
    }
  }
  return {
    width, height, depth, mipCount,
    faces: caps2 & DDSCAPS2_CUBEMAP ? 6 : 1,
    isVolume: !!(caps2 & DDSCAPS2_VOLUME) || depth > 1,
    headerSize, format, formatLabel, srgb,
  };
}

export function mipDims(h: DdsHeader, level: number): [number, number] {
  return [Math.max(1, h.width >> level), Math.max(1, h.height >> level)];
}

/** Byte size of one face of one mip level. */
export function mipBytes(h: DdsHeader, level: number): number {
  const f = h.format;
  if (!f) throw new Error(`unsupported format ${h.formatLabel}`);
  const [w, hh] = mipDims(h, level);
  return f.block ? Math.max(1, (w + 3) >> 2) * Math.max(1, (hh + 3) >> 2) * f.bytes : w * hh * f.bytes;
}
