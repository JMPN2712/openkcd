// Physics geometry stored in models (MeshPhysicsData chunk 0x1018 v0x800), decoded from the
// data files alone and checked over the whole install (docs/PHYSICS.md):
//
//   +0    u32 size of the data that follows the 24-byte header
//   +32   inertia (3 f32), +44 principal-axes quaternion, +60 centre of mass, +72 f32 volume
//   +80   i32 surface / material index
//   +92   i32 geometry type, then the geometry from +96:
//     0 box       f32 basis[3][3] (rows = box axes), i32 oriented, centre (3 f32), half-size (3 f32)
//                 (8·hx·hy·hz equals the stored volume in 10,566 of 10,566 boxes)
//     4 sphere    centre (3 f32), radius
//     5 cylinder  centre, axis (3 f32), radius, half-height       (393 of 393 volumes)
//     6 capsule   centre, axis, radius, half-height (of the cylinder part) (1,214 of 1,214)
//     1 mesh      i32 vertices, i32 triangles, i32, i32 flags, u8 shared
//                 shared = 0: f32×3 vertices from +114, then u16×3 indices per triangle
//                   (every index in range in all 867 such meshes)
//                 shared = 1: no vertices: the render mesh itself is physicalised (its
//                   triangle count is the render mesh's, or that of some of its subsets)
// Coordinates are in model space (proxy centres lie inside the render bounds whatever the
// proxy node's own offset).

export type PhysGeometry =
  | { kind: "box"; center: number[]; axes: number[][]; half: number[] }
  | { kind: "sphere"; center: number[]; radius: number }
  | { kind: "cylinder" | "capsule"; center: number[]; axis: number[]; radius: number; halfHeight: number }
  | { kind: "mesh"; positions: Float32Array; indices: Uint32Array }
  | { kind: "render"; triangles: number };

export function decodePhysics(dv: DataView, o: number, size: number): PhysGeometry | null {
  if (size < 100) return null;
  const f = (k: number) => dv.getFloat32(o + k, true);
  const v3 = (k: number) => [f(k), f(k + 4), f(k + 8)];
  switch (dv.getInt32(o + 92, true)) {
    case 0: {
      if (size < 160) return null;
      const oriented = dv.getInt32(o + 132, true) !== 0;
      return { kind: "box", axes: oriented ? [v3(96), v3(108), v3(120)] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]], center: v3(136), half: v3(148) };
    }
    case 4:
      return { kind: "sphere", center: v3(96), radius: f(108) };
    case 5:
    case 6:
      if (size < 128) return null;
      return { kind: dv.getInt32(o + 92, true) === 6 ? "capsule" : "cylinder", center: v3(96), axis: v3(108), radius: f(120), halfHeight: f(124) };
    case 1: {
      const nv = dv.getInt32(o + 96, true), nt = dv.getInt32(o + 100, true);
      if (nv < 0 || nt < 0) return null;
      if (dv.getUint8(o + 112) === 1) return { kind: "render", triangles: nt };
      if (dv.getUint8(o + 112) !== 0 || dv.getUint8(o + 113) !== 0) return null;
      const vo = 114, io = vo + nv * 12;
      if (io + nt * 6 > size) return null;
      const positions = new Float32Array(nv * 3);
      for (let i = 0; i < nv * 3; i++) positions[i] = f(vo + i * 4);
      const indices = new Uint32Array(nt * 3);
      for (let i = 0; i < nt * 3; i++) {
        const x = dv.getUint16(o + io + i * 2, true);
        if (x >= nv) return null;
        indices[i] = x;
      }
      return { kind: "mesh", positions, indices };
    }
    default:
      return null;
  }
}

/** Triangles for a primitive (boxes exact; round shapes as 12-sided prisms and caps). */
export function tessellate(g: PhysGeometry): { positions: Float32Array; indices: Uint32Array } | null {
  const P: number[] = [], I: number[] = [];
  const add = (p: number[]) => (P.push(p[0], p[1], p[2]), P.length / 3 - 1);
  if (g.kind === "mesh") return { positions: g.positions, indices: g.indices };
  if (g.kind === "render") return null;
  if (g.kind === "box") {
    const c: number[] = [];
    for (let k = 0; k < 8; k++) {
      const s = [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1];
      c.push(add([0, 1, 2].map((d) => g.center[d] + s[0] * g.half[0] * g.axes[0][d] + s[1] * g.half[1] * g.axes[1][d] + s[2] * g.half[2] * g.axes[2][d])));
    }
    for (const q of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) I.push(c[q[0]], c[q[1]], c[q[2]], c[q[0]], c[q[2]], c[q[3]]);
    return { positions: new Float32Array(P), indices: new Uint32Array(I) };
  }
  const N = 12;
  const axis = g.kind === "sphere" ? [0, 0, 1] : g.axis;
  const al = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const a = axis.map((x) => x / al);
  const t = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = [a[1] * t[2] - a[2] * t[1], a[2] * t[0] - a[0] * t[2], a[0] * t[1] - a[1] * t[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  const U = u.map((x) => x / ul), V = [a[1] * U[2] - a[2] * U[1], a[2] * U[0] - a[0] * U[2], a[0] * U[1] - a[1] * U[0]];
  // rings along the axis: (offset along axis, radius)
  const r = g.radius;
  const hh = g.kind === "sphere" ? 0 : g.halfHeight;
  const rings: [number, number][] = g.kind === "cylinder"
    ? [[-hh, r], [hh, r]]
    : [[-hh - r * 0.92, r * 0.38], [-hh - r * 0.7, r * 0.71], [-hh, r], [hh, r], [hh + r * 0.7, r * 0.71], [hh + r * 0.92, r * 0.38]];
  const ids = rings.map(([h, rr]) => Array.from({ length: N }, (_, k) => {
    const ang = (k / N) * Math.PI * 2;
    return add([0, 1, 2].map((d) => g.center[d] + a[d] * h + (U[d] * Math.cos(ang) + V[d] * Math.sin(ang)) * rr));
  }));
  for (let j = 0; j + 1 < ids.length; j++) for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    I.push(ids[j][k], ids[j + 1][k], ids[j + 1][k2], ids[j][k], ids[j + 1][k2], ids[j][k2]);
  }
  const ends = g.kind === "cylinder" ? [[-hh, 0], [hh, ids.length - 1]] : [[-hh - r, 0], [hh + r, ids.length - 1]];
  for (const [h, j] of ends) {
    const c = add([0, 1, 2].map((d) => g.center[d] + a[d] * h));
    for (let k = 0; k < N; k++) I.push(c, ids[j][k], ids[j][(k + 1) % N]);
  }
  return { positions: new Float32Array(P), indices: new Uint32Array(I) };
}
