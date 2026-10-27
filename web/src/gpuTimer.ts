// GPU time per render pass from WebGPU timestamp queries (the "timestamp-query" feature; Chrome
// rounds the stamps to 100 µs unless chrome://flags/#enable-webgpu-developer-features is on,
// which averages out over many frames). Each named pass gets a begin and end stamp; the stamps of
// a frame are resolved into a buffer and read back a few frames later, so the frame never waits.
// Without the feature every call is a no-op and `available` is false.

const RING = 4;

export interface GpuFrame {
  /** ms per pass name (passes recorded under one name more than once in a frame are summed) */
  passes: Map<string, number>;
  /** ms from the first stamp to the last: the frame's GPU work, gaps between passes included */
  total: number;
}

export class GpuTimer {
  readonly available: boolean;
  private query: GPUQuerySet | null = null;
  private resolveBuf: GPUBuffer | null = null;
  private ring: { buf: GPUBuffer; names: string[]; busy: boolean }[] = [];
  private names: string[] = [];
  private readonly max: number;
  /** smoothed ms per pass and in all (for the HUD) */
  readonly smoothed = new Map<string, number>();
  total = 0;
  /** every frame read back while recording (the benchmark) */
  recording: GpuFrame[] | null = null;

  /** The features to request for timing, when the adapter has them. */
  static features(adapter: GPUAdapter): GPUFeatureName[] {
    return adapter.features.has("timestamp-query") ? ["timestamp-query"] : [];
  }

  constructor(device: GPUDevice, maxPasses = 24) {
    this.max = maxPasses;
    this.available = device.features.has("timestamp-query");
    if (!this.available) return;
    this.query = device.createQuerySet({ type: "timestamp", count: maxPasses * 2 });
    this.resolveBuf = device.createBuffer({ size: maxPasses * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    for (let i = 0; i < RING; i++) this.ring.push({ buf: device.createBuffer({ size: maxPasses * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), names: [], busy: false });
  }

  /** Start a frame's stamps. */
  begin(): void {
    this.names.length = 0;
  }

  /** The timestampWrites for a pass named `name` (spread into its descriptor), or nothing. */
  pass(name: string): { timestampWrites?: GPURenderPassTimestampWrites } {
    if (!this.query || this.names.length >= this.max) return {};
    const i = this.names.push(name) - 1;
    return { timestampWrites: { querySet: this.query, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } };
  }

  /** Resolve this frame's stamps (before `enc.finish()`); call `collect` after the submit. */
  resolve(enc: GPUCommandEncoder): void {
    if (!this.query || !this.names.length) return;
    const slot = this.ring.find((r) => !r.busy);
    if (!slot) { this.names.length = 0; return; } // readback behind: skip this frame
    const n = this.names.length * 2;
    enc.resolveQuerySet(this.query, 0, n, this.resolveBuf!, 0);
    enc.copyBufferToBuffer(this.resolveBuf!, 0, slot.buf, 0, n * 8);
    slot.names = this.names.slice();
    slot.busy = true;
  }

  /** Read the resolved stamps back once the GPU is done with them (after the frame's submit). */
  collect(): void {
    for (const slot of this.ring) {
      if (!slot.busy || slot.buf.mapState !== "unmapped" || !slot.names.length) continue;
      const names = slot.names;
      slot.names = [];
      void slot.buf.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(slot.buf.getMappedRange(), 0, names.length * 2);
        const passes = new Map<string, number>();
        let first = t[0], last = t[1];
        for (let i = 0; i < names.length; i++) {
          const b = t[i * 2], e = t[i * 2 + 1];
          // (zero or backwards: a pass the implementation didn't stamp)
          const ms = e > b ? Number(e - b) / 1e6 : 0;
          passes.set(names[i], (passes.get(names[i]) ?? 0) + ms);
          if (b > 0n && b < first) first = b;
          if (e > last) last = e;
        }
        slot.buf.unmap();
        slot.busy = false;
        const total = last > first ? Number(last - first) / 1e6 : 0;
        this.total += (total - this.total) * 0.05;
        for (const [k, v] of passes) this.smoothed.set(k, (this.smoothed.get(k) ?? v) + (v - (this.smoothed.get(k) ?? v)) * 0.05);
        // passes not drawn this frame decay
        for (const k of this.smoothed.keys()) if (!passes.has(k)) this.smoothed.set(k, this.smoothed.get(k)! * 0.95);
        this.recording?.push({ passes, total });
      }, () => { slot.busy = false; });
    }
  }

  /** "shadow 1.2 · opaque 4.0 · …" (smoothed ms), largest first. */
  summary(): string {
    if (!this.available) return "GPU timing unavailable";
    return [...this.smoothed].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(" · ");
  }

  destroy(): void {
    this.query?.destroy();
    this.resolveBuf?.destroy();
    for (const r of this.ring) r.buf.destroy();
  }
}

/** One part of the opaque scene: a name for its timing and what it draws. */
export type OpaqueStep = [name: string, draw: (pass: GPURenderPassEncoder) => void];

/**
 * The opaque scene into `colour` and `depth` (cleared first). In one pass named "opaque", or with
 * `split` one pass per step (loading what the last stored), so each step is timed on its own: on
 * desktop GPUs the extra passes cost little, but the total is then a little above the single pass.
 */
export function encodeOpaque(enc: GPUCommandEncoder, colour: { view: GPUTextureView; clearValue: GPUColor }, depth: { view: GPUTextureView; depthClearValue: number }, steps: OpaqueStep[], timer: GpuTimer | null, split: boolean): void {
  const begin = (name: string, first: boolean) => enc.beginRenderPass({
    ...timer?.pass(name),
    colorAttachments: [{ view: colour.view, clearValue: colour.clearValue, loadOp: first ? "clear" : "load", storeOp: "store" }],
    depthStencilAttachment: { view: depth.view, depthClearValue: depth.depthClearValue, depthLoadOp: first ? "clear" : "load", depthStoreOp: "store" },
  });
  if (!split) {
    const p = begin("opaque", true);
    for (const [, draw] of steps) draw(p);
    p.end();
    return;
  }
  steps.forEach(([name, draw], i) => {
    const p = begin(name, i === 0);
    draw(p);
    p.end();
  });
}
