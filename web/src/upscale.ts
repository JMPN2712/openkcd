// Upscaling with sharpening: the scene is drawn into a smaller texture (dynamic resolution) and
// stretched to the canvas here, bilinear, with a contrast-adaptive sharpening of the four
// neighbours (a negative lobe weighted down where the neighbourhood is already contrasty, so
// edges don't ring and flat areas don't amplify noise). Our own small filter in the spirit of
// AMD's published contrast-adaptive sharpening.

const SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
// texel size of the source (xy), sharpness 0..1 (z)
@group(0) @binding(2) var<uniform> u: vec4f;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  // one triangle over the screen
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let t = u.xy;
  let c = textureSampleLevel(src, samp, i.uv, 0.0).rgb;
  let n = textureSampleLevel(src, samp, i.uv + vec2f(0.0, -t.y), 0.0).rgb;
  let s = textureSampleLevel(src, samp, i.uv + vec2f(0.0, t.y), 0.0).rgb;
  let e = textureSampleLevel(src, samp, i.uv + vec2f(t.x, 0.0), 0.0).rgb;
  let w = textureSampleLevel(src, samp, i.uv + vec2f(-t.x, 0.0), 0.0).rgb;
  let mn = min(c, min(min(n, s), min(e, w)));
  let mx = max(c, max(max(n, s), max(e, w)));
  // room to sharpen before clipping, relative to the brightest neighbour
  let amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3f(1e-4)), vec3f(0.0), vec3f(1.0)));
  let lobe = amp * mix(-0.1, -0.2, u.z);
  let out = (c + (n + s + e + w) * lobe) / (1.0 + 4.0 * lobe);
  return vec4f(clamp(out, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

export class Upscaler {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniforms: GPUBuffer;
  private bind: GPUBindGroup | null = null;
  private source: GPUTexture | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Stretch `source` over `target` (the canvas) with sharpening 0..1. */
  draw(enc: GPUCommandEncoder, source: GPUTexture, target: GPUTextureView, sharpness: number, timestamps?: { timestampWrites?: GPURenderPassTimestampWrites }): void {
    if (source !== this.source) {
      this.source = source;
      this.bind = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: source.createView() }, { binding: 1, resource: this.sampler }, { binding: 2, resource: { buffer: this.uniforms } }],
      });
    }
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array([1 / source.width, 1 / source.height, sharpness, 0]));
    const pass = enc.beginRenderPass({ ...timestamps, colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind!);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.uniforms.destroy();
  }
}

/**
 * The next render scale from the GPU's frame time: down a step when over the target, up a step
 * when well under it, within [min, max]; steps of 0.05 so the scene texture is rarely remade.
 */
export function nextScale(scale: number, gpuMs: number, o: { min: number; max: number; targetMs: number }): number {
  let s = scale;
  if (gpuMs > o.targetMs) s -= gpuMs > o.targetMs * 1.3 ? 0.1 : 0.05;
  else if (gpuMs < o.targetMs * 0.75) s += 0.05;
  return Math.round(Math.min(o.max, Math.max(o.min, s)) * 20) / 20;
}
