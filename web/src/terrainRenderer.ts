// WebGPU terrain renderer: the heightmap lives in an r16uint texture; one
// instanced grid patch per 64 m sector, at a resolution chosen per sector by
// distance (1/4/16 m). Each patch has a skirt (an extra ring pulled down) to
// hide cracks between neighbouring LODs. Colours come from slope and height
// until the terrain colour texture (cover.ctc) is decoded.

import { HEIGHT_UNIT, type Terrain } from "./terrain.ts";
import type { Cover } from "./cover.ts";
import type { DetailLayers } from "./terrainDetail.ts";
import { ShadowMap, SHADOW_WGSL } from "./shadow.ts";
import { decodeBC1 } from "./bcn.ts";
import { DEFAULT_LIGHTING, DEFAULT_PASS, depthCompare, depthFormat, lookAt, multiply, perspective, perspectiveReversed, type Lighting, type PassSetup, type Vec3 } from "./mat4.ts";

const SHADER = /* wgsl */ `${SHADOW_WGSL}
// params: x heightUnit, y size, z fog density, w cover gain (0 = none)
struct Cam { viewProj: mat4x4f, eye: vec4f, sun: vec4f, params: vec4f, sunColor: vec4f, skyColor: vec4f, groundColor: vec4f, fogColor: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var heights: texture_2d<u32>;
// terrain colour (cover.ctc), stored X-major: sample at (y, x) / size
@group(0) @binding(2) var cover: texture_2d<f32>;
@group(0) @binding(3) var coverSamp: sampler;
// detail layers: the layer index of each heightmap sample (255 none), the layer textures, and per
// layer (repeats per metre, average colour); info: x fade start, y fade end (m), z count
struct Layers { info: vec4f, layer: array<vec4f, 32> };
@group(0) @binding(4) var surface: texture_2d<u32>;
@group(0) @binding(5) var detail: texture_2d_array<f32>;
@group(0) @binding(6) var detailSamp: sampler;
@group(0) @binding(7) var<uniform> layers: Layers;
@group(0) @binding(8) var shadowTex: texture_depth_2d_array;
@group(0) @binding(9) var shadowSamp: sampler_comparison;
@group(0) @binding(10) var<uniform> shadowU: Shadow;

struct VOut { @builtin(position) pos: vec4f, @location(0) wpos: vec3f, @location(1) n: vec3f };

fn h(p: vec2i) -> f32 {
  let s = i32(cam.params.y);
  let q = clamp(p, vec2i(0), vec2i(s));
  return f32(textureLoad(heights, q, 0).r) * cam.params.x;
}

// vertex: xy = grid coordinate in samples within the patch, z = 1 for skirt vertices
// instance: xy = patch origin in samples, z = step in samples
@vertex fn vs(@location(0) g: vec3f, @location(1) inst: vec3f) -> VOut {
  let step = i32(inst.z);
  let p = vec2i(inst.xy) + vec2i(g.xy) * step;
  var z = h(p);
  let dx = h(p + vec2i(step, 0)) - h(p - vec2i(step, 0));
  let dy = h(p + vec2i(0, step)) - h(p - vec2i(0, step));
  let n = normalize(vec3f(-dx, -dy, 2.0 * f32(step)));
  if (g.z > 0.5) { z -= 4.0 * f32(step); }
  var o: VOut;
  let w = vec3f(vec2f(p), z);
  o.pos = cam.viewProj * vec4f(w, 1.0);
  o.wpos = w;
  o.n = n;
  return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let n = normalize(i.n);
  let slope = 1.0 - n.z;
  let grass = vec3f(0.20, 0.30, 0.11);
  let dry = vec3f(0.36, 0.36, 0.20);
  let rock = vec3f(0.33, 0.31, 0.28);
  var c = mix(grass, dry, smoothstep(120.0, 200.0, i.wpos.z));
  c = mix(c, rock, smoothstep(0.25, 0.5, slope));
  let cov = textureSample(cover, coverSamp, vec2f(i.wpos.y, i.wpos.x) / cam.params.y).rgb;
  c = select(c, cov * cam.params.w, cam.params.w > 0.0);
  // detail: blend the layers of the four samples around the pixel, each as a modulation of the
  // colour map (layer ÷ its average colour), fading out with distance
  let d0 = distance(i.wpos, cam.eye.xyz);
  // derivatives before any branch (explicit-gradient sampling inside it)
  let gdx = dpdx(i.wpos.xy);
  let gdy = dpdy(i.wpos.xy);
  let fade = 1.0 - smoothstep(layers.info.x, layers.info.y, d0);
  if (fade > 0.0 && layers.info.z > 0.0) {
    let g = i.wpos.xy;
    let p0 = vec2i(floor(g));
    let f = g - floor(g);
    let s = i32(cam.params.y);
    var acc = vec3f(0.0);
    var wsum = 0.0;
    for (var k = 0; k < 4; k++) {
      let o = vec2i(k & 1, k >> 1);
      let id = textureLoad(surface, clamp(p0 + o, vec2i(0), vec2i(s)), 0).r;
      let wx = select(1.0 - f.x, f.x, o.x == 1);
      let wy = select(1.0 - f.y, f.y, o.y == 1);
      let valid = id < 32u;
      let li = select(0u, id, valid);
      let L = layers.layer[li];
      let t = textureSampleGrad(detail, detailSamp, g * L.x, li, gdx * L.x, gdy * L.x).rgb;
      let w = select(0.0, wx * wy, valid);
      acc += w * t / max(L.yzw, vec3f(0.02));
      wsum += w;
    }
    if (wsum > 0.001) {
      let m = clamp(acc / wsum, vec3f(0.25), vec3f(2.5));
      c = c * mix(vec3f(1.0), m, fade * min(1.0, wsum * 1.5));
    }
  }
  let ndl = max(dot(n, normalize(cam.sun.xyz)), 0.0);
  let sh = shadowFactor(i.wpos, n, d0);
  var lit = c * (mix(cam.groundColor.rgb, cam.skyColor.rgb, n.z * 0.5 + 0.5) + cam.sunColor.rgb * ndl * sh);
  let fog = 1.0 - exp(-d0 * cam.params.z);
  lit = mix(lit, cam.fogColor.rgb, clamp(fog, 0.0, 1.0));
  return vec4f(pow(lit, vec3f(1.0 / 2.2)), 1.0);
}
`;

export interface FlyCamera {
  pos: Vec3;
  yaw: number; // radians, 0 = +x
  pitch: number;
}

const LODS = [1, 4, 16]; // sample steps
const PATCH = 64; // samples per patch side

/** The world view's vertical field of view (radians). */
export const FOV_Y = Math.PI / 3.2;

export class TerrainRenderer {
  readonly device: GPUDevice;
  readonly terrain: Terrain;
  private pipeline: GPURenderPipeline;
  private camBuf: GPUBuffer;
  private bind: GPUBindGroup;
  private heightTex: GPUTexture;
  private meshes: { vb: GPUBuffer; ib: GPUBuffer; count: number }[] = [];
  private instBufs: GPUBuffer[] = [];
  private depth: GPUTexture | null = null;
  private msaa: GPUTexture | null = null;
  readonly format: GPUTextureFormat;
  stats = { patches: [0, 0, 0], triangles: 0 };

  private coverTex: GPUTexture;
  private coverGain = 0;
  /** "bc1" (compressed upload), "rgba" (decoded fallback) or "none" */
  readonly coverMode: "bc1" | "rgba" | "none";

  private detailTex: GPUTexture;
  private surfaceTex: GPUTexture;
  private layerBuf: GPUBuffer;
  /** detail layers loaded (0 = colour map only) */
  detailLayers: number;

  constructor(device: GPUDevice, format: GPUTextureFormat, terrain: Terrain, cover?: Cover, pass: PassSetup = DEFAULT_PASS, detail?: DetailLayers, opts: { detailFade?: [number, number] } = {}) {
    this.device = device;
    this.format = format;
    this.terrain = terrain;
    const side = terrain.size + 1;
    this.heightTex = device.createTexture({ size: [side, side], format: "r16uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    // rows are 2-byte samples: bytesPerRow must be a multiple of 256, so upload in padded rows
    const rowBytes = Math.ceil((side * 2) / 256) * 256;
    const padded = new Uint16Array((rowBytes / 2) * side);
    for (let y = 0; y < side; y++) padded.set(terrain.heights.subarray(y * side, (y + 1) * side), (y * rowBytes) / 2);
    device.queue.writeTexture({ texture: this.heightTex }, padded, { bytesPerRow: rowBytes }, [side, side]);

    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
          { arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: depthFormat(pass), depthWriteEnabled: true, depthCompare: depthCompare(pass) },
      multisample: { count: pass.sampleCount },
    });
    this.camBuf = device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    ({ tex: this.coverTex, mode: this.coverMode } = this.uploadCover(cover));
    if (this.coverMode !== "none") this.coverGain = 2 * (cover?.brightness ?? 1); // CryEngine terrain doubles the colour map
    const coverSamp = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", maxAnisotropy: 8 });
    this.coverSamp = coverSamp;
    this.detailSamp = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8 });
    this.fade = opts.detailFade ?? [40, 160];
    ({ surfaceTex: this.surfaceTex, detailTex: this.detailTex, layerBuf: this.layerBuf } = this.uploadDetail(terrain, detail, this.fade));
    this.detailLayers = detail?.layers.length ?? 0;
    this.bind = this.bindGroup();
    for (const step of LODS) this.meshes.push(this.patchMesh(PATCH / step));
    const maxPatches = (terrain.size / PATCH) ** 2;
    for (let i = 0; i < LODS.length; i++) {
      this.instBufs.push(device.createBuffer({ size: maxPatches * 12, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }));
    }
  }

  /**
   * The cover mosaics are a ready-made mip chain (8192 → 256 px for Rataje).
   * Upload the BC1 blocks as-is when the device has texture-compression-bc;
   * otherwise decode depth ≤ 4 (≤ 4096 px) to RGBA.
   */
  private uploadCover(cover?: Cover): { tex: GPUTexture; mode: "bc1" | "rgba" | "none" } {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    if (!cover?.mosaics.length) {
      const tex = this.device.createTexture({ size: [1, 1], format: "rgba8unorm-srgb", usage });
      this.device.queue.writeTexture({ texture: tex }, new Uint8Array([128, 128, 128, 255]), { bytesPerRow: 4 }, [1, 1]);
      return { tex, mode: "none" };
    }
    const bc = this.device.features.has("texture-compression-bc");
    const levels = bc ? cover.mosaics : cover.mosaics.filter((m) => m.size <= 4096);
    const tex = this.device.createTexture({ size: [levels[0].size, levels[0].size], mipLevelCount: levels.length, format: bc ? "bc1-rgba-unorm-srgb" : "rgba8unorm-srgb", usage });
    levels.forEach((m, i) => {
      if (bc) {
        this.device.queue.writeTexture({ texture: tex, mipLevel: i }, m.bc1, { bytesPerRow: (m.size / 4) * 8 }, [m.size, m.size]);
      } else {
        const rgba = decodeBC1(m.bc1, m.size, m.size);
        this.device.queue.writeTexture({ texture: tex, mipLevel: i }, rgba as Uint8ClampedArray<ArrayBuffer>, { bytesPerRow: m.size * 4 }, [m.size, m.size]);
      }
    });
    return { tex, mode: bc ? "bc1" : "rgba" };
  }

  private coverSamp: GPUSampler;
  private detailSamp: GPUSampler;
  private fade: [number, number];

  private bindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: this.heightTex.createView() },
        { binding: 2, resource: this.coverTex.createView() },
        { binding: 3, resource: this.coverSamp },
        { binding: 4, resource: this.surfaceTex.createView() },
        { binding: 5, resource: this.detailTex.createView({ dimension: "2d-array" }) },
        { binding: 6, resource: this.detailSamp },
        { binding: 7, resource: { buffer: this.layerBuf } },
        { binding: 8, resource: this.shadowMap().arrayView },
        { binding: 9, resource: this.shadowMap().sampler },
        { binding: 10, resource: { buffer: this.shadowMap().buffer } },
      ],
    });
  }

  private shadow: ShadowMap | null = null;
  private standIn: ShadowMap | null = null;

  private shadowMap(): ShadowMap {
    return this.shadow ?? (this.standIn ??= new ShadowMap(this.device, 1, 0));
  }

  /** Receive shadows from `map` (null: none). */
  setShadow(map: ShadowMap | null): void {
    this.shadow = map && map.cascades ? map : null;
    this.bind = this.bindGroup();
  }

  /** Add (or replace) the detail layers after construction (they load in the background). */
  setDetail(detail: DetailLayers): void {
    this.surfaceTex.destroy();
    this.detailTex.destroy();
    this.layerBuf.destroy();
    ({ surfaceTex: this.surfaceTex, detailTex: this.detailTex, layerBuf: this.layerBuf } = this.uploadDetail(this.terrain, detail, this.fade));
    this.detailLayers = detail.layers.length;
    this.bind = this.bindGroup();
  }

  /** Surface layer map (r8uint, layer index per sample), the layer array and its parameters. */
  private uploadDetail(terrain: Terrain, detail: DetailLayers | undefined, fade: [number, number]) {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const n = detail?.layers.length ?? 0;
    const side = terrain.size + 1;
    let surfaceTex: GPUTexture;
    if (n) {
      surfaceTex = this.device.createTexture({ size: [side, side], format: "r8uint", usage });
      const row = Math.ceil(side / 256) * 256;
      const map = new Uint8Array(row * side).fill(255);
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        const l = detail!.layerOf[terrain.surface[y * side + x]];
        if (l >= 0 && l < 32) map[y * row + x] = l;
      }
      this.device.queue.writeTexture({ texture: surfaceTex }, map, { bytesPerRow: row }, [side, side]);
    } else {
      surfaceTex = this.device.createTexture({ size: [1, 1], format: "r8uint", usage });
      this.device.queue.writeTexture({ texture: surfaceTex }, new Uint8Array([255]), { bytesPerRow: 1 }, [1, 1]);
    }
    const size = n ? detail!.size : 1;
    const levels = n ? detail!.layers[0].length : 1;
    const detailTex = this.device.createTexture({ size: [size, size, Math.max(1, Math.min(n, 32))], mipLevelCount: levels, format: "rgba8unorm-srgb", usage });
    if (n) detail!.layers.slice(0, 32).forEach((mipsOf, k) => mipsOf.forEach((data, l) => {
      const s = Math.max(1, size >> l);
      this.device.queue.writeTexture({ texture: detailTex, mipLevel: l, origin: [0, 0, k] }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: s * 4 }, [s, s, 1]);
    }));
    else this.device.queue.writeTexture({ texture: detailTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
    const u = new Float32Array(4 + 32 * 4);
    u.set([fade[0], fade[1], Math.min(n, 32), 0], 0);
    for (let k = 0; k < Math.min(n, 32); k++) u.set([1 / detail!.metres[k], ...detail!.average[k]], 4 + k * 4);
    const layerBuf = this.device.createBuffer({ size: u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(layerBuf, 0, u);
    return { surfaceTex, detailTex, layerBuf };
  }

  /** Grid of (n+1)² vertices plus a skirt ring; returns indexed triangles. */
  private patchMesh(n: number): { vb: GPUBuffer; ib: GPUBuffer; count: number } {
    const verts: number[] = [];
    const idx: number[] = [];
    const V = (x: number, y: number, skirt: number) => { verts.push(x, y, skirt); return verts.length / 3 - 1; };
    const grid: number[][] = [];
    for (let y = 0; y <= n; y++) { grid.push([]); for (let x = 0; x <= n; x++) grid[y].push(V(x, y, 0)); }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const a = grid[y][x], b = grid[y][x + 1], c = grid[y + 1][x], d = grid[y + 1][x + 1];
      idx.push(a, b, d, a, d, c);
    }
    // skirt: duplicate the border, pulled down in the shader
    const border: [number, number][] = [];
    for (let x = 0; x <= n; x++) border.push([x, 0]);
    for (let y = 1; y <= n; y++) border.push([n, y]);
    for (let x = n - 1; x >= 0; x--) border.push([x, n]);
    for (let y = n - 1; y >= 1; y--) border.push([0, y]);
    const top = border.map(([x, y]) => grid[y][x]);
    const low = border.map(([x, y]) => V(x, y, 1));
    for (let i = 0; i < border.length; i++) {
      const j = (i + 1) % border.length;
      idx.push(top[i], top[j], low[j], top[i], low[j], low[i]);
    }
    const vb = this.device.createBuffer({ size: verts.length * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vb, 0, new Float32Array(verts));
    const ib = this.device.createBuffer({ size: idx.length * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ib, 0, new Uint32Array(idx));
    return { vb, ib, count: idx.length };
  }

  /**
   * View-projection for a fly camera (shared with other renderers drawing into the same pass).
   * With `reversed`, a reversed-Z infinite projection from `near` (default 1 cm).
   */
  static viewProj(cam: FlyCamera, aspect: number, opts: { reversed?: boolean; near?: number; fovY?: number } = {}): Float32Array {
    const dir: Vec3 = [Math.cos(cam.pitch) * Math.cos(cam.yaw), Math.cos(cam.pitch) * Math.sin(cam.yaw), Math.sin(cam.pitch)];
    const at: Vec3 = [cam.pos[0] + dir[0], cam.pos[1] + dir[1], cam.pos[2] + dir[2]];
    const fov = opts.fovY ?? FOV_Y;
    const proj = opts.reversed ? perspectiveReversed(fov, aspect, opts.near ?? 0.01) : perspective(fov, aspect, opts.near ?? 0.5, 12000);
    return multiply(proj, lookAt(cam.pos, at, [0, 0, 1]));
  }

  /** Upload camera uniforms and choose patch LODs for the next draw(). */
  prepare(cam: FlyCamera, viewProj: Float32Array, opts: { lodDistance?: number; lighting?: Lighting } = {}): void {
    // the terrain always had distance fog and a brighter ambient than models (0.35 flat, 0.9 sun)
    const L = opts.lighting ?? { ...DEFAULT_LIGHTING, skyColor: [0.35, 0.35, 0.35] as Vec3, groundColor: [0.35, 0.35, 0.35] as Vec3, fogDensity: 0.00018 };
    const u = new Float32Array(44);
    u.set(viewProj, 0);
    u.set([...cam.pos, 1], 16);
    u.set([...L.sunDir, 0], 20);
    u.set([HEIGHT_UNIT, this.terrain.size, L.fogDensity, this.coverGain], 24);
    u.set([...L.sunColor, 0], 28);
    u.set([...L.skyColor, 0], 32);
    u.set([...L.groundColor, 0], 36);
    u.set([...L.fogColor, 0], 40);
    this.device.queue.writeBuffer(this.camBuf, 0, u);
    const near = opts.lodDistance ?? 250;
    const per = this.terrain.size / PATCH;
    const lists: number[][] = LODS.map(() => []);
    for (let py = 0; py < per; py++) for (let px = 0; px < per; px++) {
      const d = Math.hypot((px + 0.5) * PATCH - cam.pos[0], (py + 0.5) * PATCH - cam.pos[1]);
      const l = d < near ? 0 : d < near * 4 ? 1 : 2;
      lists[l].push(px * PATCH, py * PATCH, LODS[l]);
    }
    this.stats.triangles = 0;
    lists.forEach((list, l) => {
      this.stats.patches[l] = list.length / 3;
      this.stats.triangles += (list.length / 3) * (this.meshes[l].count / 3);
      if (list.length) this.device.queue.writeBuffer(this.instBufs[l], 0, new Float32Array(list));
    });
  }

  /** Record the terrain draws into a pass set up like the constructor's PassSetup. */
  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    this.stats.patches.forEach((n, l) => {
      if (!n) return;
      const m = this.meshes[l];
      pass.setVertexBuffer(0, m.vb);
      pass.setVertexBuffer(1, this.instBufs[l]);
      pass.setIndexBuffer(m.ib, "uint32");
      pass.drawIndexed(m.count, n);
    });
  }

  render(target: GPUTexture, cam: FlyCamera, opts: { lodDistance?: number; lighting?: Lighting } = {}): void {
    const { width, height } = target;
    if (!this.depth || this.depth.width !== width || this.depth.height !== height) {
      this.depth?.destroy();
      this.msaa?.destroy();
      this.depth = this.device.createTexture({ size: [width, height], format: "depth24plus", sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.msaa = this.device.createTexture({ size: [width, height], format: this.format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    this.prepare(cam, TerrainRenderer.viewProj(cam, width / height), opts);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaa!.createView(), resolveTarget: target.createView(), clearValue: { r: 0.55, g: 0.62, b: 0.70, a: 1 }, loadOp: "clear", storeOp: "discard" }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    });
    this.draw(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    this.heightTex.destroy();
    this.coverTex.destroy();
    this.surfaceTex.destroy();
    this.detailTex.destroy();
    this.layerBuf.destroy();
    this.standIn?.destroy();
    this.camBuf.destroy();
    for (const m of this.meshes) { m.vb.destroy(); m.ib.destroy(); }
    for (const b of this.instBufs) b.destroy();
    this.depth?.destroy();
    this.msaa?.destroy();
  }
}
