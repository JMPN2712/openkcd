// The final pass: upscaling with sharpening, or anti-aliasing (FXAA-style) with the stretch.
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

// Anti-aliasing from the finished image (the well-known luma-edge method, our own code): find
// where luma changes sharply, whether the edge runs across or along, walk along it both ways to
// its ends, and blend across it by how far this pixel is from the nearer end; plus a little
// sub-pixel blending where a pixel stands out from all its neighbours (thin wires, leaves).
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
fn at(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }
fn lumaAt(uv: vec2f) -> f32 { return luma(at(uv)); }

@fragment fn fsAa(i: VOut) -> @location(0) vec4f {
  let t = u.xy;
  let uv = i.uv;
  let cM = at(uv);
  let lM = luma(cM);
  let lN = lumaAt(uv + vec2f(0.0, -t.y));
  let lS = lumaAt(uv + vec2f(0.0, t.y));
  let lE = lumaAt(uv + vec2f(t.x, 0.0));
  let lW = lumaAt(uv + vec2f(-t.x, 0.0));
  let lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  let lMax = max(lM, max(max(lN, lS), max(lE, lW)));
  let range = lMax - lMin;
  // flat enough: untouched
  if (range < max(0.0312, lMax * 0.125)) { return vec4f(cM, 1.0); }
  let lNW = lumaAt(uv + vec2f(-t.x, -t.y));
  let lNE = lumaAt(uv + vec2f(t.x, -t.y));
  let lSW = lumaAt(uv + vec2f(-t.x, t.y));
  let lSE = lumaAt(uv + vec2f(t.x, t.y));
  let edgeH = abs(lNW + lSW - 2.0 * lW) + 2.0 * abs(lN + lS - 2.0 * lM) + abs(lNE + lSE - 2.0 * lE);
  let edgeV = abs(lNW + lNE - 2.0 * lN) + 2.0 * abs(lW + lE - 2.0 * lM) + abs(lSW + lSE - 2.0 * lS);
  // horizontal: the edge runs along x (luma changes going up or down)
  let horizontal = edgeH >= edgeV;
  let l1 = select(lW, lN, horizontal);
  let l2 = select(lE, lS, horizontal);
  let g1 = abs(l1 - lM);
  let g2 = abs(l2 - lM);
  var stepLen = select(t.x, t.y, horizontal);
  var lLocal = 0.5 * (l2 + lM);
  var grad = g2;
  if (g1 >= g2) { stepLen = -stepLen; lLocal = 0.5 * (l1 + lM); grad = g1; }
  // half a pixel onto the edge, then along it both ways
  var cur = uv;
  if (horizontal) { cur.y += stepLen * 0.5; } else { cur.x += stepLen * 0.5; }
  let along = select(vec2f(0.0, t.y), vec2f(t.x, 0.0), horizontal);
  var p1 = cur - along;
  var p2 = cur + along;
  var e1 = lumaAt(p1) - lLocal;
  var e2 = lumaAt(p2) - lLocal;
  let limit = grad * 0.25;
  var done1 = abs(e1) >= limit;
  var done2 = abs(e2) >= limit;
  let steps = array<f32, 10>(1.0, 1.0, 1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0);
  for (var k = 0; k < 10; k++) {
    if (done1 && done2) { break; }
    if (!done1) { p1 -= along * steps[k]; e1 = lumaAt(p1) - lLocal; done1 = abs(e1) >= limit; }
    if (!done2) { p2 += along * steps[k]; e2 = lumaAt(p2) - lLocal; done2 = abs(e2) >= limit; }
  }
  let d1 = select(uv.y - p1.y, uv.x - p1.x, horizontal);
  let d2 = select(p2.y - uv.y, p2.x - uv.x, horizontal);
  let nearer1 = d1 < d2;
  let dMin = min(d1, d2);
  var off = 0.5 - dMin / max(d1 + d2, 1e-6);
  // only when the nearer end goes the way the centre does
  let centreLow = lM < lLocal;
  let endLow = select(e2, e1, nearer1) < 0.0;
  if (endLow == centreLow) { off = 0.0; }
  // sub-pixel: a pixel unlike its whole neighbourhood
  let lAvg = (2.0 * (lN + lS + lE + lW) + lNW + lNE + lSW + lSE) / 12.0;
  let sub1 = clamp(abs(lAvg - lM) / range, 0.0, 1.0);
  let sub2 = (3.0 - 2.0 * sub1) * sub1 * sub1;
  off = max(off, sub2 * sub2 * 0.75);
  var f = uv;
  if (horizontal) { f.y += off * stepLen; } else { f.x += off * stepLen; }
  return vec4f(at(f), 1.0);
}
`;

export class Upscaler {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private aaPipeline: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private sampler: GPUSampler;
  private uniforms: GPUBuffer;
  private bind: GPUBindGroup | null = null;
  private source: GPUTexture | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    const module = device.createShaderModule({ code: SHADER });
    // one layout for both passes (a bind group made for one "auto" layout fits no other pipeline)
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
      ],
    });
    this.layout = bgl;
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const make = (entryPoint: string) => device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint, targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.pipeline = make("fs");
    this.aaPipeline = make("fsAa");
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Stretch `source` over `target` (the canvas) with sharpening 0..1, or anti-aliased (`aa`). */
  draw(enc: GPUCommandEncoder, source: GPUTexture, target: GPUTextureView, sharpness: number, timestamps?: { timestampWrites?: GPURenderPassTimestampWrites }, aa = false): void {
    if (source !== this.source) {
      this.source = source;
      this.bind = this.device.createBindGroup({
        layout: this.layout,
        entries: [{ binding: 0, resource: source.createView() }, { binding: 1, resource: this.sampler }, { binding: 2, resource: { buffer: this.uniforms } }],
      });
    }
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array([1 / source.width, 1 / source.height, sharpness, 0]));
    const pass = enc.beginRenderPass({ ...timestamps, colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(aa ? this.aaPipeline : this.pipeline);
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
