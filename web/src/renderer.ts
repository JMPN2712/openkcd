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
import { colorizeOf } from "./mtl.ts";
import { DEFAULT_LIGHTING, depthCompare, depthFormat, lookAt, multiply, perspective, transformPoint, type Lighting, type PassSetup, type Vec3 } from "./mat4.ts";

// position 3f, normal 3f, uv 2f, bone ids u16×4, weights unorm8×4
const VERTEX_BYTES = 44;
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const SHADER = /* wgsl */ `
// light.w = 1 for flat shading; eye.w = -1 for reversed-Z; fog.w = density per metre
struct Camera { viewProj: mat4x4f, eye: vec4f, light: vec4f, sunColor: vec4f, skyColor: vec4f, groundColor: vec4f, fog: vec4f };
// params: x alpha test, y diffuse map, z specular map, w layer
// colorize: KCD %COLORIZING shader, x/y/z = hue (deg) / saturation / brightness, w = 0 off, 1 global, 2 with mask
//   (the "Specular" slot then holds the region mask: R/G/B select mask1/2/3)
struct Draw { model: mat4x4f, color: vec4f, spec: vec4f, params: vec4f, colorize: vec4f, mask1: vec4f, mask2: vec4f, mask3: vec4f };
@group(0) @binding(0) var<uniform> cam: Camera;
@group(1) @binding(0) var<uniform> drw: Draw;
@group(1) @binding(1) var tex: texture_2d<f32>;
@group(1) @binding(2) var samp: sampler;
@group(1) @binding(3) var specTex: texture_2d<f32>;
// skinning palette: model-space bone matrices × inverse bind pose (identity for static meshes)
@group(1) @binding(4) var<storage, read> bones: array<mat4x4f>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) n: vec3f,
  @location(1) uv: vec2f,
  @location(2) wpos: vec3f,
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f,
               @location(3) bi: vec4u, @location(4) bw: vec4f,
               @location(5) i0: vec4f, @location(6) i1: vec4f, @location(7) i2: vec4f, @location(8) i3: vec4f) -> VOut {
  var o: VOut;
  let sk = bones[bi.x] * bw.x + bones[bi.y] * bw.y + bones[bi.z] * bw.z + bones[bi.w] * bw.w;
  // per-instance world matrix (identity for single models)
  let world = mat4x4f(i0, i1, i2, i3) * drw.model;
  let w = world * (sk * vec4f(p, 1.0));
  o.pos = cam.viewProj * w;
  // layered character clothing shares the body's surface: pull outer layers slightly towards the camera
  // (reversed-Z: scale the depth up by 0.02% per layer, about 0.4 mm at 2 m)
  if (cam.eye.w > 0.0) { o.pos.z = o.pos.z - drw.params.w * 0.00004 * o.pos.w; } else { o.pos.z = o.pos.z * (1.0 + drw.params.w * 0.0002); }
  o.n = (world * (sk * vec4f(n, 0.0))).xyz;
  o.uv = uv;
  o.wpos = w.xyz;
  return o;
}

fn rgb2hsv(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let d = mx - mn;
  var h = 0.0;
  if (d > 1e-5) {
    if (mx == c.r) { h = (c.g - c.b) / d; } else if (mx == c.g) { h = 2.0 + (c.b - c.r) / d; } else { h = 4.0 + (c.r - c.g) / d; }
    h = fract(h / 6.0);
  }
  return vec3f(h, select(0.0, d / mx, mx > 1e-5), mx);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = vec3f(0.0, 4.0, 2.0);
  let p = clamp(abs(fract(vec3f(c.x) + k / 6.0) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), p, c.y);
}

// hue shift in degrees, saturation and brightness multipliers, applied in gamma space
fn adjust(lin: vec3f, hsb: vec3f) -> vec3f {
  var hsv = rgb2hsv(pow(lin, vec3f(1.0 / 2.2)));
  hsv = vec3f(fract(hsv.x + hsb.x / 360.0), clamp(hsv.y * hsb.y, 0.0, 1.0), hsv.z * hsb.z);
  return pow(max(hsv2rgb(hsv), vec3f(0.0)), vec3f(2.2));
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let t = textureSample(tex, samp, i.uv);
  let st = textureSample(specTex, samp, i.uv);
  var base = drw.color * select(vec4f(1.0), t, drw.params.y > 0.5);
  var specMap = select(vec3f(1.0), st.rgb, drw.params.z > 0.5);
  if (drw.colorize.w > 1.5) {
    let m = clamp(st.rgb, vec3f(0.0), vec3f(1.0));
    let rest = max(0.0, 1.0 - m.r - m.g - m.b);
    let c = base.rgb * rest + adjust(base.rgb, drw.mask1.xyz) * m.r + adjust(base.rgb, drw.mask2.xyz) * m.g + adjust(base.rgb, drw.mask3.xyz) * m.b;
    base = vec4f(c, base.a);
    specMap = vec3f(0.04);
  }
  if (drw.colorize.w > 0.5) { base = vec4f(adjust(base.rgb, drw.colorize.xyz), base.a); }
  if (drw.params.x > 0.0 && base.a < drw.params.x) { discard; }
  var n = normalize(i.n);
  if (cam.light.w > 0.5) { n = normalize(cross(dpdx(i.wpos), dpdy(i.wpos))); }
  let v = normalize(cam.eye.xyz - i.wpos);
  if (dot(n, v) < 0.0) { n = -n; }
  let l = normalize(cam.light.xyz);
  let ndl = max(dot(n, l), 0.0);
  let hemi = mix(cam.groundColor.rgb, cam.skyColor.rgb, n.z * 0.5 + 0.5);
  // Blinn-Phong stand-in for the PBR specular colour, plus a flat "environment" term so metals read as metal
  let specCol = drw.spec.rgb * specMap;
  let spec = specCol * (pow(max(dot(n, normalize(l + v)), 0.0), 48.0) * ndl * 2.0 * cam.sunColor.rgb / 0.9 + hemi * 1.2);
  var lin = base.rgb * (hemi + cam.sunColor.rgb * ndl) + spec;
  let fd = distance(i.wpos, cam.eye.xyz);
  lin = mix(lin, cam.fog.rgb, clamp(1.0 - exp(-fd * cam.fog.w), 0.0, 1.0));
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
  item: number;
  ubuf: GPUBuffer;
  inst: GPUBuffer;
  instCount: number;
  /** the mesh's own node transform, composed with the item transform */
  meshTm: Float32Array;
}

export class ModelRenderer {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly sampleCount: number;
  private reversedZ: boolean;
  private pipeline: GPURenderPipeline;
  private camBuf: GPUBuffer;
  private camBind: GPUBindGroup;
  private sampler: GPUSampler;
  private white: GPUTexture;
  private draws: DrawItem[] = [];
  private palettes: ({ buf: GPUBuffer; count: number } | null)[] = [];
  private itemInst: { buf: GPUBuffer; count: number; capacity: number }[] = [];
  private drawsByItem: Map<number, DrawItem[]> | null = null;
  private identityPalette: GPUBuffer;
  private identityInstance: GPUBuffer;
  private owned: (GPUBuffer | GPUTexture)[] = [];
  private depth: GPUTexture | null = null;
  private msaa: GPUTexture | null = null;
  /** model-space bounds of everything drawn */
  bboxMin: Vec3 = [-1, -1, -1];
  bboxMax: Vec3 = [1, 1, 1];
  stats = { meshes: 0, triangles: 0, vertices: 0, draws: 0, textured: 0 };

  constructor(device: GPUDevice, format: GPUTextureFormat, sampleCount = 4, opts: { reversedZ?: boolean } = {}) {
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
    this.reversedZ = opts.reversedZ ?? false;
    const pass: PassSetup = { sampleCount, reversedZ: this.reversedZ };
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [{
          arrayStride: VERTEX_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "uint16x4" },
            { shaderLocation: 4, offset: 40, format: "unorm8x4" },
          ],
        }, {
          arrayStride: 64,
          stepMode: "instance",
          attributes: [0, 1, 2, 3].map((k) => ({ shaderLocation: 5 + k, offset: k * 16, format: "float32x4" as GPUVertexFormat })),
        }],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
      depthStencil: { format: depthFormat(pass), depthWriteEnabled: true, depthCompare: depthCompare(pass) },
      multisample: { count: sampleCount },
    });
    this.camBuf = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.camBind = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.camBuf } }] });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8 });
    this.identityInstance = device.createBuffer({ size: 64, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.identityInstance, 0, IDENTITY);
    this.identityPalette = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.identityPalette, 0, IDENTITY);
    this.white = device.createTexture({ size: [1, 1], format: "rgba8unorm-srgb", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
  }

  private upload(chain: MipChain): GPUTexture {
    const top = chain.levels[0];
    if (chain.bc) {
      // raw BCn blocks: the GPU decodes them (sizes rounded up to whole 4×4 blocks for small mips)
      const format = (/^(bc1|bc2|bc3|bc7)-rgba-unorm$/.test(chain.bc.format) ? `${chain.bc.format}-srgb` : chain.bc.format) as GPUTextureFormat;
      const t = this.device.createTexture({
        size: [Math.ceil(top.w / 4) * 4, Math.ceil(top.h / 4) * 4],
        mipLevelCount: chain.levels.length,
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      chain.levels.forEach((l, i) => {
        const bw = Math.ceil(l.w / 4), bh = Math.ceil(l.h / 4);
        this.device.queue.writeTexture({ texture: t, mipLevel: i }, l.data as Uint8Array<ArrayBuffer>, { bytesPerRow: bw * chain.bc!.blockBytes, rowsPerImage: bh }, [bw * 4, bh * 4]);
      });
      this.owned.push(t);
      return t;
    }
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
    this.setModels([{ model }]);
  }

  /**
   * Several models drawn together, each with an optional extra transform and
   * depth layer. Models with bone weights and a skeleton get a skinning
   * palette (initially the bind pose), updated with setPalette(index, …).
   */
  setModels(items: {
    model: LoadedModel;
    transform?: Float32Array;
    layer?: number;
    /** fixed per-instance world matrices (16 floats each) */
    instances?: Float32Array;
    /** or: room for this many instances, filled per frame with setInstances() */
    capacity?: number;
  }[]): void {
    this.clear();
    this.palettes = items.map(({ model }) => {
      const n = model.skeleton && model.cgf.meshes.some((m) => m.boneIds) ? model.skeleton.bones.length : 0;
      if (!n) return null;
      const buf = this.device.createBuffer({ size: n * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const id = new Float32Array(n * 16);
      for (let i = 0; i < n; i++) id.set(IDENTITY, i * 16);
      this.device.queue.writeBuffer(buf, 0, id);
      this.owned.push(buf);
      return { buf, count: n };
    });
    const textures = new Map<MipChain, GPUTexture>();
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    this.itemInst = items.map(({ instances, capacity }) => {
      if (capacity !== undefined) {
        const buf = this.device.createBuffer({ size: Math.max(1, capacity) * 64, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        this.owned.push(buf);
        return { buf, count: 0, capacity };
      }
      if (!instances?.length) return { buf: this.identityInstance, count: 1, capacity: 1 };
      const buf = this.device.createBuffer({ size: instances.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buf, 0, instances);
      this.owned.push(buf);
      return { buf, count: instances.length / 16, capacity: instances.length / 16 };
    });
    const instBufs = this.itemInst;
    for (const [itemIndex, { model, transform: partTm, layer = 0 }] of items.entries())
    for (const mesh of model.cgf.meshes) {
      const meshTm = partTm ? multiply(partTm, mesh.transform) : mesh.transform;
      const nv = mesh.positions.length / 3;
      const palette = mesh.boneIds && mesh.boneWeights ? this.palettes[itemIndex] : null;
      const raw = new ArrayBuffer(nv * VERTEX_BYTES);
      const verts = new Float32Array(raw);
      const ids = new Uint16Array(raw);
      const wts = new Uint8Array(raw);
      const F = VERTEX_BYTES / 4, U = VERTEX_BYTES / 2;
      for (let i = 0; i < nv; i++) {
        verts.set(mesh.positions.subarray(i * 3, i * 3 + 3), i * F);
        if (mesh.normals) verts.set(mesh.normals.subarray(i * 3, i * 3 + 3), i * F + 3);
        else verts[i * F + 5] = 1;
        if (mesh.uvs) verts.set(mesh.uvs.subarray(i * 2, i * 2 + 2), i * F + 6);
        if (palette) {
          for (let k = 0; k < 4; k++) {
            ids[i * U + 16 + k] = Math.min(mesh.boneIds![i * 4 + k], palette.count - 1);
            wts[i * VERTEX_BYTES + 40 + k] = mesh.boneWeights![i * 4 + k];
          }
        } else {
          wts[i * VERTEX_BYTES + 40] = 255; // bone 0 of the identity palette
        }
        const p = transformPoint(meshTm, [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]]);
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
        // a single (non-multi) material applies to every subset whatever its ID, as in CryEngine:
        // NPC bodies use material ID 4 with the one-material s1_body_normal.mtl (arms and hands were white)
        const mi = model.materials.length === 1 ? 0 : s.matId;
        const mat = model.materials[mi];
        if (mat?.nodraw) continue;
        const chain = model.diffuse[mi] ?? null;
        const specChain = model.specular[mi] ?? null;
        const gpu = (c: MipChain | null) => {
          if (!c) return this.white;
          let t = textures.get(c);
          if (!t) textures.set(c, (t = this.upload(c)));
          return t;
        };
        const gpuTex = gpu(chain);
        const specTex = gpu(specChain);
        if (chain) this.stats.textured++;
        const ubuf = this.device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const u = new Float32Array(44);
        u.set(meshTm, 0);
        const col = mat?.diffuse ?? [0.8, 0.8, 0.8];
        u.set([col[0], col[1], col[2], 1], 16);
        // Hair-shader Specular (often 1,1,1) drives a subtle anisotropic sheen in the engine; as plain
        // reflectance it turned lashes and hair partings white, so scale it to a dielectric level
        const specular = mat?.specular ?? [0.04, 0.04, 0.04];
        u.set([...(/^hair$/i.test(mat?.shader ?? "") ? specular.map((v) => v * 0.05) : specular), 0], 20);
        u.set([mat?.alphaTest ?? 0, chain ? 1 : 0, specChain ? 1 : 0, layer], 24);
        const cz = mat ? colorizeOf(mat) : null;
        if (cz) {
          u.set([...cz.global, cz.withMask && specChain ? 2 : 1], 28);
          cz.masks.forEach((m, k) => u.set([...m, 0], 32 + k * 4));
        }
        this.device.queue.writeBuffer(ubuf, 0, u);
        this.owned.push(ubuf);
        const bind = this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: { buffer: ubuf } },
            { binding: 1, resource: gpuTex.createView() },
            { binding: 2, resource: this.sampler },
            { binding: 3, resource: specTex.createView() },
            { binding: 4, resource: { buffer: palette ? palette.buf : this.identityPalette } },
          ],
        });
        const ib2 = instBufs[itemIndex];
        this.draws.push({ vb, ib, firstIndex: s.firstIndex, count: s.numIndices, bind, item: itemIndex, ubuf, meshTm: mesh.transform, inst: ib2.buf, instCount: ib2.count });
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
    // sun from the camera's upper-left, so the visible side is lit
    this.setCamera(vp, eye, [Math.cos(cam.yaw + 0.8), Math.sin(cam.yaw + 0.8), 0.9], cam.flat);

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
    this.draw(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Light for the next setCamera (the viewers keep the default). */
  lighting: Lighting = DEFAULT_LIGHTING;

  /** Camera for the next draw(): view-projection, eye position, sun direction (lighting's own when omitted). */
  setCamera(viewProj: Float32Array, eye: Vec3, sun?: Vec3, flat = false): void {
    const L = this.lighting;
    const cu = new Float32Array(40);
    cu.set(viewProj, 0);
    cu.set([...eye, this.reversedZ ? -1 : 1], 16);
    cu.set([...(sun ?? L.sunDir), flat ? 1 : 0], 20);
    cu.set([...L.sunColor, 0], 24);
    cu.set([...L.skyColor, 0], 28);
    cu.set([...L.groundColor, 0], 32);
    cu.set([...L.fogColor, L.fogDensity], 36);
    this.device.queue.writeBuffer(this.camBuf, 0, cu);
  }

  /** Record this renderer's draws into a pass with the same format, sample count and depth convention. */
  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.camBind);
    let tris = 0;
    for (const d of this.draws) {
      const n = this.itemInst[d.item]?.count ?? d.instCount;
      if (!n || !d.count) continue;
      pass.setVertexBuffer(0, d.vb);
      pass.setVertexBuffer(1, d.inst);
      pass.setIndexBuffer(d.ib, "uint32");
      pass.setBindGroup(1, d.bind);
      pass.drawIndexed(d.count, n, d.firstIndex);
      tris += (d.count / 3) * n;
    }
    this.stats.triangles = tris;
  }

  /** Upload `count` instance matrices for an item created with `capacity`. */
  setInstances(index: number, matrices: Float32Array, count: number): void {
    const it = this.itemInst[index];
    if (!it) return;
    it.count = Math.min(count, it.capacity);
    if (it.count) this.device.queue.writeBuffer(it.buf, 0, matrices.subarray(0, it.count * 16));
  }

  /** Number of bones in item `index`'s palette (0 = not skinned). */
  paletteSize(index: number): number {
    return this.palettes[index]?.count ?? 0;
  }

  /** Replace item `index`'s extra transform (e.g. a prop following an animated bone). */
  setItemTransform(index: number, transform: Float32Array): void {
    // draws of this item (indexed lazily: scanning every draw per item was O(items × draws) per frame)
    if (!this.drawsByItem) {
      this.drawsByItem = new Map();
      for (const d of this.draws) {
        const list = this.drawsByItem.get(d.item);
        if (list) list.push(d);
        else this.drawsByItem.set(d.item, [d]);
      }
    }
    for (const d of this.drawsByItem.get(index) ?? []) this.device.queue.writeBuffer(d.ubuf, 0, multiply(transform, d.meshTm));
  }

  /** Upload skinning matrices (column-major 4×4 per bone) for item `index`. */
  setPalette(index: number, matrices: Float32Array): void {
    const p = this.palettes[index];
    if (p) this.device.queue.writeBuffer(p.buf, 0, matrices.subarray(0, p.count * 16));
  }

  clear(): void {
    for (const o of this.owned) o.destroy();
    this.owned = [];
    this.draws = [];
    this.drawsByItem = null;
    this.palettes = [];
    this.itemInst = [];
    this.stats = { meshes: 0, triangles: 0, vertices: 0, draws: 0, textured: 0 };
  }

  destroy(): void {
    this.clear();
    this.depth?.destroy();
    this.msaa?.destroy();
    this.white.destroy();
    this.identityPalette.destroy();
    this.identityInstance.destroy();
    this.camBuf.destroy();
  }
}
