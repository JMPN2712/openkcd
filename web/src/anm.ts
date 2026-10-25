// .anm: animations of a .cga's nodes (chest lids), in CryTek's older chunk format:
//
//   "CryTek\0\0", u32 file type, u32 version, u32 chunk-table offset
//   table: u32 count, then per chunk u32 type, version, offset, id, size
//
// Chunks used (each starts with a 16-byte copy of its type, version, offset and id):
//   0xCCCC000B node: name[64], object id, parent id, children, material id, 2 bytes + padding,
//              tm f32[16], pos f32[3], rot f32[4], scale f32[3], then the position, rotation and
//              scale controller ids (−1 none), and a property string;
//   0xCCCC000D controller (v0x826): u32 type, key count, flags, controller id, then the keys. Type
//              10 is TCB rotation: 40-byte keys of i32 time, axis xyz + angle (radians), and
//              tension, continuity, bias, ease in, ease out.
//
// Rotation keys are relative, as 3ds Max exports TCB rotations: each turns on from the one before,
// by Max's left-hand rule (checked: with it the chests' lids rise).
// Times are Max ticks (4,800 a second). The chests' lids turn 10–20° about their x axis over
// 0.83–1 s; some open and close files go up and back down (chest02).

export interface AnmNode {
  name: string;
  /** cumulative rotation at each key: time (s) and angle (rad) about `axis` (node space) */
  keys: { time: number; angle: number }[];
  axis: [number, number, number];
}

const TICKS_PER_SECOND = 4800;

export function parseAnm(bytes: Uint8Array): AnmNode[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, 6)) !== "CryTek") throw new Error("not a CryTek chunk file");
  const table = dv.getUint32(16, true);
  const count = dv.getUint32(table, true);
  const chunks = new Map<number, { type: number; offset: number }>();
  for (let i = 0; i < count; i++) {
    const o = table + 4 + i * 20;
    chunks.set(dv.getInt32(o + 12, true), { type: dv.getUint32(o, true), offset: dv.getUint32(o + 8, true) });
  }
  const out: AnmNode[] = [];
  for (const c of chunks.values()) {
    if (c.type !== 0xcccc000b) continue;
    const o = c.offset + 16;
    const name = new TextDecoder().decode(bytes.subarray(o, o + 64)).split("\0")[0];
    // controller ids follow name, 4 ints, 4 bytes, tm, pos, rot, scale
    const rotCtrl = dv.getInt32(o + 64 + 16 + 4 + 64 + 12 + 16 + 12 + 4, true);
    const ctrl = chunks.get(rotCtrl);
    if (!ctrl || ctrl.type !== 0xcccc000d) continue;
    const k0 = ctrl.offset + 16;
    if (dv.getUint32(k0, true) !== 10) continue; // TCB rotation only
    const n = dv.getUint32(k0 + 4, true);
    const keys: AnmNode["keys"] = [];
    let axis: [number, number, number] = [1, 0, 0];
    let angle = 0;
    for (let k = 0; k < n; k++) {
      const p = k0 + 16 + k * 40;
      const ax: [number, number, number] = [dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true)];
      const a = dv.getFloat32(p + 16, true);
      // keep one axis: later keys along it or against it (chest lids turn about a single axis)
      if (k === 0) axis = ax;
      const along = ax[0] * axis[0] + ax[1] * axis[1] + ax[2] * axis[2];
      // (3ds Max turns by the left-hand rule about the axis: as a right-handed angle, negated)
      angle -= along < 0 ? -a : a;
      keys.push({ time: dv.getInt32(p, true) / TICKS_PER_SECOND, angle });
    }
    out.push({ name, keys, axis });
  }
  return out;
}

/**
 * A node's opening as one swing: from its first key to its widest one (the opening of an open file
 * that goes up and back down). Returns the duration and the angle at time t (eased between keys).
 */
export function swing(node: AnmNode): { duration: number; at: (t: number) => number } {
  let widest = 0;
  node.keys.forEach((k, i) => { if (Math.abs(k.angle) > Math.abs(node.keys[widest].angle)) widest = i; });
  const keys = node.keys.slice(0, widest + 1);
  const t0 = keys[0]?.time ?? 0;
  const duration = Math.max(0, (keys[keys.length - 1]?.time ?? 0) - t0);
  return {
    duration,
    at: (t) => {
      const time = t0 + Math.max(0, Math.min(duration, t));
      let i = 1;
      while (i < keys.length - 1 && keys[i].time < time) i++;
      const a = keys[i - 1] ?? keys[0], b = keys[i] ?? a;
      if (!b || b.time <= a.time) return b?.angle ?? 0;
      const u = (time - a.time) / (b.time - a.time), e = u * u * (3 - 2 * u);
      return a.angle + (b.angle - a.angle) * e;
    },
  };
}
