// CPU decoders for the block-compressed formats KCD uses (BC1–BC7).
// LDR decoders write RGBA8; BC6H writes linear float RGBA.
// Layouts follow the D3D11 functional spec / Khronos Data Format spec.

export type Ldr = Uint8ClampedArray;

// ---------------------------------------------------------------- helpers

function blockLoop(
  w: number,
  h: number,
  blockBytes: number,
  decodeBlock: (blockIndex: number, px: (x: number, y: number) => number) => void,
): void {
  const bw = Math.max(1, (w + 3) >> 2);
  const bh = Math.max(1, (h + 3) >> 2);
  let b = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, b++) {
      const ox = bx * 4;
      const oy = by * 4;
      // returns -1 for pixels outside the image (partial edge blocks)
      decodeBlock(b * blockBytes, (x, y) => {
        const X = ox + x;
        const Y = oy + y;
        return X < w && Y < h ? (Y * w + X) * 4 : -1;
      });
    }
  }
}

function rgb565(v: number, out: number[], o: number): void {
  const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 2) | (g >> 4);
  out[o + 2] = (b << 3) | (b >> 2);
}

/** Colour part of BC1/2/3. `forceFour` = BC2/3 always use 4-colour mode. */
function colorBlock(src: Uint8Array, o: number, out: Ldr, px: (x: number, y: number) => number, forceFour: boolean, writeAlpha: boolean): void {
  const c0 = src[o] | (src[o + 1] << 8);
  const c1 = src[o + 2] | (src[o + 3] << 8);
  const pal: number[] = new Array(16).fill(255);
  rgb565(c0, pal, 0);
  rgb565(c1, pal, 4);
  if (c0 > c1 || forceFour) {
    for (let i = 0; i < 3; i++) {
      pal[8 + i] = ((2 * pal[i] + pal[4 + i]) / 3) | 0;
      pal[12 + i] = ((pal[i] + 2 * pal[4 + i]) / 3) | 0;
    }
  } else {
    for (let i = 0; i < 3; i++) {
      pal[8 + i] = (pal[i] + pal[4 + i]) >> 1;
      pal[12 + i] = 0;
    }
    pal[15] = 0;
  }
  const bits = src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24);
  for (let i = 0; i < 16; i++) {
    const d = px(i & 3, i >> 2);
    if (d < 0) continue;
    const s = ((bits >>> (2 * i)) & 3) * 4;
    out[d] = pal[s];
    out[d + 1] = pal[s + 1];
    out[d + 2] = pal[s + 2];
    if (writeAlpha) out[d + 3] = pal[s + 3];
  }
}

/** BC4-style 8-byte single channel block, written to channel `ch` (0–3). */
function alphaBlock(src: Uint8Array, o: number, out: Ldr, px: (x: number, y: number) => number, ch: number): void {
  const a0 = src[o], a1 = src[o + 1];
  const pal = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) {
    for (let i = 1; i < 7; i++) pal[i + 1] = (((7 - i) * a0 + i * a1) / 7) | 0;
  } else {
    for (let i = 1; i < 5; i++) pal[i + 1] = (((5 - i) * a0 + i * a1) / 5) | 0;
    pal[6] = 0;
    pal[7] = 255;
  }
  // 48 bits of 3-bit indices; split into two 24-bit halves to stay in int range
  const lo = src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16);
  const hi = src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16);
  for (let i = 0; i < 16; i++) {
    const d = px(i & 3, i >> 2);
    if (d < 0) continue;
    const idx = i < 8 ? (lo >> (3 * i)) & 7 : (hi >> (3 * (i - 8))) & 7;
    out[d + ch] = pal[idx];
  }
}

// ---------------------------------------------------------------- BC1–BC5

export function decodeBC1(src: Uint8Array, w: number, h: number): Ldr {
  const out = new Uint8ClampedArray(w * h * 4);
  blockLoop(w, h, 8, (o, px) => colorBlock(src, o, out, px, false, true));
  return out;
}

export function decodeBC2(src: Uint8Array, w: number, h: number): Ldr {
  const out = new Uint8ClampedArray(w * h * 4);
  blockLoop(w, h, 16, (o, px) => {
    for (let i = 0; i < 16; i++) {
      const d = px(i & 3, i >> 2);
      if (d < 0) continue;
      const a = (src[o + (i >> 1)] >> ((i & 1) * 4)) & 15;
      out[d + 3] = a * 17;
    }
    colorBlock(src, o + 8, out, px, true, false);
  });
  return out;
}

export function decodeBC3(src: Uint8Array, w: number, h: number): Ldr {
  const out = new Uint8ClampedArray(w * h * 4);
  blockLoop(w, h, 16, (o, px) => {
    alphaBlock(src, o, out, px, 3);
    colorBlock(src, o + 8, out, px, true, false);
  });
  return out;
}

/** BC4 / ATI1: grey image. */
export function decodeBC4(src: Uint8Array, w: number, h: number): Ldr {
  const out = new Uint8ClampedArray(w * h * 4);
  blockLoop(w, h, 8, (o, px) => alphaBlock(src, o, out, px, 0));
  for (let i = 0; i < out.length; i += 4) {
    out[i + 1] = out[i + 2] = out[i];
    out[i + 3] = 255;
  }
  return out;
}

/** BC5 / ATI2: R and G; B = 0. */
export function decodeBC5(src: Uint8Array, w: number, h: number): Ldr {
  const out = new Uint8ClampedArray(w * h * 4);
  blockLoop(w, h, 16, (o, px) => {
    alphaBlock(src, o, out, px, 0);
    alphaBlock(src, o + 8, out, px, 1);
  });
  for (let i = 0; i < out.length; i += 4) out[i + 3] = 255;
  return out;
}

// ---------------------------------------------------------------- shared BC6H/BC7 tables

const P2 = [
  "0011001100110011", // 0
  "0001000100010001", // 1
  "0111011101110111", // 2
  "0001001100110111", // 3
  "0000000100010011", // 4
  "0011011101111111", // 5
  "0001001101111111", // 6
  "0000000100110111", // 7
  "0000000000010011", // 8
  "0011011111111111", // 9
  "0000000101111111", // 10
  "0000000000010111", // 11
  "0001011111111111", // 12
  "0000000011111111", // 13
  "0000111111111111", // 14
  "0000000000001111", // 15
  "0000100011101111", // 16
  "0111000100000000", // 17
  "0000000010001110", // 18
  "0111001100010000", // 19
  "0011000100000000", // 20
  "0000100011001110", // 21
  "0000000010001100", // 22
  "0111001100110001", // 23
  "0011000100010000", // 24
  "0000100010001100", // 25
  "0110011001100110", // 26
  "0011011001101100", // 27
  "0001011111101000", // 28
  "0000111111110000", // 29
  "0111000110001110", // 30
  "0011100110011100", // 31
  "0101010101010101", // 32
  "0000111100001111", // 33
  "0101101001011010", // 34
  "0011001111001100", // 35
  "0011110000111100", // 36
  "0101010110101010", // 37
  "0110100101101001", // 38
  "0101101010100101", // 39
  "0111001111001110", // 40
  "0001001111001000", // 41
  "0011001001001100", // 42
  "0011101111011100", // 43
  "0110100110010110", // 44
  "0011110011000011", // 45
  "0110011010011001", // 46
  "0000011001100000", // 47
  "0100111001000000", // 48
  "0010011100100000", // 49
  "0000001001110010", // 50
  "0000010011100100", // 51
  "0110110010010011", // 52
  "0011011011001001", // 53
  "0110001110011100", // 54
  "0011100111000110", // 55
  "0110110011001001", // 56
  "0110001100111001", // 57
  "0111111010000001", // 58
  "0001100011100111", // 59
  "0000111100110011", // 60
  "0011001111110000", // 61
  "0010001011101110", // 62
  "0100010001110111", // 63
].join("");

const P3 = [
  "0011001102212222", // 0
  "0001001122112221", // 1
  "0000200122112211", // 2
  "0222002200110111", // 3
  "0000000011221122", // 4
  "0011001100220022", // 5
  "0022002211111111", // 6
  "0011001122112211", // 7
  "0000000011112222", // 8
  "0000111111112222", // 9
  "0000111122222222", // 10
  "0012001200120012", // 11
  "0112011201120112", // 12
  "0122012201220122", // 13
  "0011011211221222", // 14
  "0011200122002220", // 15
  "0001001101121122", // 16
  "0111001120012200", // 17
  "0000112211221122", // 18
  "0022002200221111", // 19
  "0111011102220222", // 20
  "0001000122212221", // 21
  "0000001101220122", // 22
  "0000110022102210", // 23
  "0122012200110000", // 24
  "0012001211222222", // 25
  "0110122112210110", // 26
  "0000011012211221", // 27
  "0022110211020022", // 28
  "0110011020022222", // 29
  "0011012201220011", // 30
  "0000200022112221", // 31
  "0000000211221222", // 32
  "0222002200120011", // 33
  "0011001200220222", // 34
  "0120012001200120", // 35
  "0000111122220000", // 36
  "0120120120120120", // 37
  "0120201212010120", // 38
  "0011220011220011", // 39
  "0011112222000011", // 40
  "0101010122222222", // 41
  "0000000021212121", // 42
  "0022112200221122", // 43
  "0022001100220011", // 44
  "0220122102201221", // 45
  "0101222222220101", // 46
  "0000212121212121", // 47
  "0101010101012222", // 48
  "0222011102220111", // 49
  "0002111200021112", // 50
  "0000211221122112", // 51
  "0222011101110222", // 52
  "0002111211120002", // 53
  "0110011001102222", // 54
  "0000000021122112", // 55
  "0110011022222222", // 56
  "0022001100110022", // 57
  "0022112211220022", // 58
  "0000000000002112", // 59
  "0002000100020001", // 60
  "0222122202221222", // 61
  "0101222222222222", // 62
  "0111201122012220", // 63
].join("");

const A2 = [15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,2,8,2,2,8,8,15,2,8,2,2,8,8,2,2,15,15,6,8,2,8,15,15,2,8,2,2,2,15,15,6,6,2,6,8,15,15,2,2,15,15,15,15,15,2,2,15];
const A3a = [3,3,15,15,8,3,15,15,8,8,6,6,6,5,3,3,3,3,8,15,3,3,6,10,5,8,8,6,8,5,15,15,8,15,3,5,6,10,8,15,15,3,15,5,15,15,15,15,3,15,5,5,5,8,5,10,5,10,8,13,15,12,3,3];
const A3b = [15,8,8,3,15,15,3,8,15,15,15,15,15,15,15,8,15,8,15,3,15,8,15,8,3,15,6,10,15,15,10,8,15,3,15,10,10,8,9,10,6,15,8,15,3,6,6,8,15,3,15,15,15,15,15,15,15,15,15,15,3,15,15,8];

const W2 = [0, 21, 43, 64];
const W3 = [0, 9, 18, 27, 37, 46, 55, 64];
const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

function subsetOf(ns: number, part: number, i: number): number {
  if (ns === 1) return 0;
  return (ns === 2 ? P2 : P3).charCodeAt(part * 16 + i) - 48;
}

function isAnchor(ns: number, part: number, i: number): boolean {
  if (i === 0) return true;
  if (ns === 2) return i === A2[part];
  if (ns === 3) return i === A3a[part] || i === A3b[part];
  return false;
}

/** LSB-first bit reader over a 16-byte block. */
class Bits {
  private pos = 0;
  private src: Uint8Array;
  private base: number;
  constructor(src: Uint8Array, base: number) {
    this.src = src;
    this.base = base;
  }
  get(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) {
      v |= ((this.src[this.base + (this.pos >> 3)] >> (this.pos & 7)) & 1) << i;
    }
    return v;
  }
  at(): number { return this.pos; }
}

// ---------------------------------------------------------------- BC7

// [subsets, partitionBits, rotationBits, indexSelBit, colorBits, alphaBits, endpointPBits, sharedPBits, indexBits, index2Bits]
const BC7_MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
];

function weights(bits: number): number[] {
  return bits === 2 ? W2 : bits === 3 ? W3 : W4;
}

export function decodeBC7(src: Uint8Array, w: number, h: number): Ldr {
  const out = new Uint8ClampedArray(w * h * 4);
  const ep = new Array<number>(24); // up to 6 endpoints × RGBA
  blockLoop(w, h, 16, (o, px) => {
    let mode = 0;
    while (mode < 8 && !(src[o] & (1 << mode))) mode++;
    if (mode === 8) {
      for (let i = 0; i < 16; i++) {
        const d = px(i & 3, i >> 2);
        if (d >= 0) out[d] = out[d + 1] = out[d + 2] = out[d + 3] = 0;
      }
      return;
    }
    const [ns, pb, rb, isb, cb, ab, epb, spb, ib, ib2] = BC7_MODES[mode];
    const r = new Bits(src, o);
    r.get(mode + 1);
    const part = r.get(pb);
    const rot = r.get(rb);
    const idxSel = r.get(isb);
    const ne = ns * 2;
    for (let c = 0; c < 3; c++) for (let e = 0; e < ne; e++) ep[e * 4 + c] = r.get(cb);
    for (let e = 0; e < ne; e++) ep[e * 4 + 3] = ab ? r.get(ab) : 255;
    let cbits = cb, abits = ab;
    if (epb) {
      for (let e = 0; e < ne; e++) {
        const p = r.get(1);
        for (let c = 0; c < 3; c++) ep[e * 4 + c] = (ep[e * 4 + c] << 1) | p;
        if (ab) ep[e * 4 + 3] = (ep[e * 4 + 3] << 1) | p;
      }
      cbits++;
      if (ab) abits++;
    } else if (spb) {
      for (let s = 0; s < ns; s++) {
        const p = r.get(1);
        for (const e of [s * 2, s * 2 + 1]) for (let c = 0; c < 3; c++) ep[e * 4 + c] = (ep[e * 4 + c] << 1) | p;
      }
      cbits++;
    }
    // expand to 8 bits
    for (let e = 0; e < ne; e++) {
      for (let c = 0; c < 3; c++) {
        const v = ep[e * 4 + c] << (8 - cbits);
        ep[e * 4 + c] = v | (v >> cbits);
      }
      if (ab) {
        const v = ep[e * 4 + 3] << (8 - abits);
        ep[e * 4 + 3] = v | (v >> abits);
      }
    }
    const idx1 = new Array<number>(16);
    for (let i = 0; i < 16; i++) idx1[i] = r.get(isAnchor(ns, part, i) ? ib - 1 : ib);
    const idx2 = new Array<number>(16);
    if (ib2) for (let i = 0; i < 16; i++) idx2[i] = r.get(i === 0 ? ib2 - 1 : ib2);

    const wc = weights(ib), wa = ib2 ? weights(ib2) : wc;
    for (let i = 0; i < 16; i++) {
      const d = px(i & 3, i >> 2);
      if (d < 0) continue;
      const s = subsetOf(ns, part, i);
      const e0 = s * 8, e1 = s * 8 + 4;
      let cw: number, aw: number;
      if (ib2) {
        cw = idxSel ? wa[idx2[i]] : wc[idx1[i]];
        aw = idxSel ? wc[idx1[i]] : wa[idx2[i]];
      } else {
        cw = aw = wc[idx1[i]];
      }
      let R = (ep[e0] * (64 - cw) + ep[e1] * cw + 32) >> 6;
      let G = (ep[e0 + 1] * (64 - cw) + ep[e1 + 1] * cw + 32) >> 6;
      let B = (ep[e0 + 2] * (64 - cw) + ep[e1 + 2] * cw + 32) >> 6;
      let A = (ep[e0 + 3] * (64 - aw) + ep[e1 + 3] * aw + 32) >> 6;
      if (rot === 1) [R, A] = [A, R];
      else if (rot === 2) [G, A] = [A, G];
      else if (rot === 3) [B, A] = [A, B];
      out[d] = R; out[d + 1] = G; out[d + 2] = B; out[d + 3] = A;
    }
  });
  return out;
}

// ---------------------------------------------------------------- BC6H

// Bit layouts per mode: sequence of [field, bitIndex] in stream order (after
// the mode bits). Fields: rw gw bw rx gx bx ry gy by rz gz bz d (partition).
type Field = "rw" | "gw" | "bw" | "rx" | "gx" | "bx" | "ry" | "gy" | "by" | "rz" | "gz" | "bz" | "d";

/** Expand a compact layout string like "rw9:0 gy4 by3:0" into [field, bit] pairs (LSB-first within a range; "10:15" reads 15 first). */
function layout(spec: string): [Field, number][] {
  const out: [Field, number][] = [];
  for (const tok of spec.trim().split(/\s+/)) {
    const m = /^([a-z]{1,2})(\d+)(?::(\d+))?$/.exec(tok)!;
    const f = m[1] as Field;
    const a = +m[2];
    const b = m[3] === undefined ? a : +m[3];
    // "hi:lo" -> lo..hi ; "lo:hi" (reversed notation) -> hi..lo
    if (a >= b) for (let i = b; i <= a; i++) out.push([f, i]);
    else for (let i = b; i >= a; i--) out.push([f, i]);
  }
  return out;
}

interface Bc6Mode {
  modeBits: number;
  regions: 1 | 2;
  epb: number;
  delta: [number, number, number];
  transformed: boolean;
  bits: [Field, number][];
}

const TWO_TAIL = "d4:0";
const BC6_MODES: Record<number, Bc6Mode> = {
  0x00: { modeBits: 2, regions: 2, epb: 10, delta: [5, 5, 5], transformed: true,
    bits: layout(`gy4 by4 bz4 rw9:0 gw9:0 bw9:0 rx4:0 gz4 gy3:0 gx4:0 bz0 gz3:0 bx4:0 bz1 by3:0 ry4:0 bz2 rz4:0 bz3 ${TWO_TAIL}`) },
  0x01: { modeBits: 2, regions: 2, epb: 7, delta: [6, 6, 6], transformed: true,
    bits: layout(`gy5 gz4 gz5 rw6:0 bz0 bz1 by4 gw6:0 by5 bz2 gy4 bw6:0 bz3 bz5 bz4 rx5:0 gy3:0 gx5:0 gz3:0 bx5:0 by3:0 ry5:0 rz5:0 ${TWO_TAIL}`) },
  0x02: { modeBits: 5, regions: 2, epb: 11, delta: [5, 4, 4], transformed: true,
    bits: layout(`rw9:0 gw9:0 bw9:0 rx4:0 rw10 gy3:0 gx3:0 gw10 bz0 gz3:0 bx3:0 bw10 bz1 by3:0 ry4:0 bz2 rz4:0 bz3 ${TWO_TAIL}`) },
  0x06: { modeBits: 5, regions: 2, epb: 11, delta: [4, 5, 4], transformed: true,
    bits: layout(`rw9:0 gw9:0 bw9:0 rx3:0 rw10 gz4 gy3:0 gx4:0 gw10 gz3:0 bx3:0 bw10 bz1 by3:0 ry3:0 bz0 bz2 rz3:0 gy4 bz3 ${TWO_TAIL}`) },
  0x0a: { modeBits: 5, regions: 2, epb: 11, delta: [4, 4, 5], transformed: true,
    bits: layout(`rw9:0 gw9:0 bw9:0 rx3:0 rw10 by4 gy3:0 gx3:0 gw10 bz0 gz3:0 bx4:0 bw10 by3:0 ry3:0 bz1 bz2 rz3:0 bz4 bz3 ${TWO_TAIL}`) },
  0x0e: { modeBits: 5, regions: 2, epb: 9, delta: [5, 5, 5], transformed: true,
    bits: layout(`rw8:0 by4 gw8:0 gy4 bw8:0 bz4 rx4:0 gz4 gy3:0 gx4:0 bz0 gz3:0 bx4:0 bz1 by3:0 ry4:0 bz2 rz4:0 bz3 ${TWO_TAIL}`) },
  0x12: { modeBits: 5, regions: 2, epb: 8, delta: [6, 5, 5], transformed: true,
    bits: layout(`rw7:0 gz4 by4 gw7:0 bz2 gy4 bw7:0 bz3 bz4 rx5:0 gy3:0 gx4:0 bz0 gz3:0 bx4:0 bz1 by3:0 ry5:0 rz5:0 ${TWO_TAIL}`) },
  0x16: { modeBits: 5, regions: 2, epb: 8, delta: [5, 6, 5], transformed: true,
    bits: layout(`rw7:0 bz0 by4 gw7:0 gy5 gy4 bw7:0 gz5 bz4 rx4:0 gz4 gy3:0 gx5:0 gz3:0 bx4:0 bz1 by3:0 ry4:0 bz2 rz4:0 bz3 ${TWO_TAIL}`) },
  0x1a: { modeBits: 5, regions: 2, epb: 8, delta: [5, 5, 6], transformed: true,
    bits: layout(`rw7:0 bz1 by4 gw7:0 by5 gy4 bw7:0 bz5 bz4 rx4:0 gz4 gy3:0 gx4:0 bz0 gz3:0 bx5:0 by3:0 ry4:0 bz2 rz4:0 bz3 ${TWO_TAIL}`) },
  0x1e: { modeBits: 5, regions: 2, epb: 6, delta: [6, 6, 6], transformed: false,
    bits: layout(`rw5:0 gz4 bz0 bz1 by4 gw5:0 gy5 by5 bz2 gy4 bw5:0 gz5 bz3 bz5 bz4 rx5:0 gy3:0 gx5:0 gz3:0 bx5:0 by3:0 ry5:0 rz5:0 ${TWO_TAIL}`) },
  0x03: { modeBits: 5, regions: 1, epb: 10, delta: [10, 10, 10], transformed: false,
    bits: layout("rw9:0 gw9:0 bw9:0 rx9:0 gx9:0 bx9:0") },
  0x07: { modeBits: 5, regions: 1, epb: 11, delta: [9, 9, 9], transformed: true,
    bits: layout("rw9:0 gw9:0 bw9:0 rx8:0 rw10 gx8:0 gw10 bx8:0 bw10") },
  0x0b: { modeBits: 5, regions: 1, epb: 12, delta: [8, 8, 8], transformed: true,
    bits: layout("rw9:0 gw9:0 bw9:0 rx7:0 rw10:11 gx7:0 gw10:11 bx7:0 bw10:11") },
  0x0f: { modeBits: 5, regions: 1, epb: 16, delta: [4, 4, 4], transformed: true,
    bits: layout("rw9:0 gw9:0 bw9:0 rx3:0 rw10:15 gx3:0 gw10:15 bx3:0 bw10:15") },
};

function signExtend(v: number, bits: number): number {
  const s = 32 - bits;
  return (v << s) >> s;
}

function unquantize(v: number, epb: number, signed: boolean): number {
  if (!signed) {
    if (epb >= 15) return v;
    if (v === 0) return 0;
    if (v === (1 << epb) - 1) return 0xffff;
    return ((v << 16) + 0x8000) >> epb;
  }
  if (epb >= 16) return v;
  let s = false;
  if (v < 0) { s = true; v = -v; }
  let q: number;
  if (v === 0) q = 0;
  else if (v >= (1 << (epb - 1)) - 1) q = 0x7fff;
  else q = ((v << 15) + 0x4000) >> (epb - 1);
  return s ? -q : q;
}

const HALF = new Float32Array(65536);
{
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    HALF[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
}
export function halfToFloat(h: number): number {
  return HALF[h & 0xffff];
}

export function decodeBC6H(src: Uint8Array, w: number, h: number, signed = false): Float32Array {
  const out = new Float32Array(w * h * 4);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const f: Record<Field, number> = { rw: 0, gw: 0, bw: 0, rx: 0, gx: 0, bx: 0, ry: 0, gy: 0, by: 0, rz: 0, gz: 0, bz: 0, d: 0 };
  let b = 0;
  for (let byi = 0; byi < bh; byi++) {
    for (let bxi = 0; bxi < bw; bxi++, b++) {
      const o = b * 16;
      const r = new Bits(src, o);
      let m = r.get(2);
      if (m > 1) m |= r.get(3) << 2;
      const mode = BC6_MODES[m];
      const px = (i: number) => {
        const X = bxi * 4 + (i & 3), Y = byi * 4 + (i >> 2);
        return X < w && Y < h ? (Y * w + X) * 4 : -1;
      };
      if (!mode) {
        for (let i = 0; i < 16; i++) {
          const d = px(i);
          if (d >= 0) { out[d] = out[d + 1] = out[d + 2] = 0; out[d + 3] = 1; }
        }
        continue;
      }
      for (const k in f) f[k as Field] = 0;
      for (const [field, bit] of mode.bits) f[field] |= r.get(1) << bit;

      const { epb, delta, transformed, regions } = mode;
      // endpoints: [w, x, y, z] per channel
      const chans: [Field, Field, Field, Field][] = [["rw", "rx", "ry", "rz"], ["gw", "gx", "gy", "gz"], ["bw", "bx", "by", "bz"]];
      const ep: number[][] = [[], [], [], []]; // ep[endpoint][channel]
      for (let c = 0; c < 3; c++) {
        const [fw, fx, fy, fz] = chans[c];
        let W = f[fw], X = f[fx], Y = f[fy], Z = f[fz];
        if (signed) W = signExtend(W, epb);
        if (transformed || signed) {
          const db = delta[c];
          X = signExtend(X, transformed ? db : epb);
          if (regions === 2) { Y = signExtend(Y, transformed ? db : epb); Z = signExtend(Z, transformed ? db : epb); }
        }
        if (transformed) {
          const mask = (1 << epb) - 1;
          X = (W + X) & mask;
          if (regions === 2) { Y = (W + Y) & mask; Z = (W + Z) & mask; }
          if (signed) {
            X = signExtend(X, epb);
            if (regions === 2) { Y = signExtend(Y, epb); Z = signExtend(Z, epb); }
          }
        }
        ep[0][c] = unquantize(W, epb, signed);
        ep[1][c] = unquantize(X, epb, signed);
        ep[2][c] = unquantize(Y, epb, signed);
        ep[3][c] = unquantize(Z, epb, signed);
      }

      const ib = regions === 2 ? 3 : 4;
      const wt = regions === 2 ? W3 : W4;
      const part = f.d;
      for (let i = 0; i < 16; i++) {
        const anchor = i === 0 || (regions === 2 && i === A2[part]);
        const idx = r.get(anchor ? ib - 1 : ib);
        const d = px(i);
        if (d < 0) continue;
        const s = regions === 2 ? P2.charCodeAt(part * 16 + i) - 48 : 0;
        const e0 = ep[s * 2], e1 = ep[s * 2 + 1];
        const wgt = wt[idx];
        for (let c = 0; c < 3; c++) {
          const v = (e0[c] * (64 - wgt) + e1[c] * wgt + 32) >> 6;
          let hbits: number;
          if (!signed) hbits = (v * 31) >> 6;
          else hbits = v < 0 ? ((-v * 31) >> 5) | 0x8000 : (v * 31) >> 5;
          out[d + c] = HALF[hbits & 0xffff];
        }
        out[d + 3] = 1;
      }
    }
  }
  return out;
}
