// Occlusion culling of world instances (interiors behind house walls, objects behind buildings),
// from the research note interiors-visibility.md: the level's occluder mesh (`occluder.ocm`,
// simple double-sided building shells that keep doorways open) is rasterised near the camera
// into a small CPU depth buffer (128 × 64, as wide as the original's), and each instance's bounding sphere
// is tested against it. Reprojecting the previous frame's depth into the same buffer (the
// original's other source) is not done yet.

/** The level's occluder shells, in world space: one triangle list (x, y, z) per instance. */
export interface Occluders {
  tris: Float32Array[];
  /** per instance: world-space bounding box centre and half size */
  centre: Float32Array;
  half: Float32Array;
  triangles: number;
}

/** Parse `occluder.ocm` (version −6, research note §4.1). */
export function parseOccluders(bytes: Uint8Array): Occluders {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getInt32(0, false);
  if (version !== -6) throw new Error(`occluder.ocm version ${version} not supported`);
  const shapeCount = dv.getUint32(4, true), count = dv.getUint32(8, true), table = dv.getUint32(12, true);
  // shapes back to back: u32 vertex count, 12 bytes of padding, then x, y, z, 1 per vertex
  const shapes = new Map<number, Float32Array>();
  let o = 16;
  for (let s = 0; s < shapeCount; s++) {
    const n = dv.getUint32(o, true);
    const v = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) v[i * 3 + k] = dv.getFloat32(o + 16 + i * 16 + k * 4, true);
    shapes.set(o, v);
    o += 16 + 16 * n;
  }
  if (o !== table) throw new Error(`occluder.ocm: shapes end at ${o}, the instance table starts at ${table}`);
  const tris: Float32Array[] = [], centre = new Float32Array(count * 3), half = new Float32Array(count * 3);
  let triangles = 0;
  for (let k = 0; k < count; k++) {
    const r = table + k * 64;
    const m = Array.from({ length: 12 }, (_, i) => dv.getFloat32(r + i * 4, true)); // 3×4 row-major
    for (let i = 0; i < 3; i++) { centre[k * 3 + i] = m[i * 4 + 3]; half[k * 3 + i] = dv.getFloat32(r + 48 + i * 4, true); }
    const shape = shapes.get(dv.getUint32(r + 60, true));
    if (!shape) throw new Error(`occluder.ocm: instance ${k} names no shape`);
    const w = new Float32Array(shape.length);
    for (let i = 0; i < shape.length; i += 3) {
      const x = shape[i], y = shape[i + 1], z = shape[i + 2];
      for (let j = 0; j < 3; j++) w[i + j] = m[j * 4] * x + m[j * 4 + 1] * y + m[j * 4 + 2] * z + m[j * 4 + 3];
    }
    tris.push(w);
    triangles += shape.length / 9;
  }
  return { tris, centre, half, triangles };
}

/** Nearer than this (metres along the view axis) nothing occludes and nothing is culled. */
const NEAR = 0.3;
/** Shells whose box, grown by this much, holds the eye are not drawn. */
const EYE_MARGIN = 1;

/** A small depth buffer of the occluders in view, and the test of bounding spheres against it. */
export class CoverageBuffer {
  readonly w: number;
  readonly h: number;
  /** per pixel: 1 / view depth of the nearest occluder (0: none) */
  private depth: Float32Array;
  /** per 8×8 tile: the smallest of its pixels' (the farthest occluder; 0 when a pixel is empty) */
  private tileMin: Float32Array;
  private tw: number;
  private th: number;
  private m = new Float32Array(16);
  private sx = 1;
  private sy = 1;
  /** occluder triangles drawn by the last render() */
  drawn = 0;

  constructor(w = 128, h = 64) {
    this.w = w; this.h = h;
    this.depth = new Float32Array(w * h);
    this.tw = Math.ceil(w / 8); this.th = Math.ceil(h / 8);
    this.tileMin = new Float32Array(this.tw * this.th);
  }

  /**
   * Rasterise the occluders in view within `maxDistance` of the eye whose bounding radius is at
   * least `minSize` of their distance (about 0.3–0.7 ms on an M3 Pro in town; at these defaults
   * renders matched the unculled ones pixel for pixel in six test views).
   */
  render(occ: Occluders, viewProj: Float32Array, eye: ArrayLike<number>, maxDistance = 150, minSize = 0.02): void {
    const m = this.m;
    m.set(viewProj);
    this.sx = Math.hypot(m[0], m[4], m[8]);
    this.sy = Math.hypot(m[1], m[5], m[9]);
    this.depth.fill(0);
    this.drawn = 0;
    const C = occ.centre, Hf = occ.half;
    for (let k = 0; k < occ.tris.length; k++) {
      const cx = C[k * 3], cy = C[k * 3 + 1], cz = C[k * 3 + 2];
      const r = Math.hypot(Hf[k * 3], Hf[k * 3 + 1], Hf[k * 3 + 2]);
      const d = Math.hypot(cx - eye[0], cy - eye[1], cz - eye[2]);
      if (d - r > maxDistance) continue;
      // shells small on screen hide little and cost as much
      if (r < d * minSize) continue;
      // a shell around the eye (standing in a house, a market stall, a 256 m terrain tile) would
      // cover the whole view from inside: left out
      if (Math.abs(eye[0] - cx) < Hf[k * 3] + EYE_MARGIN && Math.abs(eye[1] - cy) < Hf[k * 3 + 1] + EYE_MARGIN && Math.abs(eye[2] - cz) < Hf[k * 3 + 2] + EYE_MARGIN) continue;
      if (!this.sphereInView(cx, cy, cz, r)) continue;
      this.drawTris(occ.tris[k]);
    }
    // the tiles' farthest depth, for testing large boxes a tile at a time
    const W = this.w, D = this.depth;
    for (let ty = 0; ty < this.th; ty++) {
      for (let tx = 0; tx < this.tw; tx++) {
        let mn = Infinity;
        for (let y = ty * 8; y < Math.min(this.h, ty * 8 + 8); y++) for (let x = tx * 8; x < Math.min(W, tx * 8 + 8); x++) mn = Math.min(mn, D[y * W + x]);
        this.tileMin[ty * this.tw + tx] = mn;
      }
    }
  }

  private sphereInView(x: number, y: number, z: number, r: number): boolean {
    const m = this.m;
    // the four side planes of the clip volume (|x| <= w, |y| <= w), unnormalised but with their
    // lengths for the radius
    const cxv = m[0] * x + m[4] * y + m[8] * z + m[12], cyv = m[1] * x + m[5] * y + m[9] * z + m[13], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const lw = Math.hypot(m[3], m[7], m[11]);
    if (cw + r * lw < NEAR) return false;
    if (cxv - cw > r * (this.sx + lw) || -cxv - cw > r * (this.sx + lw)) return false;
    if (cyv - cw > r * (this.sy + lw) || -cyv - cw > r * (this.sy + lw)) return false;
    return true;
  }

  private drawTris(t: Float32Array): void {
    const m = this.m;
    const P = new Float64Array(15); // up to 5 clipped vertices: screen x, y, 1/w
    const v = new Float64Array(9); // clip x, y, w of the triangle's corners
    for (let i = 0; i + 8 < t.length; i += 9) {
      for (let c = 0; c < 3; c++) {
        const x = t[i + c * 3], y = t[i + c * 3 + 1], z = t[i + c * 3 + 2];
        v[c * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        v[c * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        v[c * 3 + 2] = m[3] * x + m[7] * y + m[11] * z + m[15];
      }
      // clip against w >= NEAR (Sutherland–Hodgman, one plane)
      let n = 0;
      for (let c = 0; c < 3; c++) {
        const a = c * 3, b = ((c + 1) % 3) * 3;
        const wa = v[a + 2], wb = v[b + 2];
        if (wa >= NEAR) { this.toScreen(P, n++, v[a], v[a + 1], wa); }
        if ((wa >= NEAR) !== (wb >= NEAR)) {
          const f = (NEAR - wa) / (wb - wa);
          this.toScreen(P, n++, v[a] + (v[b] - v[a]) * f, v[a + 1] + (v[b + 1] - v[a + 1]) * f, NEAR);
        }
      }
      if (n < 3) continue;
      // each face is stored with both windings: draw one of them
      const area = (P[3] - P[0]) * (P[7] - P[1]) - (P[4] - P[1]) * (P[6] - P[0]);
      if (!(area > 0)) continue;
      for (let k = 1; k + 1 < n; k++) this.raster(P, 0, k, k + 1);
      this.drawn++;
    }
  }

  private toScreen(P: Float64Array, k: number, x: number, y: number, w: number): void {
    P[k * 3] = (x / w * 0.5 + 0.5) * this.w;
    P[k * 3 + 1] = (0.5 - y / w * 0.5) * this.h;
    P[k * 3 + 2] = 1 / w;
  }

  /** Fill a screen triangle (pixel centres inside), keeping the nearest 1/w. */
  private raster(P: Float64Array, a: number, b: number, c: number): void {
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) return;
    const sign = area > 0 ? 1 : -1, inv = 1 / area;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(this.w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(this.h - 1, Math.ceil(Math.max(ay, by, cy)));
    const D = this.depth, W = this.w;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const e0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * sign;
        const e1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * sign;
        const e2 = ((ax - px) * (by - py) - (ay - py) * (bx - px)) * sign;
        if (e0 < 0 || e1 < 0 || e2 < 0) continue;
        const z = (e0 * az + e1 * bz + e2 * cz) * inv * sign;
        const i = y * W + x;
        if (z > D[i]) D[i] = z;
      }
    }
  }

  /**
   * Whether a bounding sphere may be visible: false only when every pixel its screen bounds touch
   * holds an occluder nearer than the sphere's nearest point.
   */
  sphereVisible(x: number, y: number, z: number, r: number): boolean {
    const m = this.m;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const near = cw - r;
    if (near < NEAR) return true;
    const far = cw + r;
    const rx = r * this.sx, ry = r * this.sy;
    const nx0 = Math.min((cx - rx) / near, (cx - rx) / far), nx1 = Math.max((cx + rx) / near, (cx + rx) / far);
    const ny0 = Math.min((cy - ry) / near, (cy - ry) / far), ny1 = Math.max((cy + ry) / near, (cy + ry) / far);
    // one pixel of margin: occluder edges are sampled at pixel centres
    const x0 = Math.max(0, Math.floor((nx0 * 0.5 + 0.5) * this.w) - 1), x1 = Math.min(this.w - 1, Math.ceil((nx1 * 0.5 + 0.5) * this.w) + 1);
    const y0 = Math.max(0, Math.floor((0.5 - ny1 * 0.5) * this.h) - 1), y1 = Math.min(this.h - 1, Math.ceil((0.5 - ny0 * 0.5) * this.h) + 1);
    if (x0 > x1 || y0 > y1) return true;
    const iz = 1 / near, D = this.depth, W = this.w;
    for (let ty = y0 >> 3; ty <= y1 >> 3; ty++) {
      for (let tx = x0 >> 3; tx <= x1 >> 3; tx++) {
        if (this.tileMin[ty * this.tw + tx] > iz) continue; // the whole tile is nearer
        const ya = Math.max(y0, ty * 8), yb = Math.min(y1, ty * 8 + 7), xa = Math.max(x0, tx * 8), xb = Math.min(x1, tx * 8 + 7);
        for (let py = ya; py <= yb; py++) for (let px = xa; px <= xb; px++) if (D[py * W + px] <= iz) return true;
      }
    }
    return false;
  }
}
