// Texture streaming: one GPU texture per texture file, shared by every ModelRenderer that has the
// pool and kept across scene rebuilds. Models load their textures small (the preset's
// maxTextureDim); each frame the renderers ask for the size their nearest draw needs on screen
// (request), and the pool loads larger mip chains for the textures that need them, within a
// memory budget, shrinking the ones nobody needs at their size when it runs short.
//
// Changes are applied in one place, at the start of a frame (beginFrame): the listeners (the
// renderers) rebuild the bind groups that used a replaced texture before anything is drawn, and
// only then is the old texture destroyed.

import { loadMipChain, type MipChain } from "./model.ts";
import type { Texture } from "./texture.ts";
import type { Vfs } from "./vfs.ts";

export interface PoolOptions {
  /** bytes of GPU memory for pooled textures */
  budget: number;
  /** largest side streamed in */
  maxDim: number;
  /** smallest side a texture is shrunk to under memory pressure */
  minDim?: number;
  /** drop chains' CPU copies once uploaded (default true): the pool reloads what it evicted */
  releaseCpu?: boolean;
  /** loads in flight at once */
  concurrency?: number;
}

export class PooledTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  /** current top-level side, and its bytes on the GPU */
  dim: number;
  bytes: number;
  /** renderers' draws using it */
  refs = 0;
  /** largest side requested recently, and the frame it was last requested */
  want = 0;
  wantFrame = -1;
  /** a load of another size is in flight, and the bytes it reserved */
  loading = false;
  reserved = 0;
  /** the side worth having, as of the last plan */
  target = 0;

  readonly key: string;
  readonly stem: string;
  readonly linear: boolean;
  readonly normalMap: boolean;
  /** largest side the texture has, and the opened file (to read more mips without reopening it) */
  readonly full: number;
  readonly source: Texture;

  constructor(key: string, chain: MipChain, linear: boolean, device: GPUDevice) {
    this.key = key;
    this.stem = chain.stem;
    this.linear = linear;
    this.normalMap = chain.normalMap;
    this.full = chain.full;
    this.source = chain.texture;
    if (chain.released) {
      // the data is gone (an evicted texture used again): a 1×1 stand-in until a load (dim 0) replaces it
      this.texture = device.createTexture({ size: [1, 1], format: linear ? "rgba8unorm" : "rgba8unorm-srgb", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
      device.queue.writeTexture({ texture: this.texture }, new Uint8Array(linear ? [0, 0, 255, 255] : [255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
      this.dim = 0;
      this.bytes = 4;
    } else {
      this.texture = uploadChain(device, chain, linear);
      this.dim = topDim(chain);
      this.bytes = chainBytes(chain);
    }
    this.view = this.texture.createView();
  }
}

const topDim = (c: MipChain) => Math.max(c.levels[0].w, c.levels[0].h);
const chainBytes = (c: MipChain) => c.levels.reduce((s, l) => s + l.data.byteLength, 0);

/** A mip chain as a GPU texture: raw BCn blocks when the chain has them, else RGBA8. */
export function uploadChain(device: GPUDevice, chain: MipChain, linear = false, extraLevels = 0): GPUTexture {
  // (extraLevels: room below the chain's levels for more, filled by the caller)
  const top = chain.levels[0];
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
  if (chain.bc) {
    // raw BCn blocks: the GPU decodes them (sizes rounded up to whole 4×4 blocks for small mips)
    const format = (!linear && /^(bc1|bc2|bc3|bc7)-rgba-unorm$/.test(chain.bc.format) ? `${chain.bc.format}-srgb` : chain.bc.format) as GPUTextureFormat;
    const t = device.createTexture({ size: [Math.ceil(top.w / 4) * 4, Math.ceil(top.h / 4) * 4], mipLevelCount: chain.levels.length + extraLevels, format, usage });
    chain.levels.forEach((l, i) => {
      const bw = Math.ceil(l.w / 4), bh = Math.ceil(l.h / 4);
      device.queue.writeTexture({ texture: t, mipLevel: i }, l.data as Uint8Array<ArrayBuffer>, { bytesPerRow: bw * chain.bc!.blockBytes, rowsPerImage: bh }, [bw * 4, bh * 4]);
    });
    return t;
  }
  // diffuse maps are colour data: sample as sRGB even if the DDS says UNORM (normal maps: linear)
  const t = device.createTexture({ size: [top.w, top.h], mipLevelCount: chain.levels.length + extraLevels, format: linear ? "rgba8unorm" : "rgba8unorm-srgb", usage });
  chain.levels.forEach((l, i) => {
    device.queue.writeTexture({ texture: t, mipLevel: i }, l.data as Uint8ClampedArray<ArrayBuffer>, { bytesPerRow: l.w * 4 }, [l.w, l.h]);
  });
  return t;
}

/** Frames a request counts for: a texture behind the camera keeps its size this long (~1.5 s). */
const WANT_FRAMES = 90;
/** Plan loads and shrinks every few frames. */
const PLAN_EVERY = 4;
/**
 * Loads in flight for stand-ins (textures whose CPU copy was dropped, used again: after a preset
 * change, the model cache comes back without texture data): small chains, many at once, planned
 * every frame. At the normal rate thousands of them took over 9 s to come back.
 */
const STAND_IN_CONCURRENCY = 64;
/** CPU-decoded (RGBA) textures are never streamed above this side: decoding is slow. */
const RGBA_MAX = 1024;
/**
 * Finished loads go in together every this many frames (~4 times a second): each swap makes the
 * renderers re-record the bundles of every item using the texture, and shared textures (plaster,
 * wood) are on hundreds of items, so one batch costs far less than the same swaps spread out.
 */
const APPLY_EVERY = 15;
/** Bytes of finished loads uploaded per frame (the rest wait a frame): spreads a burst over frames. */
const UPLOAD_PER_FRAME = 48 * 2 ** 20;

// the nearest power of two (trilinear filtering blends with the next mip anyway): rounding up
// doubled both the memory and the loads
const pow2 = (v: number) => 2 ** Math.round(Math.log2(Math.max(1, v)));

export class TexturePool {
  private entries = new Map<string, PooledTexture>();
  private listeners = new Set<(changed: Set<PooledTexture>) => void>();
  /** finished loads: whole chains, or (top) only the levels above the texture's current size */
  private done: { e: PooledTexture; chain: MipChain | null; top?: boolean }[] = [];
  private inFlight = 0;
  private frame = 0;
  /** textures that wanted to grow at the last plan but weren't started */
  private queued = 0;
  /** stand-ins that wanted loading at the last plan */
  private standIns = 0;
  /** device pixels per unit of distance-normalised size: viewport height / (2 tan(fov / 2)) */
  pixelScale = 1000;
  bytes = 0;
  /** bytes the loads in flight will add */
  private reserved = 0;
  stats = { textures: 0, loads: 0, shrinks: 0, evicted: 0, failed: 0 };

  private device: GPUDevice;
  private vfs: Vfs;
  readonly opts: PoolOptions;

  constructor(device: GPUDevice, vfs: Vfs, opts: PoolOptions) {
    this.device = device;
    this.vfs = vfs;
    this.opts = opts;
  }

  /** The view's height in device pixels and its vertical field of view: how big a texel looks. */
  setViewport(height: number, fovY: number): void {
    this.pixelScale = height / (2 * Math.tan(fovY / 2));
  }

  onChange(fn: (changed: Set<PooledTexture>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The pooled texture for a chain (uploaded on first use; a larger chain replaces a smaller copy). */
  acquire(chain: MipChain, linear = false): PooledTexture {
    const key = `${chain.stem}|${chain.normalMap ? "n" : ""}${chain.bc ? "" : "rgba"}${linear ? "l" : ""}`;
    let e = this.entries.get(key);
    if (!e) {
      e = new PooledTexture(key, chain, linear, this.device);
      this.entries.set(key, e);
      this.bytes += e.bytes;
    } else if (!chain.released && topDim(chain) > e.dim && !e.loading) {
      // already on the CPU at a larger size: take it (applied with the next frame's changes, which drop its data)
      e.loading = true;
      this.done.push({ e, chain });
      e.refs++;
      return e;
    }
    e.refs++;
    // (a larger copy may still be waiting in `done` to go in: that one keeps its data)
    if (topDim(chain) <= e.dim) this.drop(chain);
    return e;
  }

  /** Free a chain's CPU copy (it is on the GPU now); its sizes stay for acquire's comparisons. */
  private drop(chain: MipChain): void {
    if (chain.released || this.opts.releaseCpu === false) return;
    chain.levels = chain.levels.map((l) => ({ w: l.w, h: l.h, data: new Uint8Array(0) }));
    chain.released = true;
  }

  release(e: PooledTexture): void {
    e.refs--;
  }

  /** A draw needs `dim` texels across the texture this frame. */
  request(e: PooledTexture, dim: number): void {
    if (e.wantFrame !== this.frame) {
      // a new frame's first request: an old want only counts while it is recent
      if (this.frame - e.wantFrame > WANT_FRAMES) e.want = 0;
      e.wantFrame = this.frame;
    }
    if (dim > e.want) e.want = dim;
  }

  /** Largest side worth having for a texture now. */
  private targetOf(e: PooledTexture): number {
    const recent = this.frame - e.wantFrame <= WANT_FRAMES ? e.want : 0;
    const cap = Math.min(this.opts.maxDim, e.full, e.key.includes("rgba") ? RGBA_MAX : Infinity);
    return Math.min(cap, Math.max(this.opts.minDim ?? 64, pow2(recent)));
  }

  /** Apply finished loads (listeners rebuild their bind groups), then plan more. Call once per frame, before drawing. */
  beginFrame(): void {
    this.frame++;
    const changed = new Set<PooledTexture>();
    const old: GPUTexture[] = [];
    let uploaded = 0;
    while (this.done.length && uploaded < UPLOAD_PER_FRAME && (this.frame % APPLY_EVERY === 0 || this.done.length > 64)) {
      const { e, chain, top } = this.done.shift()!;
      e.loading = false;
      this.reserved -= e.reserved;
      e.reserved = 0;
      if (!chain || !chain.levels.length || !this.entries.has(e.key) || topDim(chain) === e.dim) continue;
      if (top) {
        // new top levels over the ones on the GPU (unless the texture changed size meanwhile)
        const last = chain.levels.at(-1)!;
        if (Math.max(last.w, last.h) !== e.dim * 2) continue;
        if (!!chain.bc !== e.texture.format.startsWith("bc")) {
          console.warn(`texture pool: ${e.key} is ${e.texture.format} on the GPU but loaded as ${chain.bc?.format ?? "RGBA"}`);
          continue;
        }
        const bytes = chainBytes(chain);
        old.push(e.texture);
        uploaded += bytes;
        this.grow(e, chain);
        this.bytes += bytes;
        e.bytes += bytes;
        e.dim = topDim(chain);
        changed.add(e);
        continue;
      }
      const bytes = chainBytes(chain);
      // (a larger chain from acquire reserved nothing: it goes in only if it fits)
      if (topDim(chain) > e.dim && this.bytes + this.reserved - e.bytes + bytes > this.opts.budget) continue;
      old.push(e.texture);
      uploaded += bytes;
      e.texture = uploadChain(this.device, chain, e.linear);
      this.drop(chain);
      e.view = e.texture.createView();
      this.bytes += bytes - e.bytes;
      e.bytes = bytes;
      e.dim = topDim(chain);
      changed.add(e);
    }
    if (this.frame % PLAN_EVERY === 0 || this.standIns) this.plan(changed, old);
    if (changed.size) for (const fn of this.listeners) fn(changed);
    for (const t of old) t.destroy();
    this.stats.textures = this.entries.size;
  }

  private plan(changed: Set<PooledTexture>, old: GPUTexture[]): void {
    const budget = this.opts.budget;
    this.excess = null;
    for (const e of this.entries.values()) e.target = this.targetOf(e);
    // unused textures go first when memory runs short (least recently wanted first)
    if (this.bytes + this.reserved > budget * 0.9) {
      const unused = [...this.entries.values()].filter((e) => !e.refs && !e.loading).sort((a, b) => a.wantFrame - b.wantFrame);
      for (const e of unused) {
        if (this.bytes + this.reserved <= budget * 0.8) break;
        this.entries.delete(e.key);
        this.bytes -= e.bytes;
        old.push(e.texture);
        this.stats.evicted++;
      }
    }
    // the biggest shortfalls first: a texture at an eighth of what it needs before one at half
    const grow = [...this.entries.values()]
      .filter((e) => e.refs && !e.loading && e.target > e.dim)
      .sort((a, b) => b.target / b.dim - a.target / a.dim || b.want - a.want);
    const concurrency = this.opts.concurrency ?? 8;
    this.queued = grow.length;
    this.standIns = 0;
    // (stand-ins sort first: their ratio is infinite)
    for (const e of grow) {
      if (!e.dim) this.standIns++;
      if (this.inFlight >= (e.dim ? concurrency : STAND_IN_CONCURRENCY)) break;
      const dim = e.target;
      // (a stand-in, dim 0, becomes a whole chain: about 4/3 of its top level)
      const growth = e.dim ? e.bytes * ((dim / e.dim) ** 2 - 1) : dim * dim * (e.key.includes("rgba") ? 4 : 1) * 4 / 3;
      if (this.bytes + this.reserved + growth > budget && !this.shrinkFor(growth, e, changed, old)) break;
      e.reserved = growth;
      this.reserved += growth;
      this.load(e, dim);
      this.queued--;
    }
  }

  /** Textures held at 4× or more what they need, most oversized first: what shrinkFor takes from (one plan's list). */
  private excess: PooledTexture[] | null = null;

  /** Shrink textures held above what they need (each in one GPU copy) until `need` more bytes fit. */
  private shrinkFor(need: number, keep: PooledTexture, changed: Set<PooledTexture>, old: GPUTexture[]): boolean {
    const minDim = this.opts.minDim ?? 64;
    // (only at 4× or more: one at 2× would grow straight back when the view turns)
    this.excess ??= [...this.entries.values()]
      .filter((e) => !e.loading && e.dim >= e.target * 4 && e.dim > minDim)
      .sort((a, b) => b.dim / b.target - a.dim / a.target || b.bytes - a.bytes);
    while (this.bytes + this.reserved + need > this.opts.budget) {
      const e = this.excess.shift();
      if (!e) return false;
      if (e === keep || e.loading) continue;
      const levels = Math.min(Math.log2(e.dim / Math.max(e.target, minDim)), e.texture.mipLevelCount - 1);
      if (levels < 1) continue;
      old.push(e.texture);
      this.shrink(e, levels);
      changed.add(e);
    }
    return true;
  }

  /** Drop a texture's top `k` mips: a GPU copy of the rest, no reading or decoding. */
  private shrink(e: PooledTexture, k: number): void {
    const src = e.texture;
    const n = src.mipLevelCount - k;
    const block = /^bc/.test(src.format) ? 4 : 1;
    // physical (block-rounded) mip sizes: compressed copies must cover whole blocks
    const phys = (v: number, l: number) => Math.max(block, Math.ceil(Math.max(1, v >> l) / block) * block);
    const w = phys(src.width, k), h = phys(src.height, k);
    const dst = this.device.createTexture({ size: [w, h], mipLevelCount: n, format: src.format, usage: src.usage });
    const enc = this.device.createCommandEncoder();
    for (let l = 0; l < n; l++) enc.copyTextureToTexture({ texture: src, mipLevel: l + k }, { texture: dst, mipLevel: l }, [phys(w, l), phys(h, l)]);
    this.device.queue.submit([enc.finish()]);
    const bytes = Math.round(e.bytes / 4 ** k) || 1;
    this.bytes += bytes - e.bytes;
    e.bytes = bytes;
    e.dim = Math.max(1, e.dim >> k);
    e.texture = dst;
    e.view = dst.createView();
    this.stats.shrinks++;
  }

  /** Put new top levels over a texture's current ones (copied on the GPU, not read again). */
  private grow(e: PooledTexture, top: MipChain): void {
    const src = e.texture;
    const big = uploadChain(this.device, top, e.linear, src.mipLevelCount);
    const block = /^bc/.test(src.format) ? 4 : 1;
    const enc = this.device.createCommandEncoder();
    for (let l = 0; l < src.mipLevelCount; l++) {
      const mw = Math.max(block, Math.ceil(Math.max(1, src.width >> l) / block) * block);
      const mh = Math.max(block, Math.ceil(Math.max(1, src.height >> l) / block) * block);
      enc.copyTextureToTexture({ texture: src, mipLevel: l }, { texture: big, mipLevel: top.levels.length + l }, [mw, mh]);
    }
    this.device.queue.submit([enc.finish()]);
    e.texture = big;
    e.view = big.createView();
  }

  private load(e: PooledTexture, dim: number): void {
    e.loading = true;
    this.inFlight++;
    this.stats.loads++;
    // only the levels above what the GPU holds (all of them for a stand-in), in the format it holds
    const top = e.dim > 0;
    void loadMipChain(this.vfs, e.stem, dim, { normalMap: e.normalMap, rgba: !e.texture.format.startsWith("bc") && e.dim > 0, texture: e.source, above: e.dim })
      .catch(() => { this.stats.failed++; return null; })
      .then((chain) => {
        this.inFlight--;
        this.done.push({ e, chain, top });
      });
  }

  /** Nothing is loading or waiting to be uploaded. */
  get idle(): boolean {
    return !this.inFlight && !this.done.length && !this.queued;
  }

  /** Texture count and memory by top-level side, for the HUD and the benchmarks. */
  summary(): string {
    const by = new Map<number, number>();
    for (const e of this.entries.values()) by.set(e.dim, (by.get(e.dim) ?? 0) + 1);
    const sizes = [...by].sort((a, b) => b[0] - a[0]).slice(0, 4).map(([d, n]) => `${n}×${d}`).join(" ");
    return `textures ${(this.bytes / 2 ** 20).toFixed(0)}/${(this.opts.budget / 2 ** 20).toFixed(0)} MiB (${sizes}${this.inFlight ? `, loading ${this.inFlight}` : ""})`;
  }

  destroy(): void {
    for (const e of this.entries.values()) e.texture.destroy();
    this.entries.clear();
    this.listeners.clear();
    this.bytes = 0;
  }
}
