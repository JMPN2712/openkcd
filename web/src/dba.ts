// CryEngine animation databases (.dba): many clips sharing one pool of
// tracks, in a single Controller chunk (0x100d v0x905). This is where KCD
// keeps gameplay animation (locomotion, idles, combat).
//
// Layout (verified on 122 databases, scripts/test-dba.ts; docs/ANIMATION.md):
//   u32 numPosTracks, numRotTracks, numTimeTracks, numAnims
//   u16 timeLen[numTime]; u32 timeFormatCounts[7]
//   u16 posLen[numPos];   u32 posFormatCounts[9]
//   u16 rotLen[numRot];   u32 rotFormatCounts[9]
//     tracks of each kind are ordered by format: the first count[0] use
//     format 0, the next count[1] format 1, …
//   i32 offsets[numTime + numPos + numRot + 1]: track starts relative to the
//     END of the chunk (tracks are laid out backwards, each padded to 4);
//     the extra last entry is the start of the whole track region
//   u32, zero padding
//   animation headers, back to back: u16 nameLen, name, MotionParams905
//     (132 bytes), u16 (0), u16 numControllers, u32 recordsOffset (from the
//     first header)
//   controller records, 20 bytes: u32 controllerId, i32 posTimeTrack,
//     i32 posTrack, i32 rotTimeTrack, i32 rotTrack (-1 = none)
// Key-time format 6 is a bitset: u16 start, end, keyCount, then one bit per
// frame from start (LSB first); its "length" counts u16 words.

import { readMotion, readRotation, ROT_SIZE, type Clip, type Motion, type Quat, type Track, type Vec3 } from "./anim.ts";

const POS_SIZE: Record<number, number> = { 0: 12, 2: 12 };
const TIME_UNIT: Record<number, number> = { 0: 4, 1: 2, 2: 1, 6: 2 };

export interface DbaAnim {
  name: string;
  start: number;
  end: number;
  fps: number;
  motion: Motion;
  records: { controllerId: number; posTime: number; pos: number; rotTime: number; rot: number }[];
}

interface TrackRef {
  format: number;
  len: number;
  offset: number; // absolute byte offset
}

export class Dba {
  readonly anims: DbaAnim[] = [];
  private dv: DataView;
  private times: TrackRef[] = [];
  private pos: TrackRef[] = [];
  private rot: TrackRef[] = [];
  private timeCache = new Map<number, Float32Array>();

  constructor(bytes: Uint8Array) {
    const dv = (this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== "CrCh" || dv.getUint32(4, true) !== 0x746) throw new Error("not a CryEngine 0x746 chunk file");
    const n = dv.getUint32(8, true);
    const table = dv.getUint32(12, true);
    let chunk: { offset: number; size: number } | null = null;
    for (let i = 0; i < n; i++) {
      const e = table + i * 16;
      if (dv.getUint16(e, true) === 0x100d) {
        const v = dv.getUint16(e + 2, true);
        if (v !== 0x905) throw new Error(`controller chunk version ${v.toString(16)} is not a 0x905 database`);
        chunk = { size: dv.getUint32(e + 8, true), offset: dv.getUint32(e + 12, true) };
        break;
      }
    }
    if (!chunk) throw new Error("no controller chunk");
    const o = chunk.offset;
    const end = o + chunk.size;
    const nPos = dv.getUint32(o, true), nRot = dv.getUint32(o + 4, true), nTime = dv.getUint32(o + 8, true), nAnims = dv.getUint32(o + 12, true);
    let p = o + 16;
    const u16s = (count: number) => { const a = Array.from({ length: count }, (_, i) => dv.getUint16(p + i * 2, true)); p += count * 2; return a; };
    const u32s = (count: number) => { const a = Array.from({ length: count }, (_, i) => dv.getUint32(p + i * 4, true)); p += count * 4; return a; };
    const timeLen = u16s(nTime), timeFmt = u32s(7);
    const posLen = u16s(nPos), posFmt = u32s(9);
    const rotLen = u16s(nRot), rotFmt = u32s(9);
    const formats = (counts: number[]) => counts.flatMap((c, f) => Array<number>(c).fill(f));
    const tf = formats(timeFmt), pf = formats(posFmt), rf = formats(rotFmt);
    if (tf.length !== nTime || pf.length !== nPos || rf.length !== nRot) throw new Error("format counts don't match track counts");
    const offsets = Array.from({ length: nTime + nPos + nRot + 1 }, (_, i) => dv.getInt32(p + i * 4, true));
    p += offsets.length * 4 + 4;
    this.times = timeLen.map((len, i) => ({ format: tf[i], len, offset: end + offsets[i] }));
    this.pos = posLen.map((len, i) => ({ format: pf[i], len, offset: end + offsets[nTime + i] }));
    this.rot = rotLen.map((len, i) => ({ format: rf[i], len, offset: end + offsets[nTime + nPos + i] }));

    while (p < end && dv.getUint8(p) === 0) p++;
    const base = p;
    const latin1 = new TextDecoder("latin1");
    for (let a = 0; a < nAnims; a++) {
      const nameLen = dv.getUint16(p, true);
      const name = latin1.decode(bytes.subarray(p + 2, p + 2 + nameLen)).replaceAll("\\", "/").toLowerCase();
      p += 2 + nameLen;
      const ticksPerFrame = dv.getInt32(p + 8, true);
      const secsPerTick = dv.getFloat32(p + 12, true);
      const start = dv.getInt32(p + 16, true);
      const stop = dv.getInt32(p + 20, true);
      const motion = readMotion(dv, p);
      p += 132;
      const nCtl = dv.getUint16(p + 2, true);
      const recOff = dv.getUint32(p + 4, true);
      p += 8;
      const records: DbaAnim["records"] = [];
      for (let k = 0; k < nCtl; k++) {
        const r = base + recOff + k * 20;
        records.push({
          controllerId: dv.getUint32(r, true),
          posTime: dv.getInt32(r + 4, true),
          pos: dv.getInt32(r + 8, true),
          rotTime: dv.getInt32(r + 12, true),
          rot: dv.getInt32(r + 16, true),
        });
      }
      const fps = ticksPerFrame > 0 && secsPerTick > 0 ? Math.round(1 / (ticksPerFrame * secsPerTick)) : 30;
      this.anims.push({ name, start, end: stop, fps, motion, records });
    }
  }

  private keyTimes(i: number): Float32Array {
    let t = this.timeCache.get(i);
    if (t) return t;
    const { format, len, offset } = this.times[i];
    const dv = this.dv;
    if (format === 6) {
      const start = dv.getUint16(offset, true);
      const count = dv.getUint16(offset + 4, true);
      t = new Float32Array(count);
      let k = 0;
      for (let w = 3; w < len && k < count; w++) {
        const word = dv.getUint16(offset + w * 2, true);
        for (let bit = 0; bit < 16 && k < count; bit++) if (word & (1 << bit)) t[k++] = start + (w - 3) * 16 + bit;
      }
    } else {
      if (!TIME_UNIT[format]) throw new Error(`key time format ${format} not supported`);
      t = new Float32Array(len);
      for (let k = 0; k < len; k++) {
        t[k] = format === 0 ? dv.getFloat32(offset + k * 4, true) : format === 1 ? dv.getUint16(offset + k * 2, true) : dv.getUint8(offset + k);
      }
    }
    this.timeCache.set(i, t);
    return t;
  }

  private positions(i: number): Vec3[] {
    const { format, len, offset } = this.pos[i];
    if (!POS_SIZE[format]) throw new Error(`position format ${format} not supported`);
    return Array.from({ length: len }, (_, k): Vec3 => {
      const o = offset + k * 12;
      return [this.dv.getFloat32(o, true), this.dv.getFloat32(o + 4, true), this.dv.getFloat32(o + 8, true)];
    });
  }

  private rotations(i: number): Quat[] {
    const { format, len, offset } = this.rot[i];
    const size = ROT_SIZE[format];
    if (!size) throw new Error(`rotation format ${format} not supported`);
    return Array.from({ length: len }, (_, k) => readRotation(this.dv, offset + k * size, format));
  }

  /** Decode one animation into a Clip (only the tracks it references). */
  clip(name: string): Clip {
    const a = this.anims.find((x) => x.name === name.toLowerCase());
    if (!a) throw new Error(`${name} is not in this database`);
    const tracks = new Map<number, Track>();
    for (const r of a.records) {
      const empty = new Float32Array(0);
      tracks.set(r.controllerId, {
        controllerId: r.controllerId,
        rotTimes: r.rot >= 0 ? this.keyTimes(r.rotTime) : empty,
        rotations: r.rot >= 0 ? this.rotations(r.rot) : [],
        posTimes: r.pos >= 0 ? this.keyTimes(r.posTime) : empty,
        positions: r.pos >= 0 ? this.positions(r.pos) : [],
      });
    }
    return { tracks, start: a.start, end: a.end, fps: a.fps, motion: a.motion };
  }
}

