// Sun (or moon) shadows: a cascaded shadow map. Each cascade is an orthographic view along the
// light covering a sphere around a slice of the camera's view (the near cascade a few metres in
// front of the eye, the far one out to the shadow distance), snapped to whole texels so it
// doesn't shimmer as the camera moves. Casters are drawn into one layer each (depth only, alpha
// tested); the terrain and model shaders read the array with 3×3 PCF.
//
// Receivers bind the map, a comparison sampler and this uniform:
//   struct Shadow { m: array<mat4x4f, 2>, info: vec4f }  // info: x near-cascade end, y shadow
//   distance, z cascades (0 = none), w texel size of cascade 0 (m)

import { lookAt, multiply, type Vec3 } from "./mat4.ts";

export const SHADOW_FORMAT: GPUTextureFormat = "depth32float";
export const MAX_CASCADES = 2;

/** Orthographic projection to WebGPU clip space (depth 0..1), looking down −Z. */
function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Float32Array {
  return new Float32Array([
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, -1 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -n / (f - n), 1,
  ]);
}

export class ShadowMap {
  readonly device: GPUDevice;
  readonly size: number;
  readonly cascades: number;
  readonly texture: GPUTexture;
  readonly layers: GPUTextureView[];
  readonly arrayView: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly buffer: GPUBuffer;
  /** light view-projection per cascade (after update) */
  readonly viewProj: Float32Array[] = [];
  /** far end of each cascade's slice (m from the eye) */
  readonly splits: number[];

  /** `cascades` 0 makes the stand-in bound by renderers without shadows (always lit). */
  constructor(device: GPUDevice, size: number, cascades: number, splits: number[] = [20, 120]) {
    this.device = device;
    this.size = cascades ? size : 1;
    this.cascades = cascades;
    this.splits = splits.slice(0, Math.max(1, cascades));
    this.texture = device.createTexture({
      size: [this.size, this.size, MAX_CASCADES],
      format: SHADOW_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.layers = Array.from({ length: MAX_CASCADES }, (_, k) => this.texture.createView({ dimension: "2d", baseArrayLayer: k, arrayLayerCount: 1 }));
    this.arrayView = this.texture.createView({ dimension: "2d-array" });
    this.sampler = device.createSampler({ compare: "less-equal", magFilter: "linear", minFilter: "linear" });
    this.buffer = device.createBuffer({ size: 2 * 64 + 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const u = new Float32Array(36);
    u.set([0, 0, 0, 0], 32);
    device.queue.writeBuffer(this.buffer, 0, u);
    if (!cascades) {
      // the stand-in: depth cleared to 1 so every comparison passes
      const enc = device.createCommandEncoder();
      for (const v of this.layers) enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: v, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } }).end();
      device.queue.submit([enc.finish()]);
    }
  }

  /**
   * Place the cascades for a camera at `eye` looking along `fwd`, with light travelling along
   * −`toLight`. `depthRange` metres of casters are kept above and below each cascade's centre.
   */
  update(eye: Vec3, fwd: Vec3, toLight: Vec3, depthRange = 250, only?: (c: number) => boolean): void {
    if (!this.cascades) return;
    const l = Math.hypot(...toLight) || 1;
    const L: Vec3 = [toLight[0] / l, toLight[1] / l, toLight[2] / l];
    const up: Vec3 = Math.abs(L[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    // rotation only: the light looks from +L towards the origin
    const rot = lookAt([0, 0, 0], [-L[0], -L[1], -L[2]], up);
    const u = new Float32Array(36);
    let near = 0;
    for (let c = 0; c < this.cascades; c++) {
      const far = this.splits[c];
      if (only && !only(c) && this.viewProj[c]) {
        // not re-rendered this frame: keep the matrix its texture layer was drawn with
        u.set(this.viewProj[c], c * 16);
        near = far;
        continue;
      }
      // a sphere around the slice [near, far] of the view (wide enough for any view direction)
      const mid = (near + far) / 2;
      const center: Vec3 = [eye[0] + fwd[0] * mid, eye[1] + fwd[1] * mid, eye[2] + fwd[2] * mid];
      const r = far * 0.75 + 2;
      const texel = (2 * r) / this.size;
      const cx = rot[0] * center[0] + rot[4] * center[1] + rot[8] * center[2];
      const cy = rot[1] * center[0] + rot[5] * center[1] + rot[9] * center[2];
      const cz = rot[2] * center[0] + rot[6] * center[1] + rot[10] * center[2];
      const sx = Math.round(cx / texel) * texel, sy = Math.round(cy / texel) * texel;
      const vp = multiply(ortho(sx - r, sx + r, sy - r, sy + r, -(cz + depthRange), -(cz - depthRange)), rot);
      this.viewProj[c] = vp;
      u.set(vp, c * 16);
      near = far;
    }
    u.set([this.splits[0], this.splits[this.cascades - 1], this.cascades, (2 * (this.splits[0] * 0.75 + 2)) / this.size], 32);
    this.device.queue.writeBuffer(this.buffer, 0, u);
  }

  /** No shadows this frame (light below the horizon): receivers read every point as lit. */
  disable(): void {
    if (!this.cascades) return;
    const u = new Float32Array(36);
    this.device.queue.writeBuffer(this.buffer, 0, u);
  }

  /** A depth-only render pass into cascade `c`. */
  beginPass(enc: GPUCommandEncoder, c: number): GPURenderPassEncoder {
    return enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.layers[c], depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
  }

  destroy(): void {
    this.texture.destroy();
    this.buffer.destroy();
  }
}

/** WGSL for receivers (bindings are given by the includer): returns 0 (shadowed) … 1 (lit). */
export const SHADOW_WGSL = /* wgsl */ `
struct Shadow { m: array<mat4x4f, 2>, info: vec4f };
fn shadowFactor(wpos: vec3f, n: vec3f, eyeDist: f32) -> f32 {
  let cascades = i32(shadowU.info.z);
  if (cascades == 0 || eyeDist > shadowU.info.y) { return 1.0; }
  let c = select(1, 0, eyeDist < shadowU.info.x || cascades == 1);
  // normal offset (a texel and a half of that cascade) against acne
  let texel = shadowU.info.w * select(1.0, shadowU.info.y / shadowU.info.x, c == 1);
  let p = shadowU.m[c] * vec4f(wpos + n * texel * 1.5, 1.0);
  let uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || p.z > 1.0) { return 1.0; }
  let size = vec2f(textureDimensions(shadowTex));
  var s = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      s += textureSampleCompareLevel(shadowTex, shadowSamp, uv + vec2f(f32(x), f32(y)) / size, c, p.z - 0.0005);
    }
  }
  // fade out over the last tenth of the shadow distance
  let fade = smoothstep(shadowU.info.y * 0.9, shadowU.info.y, eyeDist);
  return mix(s / 9.0, 1.0, fade);
}
`;
