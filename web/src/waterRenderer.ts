// Water surfaces from the level's water volumes (octree type 9): each volume
// is an outline polygon at the water height (rivers slope, so every vertex
// keeps its own z). Polygons are ear-clipped in XY and drawn in a blended pass
// after the opaque geometry: depth-tested, not depth-writing.
//
// The look, with the scene's depth bound (setDepth; the pass must hold depth read-only):
// - the volume's material (WaterVolume shader: a wave normal map, its tiling and strength for a
//   base and a detail layer, the shore softness) drives the surface; the two layers flow
//   downhill (a river's outline slopes), cross-fading two phases so the texture never stretches;
// - how much water is under each pixel (scene depth behind the surface) sets the transparency,
//   the colour (clear over the bed in the shallows, the volume's fog colour when deep) and a
//   soft, foamy edge at the banks;
// - reflections: the banks' dark band near the horizon, then haze, then sky; sun glitter.
// Without depth (the viewers, some scripts) the water is uniformly deep, as before.

import type { WaterVolume } from "./levelObjects.ts";
import { DEFAULT_PASS, depthCompare, depthFormat, type Lighting, type PassSetup, type Vec3 } from "./mat4.ts";
import { loadMipChain } from "./model.ts";
import { parseMtl } from "./mtl.ts";
import { textureFile } from "./mtl.ts";
import { uploadChain } from "./texturePool.ts";
import type { Vfs } from "./vfs.ts";

/** Floats per vertex: position, fog colour, flow (m/s in xy), material A, material B. */
const VERTEX_FLOATS = 16;

const shader = (msDepth: boolean) => /* wgsl */ `
// params: x time (s), z fog density, w near plane (0: no scene depth); sky.w scales the body
// colour with the light; sunColor scales the glint
struct Cam { viewProj: mat4x4f, eye: vec4f, sun: vec4f, params: vec4f, sky: vec4f, fogColor: vec4f, sunColor: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var sceneDepth: ${msDepth ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
@group(0) @binding(2) var waves: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
struct VOut {
  @builtin(position) pos: vec4f, @location(0) wpos: vec3f, @location(1) tint: vec3f, @location(2) flow: vec2f,
  // a: tiling (per metre), normal strength, detail tiling, detail strength; b: shore softness, specular, opacity, has a normal map
  @location(3) a: vec4f, @location(4) b: vec4f,
};
@vertex fn vs(@location(0) p: vec3f, @location(1) tint: vec3f, @location(2) flow: vec2f, @location(3) a: vec4f, @location(4) b: vec4f) -> VOut {
  var o: VOut;
  o.pos = cam.viewProj * vec4f(p, 1.0);
  o.wpos = p;
  o.tint = tint;
  o.flow = flow;
  o.a = a;
  o.b = b;
  return o;
}

// the wave normal map's slope (BC5 SNORM xy) at a point, scrolled by the flow over one phase
fn slope(p: vec2f, flow: vec2f, tiling: f32, scale: f32, t: f32, offset: f32) -> vec2f {
  let ph0 = fract(t * 0.25 + offset);
  let ph1 = fract(t * 0.25 + offset + 0.5);
  // drift on still water so it never freezes
  let f = flow + vec2f(0.05, 0.03);
  let s0 = textureSample(waves, samp, (p - f * ph0 * 4.0) * tiling).rg;
  let s1 = textureSample(waves, samp, (p - f * ph1 * 4.0) * tiling + vec2f(0.5)).rg;
  return mix(s0, s1, abs(ph0 * 2.0 - 1.0)) * scale;
}

// procedural ripples, without a normal map: slope of a sum of small wave trains
fn ripples(p: vec2f, t: f32) -> vec2f {
  let waves = array<vec4f, 6>(
    vec4f(1.0, 0.3, 3.7, 0.9), vec4f(-0.4, 1.0, 2.3, 0.7), vec4f(0.7, -0.8, 1.3, 0.5),
    vec4f(-1.0, -0.2, 0.9, 0.4), vec4f(0.2, 1.0, 0.6, 0.35), vec4f(0.9, 0.6, 0.45, 0.3));
  var g = vec2f(0.0);
  for (var k = 0; k < 6; k++) {
    let w = waves[k];
    let d = normalize(w.xy);
    let f = 6.2831853 / w.z;
    let drift = sin(dot(p, vec2f(0.031, 0.047) * f32(k + 1)) + t * 0.1) * 2.0;
    g += d * 0.035 * cos(dot(d, p) * f - t * w.w * f + drift);
  }
  return g;
}

// the wave map's width in texels (all water materials share one, 256 wide)
const WAVE_TEXELS = 256.0;

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let v = normalize(cam.eye.xyz - i.wpos);
  let d = distance(i.wpos, cam.eye.xyz);
  let t = cam.params.x;
  // detail fades out with distance (finer than a pixel there: it would only shimmer)
  let near = 1.0 - smoothstep(20.0, 160.0, d);
  // (both, then one picked: texture sampling must stay in uniform control flow)
  // each layer calms down where a pixel spans more than a texel or two of it: there the waves are
  // finer than a pixel and each one would flip the reflection between bank and sky (grain)
  let metres = max(length(dpdx(i.wpos.xy)), length(dpdy(i.wpos.xy))) * WAVE_TEXELS;
  let calm = clamp(3.0 / max(metres * i.a.x, 1e-3), 0.15, 1.0);
  let detail = clamp(1.0 / max(metres * i.a.z * 0.25, 1e-3) - 0.25, 0.0, 1.0);
  let mapped = slope(i.wpos.xy, i.flow, i.a.x, i.a.y * calm, t, 0.0) + slope(i.wpos.xy, i.flow * 1.3, i.a.z * 0.25, i.a.w * 0.15 * detail, t, 0.37);
  let g = select(ripples(i.wpos.xy, t) * near, mapped, i.b.w > 0.5);
  let n = normalize(vec3f(-g.x, -g.y, 1.0));
  let fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);

  // water under this pixel: how far the scene behind lies past the surface, along the view ray
  // (reversed infinite Z: depth = near / forward distance), as a vertical depth
  var depth = 50.0;
  if (cam.params.w > 0.0) {
    let px = vec2i(i.pos.xy);
    let sd = textureLoad(sceneDepth, px, 0);
    let fwdWater = cam.params.w / max(i.pos.z, 1e-7);
    let fwdScene = cam.params.w / max(sd, 1e-7);
    depth = max(fwdScene - fwdWater, 0.0) * (d / fwdWater) * max(v.z, 0.05);
  }

  // what the surface reflects: near the horizon mostly the banks and their trees (dark, green),
  // then the horizon haze, then the sky
  let r = reflect(-v, n);
  let bank = cam.fogColor.rgb * vec3f(0.32, 0.38, 0.3);
  let sky = mix(mix(bank, cam.fogColor.rgb, smoothstep(0.03, 0.12, r.z)), cam.sky.rgb * 0.85, smoothstep(0.12, 0.5, r.z));
  // the body: the volume's fog colour when deep; shallow water is mostly see-through
  let deep = (i.tint * 4.0 + vec3f(0.03, 0.06, 0.06)) * cam.sky.w;
  let h = normalize(normalize(cam.sun.xyz) + v);
  let glint = pow(max(dot(n, h), 0.0), 600.0) * 5.0 * smoothstep(0.0, 0.3, depth);
  var c = mix(deep, sky, fres) + glint * cam.sunColor.rgb;
  // see-through by depth: about 1.5 m to opaque, more at grazing angles (fresnel)
  var a = mix(1.0 - exp(-depth * 1.6), 1.0, fres) * i.b.z;
  // foam where the bank meets the water: broken up by the waves, moving with them
  let foam = (1.0 - smoothstep(0.0, 0.12, depth)) * smoothstep(0.05, 0.25, length(g) + 0.1 * sin(dot(i.wpos.xy, vec2f(3.1, 2.3)) + t)) * near;
  c = mix(c, vec3f(0.75, 0.78, 0.76) * cam.sky.w, foam * 0.6);
  a = max(a, foam * 0.5);
  // soft edge: no hard line where the surface cuts the bank (SoftIntersectionFactor: larger is sharper)
  a *= clamp(depth * 8.0 * i.b.x, 0.0, 1.0);
  c = mix(c, cam.fogColor.rgb, clamp(1.0 - exp(-d * cam.params.z), 0.0, 1.0));
  return vec4f(pow(c, vec3f(1.0 / 2.2)), a);
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

/** A water material's parameters (WaterVolume shader PublicParams), with defaults for volumes without one. */
interface WaterLook { tiling: number; normals: number; detailTiling: number; detailNormals: number; soft: number; specular: number; opacity: number; waves: string | null }
const DEFAULT_LOOK: WaterLook = { tiling: 0.125, normals: 0.3, detailTiling: 1.2, detailNormals: 2, soft: 1, specular: 0.08, opacity: 1, waves: null };

/** Per-vertex downhill flow (m/s) of an outline whose vertices keep their own heights. */
function flowOf(v: Float32Array, tris: number[]): Float32Array {
  const n = v.length / 3, out = new Float32Array(n * 2), w = new Float32Array(n);
  for (let k = 0; k < tris.length; k += 3) {
    const [a, b, c] = [tris[k], tris[k + 1], tris[k + 2]];
    const x1 = v[b * 3] - v[a * 3], y1 = v[b * 3 + 1] - v[a * 3 + 1], z1 = v[b * 3 + 2] - v[a * 3 + 2];
    const x2 = v[c * 3] - v[a * 3], y2 = v[c * 3 + 1] - v[a * 3 + 1], z2 = v[c * 3 + 2] - v[a * 3 + 2];
    const det = x1 * y2 - x2 * y1;
    if (Math.abs(det) < 1e-6) continue;
    // the plane's height gradient
    const gx = (z1 * y2 - z2 * y1) / det, gy = (x1 * z2 - x2 * z1) / det;
    const slope = Math.hypot(gx, gy);
    if (slope < 1e-5) continue;
    // a 1% slope runs at about 0.5 m/s, at most 1.5 m/s
    const speed = Math.min(1.5, slope * 50);
    const area = Math.abs(det) / 2;
    for (const i of [a, b, c]) { out[i * 2] += (-gx / slope) * speed * area; out[i * 2 + 1] += (-gy / slope) * speed * area; w[i] += area; }
  }
  for (let i = 0; i < n; i++) if (w[i]) { out[i * 2] /= w[i]; out[i * 2 + 1] /= w[i]; }
  return out;
}

export class WaterRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private camBuf: GPUBuffer;
  private bind: GPUBindGroup | null = null;
  private vb: GPUBuffer;
  private ib: GPUBuffer;
  private sampler: GPUSampler;
  private waves: GPUTexture;
  private depthView: GPUTextureView | null = null;
  private standInDepth: GPUTexture;
  private volumes: WaterVolume[];
  private tris: number[][] = [];
  private near = 0;
  readonly triangles: number;

  constructor(device: GPUDevice, format: GPUTextureFormat, volumes: WaterVolume[], pass: PassSetup = DEFAULT_PASS) {
    this.device = device;
    this.volumes = volumes;
    const idx: number[] = [];
    let base = 0;
    for (const w of volumes) {
      const n = w.vertices.length / 3;
      const xy: number[] = [];
      for (let k = 0; k < n; k++) xy.push(w.vertices[k * 3], w.vertices[k * 3 + 1]);
      const t = triangulate(xy);
      this.tris.push(t);
      for (const k of t) idx.push(base + k);
      base += n;
    }
    this.triangles = idx.length / 3;
    this.vb = device.createBuffer({ size: Math.max(64, base * VERTEX_FLOATS * 4), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.writeVertices(volumes.map(() => DEFAULT_LOOK));
    this.ib = device.createBuffer({ size: Math.max(16, idx.length * 4), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.ib, 0, new Uint32Array(idx));
    const module = device.createShaderModule({ code: shader(pass.sampleCount > 1) });
    const F = 4;
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [{
          arrayStride: VERTEX_FLOATS * F,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 3 * F, format: "float32x3" },
            { shaderLocation: 2, offset: 6 * F, format: "float32x2" }, { shaderLocation: 3, offset: 8 * F, format: "float32x4" },
            { shaderLocation: 4, offset: 12 * F, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module, entryPoint: "fs",
        targets: [{ format, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: depthFormat(pass), depthWriteEnabled: false, depthCompare: depthCompare(pass) },
      multisample: { count: pass.sampleCount },
    });
    this.camBuf = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8 });
    this.waves = device.createTexture({ size: [1, 1], format: "rgba8snorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.standInDepth = device.createTexture({ size: [1, 1], format: depthFormat(pass), sampleCount: pass.sampleCount, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  }

  private writeVertices(looks: WaterLook[]): void {
    const out: number[] = [];
    for (const [i, w] of this.volumes.entries()) {
      const L = looks[i], n = w.vertices.length / 3, flow = flowOf(w.vertices, this.tris[i]);
      for (let k = 0; k < n; k++) {
        out.push(w.vertices[k * 3], w.vertices[k * 3 + 1], w.vertices[k * 3 + 2], ...w.fogColor, flow[k * 2], flow[k * 2 + 1],
          L.tiling, L.normals, L.detailTiling, L.detailNormals, L.soft, L.specular, L.opacity, L.waves ? 1 : 0);
      }
    }
    if (out.length) this.device.queue.writeBuffer(this.vb, 0, new Float32Array(out));
  }

  /**
   * Read each volume's material (`names`: the terrain's material table) and the wave normal map.
   * Until this finishes, or without BC textures, the procedural ripples stand in.
   */
  async loadMaterials(vfs: Vfs, names: string[]): Promise<void> {
    const cache = new Map<string, WaterLook>();
    const looks: WaterLook[] = [];
    for (const w of this.volumes) {
      const name = names[w.material] ?? "";
      let look = cache.get(name);
      if (!look) {
        look = DEFAULT_LOOK;
        const hit = name ? vfs.lookup(`${name.toLowerCase()}.mtl`) : undefined;
        const m = hit ? parseMtl(new TextDecoder().decode(await vfs.read(hit)))[0] : undefined;
        if (m) {
          const p = (k: string, d: number) => { const v = Number(m.params[k]); return Number.isFinite(v) && m.params[k] !== undefined ? v : d; };
          look = {
            tiling: p("Tilling", DEFAULT_LOOK.tiling), normals: p("NormalsScale", DEFAULT_LOOK.normals),
            detailTiling: p("DetailTilling", DEFAULT_LOOK.detailTiling), detailNormals: p("DetailNormalsScale", DEFAULT_LOOK.detailNormals),
            soft: Math.max(0.2, p("SoftIntersectionFactor", DEFAULT_LOOK.soft)), specular: m.specular?.[0] ?? DEFAULT_LOOK.specular,
            opacity: Math.min(1, m.opacity ?? 1), waves: m.textures.get("Bumpmap") ?? null,
          };
        }
        cache.set(name, look);
      }
      looks.push(look);
    }
    // one wave map for all (every water material in the game uses the same one)
    const file = looks.find((l) => l.waves)?.waves;
    const chain = file ? await loadMipChain(vfs, textureFile(file), 512, { normalMap: true }).catch(() => null) : null;
    if (!chain) {
      this.writeVertices(looks.map((l) => ({ ...l, waves: null })));
      return;
    }
    this.waves.destroy();
    this.waves = uploadChain(this.device, chain, true);
    this.bind = null;
    this.writeVertices(looks);
  }

  /**
   * The opaque scene's depth (drawn first; this pass must hold it read-only), and the camera's
   * near plane for reversed infinite Z. Null: no depth effects.
   */
  setDepth(view: GPUTextureView | null, near = 0.1): void {
    if (view !== this.depthView) this.bind = null;
    this.depthView = view;
    this.near = view ? near : 0;
    // (setCamera may already have run this frame)
    this.device.queue.writeBuffer(this.camBuf, 27 * 4, new Float32Array([this.near]));
  }

  /** seconds, for the ripples */
  time = 0;

  setCamera(viewProj: Float32Array, eye: Vec3, sun: Vec3, fogDensity = 0.00018, lighting?: Lighting, skyColor?: Vec3): void {
    const u = new Float32Array(40);
    u.set(viewProj, 0);
    u.set([...eye, 1], 16);
    u.set([...(lighting?.sunDir ?? sun), 0], 20);
    u.set([this.time, 0, lighting?.fogDensity ?? fogDensity, this.near], 24);
    // sky.w scales the water body's own colour with the light (1 = the fixed look)
    const sky = skyColor ?? [0.55, 0.62, 0.7];
    u.set([...sky, lighting ? Math.min(1.5, (lighting.skyColor[0] + lighting.skyColor[1] + lighting.skyColor[2]) / 1.05 + 0.2 * (lighting.sunColor[0] + lighting.sunColor[1] + lighting.sunColor[2]) / 2.7) : 1], 28);
    u.set([...(lighting?.fogColor ?? [0.55, 0.62, 0.7]), 0], 32);
    u.set([...(lighting?.sunColor ?? [1, 1, 1]), 0], 36);
    this.device.queue.writeBuffer(this.camBuf, 0, u);
  }

  /** Draw after all opaque geometry in the same pass. */
  draw(pass: GPURenderPassEncoder): void {
    if (!this.triangles) return;
    this.bind ??= this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: this.depthView ?? this.standInDepth.createView() },
        { binding: 2, resource: this.waves.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });
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
    this.waves.destroy();
    this.standInDepth.destroy();
  }
}
