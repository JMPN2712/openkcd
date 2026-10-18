// WebGPU model renderer: one pipeline, per-subset draws with the material's
// diffuse texture, simple sun + hemisphere lighting. Works with any target
// (canvas or offscreen texture) so it can be tested headless in Node.
//
// Conventions: CryEngine is Z-up with counter-clockwise front faces (checked
// against face normals in scripts/test-cgf.ts). Culling is off because
// foliage is double-sided. Normals are flipped when they face away from the
// viewer rather than by front_facing: KCD meshes contain layered duplicate
// triangles (the windmill roof has ~2k) whose winding doesn't match their
// authored normals, and a front_facing flip makes those z-fight visibly.

import type { LoadedModel, MipChain } from "./model.ts";
import { lookAt, multiply, perspective, transformPoint, type Vec3 } from "./mat4.ts";

const SHADER = /* wgsl */ `
struct Camera { viewProj: mat4x4f, eye: vec4f, light: vec4f }; // light.w = 1 for flat shading
struct Draw { model: mat4x4f, color: vec4f, spec: vec4f, params: vec4f }; // params: x alpha test, y diffuse map, z specular map
@group(0) @binding(0) var<uniform> cam: Camera;
@group(1) @binding(0) var<uniform> drw: Draw;
@group(1) @binding(1) var tex: texture_2d<f32>;
@group(1) @binding(2) var samp: sampler;
@group(1) @binding(3) var specTex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) n: vec3f,
  @location(1) uv: vec2f,
  @location(2) wpos: vec3f,
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  let w = drw.model * vec4f(p, 1.0);
  o.pos = cam.viewProj * w;
  o.n = (drw.model * vec4f(n, 0.0)).xyz;
  o.uv = uv;
  o.wpos = w.xyz;
  return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let t = textureSample(tex, samp, i.uv);
  let st = textureSample(specTex, samp, i.uv);
  var base = drw.color * select(vec4f(1.0), t, drw.params.y > 0.5);
  if (drw.params.x > 0.0 && base.a < drw.params.x) { discard; }
  var n = normalize(i.n);
  if (cam.light.w > 0.5) { n = normalize(cross(dpdx(i.wpos), dpdy(i.wpos))); }
  let v = normalize(cam.eye.xyz - i.wpos);
  if (dot(n, v) < 0.0) { n = -n; }
  let l = normalize(cam.light.xyz);
  let ndl = max(dot(n, l), 0.0);
  let hemi = mix(0.12, 0.35, n.z * 0.5 + 0.5);
  // Blinn-Phong stand-in for the PBR specular colour, plus a flat "environment" term so metals read as metal
  let specCol = drw.spec.rgb * select(vec3f(1.0), st.rgb, drw.params.z > 0.5);
  let spec = specCol * (pow(max(dot(n, normalize(l + v)), 0.0), 48.0) * ndl * 2.0 + hemi * 1.2);
  let lin = base.rgb * (hemi + 0.9 * ndl) + spec;
  // target is a non-sRGB format: encode manually
  return vec4f(pow(clamp(lin, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}
`;

export interface Camera {
  /** shade with face normals instead of the mesh's (often authored) vertex normals */
  flat?: boolean;
  yaw: number;
  pitch: number;
  distance: number;
  target: Vec3;
}

interface DrawItem {
  vb: GPUBuffer;
  ib: GPUBuffer;
  firstIndex: number;
  count: number;
  bind: GPUBindGroup;
}

export class ModelRenderer {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly sampleCount: number;
  private pipeline: GPURenderPipeline;
  private camBuf: GPUBuffer;
  private camBind: GPUBindGroup;
  private sampler: GPUSampler;
  private white: GPUTexture;
  private draws: DrawItem[] = [];
  private owned: (GPUBuffer | GPUTexture)[] = [];
  private depth: GPUTexture | null = null;
  private msaa: GPUTexture | null = null;
  /** model-space bounds of everything drawn */
  bboxMin: Vec3 = [-1, -1, -1];
  bboxMax: Vec3 = [1, 1, 1];
  stats = { meshes: 0, triangles: 0, vertices: 0, draws: 0, textured: 0 };

  constructor(device: GPUDevice, format: GPUTextureFormat, sampleCount = 4) {
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
          ],
        }],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: sampleCount },
    });
    this.camBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.camBind = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.camBuf } }] });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8 });
    this.white = device.createTexture({ size: [1, 1], format: "rgba8unorm-srgb", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
  }

  private upload(chain: MipChain): GPUTexture {
    const top = chain.levels[0];
    // diffuse maps are colour data: sample as sRGB even if the DDS says UNORM
    const t = this.device.createTexture({
      size: [top.w, top.h],
      mipLevelCount: chain.levels.length,
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    chain.levels.forEach((l, i) => {
      this.device.queue.writeTexture({ texture: t, mipLevel: i }, l.data as Uint8ClampedArray<ArrayBuffer>, { bytesPerRow: l.w * 4 }, [l.w, l.h]);
    });
    this.owned.push(t);
    return t;
  }

  setModel(model: LoadedModel): void {
    this.clear();
    const textures = new Map<MipChain, GPUTexture>();
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const mesh of model.cgf.meshes) {
      const nv = mesh.positions.length / 3;
      const verts = new Float32Array(nv * 8);
      for (let i = 0; i < nv; i++) {
        verts.set(mesh.positions.subarray(i * 3, i * 3 + 3), i * 8);
        if (mesh.normals) verts.set(mesh.normals.subarray(i * 3, i * 3 + 3), i * 8 + 3);
        else verts[i * 8 + 5] = 1;
        if (mesh.uvs) verts.set(mesh.uvs.subarray(i * 2, i * 2 + 2), i * 8 + 6);
        const p = transformPoint(mesh.transform, [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]]);
        for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], p[c]); max[c] = Math.max(max[c], p[c]); }
      }
      const vb = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(vb, 0, verts);
      const ib = this.device.createBuffer({ size: Math.ceil(mesh.indices.byteLength / 4) * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(ib, 0, mesh.indices);
      this.owned.push(vb, ib);
      this.stats.meshes++;
      this.stats.vertices += nv;

      for (const s of mesh.subsets) {
        const mat = model.materials[s.matId];
        if (mat?.nodraw) continue;
        const chain = model.diffuse[s.matId] ?? null;
        const specChain = model.specular[s.matId] ?? null;
        const gpu = (c: MipChain | null) => {
          if (!c) return this.white;
          let t = textures.get(c);
          if (!t) textures.set(c, (t = this.upload(c)));
          return t;
        };
        const gpuTex = gpu(chain);
        const specTex = gpu(specChain);
        if (chain) this.stats.textured++;
        const ubuf = this.device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const u = new Float32Array(28);
        u.set(mesh.transform, 0);
        const col = mat?.diffuse ?? [0.8, 0.8, 0.8];
        u.set([col[0], col[1], col[2], 1], 16);
        u.set([...(mat?.specular ?? [0.04, 0.04, 0.04]), 0], 20);
        u.set([mat?.alphaTest ?? 0, chain ? 1 : 0, specChain ? 1 : 0, 0], 24);
        this.device.queue.writeBuffer(ubuf, 0, u);
        this.owned.push(ubuf);
        const bind = this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: { buffer: ubuf } },
            { binding: 1, resource: gpuTex.createView() },
            { binding: 2, resource: this.sampler },
            { binding: 3, resource: specTex.createView() },
          ],
        });
        this.draws.push({ vb, ib, firstIndex: s.firstIndex, count: s.numIndices, bind });
        this.stats.triangles += s.numIndices / 3;
      }
    }
    this.stats.draws = this.draws.length;
    if (min[0] <= max[0]) { this.bboxMin = min; this.bboxMax = max; }
  }

  /** Camera framing the whole model, looking from the front-left and slightly above. */
  defaultCamera(): Camera {
    const c: Vec3 = [0, 1, 2].map((i) => (this.bboxMin[i] + this.bboxMax[i]) / 2) as Vec3;
    const r = Math.hypot(...[0, 1, 2].map((i) => this.bboxMax[i] - this.bboxMin[i])) / 2 || 1;
    // CryEngine characters and most props face +Y: look from the front-right
    return { yaw: Math.PI * 0.35, pitch: 0.3, distance: r * 2.8, target: c };
  }

  render(target: GPUTexture, cam: Camera): void {
    const { width, height } = target;
    if (!this.depth || this.depth.width !== width || this.depth.height !== height) {
      this.depth?.destroy();
      this.msaa?.destroy();
      this.depth = this.device.createTexture({ size: [width, height], format: "depth24plus", sampleCount: this.sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.msaa = this.sampleCount > 1
        ? this.device.createTexture({ size: [width, height], format: this.format, sampleCount: this.sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT })
        : null;
    }
    const cp = Math.cos(cam.pitch);
    const eye: Vec3 = [
      cam.target[0] + cam.distance * cp * Math.cos(cam.yaw),
      cam.target[1] + cam.distance * cp * Math.sin(cam.yaw),
      cam.target[2] + cam.distance * Math.sin(cam.pitch),
    ];
    const r = Math.hypot(...[0, 1, 2].map((i) => this.bboxMax[i] - this.bboxMin[i])) / 2 || 1;
    const near = Math.max(cam.distance - r * 1.5, cam.distance * 0.01, 0.001);
    const far = cam.distance + r * 1.5;
    const vp = multiply(perspective(Math.PI / 4, width / height, near, far), lookAt(eye, cam.target, [0, 0, 1]));
    const cu = new Float32Array(24);
    cu.set(vp, 0);
    cu.set([...eye, 1], 16);
    // sun from the camera's upper-left, so the visible side is lit
    cu.set([Math.cos(cam.yaw + 0.8), Math.sin(cam.yaw + 0.8), 0.9, cam.flat ? 1 : 0], 20);
    this.device.queue.writeBuffer(this.camBuf, 0, cu);

    const view = target.createView();
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.msaa ? this.msaa.createView() : view,
        resolveTarget: this.msaa ? view : undefined,
        clearValue: { r: 0.16, g: 0.17, b: 0.19, a: 1 },
        loadOp: "clear",
        storeOp: this.msaa ? "discard" : "store",
      }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.camBind);
    for (const d of this.draws) {
      pass.setVertexBuffer(0, d.vb);
      pass.setIndexBuffer(d.ib, "uint32");
      pass.setBindGroup(1, d.bind);
      pass.drawIndexed(d.count, 1, d.firstIndex);
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  clear(): void {
    for (const o of this.owned) o.destroy();
    this.owned = [];
    this.draws = [];
    this.stats = { meshes: 0, triangles: 0, vertices: 0, draws: 0, textured: 0 };
  }

  destroy(): void {
    this.clear();
    this.depth?.destroy();
    this.msaa?.destroy();
    this.white.destroy();
    this.camBuf.destroy();
  }
}
