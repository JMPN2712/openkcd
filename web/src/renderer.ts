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
import type { CgfMesh, Subset } from "./cgf.ts";
import { GeometryStore, type Range } from "./geometryStore.ts";
import { uploadChain, type PooledTexture, type TexturePool } from "./texturePool.ts";
import { colorizeOf } from "./mtl.ts";
import { ShadowMap, SHADOW_FORMAT, SHADOW_WGSL } from "./shadow.ts";
import { DEFAULT_LIGHTING, depthCompare, depthFormat, lookAt, multiply, perspective, transformPoint, type Lighting, type PassSetup, type Vec3 } from "./mat4.ts";

// position 3f, normal 3f, uv 2f, bone ids u16×4, weights unorm8×4, tangent 4f (w handedness), colour unorm8×4
const VERTEX_BYTES = 64;
/**
 * Largest shared vertex or index buffer (meshes are packed into as many as needed). One buffer per
 * mesh made Chrome's GPU process check thousands of buffers on every submit.
 */
const GEOMETRY_CHUNK = 128 * 2 ** 20;

/** Bytes per draw in the shared uniform buffer (208 used; bindings start at 256-byte multiples). */
const UNIFORM_SLOT = 256;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const SHADER = /* wgsl */ `${SHADOW_WGSL}
// light.w = 1 for flat shading; eye.w = -1 for reversed-Z; fog.w = density per metre
struct Camera { viewProj: mat4x4f, eye: vec4f, light: vec4f, sunColor: vec4f, skyColor: vec4f, groundColor: vec4f, fog: vec4f };
// params: x alpha test, y diffuse map, z specular map, w layer
// colorize: KCD %COLORIZING shader, x/y/z = hue (deg) / saturation / brightness, w = 0 off, 1 global, 2 with mask
//   (the "Specular" slot then holds the region mask: R/G/B select mask1/2/3)
// flags: x = 1 with a normal map; y = 1 water (Water, Waterfall shaders), 2 glass, 3 decal: blended;
//   z = 1 vertex colours shade the surface (%VERTCOLORS); w scales a blended surface's alpha
// foliage (%LEAVES materials: grass, plants, tree leaves): rgb transmittance colour, w how much
//   light comes through from behind (BackDiffuseMultiplier); w = 0 not foliage
struct Draw { model: mat4x4f, color: vec4f, spec: vec4f, params: vec4f, colorize: vec4f, mask1: vec4f, mask2: vec4f, mask3: vec4f, flags: vec4f, foliage: vec4f };
// 1 when the pipeline has alpha to coverage (MSAA): alpha-tested edges become partial coverage
override alphaToCoverage: f32 = 0.0;
@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var shadowTex: texture_depth_2d_array;
@group(0) @binding(2) var shadowSamp: sampler_comparison;
@group(0) @binding(3) var<uniform> shadowU: Shadow;
// instanceIndices renderers: every instance's world matrix, picked by the per-instance index
@group(0) @binding(4) var<storage, read> instMats: array<mat4x4f>;
@group(1) @binding(0) var<uniform> drw: Draw;
@group(1) @binding(1) var tex: texture_2d<f32>;
@group(1) @binding(2) var samp: sampler;
@group(1) @binding(3) var specTex: texture_2d<f32>;
// skinning palette: model-space bone matrices × inverse bind pose (identity for static meshes)
@group(1) @binding(4) var<storage, read> bones: array<mat4x4f>;
// tangent-space normal map (BC5: X, Y; Z rebuilt)
@group(1) @binding(5) var normalTex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) n: vec3f,
  @location(1) uv: vec2f,
  @location(2) wpos: vec3f,
  @location(3) t: vec4f,
  @location(4) col: vec4f,
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f,
               @location(3) bi: vec4u, @location(4) bw: vec4f, @location(9) tan: vec4f, @location(10) vc: vec4f,
               @location(5) i0: vec4f, @location(6) i1: vec4f, @location(7) i2: vec4f, @location(8) i3: vec4f) -> VOut {
  return vertexOut(p, n, uv, bi, bw, tan, vc, mat4x4f(i0, i1, i2, i3));
}

@vertex fn vsIndexed(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f,
                     @location(3) bi: vec4u, @location(4) bw: vec4f, @location(9) tan: vec4f, @location(10) vc: vec4f,
                     @location(5) inst: u32) -> VOut {
  return vertexOut(p, n, uv, bi, bw, tan, vc, instMats[inst]);
}

fn vertexOut(p: vec3f, n: vec3f, uv: vec2f, bi: vec4u, bw: vec4f, tan: vec4f, vc: vec4f, instance: mat4x4f) -> VOut {
  var o: VOut;
  let sk = bones[bi.x] * bw.x + bones[bi.y] * bw.y + bones[bi.z] * bw.z + bones[bi.w] * bw.w;
  // per-instance world matrix (identity for single models)
  let world = instance * drw.model;
  var w = world * (sk * vec4f(p, 1.0));
  if (drw.flags.y > 2.5) {
    // decals and roads lie on the ground, whose triangulation differs a little from theirs:
    // pull them towards the eye (8 cm plus 0.3% of the distance) so the terrain never pokes through
    let toEye = cam.eye.xyz - w.xyz;
    let d = length(toEye);
    w = vec4f(w.xyz + toEye / max(d, 1e-3) * min(0.08 + d * 0.003, d * 0.5), 1.0);
  }
  o.pos = cam.viewProj * w;
  // layered character clothing shares the body's surface: pull outer layers slightly towards the camera
  // (reversed-Z: scale the depth up by 0.02% per layer, about 0.4 mm at 2 m)
  if (cam.eye.w > 0.0) { o.pos.z = o.pos.z - drw.params.w * 0.00004 * o.pos.w; } else { o.pos.z = o.pos.z * (1.0 + drw.params.w * 0.0002); }
  o.n = (world * (sk * vec4f(n, 0.0))).xyz;
  o.t = vec4f((world * (sk * vec4f(tan.xyz, 0.0))).xyz, tan.w);
  o.uv = uv;
  o.col = vc;
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

// shadow casters: depth only, alpha-tested (leaves)
@fragment fn fsShadow(i: VOut) {
  let a = textureSample(tex, samp, i.uv).a;
  if (drw.params.x > 0.0 && drw.params.y > 0.5 && a < drw.params.x) { discard; }
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  return shade(i);
}

// water and glass materials (flags.y 1 / 2): blended over the opaque scene
@fragment fn fsBlend(i: VOut) -> @location(0) vec4f {
  return shade(i);
}

// eye shadow shells (%EYE_AO_OVERLAY): the texture is a darkening mask (white in the middle of
// the eye, black at the lids and corners, alpha its coverage), multiplied over the eyeball; at
// full strength the lids got a hard black line, so 70%
@fragment fn fsOverlay(i: VOut) -> @location(0) vec4f {
  let t = textureSample(tex, samp, i.uv);
  return vec4f(mix(vec3f(1.0), t.rgb, t.a * 0.7), 1.0);
}

fn shade(i: VOut) -> vec4f {
  let t = textureSample(tex, samp, i.uv);
  let st = textureSample(specTex, samp, i.uv);
  var base = drw.color * select(vec4f(1.0), t, drw.params.y > 0.5);
  if (drw.flags.z > 0.5) { base = vec4f(base.rgb * i.col.rgb, base.a); }
  var specMap = select(vec3f(1.0), st.rgb, drw.params.z > 0.5);
  if (drw.colorize.w > 1.5) {
    let m = clamp(st.rgb, vec3f(0.0), vec3f(1.0));
    let rest = max(0.0, 1.0 - m.r - m.g - m.b);
    let c = base.rgb * rest + adjust(base.rgb, drw.mask1.xyz) * m.r + adjust(base.rgb, drw.mask2.xyz) * m.g + adjust(base.rgb, drw.mask3.xyz) * m.b;
    base = vec4f(c, base.a);
    specMap = vec3f(0.04);
  }
  if (drw.colorize.w > 0.5) { base = vec4f(adjust(base.rgb, drw.colorize.xyz), base.a); }
  // alpha test; with alpha to coverage the edge is spread over about a pixel (sharpened by fwidth)
  var coverage = 1.0;
  if (drw.params.x > 0.0) {
    coverage = select(step(drw.params.x, base.a), clamp((base.a - drw.params.x) / max(fwidth(base.a), 1e-4) + 0.5, 0.0, 1.0), alphaToCoverage > 0.5);
    if (coverage <= 0.0) { discard; }
  }
  var n = normalize(i.n);
  if (cam.light.w > 0.5) { n = normalize(cross(dpdx(i.wpos), dpdy(i.wpos))); }
  let v = normalize(cam.eye.xyz - i.wpos);
  // the side facing the viewer (layered duplicates' windings disagree with their normals)
  let flip = select(1.0, -1.0, dot(n, v) < 0.0);
  n = n * flip;
  // BC5 SNORM: X and Y already in -1..1
  let nm = textureSample(normalTex, samp, i.uv).rg;
  if (drw.flags.x > 0.5 && dot(i.t.xyz, i.t.xyz) > 1e-6) {
    let tt = normalize(i.t.xyz - n * dot(n, i.t.xyz));
    let bb = cross(n, tt) * i.t.w * flip;
    let nz = sqrt(max(0.0, 1.0 - dot(nm, nm)));
    n = normalize(tt * nm.x + bb * nm.y + n * nz);
  }
  let l = normalize(cam.light.xyz);
  var ndl = max(dot(n, l), 0.0);
  if (drw.foliage.w > 0.0) {
    // foliage: thin cards facing every way. Bend the normals up so a clump shades as one soft
    // surface instead of light and dark cards, and let sunlight through from behind
    let through = max(-dot(n, l), 0.0) * drw.foliage.w;
    n = normalize(n + vec3f(0.0, 0.0, 1.0));
    ndl = max(dot(n, l), 0.0) * 0.8 + through * dot(drw.foliage.rgb, vec3f(0.333)) * 0.6;
  }
  let hemi = mix(cam.groundColor.rgb, cam.skyColor.rgb, n.z * 0.5 + 0.5);
  // Blinn-Phong stand-in for the PBR specular colour, plus a flat "environment" term so metals read as metal
  let specCol = drw.spec.rgb * specMap;
  let spec = specCol * (pow(max(dot(n, normalize(l + v)), 0.0), 48.0) * ndl * 2.0 * cam.sunColor.rgb / 0.9 + hemi * 1.2);
  let fd = distance(i.wpos, cam.eye.xyz);
  let sh = shadowFactor(i.wpos, n, fd);
  var lin = base.rgb * (hemi + cam.sunColor.rgb * ndl * sh) + spec * mix(0.3, 1.0, sh);
  var alpha = coverage;
  if (drw.flags.y > 0.5) {
    // water / glass: the sky reflected at grazing angles (Schlick), the sun's glint, the material's
    // own texture as the body seen through; more opaque towards the horizon
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    let glint = pow(max(dot(n, normalize(l + v)), 0.0), 220.0) * 2.5 * sh;
    let water = drw.flags.y < 1.5;
    let bodyC = select(lin * 0.6 + cam.skyColor.rgb * 0.1, lin, water);
    lin = mix(bodyC, cam.skyColor.rgb * 1.5, fres) + cam.sunColor.rgb * glint;
    alpha = select(mix(0.25, 0.85, fres), mix(0.55, 0.95, fres), water);
    if (drw.flags.y > 2.5) {
      // decal (%DECAL: road strips, puddles, mud): the lit surface, faded by the texture's alpha and
      // the vertex alpha (strips fade out towards their edges)
      lin = base.rgb * (hemi + cam.sunColor.rgb * ndl * sh) + spec * mix(0.3, 1.0, sh);
      alpha = base.a * i.col.a;
    }
    alpha *= drw.flags.w;
  }
  lin = mix(lin, cam.fog.rgb, clamp(1.0 - exp(-fd * cam.fog.w), 0.0, 1.0));
  // target is a non-sRGB format: encode manually
  return vec4f(pow(clamp(lin, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), alpha);
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
  /** the draw's uniforms: uniformBuf (rebuilt with every setModels), or a kept slot (cached) */
  ubuf: GPUBuffer;
  uoff: number;
  /** kept across rebuilds with its model (modelDraws) */
  cached: boolean;
  /** the mesh's first vertex in its vertex chunk (firstIndex already counts from its chunk's start) */
  baseVertex: number;
  inst: GPUBuffer;
  instCount: number;
  /** the mesh's own node transform, composed with the item transform */
  meshTm: Float32Array;
  /** water or glass: drawn blended, after every opaque draw (drawBlended), never in shadows */
  blend: boolean;
  /** decals and roads (%DECAL): blended onto the ground right after the terrain (drawGround), before other objects */
  ground: boolean;
  /** an eye shadow shell (%EYE_AO_OVERLAY): multiplied over what is behind it, in the blended pass (blend is set too) */
  overlay: boolean;
  /** alpha-tested (leaves, hair): its texture decides its shadow */
  cutout: boolean;
  /** pooled diffuse, specular and normal textures (null: not pooled), the palette bound, and UV units per metre */
  pooled: (PooledTexture | null)[];
  palette: GPUBufferBinding;
  uvDensity: number;
}

/** Kept draws' uniforms: 256-byte slots in buffers of 1,024, handed out and taken back. */
class UniformSlots {
  private device: GPUDevice;
  private bufs: GPUBuffer[] = [];
  private spare: { buf: GPUBuffer; at: number }[] = [];

  constructor(device: GPUDevice) {
    this.device = device;
  }

  alloc(): { buf: GPUBuffer; at: number } {
    if (!this.spare.length) {
      const buf = this.device.createBuffer({ size: 1024 * UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.bufs.push(buf);
      for (let k = 1023; k >= 0; k--) this.spare.push({ buf, at: k * UNIFORM_SLOT });
    }
    return this.spare.pop()!;
  }

  free(r: { buf: GPUBuffer; at: number }): void {
    this.spare.push(r);
  }

  destroy(): void {
    for (const b of this.bufs) b.destroy();
    this.bufs = [];
    this.spare = [];
  }
}

/** A mesh's bounds under a transform, and its farthest point from the origin. */
function meshExtent(mesh: CgfMesh, tm: Float32Array): { min: Vec3; max: Vec3; radius: number } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let radius = 0;
  const P = mesh.positions;
  for (let i = 0; i < P.length; i += 3) {
    const p = transformPoint(tm, [P[i], P[i + 1], P[i + 2]]);
    for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], p[c]); max[c] = Math.max(max[c], p[c]); }
    radius = Math.max(radius, Math.hypot(p[0], p[1], p[2]));
  }
  return { min, max, radius };
}
/** meshExtent under the mesh's own transform (items without one of their own), once per mesh */
const meshExtents = new WeakMap<CgfMesh, { min: Vec3; max: Vec3; radius: number }>();

const uvDensities = new WeakMap<CgfMesh, Map<number, number>>();
function cachedUvDensity(mesh: CgfMesh, first: number, count: number): number {
  const m = uvDensities.get(mesh) ?? uvDensities.set(mesh, new Map()).get(mesh)!;
  let d = m.get(first);
  if (d === undefined) m.set(first, (d = uvDensity(mesh, first, count)));
  return d;
}

/** Translations (xyz) of 4×4 instance matrices. */
function positionsOf(m: Float32Array): Float32Array {
  const out = new Float32Array((m.length / 16) * 3);
  for (let i = 0; i < m.length / 16; i++) out.set(m.subarray(i * 16 + 12, i * 16 + 15), i * 3);
  return out;
}

/** A subset's texture coordinates per metre: sqrt(UV area / surface area) over its triangles (0 without UVs). */
function uvDensity(mesh: LoadedModel["cgf"]["meshes"][number], first: number, count: number): number {
  const P = mesh.positions, T = mesh.uvs, I = mesh.indices;
  if (!T) return 0;
  let area = 0, uvArea = 0;
  for (let t = first; t + 2 < first + count; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const ta = I[t] * 2, tb = I[t + 1] * 2, tc = I[t + 2] * 2;
    uvArea += Math.abs((T[tb] - T[ta]) * (T[tc + 1] - T[ta + 1]) - (T[tc] - T[ta]) * (T[tb + 1] - T[ta + 1]));
  }
  return area > 0 && uvArea > 0 ? Math.sqrt(uvArea / area) : 0;
}

/** Shaders whose surfaces are see-through: drawn in the blended pass. */
const BLENDED_SHADER = /^(water|waterfall|glass)$/i;

/**
 * One way of drawing the items (indirect mode): the camera, or a shadow cascade. Each view has
 * its own instance counts, packed instances, draw arguments and render bundles (bundles capture
 * the view's pipeline and camera bind group).
 */
interface View {
  pipeline: GPURenderPipeline;
  camBuf: GPUBuffer;
  camBind: GPUBindGroup;
  colorFormats: GPUTextureFormat[];
  depthFormat: GPUTextureFormat;
  sampleCount: number;
  counts: Uint32Array;
  pending: (Float32Array | Uint32Array | null)[];
  itemFirst: Uint32Array;
  packed: GPUBuffer | null;
  /** matrices (16 floats per instance), or instance indices (instanceIndices) */
  packedCpu: Float32Array | Uint32Array;
  args: Uint32Array;
  argsBuf: GPUBuffer | null;
  /** one bundle per item: null not recorded yet, undefined no draws */
  bundles: (GPURenderBundle | null | undefined)[];
  live: GPURenderBundle[];
  /** camera view only: the blended draws' bundles */
  blendBundles: (GPURenderBundle | null | undefined)[];
  liveBlend: GPURenderBundle[];
  groundBundles: (GPURenderBundle | null | undefined)[];
  liveGround: GPURenderBundle[];
  triangles: number;
  calls: number;
}

const VERTEX_LAYOUT: GPUVertexBufferLayout[] = [{
  arrayStride: VERTEX_BYTES,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x3" },
    { shaderLocation: 2, offset: 24, format: "float32x2" },
    { shaderLocation: 3, offset: 32, format: "uint16x4" },
    { shaderLocation: 4, offset: 40, format: "unorm8x4" },
    { shaderLocation: 9, offset: 44, format: "float32x4" },
    { shaderLocation: 10, offset: 60, format: "unorm8x4" },
  ],
}, {
  arrayStride: 64,
  stepMode: "instance",
  attributes: [0, 1, 2, 3].map((k) => ({ shaderLocation: 5 + k, offset: k * 16, format: "float32x4" as GPUVertexFormat })),
}];

/** instanceIndices: the second buffer holds one u32 per instance, an index into the instance matrices. */
const VERTEX_LAYOUT_INDEXED: GPUVertexBufferLayout[] = [VERTEX_LAYOUT[0], {
  arrayStride: 4,
  stepMode: "instance",
  attributes: [{ shaderLocation: 5, offset: 0, format: "uint32" }],
}];

/** A stand-in shadow map (always lit) per device, for renderers without shadows. */
const noShadows = new WeakMap<GPUDevice, ShadowMap>();

export class ModelRenderer {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly sampleCount: number;
  private reversedZ: boolean;
  private pipeline: GPURenderPipeline;
  private shadowPipeline: GPURenderPipeline | null = null;
  private blendPipeline: GPURenderPipeline;
  private overlayPipeline: GPURenderPipeline;
  private module: GPUShaderModule;
  private camLayout: GPUBindGroupLayout;
  private drawLayout: GPUBindGroupLayout;
  private pipelineLayout: GPUPipelineLayout;
  private camBuf: GPUBuffer;
  private camBind: GPUBindGroup;
  private sampler: GPUSampler;
  private white: GPUTexture;
  /** (0, 0): the unperturbed normal, for draws without a normal map */
  private flatNormal: GPUTexture;
  private draws: DrawItem[] = [];
  /**
   * Skinning palettes: every item's range of one shared buffer (aligned for binding), with a copy
   * on the CPU. setPalette only writes the copy; the changed span goes up in one writeBuffer before
   * the next draw. (One writeBuffer per NPC part, every frame, was a quarter of the main thread's
   * time in Chrome, where each call crosses into the GPU process.)
   */
  private palettes: ({ binding: GPUBufferBinding; at: number; count: number; slot: number } | null)[] = [];
  private paletteCpu = new Float32Array(0);
  private paletteBuf: GPUBuffer | null = null;
  /** per palette slot (in buffer order): changed since the last upload */
  private paletteDirty = new Uint8Array(0);
  private paletteSlots: { at: number; count: number }[] = [];
  private anyPaletteDirty = false;
  /** per item: its palette is an earlier item's (paletteKey) */
  private paletteFollower = new Uint8Array(0);
  /**
   * Every draw's uniforms in one buffer (a 256-byte slot each), with a copy on the CPU; changed
   * slots go up before the next draw. Chrome's WebGPU checks every buffer a pass uses on each
   * submit: one small buffer per draw made that the GPU process's largest cost.
   */
  private uniformBuf: GPUBuffer | null = null;
  private uniformCpu = new Float32Array(0);
  private uniformDirty = new Uint8Array(0);
  private anyUniformDirty = false;
  private itemInst: { buf: GPUBuffer; count: number; capacity: number }[] = [];
  private dynamicItems: number[] = [];
  /** per item: 1 when dynamic (dynamicItems as a lookup) */
  private isDynamic = new Uint8Array(0);
  private drawsByItem: Map<number, DrawItem[]> | null = null;
  private drawIndex: Map<number, number[]> | null = null;
  /**
   * Shadow views draw depth only, so an item's opaque sub-meshes that follow each other in one
   * index buffer (walls, roof and beams of a house; an NPC's head, eyes and mouth) go in one draw
   * there. Cut-outs stay apart (their texture decides the shadow). Per item: the draws, each with
   * its indirect-argument slot (merged ones after this.draws' slots). About 30% fewer shadow draws
   * in the world, half for NPCs: each draw costs Chrome's GPU process about a microsecond.
   */
  private shadowDraws: Map<number, { d: DrawItem; arg: number; firstIndex: number; count: number }[]> | null = null;
  private mergedArgs = 0;
  private identityPalette: GPUBuffer;
  private identityInstance: GPUBuffer;
  private owned: (GPUBuffer | GPUTexture)[] = [];
  private depth: GPUTexture | null = null;
  private msaa: GPUTexture | null = null;
  private pass: PassSetup;
  /**
   * Indirect mode (needs "indirect-first-instance"): every item's draws are recorded once into a
   * render bundle of drawIndexedIndirect; per frame the instances of all dynamic items are packed
   * into one buffer and each draw's instance count and first instance written to one argument
   * buffer, and only the bundles of items with instances run. Recording thousands of draws a
   * frame was the town's biggest CPU cost.
   */
  readonly indirect: boolean;
  /**
   * instanceIndices: instances are indices into matrices uploaded once per setModels (4 bytes an
   * instance each frame instead of 64). The world's 17,000 visible instances were copied twice
   * and uploaded every frame.
   */
  readonly indexed: boolean;
  private instMatsBuf: GPUBuffer | null = null;
  /** shared vertex and index buffers, and each mesh's ranges in them (per palette size: bone ids are clamped to it) */
  private vertexStore: GeometryStore;
  private indexStore: GeometryStore;
  private meshGeo = new Map<CgfMesh, Map<number, { v: Range; i: Range }>>();
  /**
   * Draws of models whose items have no transform, layer or skinning (the world, grass), kept
   * across setModels with their bind groups, pooled textures and uniforms: a streaming step only
   * builds the new models' draws. gen: the last setModels that used them.
   */
  private modelDraws = new Map<LoadedModel, { draws: DrawItem[]; gen: number }>();
  private generation = 0;
  private uniformSlots: UniformSlots;
  private instMatsCpu = new Float32Array(16);
  /** elements per instance in instance data: 16 floats, or 1 index */
  private instStride = 16;
  /** views[0] the camera; views[1 + c] shadow cascade c (indirect mode only) */
  private views: View[] = [];
  private shadow: ShadowMap | null = null;
  /** model-space bounds of everything drawn */
  bboxMin: Vec3 = [-1, -1, -1];
  bboxMax: Vec3 = [1, 1, 1];
  stats = { meshes: 0, triangles: 0, vertices: 0, draws: 0, textured: 0, drawCalls: 0 };
  /** shared streamed textures (texturePool.ts); without one, each renderer uploads its own */
  private pool: TexturePool | null;
  private unlisten: (() => void) | null = null;
  /** draws by pooled texture, for rebuilding their bind groups when it changes size */
  private drawsByTexture = new Map<PooledTexture, DrawItem[]>();
  /** per item: model-space bounding radius, and the position of fixed items (transform or instances) */
  private itemRadius: number[] = [];
  private itemFixed: (Float32Array | null)[] = [];
  private eye: Vec3 = [0, 0, 0];
  private requestFrame = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, sampleCount = 4, opts: { reversedZ?: boolean; pool?: TexturePool; instanceIndices?: boolean } = {}) {
    this.pool = opts.pool ?? null;
    if (this.pool) this.unlisten = this.pool.onChange((changed) => this.texturesChanged(changed));
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
    this.reversedZ = opts.reversedZ ?? false;
    const pass: PassSetup = { sampleCount, reversedZ: this.reversedZ };
    this.pass = pass;
    this.indirect = device.features.has("indirect-first-instance");
    this.indexed = !!opts.instanceIndices && this.indirect;
    const chunk = Math.min(GEOMETRY_CHUNK, device.limits.maxBufferSize);
    this.vertexStore = new GeometryStore(device, GPUBufferUsage.VERTEX, chunk, VERTEX_BYTES);
    this.indexStore = new GeometryStore(device, GPUBufferUsage.INDEX, chunk, 4);
    this.uniformSlots = new UniformSlots(device);
    this.instStride = this.indexed ? 1 : 16;
    this.identityPalette = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.identityPalette, 0, IDENTITY);
    this.module = device.createShaderModule({ code: SHADER });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, F = GPUShaderStage.FRAGMENT;
    this.camLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: F, texture: { sampleType: "depth", viewDimension: "2d-array" } },
        { binding: 2, visibility: F, sampler: { type: "comparison" } },
        { binding: 3, visibility: F, buffer: { type: "uniform" } },
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    this.drawLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: F, texture: { sampleType: "float" } },
        { binding: 2, visibility: F, sampler: { type: "filtering" } },
        { binding: 3, visibility: F, texture: { sampleType: "float" } },
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: F, texture: { sampleType: "float" } },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.camLayout, this.drawLayout] });
    this.pipeline = device.createRenderPipeline({
      layout: this.pipelineLayout,
      vertex: this.vertexState(),
      fragment: { module: this.module, entryPoint: "fs", targets: [{ format }], constants: { alphaToCoverage: sampleCount > 1 ? 1 : 0 } },
      primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
      depthStencil: { format: depthFormat(pass), depthWriteEnabled: true, depthCompare: depthCompare(pass) },
      multisample: { count: sampleCount, alphaToCoverageEnabled: sampleCount > 1 },
    });
    this.blendPipeline = device.createRenderPipeline({
      layout: this.pipelineLayout,
      vertex: this.vertexState(),
      fragment: {
        module: this.module, entryPoint: "fsBlend",
        targets: [{ format, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }],
      },
      primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
      depthStencil: { format: depthFormat(pass), depthWriteEnabled: false, depthCompare: depthCompare(pass) },
      multisample: { count: sampleCount },
    });
    this.overlayPipeline = device.createRenderPipeline({
      layout: this.pipelineLayout,
      vertex: this.vertexState(),
      fragment: {
        module: this.module, entryPoint: "fsOverlay",
        targets: [{ format, blend: { color: { srcFactor: "dst", dstFactor: "zero" }, alpha: { srcFactor: "zero", dstFactor: "one" } } }],
      },
      primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
      depthStencil: { format: depthFormat(pass), depthWriteEnabled: false, depthCompare: depthCompare(pass) },
      multisample: { count: sampleCount },
    });
    this.camBuf = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.camBind = this.cameraBind(this.camBuf, this.shadowOrStandIn());
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8 });
    this.identityInstance = device.createBuffer({ size: 64, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.identityInstance, 0, IDENTITY);
    this.white = device.createTexture({ size: [1, 1], format: "rgba8unorm-srgb", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.flatNormal = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.flatNormal }, new Uint8Array([0, 0, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
  }

  private shadowOrStandIn(): ShadowMap {
    if (this.shadow) return this.shadow;
    let s = noShadows.get(this.device);
    if (!s) noShadows.set(this.device, (s = new ShadowMap(this.device, 1, 0)));
    return s;
  }

  private cameraBind(buf: GPUBuffer, map: ShadowMap): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.camLayout,
      entries: [
        { binding: 0, resource: { buffer: buf } },
        { binding: 1, resource: map.arrayView },
        { binding: 2, resource: map.sampler },
        { binding: 3, resource: { buffer: map.buffer } },
        { binding: 4, resource: { buffer: this.instMatsBuf ?? this.identityPalette } },
      ],
    });
  }

  /** Add a draw to this set of draws (item and instances), indexed by its pooled textures. */
  private addDraw(d: DrawItem, item: number, inst: { buf: GPUBuffer; count: number }): void {
    d.item = item;
    d.inst = inst.buf;
    d.instCount = inst.count;
    this.draws.push(d);
    for (const e of d.pooled) if (e) { const l = this.drawsByTexture.get(e); if (l) l.push(d); else this.drawsByTexture.set(e, [d]); }
  }

  private releaseDraw(d: DrawItem): void {
    if (this.pool) for (const e of d.pooled) if (e) this.pool.release(e);
  }

  /**
   * One sub-mesh's draw: its material's textures (pooled), uniforms (written where `place` puts
   * them) and bind group; null for nodraw materials. Item and instances are set by addDraw.
   */
  private makeDraw(model: LoadedModel, mesh: CgfMesh, s: Subset, meshTm: Float32Array, layer: number, palette: { binding: GPUBufferBinding; count: number } | null,
    geo: { v: Range; i: Range }, textures: Map<MipChain, GPUTexture> | null, place: (u: Float32Array) => { buf: GPUBuffer; at: number }): DrawItem | null {
    const { buf: vb, at: vOff } = geo.v, { buf: ib, at: iOff } = geo.i;
    // a single (non-multi) material applies to every subset whatever its ID, as in CryEngine:
    // NPC bodies use material ID 4 with the one-material s1_body_normal.mtl (arms and hands were white)
    const mi = model.materials.length === 1 ? 0 : s.matId;
    const mat = model.materials[mi];
    if (mat?.nodraw) return null;
    const chain = model.diffuse[mi] ?? null;
    const specChain = model.specular[mi] ?? null;
    const normChain = mesh.tangents ? model.normal?.[mi] ?? null : null;
    const pooled: (PooledTexture | null)[] = [null, null, null];
    const gpu = (c: MipChain | null, slot: number, linear = false): GPUTextureView => {
      if (!c) return (slot === 2 ? this.flatNormal : this.white).createView();
      if (this.pool) {
        const e = (pooled[slot] = this.pool.acquire(c, linear));
        return e.view;
      }
      let t = textures!.get(c);
      if (!t) textures!.set(c, (t = this.upload(c, linear)));
      return t.createView();
    };
    const normTex = gpu(normChain, 2, true);
    const gpuTex = gpu(chain, 0);
    const specTex = gpu(specChain, 1);
    if (chain) this.stats.textured++;
    const u = new Float32Array(52);
    const decal = !!mat?.genMask.includes("%DECAL");
    const overlay = !!mat?.genMask.includes("%EYE_AO_OVERLAY");
    // water sheets on Illum (waterfalls, weirs: Opacity below 1) are see-through like decals,
    // but drawn with the blended surfaces rather than on the ground
    const sheet = !!mat && !decal && /^illum$/i.test(mat.shader) && mat.surfaceType === "mat_water" && mat.opacity < 1 && !mat.alphaTest;
    const blend = decal || sheet || BLENDED_SHADER.test(mat?.shader ?? "");
    // how opaque a blended surface is: the Waterfall shader's AlphaBlendMul (0.09 on the thin
    // film over a weir's stones), a sheet's Opacity
    const alphaScale = sheet ? mat.opacity : /^waterfall$/i.test(mat?.shader ?? "") ? Math.min(1, Number(mat!.params.AlphaBlendMul ?? 1)) * Math.min(1, mat!.opacity) : 1;
    // (on Vegetation materials the vertex colours are bending and wind weights, not colour; on
    // character skins they are masks: every eye vertex is 255,255,0, which made eyes yellow)
    const vertColors = !!mesh.colors && !mesh.boneIds && !!mat?.genMask.includes("%VERTCOLORS") && !/^vegetation$/i.test(mat.shader);
    u.set([normChain ? 1 : 0, decal || sheet ? 3 : blend ? (/glass/i.test(mat!.shader) ? 2 : 1) : 0, vertColors ? 1 : 0, alphaScale], 44);
    u.set(meshTm, 0);
    const col = mat?.diffuse ?? [0.8, 0.8, 0.8];
    u.set([col[0], col[1], col[2], 1], 16);
    // Hair-shader Specular (often 1,1,1) drives a subtle anisotropic sheen in the engine; as plain
    // reflectance it turned lashes and hair partings white, so scale it to a dielectric level
    const specular = mat?.specular ?? [0.04, 0.04, 0.04];
    u.set([...(/^hair$/i.test(mat?.shader ?? "") ? specular.map((v) => v * 0.05) : specular), 0], 20);
    u.set([decal ? 0 : mat?.alphaTest ?? 0, chain ? 1 : 0, specChain ? 1 : 0, layer], 24);
    if (/%LEAVES|%GRASS/.test(mat?.genMask ?? "")) {
      const tc = (mat.params.TransmittanceColor ?? "1,1,1").split(",").map(Number);
      u.set([tc[0] || 1, tc[1] || 1, tc[2] || 1, Number(mat.params.BackDiffuseMultiplier ?? 0.5) || 0.5], 48);
    }
    const cz = mat ? colorizeOf(mat) : null;
    if (cz) {
      u.set([...cz.global, cz.withMask && specChain ? 2 : 1], 28);
      cz.masks.forEach((m, k) => u.set([...m, 0], 32 + k * 4));
    }
    const { buf: ubuf, at: uoff } = place(u);
    const paletteBinding = palette ? palette.binding : { buffer: this.identityPalette };
    const bind = this.device.createBindGroup({
      layout: this.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: ubuf, offset: uoff, size: 208 } },
        { binding: 1, resource: gpuTex },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: specTex },
        { binding: 4, resource: paletteBinding },
        { binding: 5, resource: normTex },
      ],
    });
    return {
      vb, ib, firstIndex: s.firstIndex + iOff / 4, baseVertex: vOff / VERTEX_BYTES, count: s.numIndices, bind, item: -1, ubuf, uoff, cached: false, meshTm: mesh.transform,
      inst: this.identityInstance, instCount: 1, blend: (blend && !decal) || overlay, ground: decal, overlay,
      cutout: !decal && (mat?.alphaTest ?? 0) > 0,
      pooled, palette: paletteBinding, uvDensity: pooled.some(Boolean) ? cachedUvDensity(mesh, s.firstIndex, s.numIndices) : 0,
    };
  }

  /**
   * Upload the geometry of items a coming setModels will draw, a few milliseconds at a time
   * (yielding to the frame loop in between), so that setModels finds it ready: a streaming step
   * then costs no frame much more than `sliceMs` (returns the longest slice, ms). Unskinned meshes only (the world, grass); meshes the
   * next setModels doesn't use are freed by it.
   */
  async prepare(items: { model: LoadedModel; transform?: Float32Array; layer?: number }[], sliceMs = 4): Promise<number> {
    let t = performance.now(), longest = 0;
    for (const { model, transform, layer } of items) {
      const skinned = model.cgf.meshes.some((m) => m.boneIds && m.boneWeights && model.skeleton);
      // the draws setModels would keep for this model (see modelDraws), built now
      const keep = !!this.pool && !transform && !layer && !skinned && !this.modelDraws.has(model);
      const draws: DrawItem[] = [];
      for (const mesh of model.cgf.meshes) {
        if (mesh.boneIds && mesh.boneWeights) continue;
        let geo = this.meshGeo.get(mesh)?.get(0);
        if (!geo) (this.meshGeo.get(mesh) ?? this.meshGeo.set(mesh, new Map()).get(mesh)!).set(0, (geo = this.uploadMesh(mesh, 0)));
        if (!transform && !meshExtents.has(mesh)) meshExtents.set(mesh, meshExtent(mesh, mesh.transform));
        for (const s of mesh.subsets) {
          cachedUvDensity(mesh, s.firstIndex, s.numIndices);
          if (!keep) continue;
          const d = this.makeDraw(model, mesh, s, mesh.transform, 0, null, geo, null, (u) => {
            const r = this.uniformSlots.alloc();
            this.device.queue.writeBuffer(r.buf, r.at, u);
            return r;
          });
          if (d) { d.cached = true; draws.push(d); }
        }
      }
      // (gen: the current set's, so a setModels that leaves the model out gives them back)
      if (keep) this.modelDraws.set(model, { draws, gen: this.generation });
      if (performance.now() - t > sliceMs) {
        longest = Math.max(longest, performance.now() - t);
        await new Promise((r) => setTimeout(r, 0));
        t = performance.now();
      }
    }
    return Math.max(longest, performance.now() - t);
  }

  /** A mesh's vertices in the renderer's layout (bone ids clamped to a palette of `paletteCount`; 0: not skinned), uploaded. */
  private uploadMesh(mesh: CgfMesh, paletteCount: number): { v: Range; i: Range } {
    const nv = mesh.positions.length / 3;
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
      if (mesh.tangents) verts.set(mesh.tangents.subarray(i * 4, i * 4 + 4), i * F + 11);
      for (let k = 0; k < 4; k++) wts[i * VERTEX_BYTES + 60 + k] = mesh.colors ? mesh.colors[i * 4 + k] : 255;
      if (paletteCount) {
        for (let k = 0; k < 4; k++) {
          ids[i * U + 16 + k] = Math.min(mesh.boneIds![i * 4 + k], paletteCount - 1);
          wts[i * VERTEX_BYTES + 40 + k] = mesh.boneWeights![i * 4 + k];
        }
      } else {
        wts[i * VERTEX_BYTES + 40] = 255; // bone 0 of the identity palette
      }
    }
    const v = this.vertexStore.alloc(raw.byteLength);
    const i = this.indexStore.alloc(Math.ceil(mesh.indices.byteLength / 4) * 4);
    this.device.queue.writeBuffer(v.buf, v.at, verts);
    if (mesh.indices.byteLength) this.device.queue.writeBuffer(i.buf, i.at, mesh.indices);
    return { v, i };
  }

  private vertexState(): GPUVertexState {
    return { module: this.module, entryPoint: this.indexed ? "vsIndexed" : "vs", buffers: this.indexed ? VERTEX_LAYOUT_INDEXED : VERTEX_LAYOUT };
  }

  /**
   * Receive (and, in indirect mode, cast) shadows from `map` (null: none). Casting uses one view
   * per cascade: fill it with setShadowInstances() and draw it with drawShadow().
   */
  setShadow(map: ShadowMap | null): void {
    this.shadow = map && map.cascades ? map : null;
    this.camBind = this.cameraBind(this.camBuf, this.shadowOrStandIn());
    if (this.shadow && this.indirect && !this.shadowPipeline) {
      this.shadowPipeline = this.device.createRenderPipeline({
        layout: this.pipelineLayout,
        vertex: this.vertexState(),
        fragment: { module: this.module, entryPoint: "fsShadow", targets: [] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        // slope-scaled bias against acne on surfaces at grazing light
        depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: "less", depthBias: 2, depthBiasSlopeScale: 2.5 },
      });
    }
    this.buildViews();
  }

  /** (Re)create the views for the current items: the camera, then one per shadow cascade. */
  private buildViews(): void {
    for (const v of this.views) { v.camBuf !== this.camBuf && v.camBuf.destroy(); v.packed?.destroy(); v.argsBuf?.destroy(); }
    this.views = [];
    if (!this.indirect) return;
    const items = this.itemInst.length;
    const total = this.dynamicItems.reduce((s, k) => s + this.itemInst[k].capacity, 0);
    // (shadow views also hold the merged shadow draws' arguments, after the draws')
    if (this.shadow) this.shadowDrawsOf(0);
    const make = (pipeline: GPURenderPipeline, camBuf: GPUBuffer, camBind: GPUBindGroup, colorFormats: GPUTextureFormat[], depth: GPUTextureFormat, samples: number, shadow = false): View => {
      const packed = this.device.createBuffer({ size: Math.max(1, total) * this.instStride * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      const args = new Uint32Array(Math.max(1, this.draws.length + (shadow ? this.mergedArgs : 0)) * 5);
      const argsBuf = this.device.createBuffer({ size: args.byteLength, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
      const counts = new Uint32Array(items);
      this.itemInst.forEach((it, k) => { if (!this.isDynamic[k]) counts[k] = it.count; });
      return {
        pipeline, camBuf, camBind, colorFormats, depthFormat: depth, sampleCount: samples, counts,
        pending: new Array(items).fill(null), itemFirst: new Uint32Array(items), packed, packedCpu: this.indexed ? new Uint32Array(Math.max(1, total)) : new Float32Array(Math.max(1, total) * 16),
        args, argsBuf, bundles: new Array(items).fill(null), live: [], blendBundles: new Array(items).fill(null), liveBlend: [], groundBundles: new Array(items).fill(null), liveGround: [], triangles: 0, calls: 0,
      };
    };
    this.views.push(make(this.pipeline, this.camBuf, this.camBind, [this.format], depthFormat(this.pass), this.sampleCount));
    if (this.shadow && this.shadowPipeline) {
      for (let c = 0; c < this.shadow.cascades; c++) {
        const buf = this.device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        // casters bind the stand-in map (a texture can't be sampled while it is the depth target)
        this.views.push(make(this.shadowPipeline, buf, this.cameraBind(buf, noShadows.get(this.device) ?? this.shadowOrStandInFresh()), [], SHADOW_FORMAT, 1, true));
      }
    }
  }

  private shadowOrStandInFresh(): ShadowMap {
    const s = new ShadowMap(this.device, 1, 0);
    noShadows.set(this.device, s);
    return s;
  }

  private upload(chain: MipChain, linear = false): GPUTexture {
    const t = uploadChain(this.device, chain, linear);
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
    /** items with the same key share one skinning palette (same bones, same bind poses) */
    paletteKey?: string;
  }[], instanceMatrices?: Float32Array): void {
    this.clear();
    if (this.indexed) {
      // (instanceIndices) the matrices setInstances' indices point into, and an identity after
      // them for items without instances
      const n = (instanceMatrices?.length ?? 0) / 16;
      this.instMatsCpu = new Float32Array((n + 1) * 16);
      if (instanceMatrices) this.instMatsCpu.set(instanceMatrices);
      this.instMatsCpu.set(IDENTITY, n * 16);
      this.instMatsBuf = this.device.createBuffer({ size: this.instMatsCpu.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(this.instMatsBuf, 0, this.instMatsCpu);
      this.owned.push(this.instMatsBuf);
      this.device.queue.writeBuffer(this.identityInstance, 0, new Uint32Array([n]));
      this.camBind = this.cameraBind(this.camBuf, this.shadowOrStandIn());
    }
    this.itemRadius = items.map(() => 0);
    this.itemFixed = items.map(({ transform, instances, capacity }) => (capacity !== undefined ? null : transform ? transform.slice(12, 15) : instances?.length ? positionsOf(instances) : new Float32Array(3)));
    const align = this.device.limits.minStorageBufferOffsetAlignment;
    let paletteBytes = 0;
    const slots: { at: number; n: number }[] = [];
    const byKey = new Map<string, number>();
    const slotOf = items.map(({ model, paletteKey }) => {
      const n = model.skeleton && model.cgf.meshes.some((m) => m.boneIds) ? model.skeleton.bones.length : 0;
      if (!n) return -1;
      const shared = paletteKey !== undefined ? byKey.get(paletteKey) : undefined;
      if (shared !== undefined && slots[shared].n === n) return shared;
      slots.push({ at: paletteBytes, n });
      paletteBytes += Math.ceil((n * 64) / align) * align;
      if (paletteKey !== undefined) byKey.set(paletteKey, slots.length - 1);
      return slots.length - 1;
    });
    this.paletteCpu = new Float32Array(paletteBytes / 4);
    this.paletteBuf = paletteBytes ? this.device.createBuffer({ size: paletteBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }) : null;
    if (this.paletteBuf) this.owned.push(this.paletteBuf);
    this.paletteDirty = new Uint8Array(slots.length);
    this.anyPaletteDirty = false;
    this.paletteSlots = slots.map((p) => ({ at: p.at / 4, count: p.n }));
    for (const p of slots) for (let i = 0; i < p.n; i++) this.paletteCpu.set(IDENTITY, p.at / 4 + i * 16);
    this.palettes = slotOf.map((k) => {
      if (k < 0) return null;
      const p = slots[k];
      return { binding: { buffer: this.paletteBuf!, offset: p.at, size: p.n * 64 }, at: p.at / 4, count: p.n, slot: k };
    });
    const seen = new Set<number>();
    this.paletteFollower = Uint8Array.from(slotOf, (k) => (k < 0 ? 0 : seen.has(k) ? 1 : (seen.add(k), 0)));
    if (this.paletteBuf) this.device.queue.writeBuffer(this.paletteBuf, 0, this.paletteCpu);
    const textures = new Map<MipChain, GPUTexture>();
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    // indirect mode: dynamic items' instances go to each view's packed buffer (buildViews)
    this.dynamicItems = items.flatMap((it, k) => (it.capacity !== undefined ? [k] : []));
    this.isDynamic = Uint8Array.from(items, (it) => (it.capacity !== undefined ? 1 : 0));
    // a placeholder for dynamic items' draws: the bundles bind the view's packed buffer instead
    const packedMark = this.identityInstance;
    this.itemInst = items.map(({ instances, capacity }) => {
      if (capacity !== undefined) {
        if (this.indirect) return { buf: packedMark, count: 0, capacity };
        const buf = this.device.createBuffer({ size: Math.max(1, capacity) * 64, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        this.owned.push(buf);
        return { buf, count: 0, capacity };
      }
      if (!instances?.length) return { buf: this.identityInstance, count: 1, capacity: 1 };
      if (this.indexed) throw new Error("instanceIndices renderers take instances through setInstances only");
      const buf = this.device.createBuffer({ size: instances.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buf, 0, instances);
      this.owned.push(buf);
      return { buf, count: instances.length / 16, capacity: instances.length / 16 };
    });
    const instBufs = this.itemInst;
    // items whose draws depend on their model alone (no transform, layer or skinning) keep them
    // across rebuilds (modelDraws); a model's second item in one set gets its own
    const seenModels = new Set<LoadedModel>();
    const cacheable = items.map(({ model, transform, layer }) => {
      const ok = !!this.pool && !transform && !layer && !model.cgf.meshes.some((m) => m.boneIds && m.boneWeights && model.skeleton) && !seenModels.has(model);
      seenModels.add(model);
      return ok;
    });
    let drawSlots = 0;
    items.forEach(({ model }, k) => {
      if (cacheable[k]) return;
      for (const mesh of model.cgf.meshes) for (const s of mesh.subsets) if (!model.materials[model.materials.length === 1 ? 0 : s.matId]?.nodraw) drawSlots++;
    });
    this.uniformBuf = drawSlots ? this.device.createBuffer({ size: drawSlots * UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) : null;
    if (this.uniformBuf) this.owned.push(this.uniformBuf);
    this.uniformCpu = new Float32Array((drawSlots * UNIFORM_SLOT) / 4);
    this.uniformDirty = new Uint8Array(drawSlots);
    this.anyUniformDirty = false;
    let slot = 0;
    // meshes keep their geometry (shared vertex and index buffers, GeometryStore) across rebuilds:
    // the ones this set no longer uses are freed, and only new ones are encoded and uploaded
    const paletteCountOf = (itemIndex: number, mesh: CgfMesh) => (mesh.boneIds && mesh.boneWeights ? this.palettes[itemIndex]?.count ?? 0 : 0);
    const needed = new Map<CgfMesh, Set<number>>();
    items.forEach(({ model }, k) => {
      for (const m of model.cgf.meshes) (needed.get(m) ?? needed.set(m, new Set()).get(m)!).add(paletteCountOf(k, m));
    });
    for (const [mesh, byCount] of this.meshGeo) {
      for (const [n, e] of byCount) if (!needed.get(mesh)?.has(n)) { this.vertexStore.free(e.v); this.indexStore.free(e.i); byCount.delete(n); }
      if (!byCount.size) this.meshGeo.delete(mesh);
    }
    this.vertexStore.trim();
    this.indexStore.trim();
    const gen = ++this.generation;
    for (const [itemIndex, { model, transform: partTm, layer = 0 }] of items.entries()) {
      const cached = cacheable[itemIndex] ? this.modelDraws.get(model) : undefined;
      for (const mesh of model.cgf.meshes) {
        const meshTm = partTm ? multiply(partTm, mesh.transform) : mesh.transform;
        const pc = paletteCountOf(itemIndex, mesh);
        let geo = this.meshGeo.get(mesh)?.get(pc);
        if (!geo) {
          geo = this.uploadMesh(mesh, pc);
          (this.meshGeo.get(mesh) ?? this.meshGeo.set(mesh, new Map()).get(mesh)!).set(pc, geo);
        }
        const ext = partTm ? meshExtent(mesh, meshTm) : (meshExtents.get(mesh) ?? meshExtents.set(mesh, meshExtent(mesh, meshTm)).get(mesh)!);
        for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], ext.min[c]); max[c] = Math.max(max[c], ext.max[c]); }
        if (ext.radius > this.itemRadius[itemIndex]) this.itemRadius[itemIndex] = ext.radius;
        this.stats.meshes++;
        this.stats.vertices += mesh.positions.length / 3;
        if (cached) continue;
        const palette = pc ? this.palettes[itemIndex] : null;
        for (const sub of mesh.subsets) {
          const d = this.makeDraw(model, mesh, sub, meshTm, layer, palette, geo, cacheable[itemIndex] ? null : textures, (u) => {
            if (cacheable[itemIndex]) {
              const r = this.uniformSlots.alloc();
              this.device.queue.writeBuffer(r.buf, r.at, u);
              return r;
            }
            const at = slot++ * UNIFORM_SLOT;
            this.uniformCpu.set(u, at / 4);
            return { buf: this.uniformBuf!, at };
          });
          if (!d) continue;
          if (cacheable[itemIndex]) {
            d.cached = true;
            const t = this.modelDraws.get(model) ?? this.modelDraws.set(model, { draws: [], gen }).get(model)!;
            t.draws.push(d);
          } else this.addDraw(d, itemIndex, instBufs[itemIndex]);
        }
      }
      // a model whose draws are kept: they only change item and instances
      const t = cacheable[itemIndex] ? this.modelDraws.get(model) : undefined;
      if (t) {
        t.gen = gen;
        for (const d of t.draws) this.addDraw(d, itemIndex, instBufs[itemIndex]);
      }
    }
    // models no longer drawn give back their textures and uniform slots
    for (const [model, t] of this.modelDraws) {
      if (t.gen === gen) continue;
      for (const d of t.draws) { this.releaseDraw(d); this.uniformSlots.free({ buf: d.ubuf, at: d.uoff }); }
      this.modelDraws.delete(model);
    }
    if (this.uniformBuf) this.device.queue.writeBuffer(this.uniformBuf, 0, this.uniformCpu);
    this.stats.draws = this.draws.length;
    if (min[0] <= max[0]) { this.bboxMin = min; this.bboxMax = max; }
    this.buildViews();
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
    this.drawGround(pass);
    this.draw(pass);
    this.drawBlended(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Light for the next setCamera (the viewers keep the default). */
  lighting: Lighting = DEFAULT_LIGHTING;

  /** Camera for the next draw(): view-projection, eye position, sun direction (lighting's own when omitted). */
  setCamera(viewProj: Float32Array, eye: Vec3, sun?: Vec3, flat = false): void {
    const L = this.lighting;
    this.eye = eye;
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
    this.uploadPalettes();
    if (this.indirect) {
      const v = this.views[0];
      if (!v) return;
      // (drawGround, earlier in the same pass, has already flushed the camera view)
      if (this.groundFlushed) this.groundFlushed = false;
      else this.flush(v);
      this.stats.triangles = v.triangles;
      this.stats.drawCalls = v.calls;
      if (v.live.length) pass.executeBundles(v.live);
      return;
    }
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.camBind);
    let tris = 0, calls = 0;
    for (const d of this.draws) {
      const n = this.itemInst[d.item]?.count ?? d.instCount;
      if (!n || !d.count || d.blend || d.ground) continue;
      pass.setVertexBuffer(0, d.vb);
      pass.setVertexBuffer(1, d.inst);
      pass.setIndexBuffer(d.ib, "uint32");
      pass.setBindGroup(1, d.bind);
      pass.drawIndexed(d.count, n, d.firstIndex, d.baseVertex);
      tris += (d.count / 3) * n;
      calls++;
    }
    this.stats.triangles = tris;
    /** draw calls recorded by the last draw() */
    this.stats.drawCalls = calls;
  }

  /** Record the water and glass draws: call after every renderer's opaque draw() in the pass. */
  drawBlended(pass: GPURenderPassEncoder): void {
    this.drawKind(pass, "blend");
  }

  /** Record the decals and roads: call right after the terrain, before any renderer's draw(). */
  drawGround(pass: GPURenderPassEncoder): void {
    this.drawKind(pass, "ground");
  }

  private drawKind(pass: GPURenderPassEncoder, kind: "blend" | "ground"): void {
    this.uploadPalettes();
    if (this.indirect) {
      const v = this.views[0];
      if (!v) return;
      // the ground comes first in the pass: flush here, and draw() then skips it
      if (kind === "ground") { this.flush(v); this.groundFlushed = true; }
      const live = kind === "blend" ? v.liveBlend : v.liveGround;
      if (live.length) pass.executeBundles(live);
      return;
    }
    pass.setBindGroup(0, this.camBind);
    for (const d of this.draws) {
      const n = this.itemInst[d.item]?.count ?? d.instCount;
      if (!n || !d.count || !d[kind]) continue;
      pass.setPipeline(d.overlay ? this.overlayPipeline : this.blendPipeline);
      pass.setVertexBuffer(0, d.vb);
      pass.setVertexBuffer(1, d.inst);
      pass.setIndexBuffer(d.ib, "uint32");
      pass.setBindGroup(1, d.bind);
      pass.drawIndexed(d.count, n, d.firstIndex, d.baseVertex);
    }
  }

  /**
   * Upload `count` instances for an item created with `capacity` (indirect mode: at the next draw):
   * matrices, or with instanceIndices indices into setModels' matrices.
   */
  setInstances(index: number, matrices: Float32Array | Uint32Array, count: number): void {
    const it = this.itemInst[index];
    if (!it) return;
    it.count = Math.min(count, it.capacity);
    const v = this.views[0];
    if (v) { v.counts[index] = it.count; v.pending[index] = matrices; }
    else if (it.count) this.device.queue.writeBuffer(it.buf, 0, matrices.subarray(0, it.count * 16));
  }

  /** Shadow casters in cascade `c`: like setInstances (items without capacity always cast). */
  setShadowInstances(c: number, index: number, matrices: Float32Array | Uint32Array, count: number): void {
    const v = this.views[1 + c], it = this.itemInst[index];
    if (!v || !it) return;
    v.counts[index] = Math.min(count, it.capacity);
    v.pending[index] = matrices;
  }

  /** Light view-projection of cascade `c` for the next drawShadow. */
  setShadowCamera(c: number, viewProj: Float32Array): void {
    const v = this.views[1 + c];
    if (!v) return;
    const cu = new Float32Array(40);
    cu.set(viewProj, 0);
    cu.set([0, 0, 0, 1], 16);
    this.device.queue.writeBuffer(v.camBuf, 0, cu);
  }

  /** Record cascade `c`'s casters into a depth-only pass (ShadowMap.beginPass). */
  drawShadow(pass: GPURenderPassEncoder, c: number): void {
    this.uploadPalettes();
    const v = this.views[1 + c];
    if (!v) return;
    this.flush(v);
    if (v.live.length) pass.executeBundles(v.live);
  }

  /**
   * Hide a fixed item from the camera but keep it in the shadow passes (first person: Henry's head
   * casts a shadow but isn't drawn). Indirect mode only; returns false when unsupported.
   */
  setItemHidden(index: number, hidden: boolean): boolean {
    const v = this.views[0], it = this.itemInst[index];
    if (!v || !it || this.isDynamic[index]) return false;
    v.counts[index] = hidden ? 0 : it.count;
    return true;
  }

  /** GPU bytes the kept geometry holds (vertex and index buffers), and of those in use. */
  geometryBytes(): { held: number; used: number } {
    const v = this.vertexStore.occupancy, i = this.indexStore.occupancy;
    return { held: v.held + i.held, used: v.used + i.used };
  }

  /** Draw calls the last flush of each view recorded: the camera, then each shadow cascade. */
  viewCalls(): number[] {
    return this.views.map((v) => v.calls);
  }

  /** Whether this renderer casts shadows (indirect mode with a shadow map set). */
  get castsShadows(): boolean {
    return this.views.length > 1;
  }

  /** Indirect mode: pack a view's dynamic instances, write its draw arguments, list its live bundles. */
  /** drawGround flushed the camera view this frame (draw() needn't again) */
  private groundFlushed = false;

  private flush(v: View): void {
    let off = 0;
    for (const k of this.dynamicItems) {
      const n = v.counts[k], m = v.pending[k];
      v.itemFirst[k] = off;
      if (!n || !m) { if (!m) v.counts[k] = 0; continue; }
      const S = this.instStride;
      v.packedCpu.set(m.subarray(0, n * S), off * S);
      off += n;
    }
    if (off) this.device.queue.writeBuffer(v.packed!, 0, v.packedCpu, 0, off * this.instStride);
    let tris = 0, calls = 0;
    const a = v.args;
    for (let i = 0; i < this.draws.length; i++) {
      const d = this.draws[i];
      const n = d.count ? v.counts[d.item] : 0;
      a[i * 5] = d.count;
      a[i * 5 + 1] = n;
      a[i * 5 + 2] = d.firstIndex;
      a[i * 5 + 3] = d.baseVertex;
      a[i * 5 + 4] = v.itemFirst[d.item];
      if (n) { tris += (d.count / 3) * n; calls++; }
    }
    let slots = this.draws.length;
    if (v !== this.views[0] && this.shadowDraws) {
      // shadow views: the merged draws' arguments, and their draw count instead
      calls = 0;
      for (const [item, l] of this.shadowDraws) {
        const n = v.counts[item];
        for (const e of l) {
          if (n) calls++;
          if (e.arg < this.draws.length) continue;
          const o = e.arg * 5;
          a[o] = e.count; a[o + 1] = n; a[o + 2] = e.firstIndex; a[o + 3] = e.d.baseVertex; a[o + 4] = v.itemFirst[item];
        }
      }
      slots += this.mergedArgs;
    }
    if (slots) this.device.queue.writeBuffer(v.argsBuf!, 0, a, 0, slots * 5);
    v.triangles = tris;
    v.calls = calls;
    if (this.pool && v === this.views[0] && ++this.requestFrame % 8 === 0) this.requestTextures(v.counts, v.pending);
    v.live.length = 0;
    v.liveBlend.length = 0;
    v.liveGround.length = 0;
    const camera = v === this.views[0];
    for (let k = 0; k < v.counts.length; k++) {
      if (!v.counts[k]) continue;
      let b = v.bundles[k];
      if (b === null) b = v.bundles[k] = this.record(v, k, "opaque");
      if (b) v.live.push(b);
      if (!camera) continue;
      let bb = v.blendBundles[k];
      if (bb === null) bb = v.blendBundles[k] = this.record(v, k, "blend");
      if (bb) v.liveBlend.push(bb);
      let gb = v.groundBundles[k];
      if (gb === null) gb = v.groundBundles[k] = this.record(v, k, "ground");
      if (gb) v.liveGround.push(gb);
    }
  }

  /**
   * Indirect mode: an item's draws, once, into a render bundle for a view (buffers and bind
   * groups are fixed until setModels). Items without draws get none.
   */
  private record(v: View, item: number, kind: "opaque" | "blend" | "ground"): GPURenderBundle | undefined {
    if (!this.drawIndex) {
      this.drawIndex = new Map();
      this.draws.forEach((d, i) => {
        const l = this.drawIndex!.get(d.item);
        if (l) l.push(i); else this.drawIndex!.set(d.item, [i]);
      });
    }
    const kindOf = (d: DrawItem) => (d.ground ? "ground" : d.blend ? "blend" : "opaque");
    const list = v !== this.views[0] && kind === "opaque"
      ? this.shadowDrawsOf(item).map((e) => e.arg)
      : this.drawIndex.get(item)?.filter((i) => kindOf(this.draws[i]) === kind);
    if (!list?.length) return undefined;
    // (blended draws never write depth: their bundles also run in a pass that holds the depth
    // read-only, so the water can sample it)
    const enc = this.device.createRenderBundleEncoder({ colorFormats: v.colorFormats, depthStencilFormat: v.depthFormat, sampleCount: v.sampleCount, depthReadOnly: kind === "blend", stencilReadOnly: kind === "blend" });
    let pipeline: GPURenderPipeline | null = null;
    enc.setBindGroup(0, v === this.views[0] ? this.camBind : v.camBind);
    const dynamic = this.isDynamic[item] === 1;
    let vb: GPUBuffer | null = null, ib: GPUBuffer | null = null, inst: GPUBuffer | null = null;
    const shadowOf = v !== this.views[0] && kind === "opaque" ? new Map(this.shadowDrawsOf(item).map((e) => [e.arg, e.d])) : null;
    for (const i of list) {
      const d = shadowOf ? shadowOf.get(i)! : this.draws[i];
      const ibuf = dynamic ? v.packed! : d.inst;
      const p = kind === "opaque" ? v.pipeline : d.overlay ? this.overlayPipeline : this.blendPipeline;
      if (p !== pipeline) enc.setPipeline((pipeline = p));
      if (d.vb !== vb) enc.setVertexBuffer(0, (vb = d.vb));
      if (ibuf !== inst) enc.setVertexBuffer(1, (inst = ibuf));
      if (d.ib !== ib) enc.setIndexBuffer((ib = d.ib), "uint32");
      enc.setBindGroup(1, d.bind);
      enc.drawIndexedIndirect(v.argsBuf!, i * 20);
    }
    return enc.finish();
  }

  /** An item's shadow draws (see shadowDraws), built on first use for every item. */
  private shadowDrawsOf(item: number): { d: DrawItem; arg: number; firstIndex: number; count: number }[] {
    if (!this.shadowDraws) {
      const map = new Map<number, { d: DrawItem; arg: number; firstIndex: number; count: number }[]>();
      let merged = 0;
      this.draws.forEach((d, i) => {
        if (d.blend || d.ground || !d.count) return;
        const l = map.get(d.item) ?? map.set(d.item, []).get(d.item)!;
        const last = l[l.length - 1];
        if (last && !d.cutout && !last.d.cutout && last.d.vb === d.vb && last.d.ib === d.ib && last.d.meshTm === d.meshTm && last.d.baseVertex === d.baseVertex && last.firstIndex + last.count === d.firstIndex) {
          // extend the run: it becomes (or already is) a merged draw with its own argument slot
          if (last.arg < this.draws.length) last.arg = this.draws.length + merged++;
          last.count += d.count;
          return;
        }
        l.push({ d, arg: i, firstIndex: d.firstIndex, count: d.count });
      });
      this.shadowDraws = map;
      this.mergedArgs = merged;
    }
    return this.shadowDraws.get(item) ?? [];
  }

  /**
   * Ask the pool for the texture sizes the visible draws need: the screen size of a texel at the
   * nearest instance of each item (distance to its bounding sphere), from the mesh's UV density.
   */
  private requestTextures(counts: Uint32Array, pending: (Float32Array | Uint32Array | null)[]): void {
    const pool = this.pool!, [ex, ey, ez] = this.eye;
    const nearest = new Float32Array(counts.length).fill(Infinity);
    for (let k = 0; k < counts.length; k++) {
      const n = counts[k];
      if (!n) continue;
      const m = pending[k], fixed = this.itemFixed[k];
      let best = Infinity;
      if (m && !fixed) {
        const M = this.indexed ? this.instMatsCpu : (m as Float32Array);
        for (let i = 0; i < n; i++) {
          const o = this.indexed ? m[i] * 16 : i * 16, s = Math.hypot(M[o], M[o + 1], M[o + 2]);
          const d = Math.hypot(M[o + 12] - ex, M[o + 13] - ey, M[o + 14] - ez) - this.itemRadius[k] * s;
          if (d < best) best = d;
        }
      } else if (fixed) {
        for (let i = 0; i < fixed.length; i += 3) {
          const d = Math.hypot(fixed[i] - ex, fixed[i + 1] - ey, fixed[i + 2] - ez) - this.itemRadius[k];
          if (d < best) best = d;
        }
      }
      nearest[k] = Math.max(0.5, best);
    }
    for (const d of this.draws) {
      const dist = nearest[d.item];
      if (dist === Infinity || !d.uvDensity) continue;
      // texels across the texture for one texel per pixel: pixels per metre / UV units per metre
      const dim = pool.pixelScale / (dist * d.uvDensity);
      for (const e of d.pooled) if (e) pool.request(e, dim);
    }
  }

  /** Pooled textures were replaced: rebuild the bind groups that used them, re-record their items' bundles. */
  private texturesChanged(changed: Set<PooledTexture>): void {
    const items = new Set<number>();
    for (const e of changed) {
      for (const d of this.drawsByTexture.get(e) ?? []) {
        const [dt, st, nt] = d.pooled;
        d.bind = this.device.createBindGroup({
          layout: this.drawLayout,
          entries: [
            { binding: 0, resource: { buffer: d.ubuf, offset: d.uoff, size: 208 } },
            { binding: 1, resource: dt ? dt.view : this.white.createView() },
            { binding: 2, resource: this.sampler },
            { binding: 3, resource: st ? st.view : this.white.createView() },
            { binding: 4, resource: d.palette },
            { binding: 5, resource: nt ? nt.view : this.flatNormal.createView() },
          ],
        });
        items.add(d.item);
      }
    }
    for (const v of this.views) for (const k of items) { v.bundles[k] = null; v.blendBundles[k] = null; v.groundBundles[k] = null; }
  }

  /** Number of bones in item `index`'s palette (0 = not skinned). */
  paletteSize(index: number): number {
    return this.palettes[index]?.count ?? 0;
  }

  /** Replace item `index`'s extra transform (e.g. a prop following an animated bone). */
  setItemTransform(index: number, transform: Float32Array): void {
    this.itemFixed[index]?.set(transform.subarray(12, 15));
    // draws of this item (indexed lazily: scanning every draw per item was O(items × draws) per frame)
    if (!this.drawsByItem) {
      this.drawsByItem = new Map();
      for (const d of this.draws) {
        const list = this.drawsByItem.get(d.item);
        if (list) list.push(d);
        else this.drawsByItem.set(d.item, [d]);
      }
    }
    for (const d of this.drawsByItem.get(index) ?? []) {
      if (d.cached) continue; // (shared by every item of its model: items with transforms are never cached)
      this.uniformCpu.set(multiply(transform, d.meshTm), d.uoff / 4);
      this.uniformDirty[d.uoff / UNIFORM_SLOT] = 1;
      this.anyUniformDirty = true;
    }
  }

  /** Upload skinning matrices (column-major 4×4 per bone) for item `index`. */
  setPalette(index: number, matrices: Float32Array): void {
    const p = this.palettes[index];
    if (!p) return;
    this.paletteCpu.set(matrices.subarray(0, p.count * 16), p.at);
    this.paletteDirty[p.slot] = 1;
    this.anyPaletteDirty = true;
  }

  /** Whether item `index` shares its palette with an earlier item (setModels paletteKey): no need to set it again. */
  paletteShared(index: number): boolean {
    return this.paletteFollower[index] === 1;
  }

  /** Upload the palettes and draw uniforms changed since the last draw: one writeBuffer per run of adjacent changed slots. */
  private uploadPalettes(): void {
    if (this.anyUniformDirty && this.uniformBuf) {
      const dirty = this.uniformDirty, F = UNIFORM_SLOT / 4;
      for (let i = 0; i < dirty.length; ) {
        if (!dirty[i]) { i++; continue; }
        let j = i;
        while (j + 1 < dirty.length && dirty[j + 1]) j++;
        this.device.queue.writeBuffer(this.uniformBuf, i * UNIFORM_SLOT, this.uniformCpu, i * F, (j - i) * F + 52);
        dirty.fill(0, i, j + 1);
        i = j + 1;
      }
      this.anyUniformDirty = false;
    }
    if (!this.anyPaletteDirty || !this.paletteBuf) return;
    const dirty = this.paletteDirty, slots = this.paletteSlots;
    for (let i = 0; i < slots.length; ) {
      if (!dirty[i]) { i++; continue; }
      let j = i;
      while (j + 1 < slots.length && dirty[j + 1]) j++;
      const from = slots[i].at, to = slots[j].at + slots[j].count * 16;
      this.device.queue.writeBuffer(this.paletteBuf, from * 4, this.paletteCpu, from, to - from);
      dirty.fill(0, i, j + 1);
      i = j + 1;
    }
    this.anyPaletteDirty = false;
  }

  clear(): void {
    for (const d of this.draws) if (!d.cached) this.releaseDraw(d);
    this.drawsByTexture.clear();
    for (const o of this.owned) o.destroy();
    this.owned = [];
    this.draws = [];
    this.drawsByItem = null;
    this.drawIndex = null;
    this.shadowDraws = null;
    this.mergedArgs = 0;
    for (const v of this.views) { if (v.camBuf !== this.camBuf) v.camBuf.destroy(); v.packed?.destroy(); v.argsBuf?.destroy(); }
    this.views = [];
    this.palettes = [];
    this.paletteBuf = null;
    this.uniformBuf = null;
    this.instMatsBuf = null;
    this.itemInst = [];
    this.stats = { meshes: 0, triangles: 0, vertices: 0, draws: 0, textured: 0, drawCalls: 0 };
  }

  destroy(): void {
    this.clear();
    for (const t of this.modelDraws.values()) for (const d of t.draws) this.releaseDraw(d);
    this.modelDraws.clear();
    this.uniformSlots.destroy();
    this.vertexStore.destroy();
    this.indexStore.destroy();
    this.meshGeo.clear();
    this.unlisten?.();
    this.depth?.destroy();
    this.msaa?.destroy();
    this.white.destroy();
    this.flatNormal.destroy();
    this.identityPalette.destroy();
    this.identityInstance.destroy();
    this.camBuf.destroy();
  }
}
