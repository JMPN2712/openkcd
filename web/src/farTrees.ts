// Far trees: every tree in the level (416k in Rataje) drawn as a camera-facing
// card beyond where the real tree is drawn, so the hills stay forested past
// the streamed radius.
//
// The game's last tree LOD is a placeholder card (%BILLBOARD_ATLAS, no texture
// in the data: the engine renders its billboards at run time), so we make our
// own: each tree type is rendered once from the side (orthographic, flat
// light) into a layer of a texture array, with alpha-aware mips. A card is
// dropped in the vertex shader wherever the real tree is drawn: within the
// streamed radius and inside its view distance (world.ts selectLods), so the
// two never overlap or leave a gap.

import type { LevelObjects } from "./levelObjects.ts";
import type { Terrain } from "./terrain.ts";
import type { Vfs } from "./vfs.ts";
import { loadModel, modelExists, type LoadedModel } from "./model.ts";
import { ModelRenderer } from "./renderer.ts";
import { lookAt, multiply, depthCompare, depthFormat, type Lighting, type Mat4, type PassSetup, type Vec3 } from "./mat4.ts";

const CELL_W = 128, CELL_H = 256;
const MIPS = 6; // 128×256 down to 4×8
/** Only models at least this tall count as trees (marsh sticks and saplings stay real-only). */
const MIN_HEIGHT = 4;

const SHADER = /* wgsl */ `
struct U { viewProj: mat4x4f, eye: vec4f, sunDir: vec4f, sunColor: vec4f, sky: vec4f, ground: vec4f, fog: vec4f, stream: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var atlas: texture_2d_array<f32>;
@group(0) @binding(2) var samp: sampler;
override alphaToCoverage: f32 = 0.0;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) layer: u32, @location(2) wpos: vec3f };

// a: base position xyz, atlas layer; b: half width, height, bounding radius, view distance factor
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> VOut {
  var o: VOut;
  let corners = array<vec2f, 6>(vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corners[vi];
  let centre = a.xyz + vec3f(0.0, 0.0, b.y * 0.5);
  let d = distance(centre, u.eye.xyz);
  // the real tree is drawn (streamed, and within its view distance): no card
  let streamed = distance(a.xy, u.stream.xy) < u.stream.z;
  if (streamed && d - b.z <= (80.0 + 70.0 * b.z) * u.stream.w) {
    o.pos = vec4f(0.0, 0.0, 0.0, 1.0);
    return o;
  }
  let toEye = u.eye.xy - a.xy;
  let side = normalize(vec2f(-toEye.y, toEye.x) + vec2f(1e-5, 0.0));
  let w = a.xyz + vec3f(side * c.x * b.x, c.y * b.y);
  o.pos = u.viewProj * vec4f(w, 1.0);
  o.uv = vec2f(c.x * 0.5 + 0.5, 1.0 - c.y);
  o.layer = u32(a.w);
  o.wpos = w;
  return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let t = textureSample(atlas, samp, i.uv, i.layer);
  let cov = select(step(0.5, t.a), clamp((t.a - 0.5) / max(fwidth(t.a), 1e-4) + 0.5, 0.0, 1.0), alphaToCoverage > 0.5);
  if (cov <= 0.0) { discard; }
  // the colour was captured unlit: light it like foliage (mostly from above, some sun)
  let albedo = pow(t.rgb, vec3f(2.2));
  let up = 0.75;
  var lin = albedo * (mix(u.ground.rgb, u.sky.rgb, up) + u.sunColor.rgb * max(u.sunDir.z, 0.0) * 0.7);
  let fd = distance(i.wpos, u.eye.xyz);
  lin = mix(lin, u.fog.rgb, clamp(1.0 - exp(-fd * u.fog.w), 0.0, 1.0));
  return vec4f(pow(clamp(lin, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), cov);
}
`;

const BLIT = /* wgsl */ `
// mips: average the four texels below, colour weighted by alpha (no dark fringes)
@vertex fn vsBlit(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}
@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn fsBlit(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let q = vec2i(p.xy) * 2;
  var c = vec3f(0.0);
  var a = 0.0;
  for (var k = 0; k < 4; k++) {
    let t = textureLoad(src, q + vec2i(k & 1, k >> 1), 0);
    c += t.rgb * t.a;
    a += t.a;
  }
  return vec4f(select(vec3f(0.0), c / a, a > 0.0), a * 0.25);
}
`;

interface TreeType {
  group: number;
  layer: number;
  halfWidth: number;
  height: number;
  /** model bounding-sphere radius (as world.ts computes it) */
  radius: number;
}

function bounds(m: LoadedModel): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const mesh of m.cgf.meshes) {
    for (let c = 0; c < 8; c++) {
      const v = [c & 1 ? mesh.bboxMax[0] : mesh.bboxMin[0], c & 2 ? mesh.bboxMax[1] : mesh.bboxMin[1], c & 4 ? mesh.bboxMax[2] : mesh.bboxMin[2]];
      const t = mesh.transform;
      for (let r = 0; r < 3; r++) {
        const w = t[r] * v[0] + t[4 + r] * v[1] + t[8 + r] * v[2] + t[12 + r];
        min[r] = Math.min(min[r], w);
        max[r] = Math.max(max[r], w);
      }
    }
  }
  return { min, max };
}

/** Column-major orthographic projection for WebGPU (depth 0..1). */
function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, 1 / (n - f), 0, -(r + l) / (r - l), -(t + b) / (t - b), n / (n - f), 1]);
}

export class FarTrees {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private uniforms: GPUBuffer;
  private bind: GPUBindGroup | null = null;
  private instances: GPUBuffer | null = null;
  private atlas: GPUTexture | null = null;
  private module: GPUShaderModule;
  count = 0;
  types = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, pass: PassSetup) {
    this.device = device;
    this.module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.module, entryPoint: "vs",
        buffers: [{ arrayStride: 32, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }, { shaderLocation: 1, offset: 16, format: "float32x4" }] }],
      },
      fragment: { module: this.module, entryPoint: "fs", targets: [{ format }], constants: { alphaToCoverage: pass.sampleCount > 1 ? 1 : 0 } },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: depthFormat(pass), depthWriteEnabled: true, depthCompare: depthCompare(pass) },
      multisample: { count: pass.sampleCount, alphaToCoverageEnabled: pass.sampleCount > 1 },
    });
    this.uniforms = device.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Find the level's tree types, capture their cards and upload every tree instance. */
  async build(vfs: Vfs, terrain: Terrain, objects: LevelObjects, opts: { maxTextureDim?: number; onStatus?: (s: string) => void } = {}): Promise<void> {
    const counts = new Map<number, number>();
    for (const g of objects.vegGroup) counts.set(g, (counts.get(g) ?? 0) + 1);
    const candidates = [...counts.keys()].filter((g) => /\/trees\//.test(terrain.vegetation[g]?.model ?? ""));
    // capture from a middle LOD: full detail isn't visible at a few pixels, and it loads faster
    const models: { group: number; model: LoadedModel; base: LoadedModel }[] = [];
    for (const [k, g] of candidates.entries()) {
      opts.onStatus?.(`Far trees: loading ${k + 1}/${candidates.length}`);
      const path = terrain.vegetation[g].model;
      const base = await loadModel(vfs, path, { maxTextureDim: opts.maxTextureDim ?? 256, normalMaps: false }).catch(() => null);
      if (!base) continue;
      const b = bounds(base);
      if (b.max[2] - b.min[2] < MIN_HEIGHT) continue;
      const lodPath = path.replace(/\.cgf$/, "_lod1.cgf");
      const lod = modelExists(vfs, lodPath) ? await loadModel(vfs, lodPath, { maxTextureDim: opts.maxTextureDim ?? 256, normalMaps: false }).catch(() => null) : null;
      models.push({ group: g, model: lod ?? base, base });
    }
    if (!models.length) return;
    const layers = Math.min(models.length, this.device.limits.maxTextureArrayLayers);
    this.atlas = this.device.createTexture({
      size: [CELL_W, CELL_H, layers], format: "rgba8unorm", mipLevelCount: MIPS,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const types = new Map<number, TreeType>();
    const capturePass: PassSetup = { sampleCount: 1, reversedZ: false };
    const depth = this.device.createTexture({ size: [CELL_W, CELL_H], format: depthFormat(capturePass), usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const r = new ModelRenderer(this.device, "rgba8unorm", 1, capturePass);
    // flat, even light: the cards are lit when drawn
    r.lighting = { sunDir: [0, -1, 0.3], sunColor: [0, 0, 0], skyColor: [1, 1, 1], groundColor: [1, 1, 1], fogColor: [0, 0, 0], fogDensity: 0 } as Lighting;
    for (const [layer, { group, model, base }] of models.slice(0, layers).entries()) {
      opts.onStatus?.(`Far trees: capturing ${layer + 1}/${layers}`);
      const b = bounds(base);
      const halfWidth = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2;
      const height = b.max[2];
      const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
      // looking at the tree from the side; the card spans [-halfWidth, halfWidth] × [0, height]
      const view = lookAt([cx, cy - 100, height / 2], [cx, cy, height / 2], [0, 0, 1]);
      const vp = multiply(ortho(-halfWidth, halfWidth, -height / 2, height / 2, 1, 200), view);
      r.setModels([{ model }]);
      r.setCamera(vp, [cx, cy - 100, height / 2], undefined);
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        // cleared to a leafy colour with no alpha, so filtering at the edges doesn't darken
        colorAttachments: [{ view: this.atlas.createView({ dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: 0, mipLevelCount: 1 }), clearValue: { r: 0.25, g: 0.3, b: 0.18, a: 0 }, loadOp: "clear", storeOp: "store" }],
        depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
      });
      r.draw(pass);
      pass.end();
      this.device.queue.submit([enc.finish()]);
      const radius = Math.max(0.1, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
      types.set(group, { group, layer, halfWidth, height, radius });
    }
    r.destroy();
    depth.destroy();
    this.mips(layers);
    this.types = types.size;

    // instances: base position, layer; half width, height, radius (scaled)
    const data: number[] = [];
    for (let i = 0; i < objects.vegGroup.length; i++) {
      const t = types.get(objects.vegGroup[i]);
      if (!t) continue;
      const s = objects.vegScale[i];
      data.push(objects.vegPos[i * 3], objects.vegPos[i * 3 + 1], objects.vegPos[i * 3 + 2], t.layer, t.halfWidth * s, t.height * s, t.radius * s, 0);
    }
    this.count = data.length / 8;
    this.instances = this.device.createBuffer({ size: Math.max(32, data.length * 4), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.instances, 0, new Float32Array(data));
    const sampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 4 });
    this.bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }, { binding: 1, resource: this.atlas.createView({ dimension: "2d-array" }) }, { binding: 2, resource: sampler }],
    });
  }

  private mips(layers: number): void {
    const blit = this.device.createShaderModule({ code: BLIT });
    const pipe = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: blit, entryPoint: "vsBlit" },
      fragment: { module: blit, entryPoint: "fsBlit", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });
    const enc = this.device.createCommandEncoder();
    for (let layer = 0; layer < layers; layer++) {
      for (let m = 1; m < MIPS; m++) {
        const view = (level: number) => this.atlas!.createView({ dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1 });
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: view(m), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
        pass.setPipeline(pipe);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: view(m - 1) }] }));
        pass.draw(3);
        pass.end();
      }
    }
    this.device.queue.submit([enc.finish()]);
  }

  /** Camera, light and where the real trees are: streamed around `stream` within `radius`, culled at their view distance × distanceScale. */
  setCamera(viewProj: Float32Array, eye: Vec3, L: Lighting, stream: { center: [number, number]; radius: number; distanceScale: number }): void {
    const u = new Float32Array(48);
    u.set(viewProj, 0);
    u.set([...eye, 0], 16);
    u.set([...L.sunDir, 0], 20);
    u.set([...L.sunColor, 0], 24);
    u.set([...L.skyColor, 0], 28);
    u.set([...L.groundColor, 0], 32);
    u.set([...L.fogColor, L.fogDensity], 36);
    u.set([stream.center[0], stream.center[1], stream.radius, stream.distanceScale], 40);
    this.device.queue.writeBuffer(this.uniforms, 0, u);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.bind || !this.instances || !this.count) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.setVertexBuffer(0, this.instances);
    pass.draw(6, this.count);
  }

  destroy(): void {
    this.instances?.destroy();
    this.atlas?.destroy();
    this.uniforms.destroy();
  }
}
