// Day and night: the sun's path, the light and the sky at a time of day, from the level's
// time-of-day profile (tod.ts), and a sky dome drawn behind everything.
//
// From the profile: "Sun color" and "Sun intensity" (lux-like: 100,000 at noon, 5,300 at 05:30;
// at night a grey 65, the moonlight), "Fog color" / "Fog color (top)" with their multipliers (the
// horizon and zenith of the sky, ×4 at noon, ×0.001 at night), "Sky light: Sun intensity" (the
// sky's blue), "Night sky: Star intensity", "Night sky: Moon color", and "Volumetric fog 2:
// Global fog density" for the distance haze. Sunrise and sunset are where the sun intensity
// spline rises and falls (05:00 and 21:00 in Rataje's profiles).
//
// APPROXIMATIONS: the game renders in HDR with automatic exposure; here every brightness is
// compressed by one fixed adaptation curve, (value ÷ its noon value)^0.35, so dawn and night stay
// readable. The sun's direction is not in the profile: it follows the astronomical path at
// Rataje's latitude (49.7° N) with the declination fitted to the profile's day length, east = +X,
// north = +Y. The moon is placed opposite the sun's path.

import type { Lighting, PassSetup, Vec3 } from "./mat4.ts";
import { depthFormat } from "./mat4.ts";
import { todColor, todNumber, type TimeOfDay, type TodProfile } from "./tod.ts";

const LATITUDE = (49.7 * Math.PI) / 180;
const ADAPT = 0.35;

export interface SkyState {
  lighting: Lighting;
  sunDir: Vec3;
  moonDir: Vec3;
  /** sky colours (display-referred, after adaptation) */
  horizon: Vec3;
  zenith: Vec3;
  /** sun disc / glow colour; 0 below the horizon */
  sunGlow: Vec3;
  stars: number;
  moon: Vec3;
  /** 0 day … 1 night */
  night: number;
}

/** The profile used: the given name, else the one with the highest priority (the commonest weather). */
export function pickProfile(tod: TimeOfDay, name?: string): TodProfile {
  return tod.profiles.find((p) => p.name === name) ?? [...tod.profiles].sort((a, b) => b.priority - a.priority)[0];
}

/** Sunrise and sunset hours: where "Sun intensity" jumps from moonlight (65) to daylight (above 0.3% of noon). */
export function daylight(p: TodProfile): { rise: number; set: number } {
  const noon = todNumber(p, "Sun intensity", 12.5);
  let rise = 6, set = 18;
  for (let h = 0; h < 12.5; h += 0.05) if (todNumber(p, "Sun intensity", h) >= noon * 0.003) { rise = h; break; }
  for (let h = 24; h > 12.5; h -= 0.05) if (todNumber(p, "Sun intensity", h) >= noon * 0.003) { set = h; break; }
  return { rise, set };
}

/** Direction to the sun at `hours` for a day from `rise` to `set` (Z up, east +X, north +Y). */
export function sunDirection(hours: number, rise: number, set: number): Vec3 {
  const noon = (rise + set) / 2;
  const half = ((set - rise) / 24) * Math.PI; // hour angle at sunset
  // cos(H0) = -tan(lat) tan(decl)
  const decl = Math.atan(-Math.cos(half) / Math.tan(LATITUDE));
  const H = ((hours - noon) / 24) * 2 * Math.PI;
  // horizontal coordinates: east, north, up
  const up = Math.sin(LATITUDE) * Math.sin(decl) + Math.cos(LATITUDE) * Math.cos(decl) * Math.cos(H);
  const east = -Math.cos(decl) * Math.sin(H);
  const north = Math.cos(LATITUDE) * Math.sin(decl) - Math.sin(LATITUDE) * Math.cos(decl) * Math.cos(H);
  const l = Math.hypot(east, north, up) || 1;
  return [east / l, north / l, up / l];
}

/** what sunlight bouncing off the ground picks up (a grassy, earthy average) */
const GROUND_ALBEDO: Vec3 = [0.22, 0.24, 0.14];

const lum = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const scale = (c: Vec3, k: number): Vec3 => [c[0] * k, c[1] * k, c[2] * k];
const hue = (c: Vec3): Vec3 => scale(c, 1 / Math.max(1e-6, lum(c)));
const adapt = (v: number, ref: number) => Math.pow(Math.max(0, v) / ref, ADAPT);
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function skyAt(p: TodProfile, hours: number): SkyState {
  const { rise, set } = daylight(p);
  const sunDir = sunDirection(hours, rise, set);
  const m = sunDirection(hours + 12, rise, set);
  const moonDir: Vec3 = [m[0], m[1], Math.max(0.15, m[2])];
  const ml = Math.hypot(...moonDir);
  moonDir[0] /= ml; moonDir[1] /= ml; moonDir[2] /= ml;
  const noonSun = todNumber(p, "Sun intensity", 12.5) || 100000;
  const sunI = todNumber(p, "Sun intensity", hours);
  const day = smooth(-0.02, 0.06, sunDir[2]);
  const night = 1 - smooth(-0.1, 0.02, sunDir[2]);
  // direct light: the sun by day, the same light from the moon at night (the profile's grey 65)
  const lightDir = sunDir[2] > -0.02 ? sunDir : moonDir;
  const sunColor = scale(hue(todColor(p, "Sun color", hours, [1, 1, 1])), 0.95 * adapt(sunI, noonSun) * (sunDir[2] > -0.02 ? Math.max(0.15, smooth(-0.02, 0.1, sunDir[2])) : 1));
  // sky: horizon and zenith from the fog colours, the zenith tinted by the sky light's blue
  const noonFog = todNumber(p, "Fog color multiplier", 12.5) || 1;
  const fogK = adapt(todNumber(p, "Fog color multiplier", hours), noonFog);
  const fogCol = todColor(p, "Fog color", hours, [0.15, 0.19, 0.3]);
  const horizon = scale(hue(fogCol), 0.62 * fogK);
  const topCol = todColor(p, "Fog color (top)", hours, fogCol);
  const skyBlue = hue(todColor(p, "Sky light: Sun intensity", hours, [0.06, 0.15, 0.5]));
  const topK = adapt(todNumber(p, "Fog color (top) multiplier", hours), todNumber(p, "Fog color (top) multiplier", 12.5) || 1);
  const zenith = scale(hue([0, 1, 2].map((i) => topCol[i] * 0.5 + skyBlue[i] * 0.04) as Vec3), 0.42 * topK);
  // ambient: the sky above, partly white-balanced towards the sun (pure sky blue made every
  // shaded side navy), and below, light bounced off the sunlit ground (grass and soil: warm green)
  const skyRaw = scale([0, 1, 2].map((i) => horizon[i] * 0.6 + zenith[i] * 0.4) as Vec3, 0.75);
  const skyColor = [0, 1, 2].map((i) => skyRaw[i] * 0.65 + lum(skyRaw) * 0.35) as Vec3;
  const groundColor: Vec3 = [0, 1, 2].map((i) => skyColor[i] * 0.25 + sunColor[i] * GROUND_ALBEDO[i] * Math.max(0, lightDir[2])) as Vec3;
  const fogDensity = 0.0006 * todNumber(p, "Volumetric fog 2: Global fog density", hours, 0.3);
  const glowK = smooth(-0.05, 0.02, sunDir[2]);
  return {
    lighting: { sunDir: lightDir, sunColor, skyColor, groundColor, fogColor: horizon, fogDensity },
    sunDir, moonDir, horizon, zenith,
    sunGlow: scale(hue(todColor(p, "Sun color", hours, [1, 1, 1])), glowK * Math.max(0.3, day)),
    stars: todNumber(p, "Night sky: Star intensity", hours) * night * 12,
    moon: scale(todColor(p, "Night sky: Moon color", hours, [1, 1, 1]), night * 0.9),
    night,
  };
}

const SHADER = /* wgsl */ `
struct Sky { invViewProj: mat4x4f, eye: vec4f, sunDir: vec4f, moonDir: vec4f, horizon: vec4f, zenith: vec4f, sunGlow: vec4f, moon: vec4f };
@group(0) @binding(0) var<uniform> sky: Sky;
struct VOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}
fn hash(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  // view ray from the inverse view-projection (any depth on the ray will do)
  let a = sky.invViewProj * vec4f(i.ndc, 0.5, 1.0);
  let d = normalize(a.xyz / a.w - sky.eye.xyz);
  let up = clamp(d.z, -1.0, 1.0);
  var c = mix(sky.horizon.rgb, sky.zenith.rgb, pow(clamp(up, 0.0, 1.0), 0.45));
  // below the horizon the haze continues, darkening
  c = select(c, sky.horizon.rgb * (1.0 + up * 0.6), up < 0.0);
  // sun: disc and glow (forward scattering), reddened by the sun colour near the horizon
  let s = max(dot(d, sky.sunDir.xyz), 0.0);
  c += sky.sunGlow.rgb * (pow(s, 8.0) * 0.18 + pow(s, 64.0) * 0.35 + smoothstep(0.99985, 0.99993, s) * 4.0);
  // night: stars and the moon
  if (sky.moon.w > 0.0 && up > 0.0) {
    let cell = floor(d * 300.0);
    let h = hash(cell);
    let star = select(0.0, pow(hash(cell + 7.0), 6.0), h > 0.985) * sky.moon.w * smoothstep(0.0, 0.2, up);
    c += vec3f(star);
  }
  let m = dot(d, sky.moonDir.xyz);
  c += sky.moon.rgb * (smoothstep(0.99955, 0.9997, m) * 0.9 + pow(max(m, 0.0), 300.0) * 0.08);
  return vec4f(pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}
`;

/** A full-screen sky drawn first in the pass (no depth writes; the scene draws over it). */
export class SkyRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private buf: GPUBuffer;
  private bind: GPUBindGroup;

  constructor(device: GPUDevice, format: GPUTextureFormat, pass: PassSetup) {
    this.device = device;
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: depthFormat(pass), depthWriteEnabled: false, depthCompare: "always" },
      multisample: { count: pass.sampleCount },
    });
    this.buf = device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bind = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.buf } }] });
  }

  update(invViewProj: Float32Array, eye: Vec3, s: SkyState): void {
    const u = new Float32Array(44);
    u.set(invViewProj, 0);
    u.set([...eye, 1], 16);
    u.set([...s.sunDir, 0], 20);
    u.set([...s.moonDir, 0], 24);
    u.set([...s.horizon, 0], 28);
    u.set([...s.zenith, 0], 32);
    u.set([...s.sunGlow, 0], 36);
    u.set([...s.moon, s.stars], 40);
    this.device.queue.writeBuffer(this.buf, 0, u);
  }

  /** Record first in the pass. */
  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);
  }

  destroy(): void {
    this.buf.destroy();
  }
}

/** Inverse of a 4×4 column-major matrix (general). */
export function invert(m: Float32Array): Float32Array {
  const a = Array.from(m), r = new Float32Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const id = det ? 1 / det : 0;
  r[0] = (a11 * b11 - a12 * b10 + a13 * b09) * id; r[1] = (a02 * b10 - a01 * b11 - a03 * b09) * id;
  r[2] = (a31 * b05 - a32 * b04 + a33 * b03) * id; r[3] = (a22 * b04 - a21 * b05 - a23 * b03) * id;
  r[4] = (a12 * b08 - a10 * b11 - a13 * b07) * id; r[5] = (a00 * b11 - a02 * b08 + a03 * b07) * id;
  r[6] = (a32 * b02 - a30 * b05 - a33 * b01) * id; r[7] = (a20 * b05 - a22 * b02 + a23 * b01) * id;
  r[8] = (a10 * b10 - a11 * b08 + a13 * b06) * id; r[9] = (a01 * b08 - a00 * b10 - a03 * b06) * id;
  r[10] = (a30 * b04 - a31 * b02 + a33 * b00) * id; r[11] = (a21 * b02 - a20 * b04 - a23 * b00) * id;
  r[12] = (a11 * b07 - a10 * b09 - a12 * b06) * id; r[13] = (a00 * b09 - a01 * b07 + a02 * b06) * id;
  r[14] = (a31 * b01 - a30 * b03 - a32 * b00) * id; r[15] = (a20 * b03 - a21 * b01 + a22 * b00) * id;
  return r;
}
