// CryEngine .caf animation clips: per-bone controllers (chunk 0x100d v0x829).
//
// Layout, verified against the KCD install (scripts/test-anim.ts):
//   header (16 bytes, 14 used + 2 padding): u32 controllerId, u16 numRotationKeys,
//     u16 numPositionKeys, u8 rotationFormat, u8 rotationTimeFormat,
//     u8 positionFormat, u8 positionKeysInfo, u8 positionTimeFormat, u8 tracksAligned
//   rotation keys, rotation key times, position keys, position key times
//   (each block padded to 4 bytes except the last; position times only when positionKeysInfo == 1,
//   otherwise positions share the rotation times).
// The controller id is the bone's controllerId from the CompiledBones chunk.
//
// Quaternion encodings ("smallest three"): the 2 top bits index the dropped
// largest component, the others are stored LSB-first into slots x,y,z,w in
// ascending order, each mapped from [0, 2^bits-1] to ±1/√2.
//   5 = SmallTree48Bit:     3 × 15 bits
//   8 = SmallTree64BitExt:  21 + 21 + 20 bits
// Chosen by smoothness of consecutive keys over ~1.1M real keys (docs/ANIMATION.md).

export const CHUNK_ANIM = {
  Controller: 0x100d,
  MotionParameters: 0x3002,
} as const;

export type Quat = [number, number, number, number]; // x, y, z, w
export type Vec3 = [number, number, number];

export interface Track {
  controllerId: number;
  rotTimes: Float32Array;
  rotations: Quat[];
  posTimes: Float32Array;
  positions: Vec3[];
}

export interface Clip {
  tracks: Map<number, Track>;
  /** first and last key frame over all tracks */
  start: number;
  end: number;
  /** frames per second (from MotionParameters when present, else 30) */
  fps: number;
  /** root (locator) motion over one cycle, from MotionParameters */
  motion?: Motion;
}

/** MotionParams905 bytes 24–99: the locator's movement over the clip (docs/ANIMATION.md). */
export interface Motion {
  /** metres per second (distance ÷ duration) */
  moveSpeed: number;
  distance: number;
  /** locator offset over one cycle in the character frame (x right, y forward, z up) */
  travel: Vec3;
  /** locator yaw over one cycle, radians (positive = to the left) */
  turn: number;
}

const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const qrot = (q: Quat, v: Vec3): Vec3 => {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
};

/**
 * Read the motion fields of a MotionParams905 block starting at `o`. The start and end
 * locations (quaternion x, y, z, w then position, at 44 and 72) are in the exporter's Y-up
 * frame: the start rotation maps it to the character's (walk_medium ends at z = 3.03 with
 * a 180° start rotation about (0, 1, 1)/√2), so the end is taken relative to the start.
 */
export function readMotion(dv: DataView, o: number): Motion {
  const f = (k: number) => dv.getFloat32(o + k, true);
  const q0: Quat = [f(44), f(48), f(52), f(56)], q1: Quat = [f(72), f(76), f(80), f(84)];
  const d: Vec3 = [f(88) - f(60), f(92) - f(64), f(96) - f(68)];
  const travel = qrot(qconj(q0), d);
  const rel = qmul(qconj(q0), q1);
  // yaw of the relative rotation: where it takes the forward axis (+Y)
  const fwd = qrot(rel, [0, 1, 0]);
  return { moveSpeed: f(24), distance: f(36), travel, turn: Math.atan2(-fwd[0], fwd[1]) };
}

export const ROT_SIZE: Record<number, number> = { 0: 16, 1: 16, 5: 6, 8: 8 };
const POS_SIZE: Record<number, number> = { 0: 12, 2: 12 };
const TIME_SIZE: Record<number, number> = { 0: 4, 1: 2, 2: 1 };

const INV_SQRT2 = Math.SQRT1_2;

/** Read `width` (<= 21) bits at `pos` from a 64-bit value held as two 32-bit halves. */
function bits(lo: number, hi: number, pos: number, width: number): number {
  const mask = (1 << width) - 1;
  if (pos >= 32) return (hi >>> (pos - 32)) & mask;
  if (pos + width <= 32) return (lo >>> pos) & mask;
  return ((lo >>> pos) | (hi << (32 - pos))) & mask;
}

function smallestThree(lo: number, hi: number, totalBits: number, widths: number[]): Quat {
  const idx = bits(lo, hi, totalBits - 2, 2);
  const q: Quat = [0, 0, 0, 0];
  let s = 0;
  let slot = 0;
  let pos = 0;
  for (const w of widths) {
    if (slot === idx) slot++;
    const half = ((1 << w) - 1) / 2;
    const c = ((bits(lo, hi, pos, w) - half) / half) * INV_SQRT2;
    pos += w;
    q[slot++] = c;
    s += c * c;
  }
  q[idx] = Math.sqrt(Math.max(0, 1 - s));
  return q;
}

export function readRotation(dv: DataView, o: number, fmt: number): Quat {
  switch (fmt) {
    case 0:
    case 1:
      return [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)];
    case 5: {
      const lo = dv.getUint16(o, true) | (dv.getUint16(o + 2, true) << 16);
      const hi = dv.getUint16(o + 4, true);
      return smallestThree(lo, hi, 48, [15, 15, 15]);
    }
    case 8:
      return smallestThree(dv.getUint32(o, true), dv.getUint32(o + 4, true), 64, [21, 21, 20]);
    default:
      throw new Error(`rotation format ${fmt} not supported`);
  }
}

function readTimes(dv: DataView, o: number, fmt: number, n: number): Float32Array {
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = fmt === 0 ? dv.getFloat32(o + i * 4, true) : fmt === 1 ? dv.getUint16(o + i * 2, true) : dv.getUint8(o + i);
  }
  return t;
}

const align4 = (n: number) => (n + 3) & ~3;

/** Parse one 0x829 controller chunk. Throws if the blocks don't add up to the chunk size. */
export function parseController829(dv: DataView, offset: number, size: number): Track {
  const controllerId = dv.getUint32(offset, true);
  const nRot = dv.getUint16(offset + 4, true);
  const nPos = dv.getUint16(offset + 6, true);
  const rotFmt = dv.getUint8(offset + 8);
  const rotTimeFmt = dv.getUint8(offset + 9);
  const posFmt = dv.getUint8(offset + 10);
  const posKeysInfo = dv.getUint8(offset + 11);
  const posTimeFmt = dv.getUint8(offset + 12);
  let o = offset + 16;
  let end = o; // end of the last block, before its padding
  const rotations: Quat[] = [];
  let rotTimes: Float32Array = new Float32Array(0);
  if (nRot) {
    const rs = ROT_SIZE[rotFmt];
    const ts = TIME_SIZE[rotTimeFmt];
    if (!rs) throw new Error(`rotation format ${rotFmt} not supported`);
    if (!ts) throw new Error(`key time format ${rotTimeFmt} not supported`);
    for (let i = 0; i < nRot; i++) rotations.push(readRotation(dv, o + i * rs, rotFmt));
    o += align4(nRot * rs);
    rotTimes = readTimes(dv, o, rotTimeFmt, nRot);
    end = o + nRot * ts;
    o += align4(nRot * ts);
  }
  const positions: Vec3[] = [];
  let posTimes = rotTimes;
  if (nPos) {
    const ps = POS_SIZE[posFmt];
    if (!ps) throw new Error(`position format ${posFmt} not supported`);
    for (let i = 0; i < nPos; i++) {
      const p = o + i * ps;
      positions.push([dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)]);
    }
    end = o + nPos * ps;
    o += align4(nPos * ps);
    if (posKeysInfo === 1) {
      const ts = TIME_SIZE[posTimeFmt];
      if (!ts) throw new Error(`key time format ${posTimeFmt} not supported`);
      posTimes = readTimes(dv, o, posTimeFmt, nPos);
      end = o + nPos * ts;
      o += align4(nPos * ts);
    } else if (posTimes.length !== nPos) {
      throw new Error(`positions share rotation times but counts differ (${nPos} vs ${posTimes.length})`);
    }
  }
  if (size !== end - offset && size !== o - offset) throw new Error(`controller ${controllerId >>> 0}: parsed ${end - offset} bytes, chunk is ${size}`);
  return { controllerId: controllerId >>> 0, rotTimes, rotations, posTimes, positions };
}

/** Parse a .caf clip. */
export function parseCaf(bytes: Uint8Array): Clip {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "CrCh" || dv.getUint32(4, true) !== 0x746) throw new Error("not a CryEngine 0x746 chunk file");
  const n = dv.getUint32(8, true);
  const table = dv.getUint32(12, true);
  const tracks = new Map<number, Track>();
  let start = Infinity;
  let end = -Infinity;
  let fps = 30;
  let motion: Motion | undefined;
  for (let i = 0; i < n; i++) {
    const e = table + i * 16;
    const type = dv.getUint16(e, true);
    const version = dv.getUint16(e + 2, true);
    const size = dv.getUint32(e + 8, true);
    const off = dv.getUint32(e + 12, true);
    if (type === CHUNK_ANIM.Controller) {
      if (version !== 0x829) throw new Error(`controller chunk version ${version.toString(16)} not supported`);
      const t = parseController829(dv, off, size);
      tracks.set(t.controllerId, t);
      for (const times of [t.rotTimes, t.posTimes]) {
        if (times.length) {
          start = Math.min(start, times[0]);
          end = Math.max(end, times[times.length - 1]);
        }
      }
    } else if (type === CHUNK_ANIM.MotionParameters && version === 0x925) {
      // MotionParams905: flags, compression, ticksPerFrame, secsPerTick, …
      const ticksPerFrame = dv.getInt32(off + 8, true);
      const secsPerTick = dv.getFloat32(off + 12, true);
      if (ticksPerFrame > 0 && secsPerTick > 0) fps = Math.round(1 / (ticksPerFrame * secsPerTick));
      motion = readMotion(dv, off);
    }
  }
  if (start === Infinity) { start = 0; end = 0; }
  return { tracks, start, end, fps, motion };
}
