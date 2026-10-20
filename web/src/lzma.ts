// LZMA (LZMA1) decoder, after the public-domain LZMA specification in the
// LZMA SDK. Buffer to buffer: it decodes Inno Setup's setup headers, which
// are a few MB at most. Bulk game data in GOG installers is zlib, which the
// browser inflates natively.

const PROB_INIT = 1024;
const TOP = 1 << 24;

class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  pos: number;
  private readonly src: Uint8Array;

  constructor(src: Uint8Array, start: number) {
    this.src = src;
    if (src[start] !== 0) throw new Error("LZMA: bad range coder start");
    this.pos = start + 1;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.next()) >>> 0;
    if (this.code === this.range) throw new Error("LZMA: corrupt stream");
  }

  // Inno's streams end without an end marker; past the input, feed zeros.
  private next(): number {
    return this.pos < this.src.length ? this.src[this.pos++] : (this.pos++, 0);
  }

  get overrun(): boolean {
    return this.pos > this.src.length + 4;
  }

  bit(probs: Uint16Array, i: number): number {
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
      b = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probs[i] = p - (p >>> 5);
      b = 1;
    }
    if (this.range < TOP) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.next()) >>> 0;
    }
    return b;
  }

  direct(count: number): number {
    let res = 0;
    for (; count > 0; count--) {
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      res = ((res << 1) | b) >>> 0;
      if (this.range < TOP) {
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | this.next()) >>> 0;
      }
    }
    return res;
  }
}

function bitTree(rc: RangeDecoder, probs: Uint16Array, base: number, bits: number): number {
  let m = 1;
  for (let i = 0; i < bits; i++) m = (m << 1) | rc.bit(probs, base + m);
  return m - (1 << bits);
}

function bitTreeReverse(rc: RangeDecoder, probs: Uint16Array, base: number, bits: number): number {
  let m = 1;
  let sym = 0;
  for (let i = 0; i < bits; i++) {
    const b = rc.bit(probs, base + m);
    m = (m << 1) | b;
    sym |= b << i;
  }
  return sym;
}

class LenDecoder {
  private choice = new Uint16Array(2).fill(PROB_INIT);
  private low = new Uint16Array(16 << 3).fill(PROB_INIT);
  private mid = new Uint16Array(16 << 3).fill(PROB_INIT);
  private high = new Uint16Array(256).fill(PROB_INIT);

  decode(rc: RangeDecoder, posState: number): number {
    if (rc.bit(this.choice, 0) === 0) return bitTree(rc, this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + bitTree(rc, this.mid, posState << 3, 3);
    return 16 + bitTree(rc, this.high, 0, 8);
  }
}

/**
 * Decode a raw LZMA stream: `props` is the 5-byte header (lc/lp/pb byte, then
 * the dictionary size), `src` the compressed bytes after it. Stops at the end
 * marker, at `outSize` bytes if given, or when the input runs out.
 */
export function lzmaDecode(props: Uint8Array, src: Uint8Array, outSize?: number): Uint8Array {
  let d = props[0];
  if (d >= 9 * 5 * 5) throw new Error("LZMA: bad properties");
  const lc = d % 9;
  d = (d / 9) | 0;
  const lp = d % 5;
  const pb = (d / 5) | 0;

  let out = new Uint8Array(outSize ?? Math.max(1 << 16, src.length * 4));
  let n = 0;
  const grow = (need: number) => {
    if (need <= out.length) return;
    const bigger = new Uint8Array(Math.max(need, out.length * 2));
    bigger.set(out.subarray(0, n));
    out = bigger;
  };

  const rc = new RangeDecoder(src, 0);
  const literal = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT);
  const isMatch = new Uint16Array(12 << 4).fill(PROB_INIT);
  const isRep = new Uint16Array(12).fill(PROB_INIT);
  const isRepG0 = new Uint16Array(12).fill(PROB_INIT);
  const isRepG1 = new Uint16Array(12).fill(PROB_INIT);
  const isRepG2 = new Uint16Array(12).fill(PROB_INIT);
  const isRep0Long = new Uint16Array(12 << 4).fill(PROB_INIT);
  const posSlot = new Uint16Array(4 << 6).fill(PROB_INIT);
  const posDecoders = new Uint16Array(115).fill(PROB_INIT); // 1 + kNumFullDistances - kEndPosModelIndex
  const align = new Uint16Array(16).fill(PROB_INIT);
  const lenDec = new LenDecoder();
  const repLenDec = new LenDecoder();

  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  let state = 0;
  let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  const limit = outSize ?? Infinity;

  while (n < limit) {
    if (rc.overrun) break; // input exhausted (no end marker)
    const posState = n & pbMask;
    if (rc.bit(isMatch, (state << 4) + posState) === 0) {
      const prev = n > 0 ? out[n - 1] : 0;
      const base = 0x300 * (((n & lpMask) << lc) + (prev >>> (8 - lc)));
      let sym = 1;
      if (state >= 7) {
        let matchByte = out[n - rep0 - 1];
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const b = rc.bit(literal, base + ((1 + matchBit) << 8) + sym);
          sym = (sym << 1) | b;
          if (matchBit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | rc.bit(literal, base + sym);
      grow(n + 1);
      out[n++] = sym & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len: number;
    if (rc.bit(isRep, state) !== 0) {
      if (n === 0) throw new Error("LZMA: rep match at start");
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          grow(n + 1);
          out[n] = out[n - rep0 - 1];
          n++;
          continue;
        }
      } else {
        let dist: number;
        if (rc.bit(isRepG1, state) === 0) {
          dist = rep1;
        } else {
          if (rc.bit(isRepG2, state) === 0) {
            dist = rep2;
          } else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDec.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = lenDec.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      const lenState = Math.min(len, 3);
      const slot = bitTree(rc, posSlot, lenState << 6, 6);
      if (slot < 4) {
        rep0 = slot;
      } else {
        const direct = (slot >>> 1) - 1;
        let dist = ((2 | (slot & 1)) << direct) >>> 0;
        if (slot < 14) {
          dist += bitTreeReverse(rc, posDecoders, dist - slot, direct);
        } else {
          dist += rc.direct(direct - 4) << 4;
          dist += bitTreeReverse(rc, align, 0, 4);
        }
        rep0 = dist >>> 0;
        if (rep0 === 0xffffffff) break; // end marker
      }
      if (rep0 >= n) throw new Error("LZMA: distance beyond output");
    }

    len += 2;
    grow(n + len);
    const end = Math.min(n + len, limit);
    for (; n < end; n++) out[n] = out[n - rep0 - 1];
  }
  return out.subarray(0, n);
}
