// Water surfaces from the level's water volumes (octree type 9): each volume
// is an outline polygon at the water height (rivers slope, so every vertex
// keeps its own z). Polygons are ear-clipped in XY and drawn in a blended pass
// after the opaque geometry: depth-tested, not depth-writing.

import type { WaterVolume } from "./levelObjects.ts";
import type { Vec3 } from "./mat4.ts";

const SHADER = /* wgsl */ `
struct Cam { viewProj: mat4x4f, eye: vec4f, sun: vec4f, params: vec4f }; // params.z fog density
@group(0) @binding(0) var<uniform> cam: Cam;
struct VOut { @builtin(position) pos: vec4f, @location(0) wpos: vec3f, @location(1) tint: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) tint: vec3f) -> VOut {
  var o: VOut;
  o.pos = cam.viewProj * vec4f(p, 1.0);
  o.wpos = p;
  o.tint = tint;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let v = normalize(cam.eye.xyz - i.wpos);
  let n = vec3f(0.0, 0.0, 1.0);
  let fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  let sky = vec3f(0.55, 0.62, 0.70);
  let deep = i.tint * 4.0 + vec3f(0.03, 0.06, 0.06);
  let h = normalize(normalize(cam.sun.xyz) + v);
  let glint = pow(max(dot(n, h), 0.0), 400.0) * 3.0;
  var c = mix(deep, sky, fres) + vec3f(glint);
  let d = distance(i.wpos, cam.eye.xyz);
  c = mix(c, sky, clamp(1.0 - exp(-d * cam.params.z), 0.0, 1.0));
  return vec4f(pow(c, vec3f(1.0 / 2.2)), mix(0.78, 0.95, fres));
}
`;

/** Ear clipping for a simple polygon in XY; returns triangle indices. */
export function triangulate(xy: number[]): number[] {
  const n = xy.length / 2;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += xy[j * 2] * xy[i * 2 + 1] - xy[i * 2] * xy[j * 2 + 1];
  const idx = Array.from({ length: n }, (_, i) => i);
  if (area < 0) idx.reverse(); // make counter-clockwise
  const out: number[] = [];
  const cross = (a: number, b: number, c: number) =>
    (xy[b * 2] - xy[a * 2]) * (xy[c * 2 + 1] - xy[a * 2 + 1]) - (xy[b * 2 + 1] - xy[a * 2 + 1]) * (xy[c * 2] - xy[a * 2]);
  const inside = (p: number, a: number, b: number, c: number) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (cross(a, b, c) <= 1e-9) continue; // reflex
      let ear = true;
      for (const p of idx) if (p !== a && p !== b && p !== c && inside(p, a, b, c)) { ear = false; break; }
      if (!ear) continue;
      out.push(a, b, c);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate outline: give up on the rest
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

export class WaterRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private camBuf: GPUBuffer;
  private bind: GPUBindGroup;
  private vb: GPUBuffer;
  private ib: GPUBuffer;
  readonly triangles: number;

  constructor(device: GPUDevice, format: GPUTextureFormat, volumes: WaterVolume[]) {
    this.device = device;
    const verts: number[] = [];
    const idx: number[] = [];
    for (const w of volumes) {
      const n = w.vertices.length / 3;
      const xy: number[] = [];
      for (let k = 0; k < n; k++) xy.push(w.vertices[k * 3], w.vertices[k * 3 + 1]);
      const base = verts.length / 6;
      for (let k = 0; k < n; k++) verts.push(w.vertices[k * 3], w.vertices[k * 3 + 1], w.vertices[k * 3 + 2], ...w.fogColor);
      for (const t of triangulate(xy)) idx.push(base + t);
    }
    this.triangles = idx.length / 3;
    this.vb = device.createBuffer({ size: Math.max(16, verts.length * 4), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vb, 0, new Float32Array(verts));
    this.ib = device.createBuffer({ size: Math.max(16, idx.length * 4), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.ib, 0, new Uint32Array(idx));
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }] }],
      },
      fragment: {
        module, entryPoint: "fs",
        targets: [{ format, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" },
      multisample: { count: 4 },
    });
    this.camBuf = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bind = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.camBuf } }] });
  }

  setCamera(viewProj: Float32Array, eye: Vec3, sun: Vec3, fogDensity = 0.00018): void {
    const u = new Float32Array(28);
    u.set(viewProj, 0);
    u.set([...eye, 1], 16);
    u.set([...sun, 0], 20);
    u.set([0, 0, fogDensity, 0], 24);
    this.device.queue.writeBuffer(this.camBuf, 0, u);
  }

  /** Draw after all opaque geometry in the same pass. */
  draw(pass: GPURenderPassEncoder): void {
    if (!this.triangles) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.setVertexBuffer(0, this.vb);
    pass.setIndexBuffer(this.ib, "uint32");
    pass.drawIndexed(this.triangles * 3);
  }

  destroy(): void {
    this.vb.destroy();
    this.ib.destroy();
    this.camBuf.destroy();
  }
}
