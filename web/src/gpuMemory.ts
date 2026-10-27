// GPU memory in use, counted by wrapping a device's createBuffer and createTexture: each resource
// adds its size until it is destroyed (or garbage-collected). Texture sizes are estimated from
// the format, mip levels, layers and samples; drivers pad and compress, so this is the
// application's share, not what the driver reports.

/** bytes per 4×4 block for block-compressed formats, per texel for the rest */
function formatBytes(format: GPUTextureFormat): { block: number; bytes: number } {
  if (format.startsWith("bc1") || format.startsWith("bc4")) return { block: 4, bytes: 8 };
  if (format.startsWith("bc")) return { block: 4, bytes: 16 };
  if (/^(r8|stencil8)/.test(format)) return { block: 1, bytes: 1 };
  if (/^(rg8|r16|depth16)/.test(format)) return { block: 1, bytes: 2 };
  if (/^(rgba16|rg32|depth32float-stencil8)/.test(format)) return { block: 1, bytes: 8 };
  if (/^rgba32/.test(format)) return { block: 1, bytes: 16 };
  return { block: 1, bytes: 4 };
}

function extent(size: GPUExtent3D): [number, number, number] {
  if (Array.isArray(size) || ArrayBuffer.isView(size)) {
    const s = size as number[];
    return [s[0], s[1] ?? 1, s[2] ?? 1];
  }
  const d = size as GPUExtent3DDict;
  return [d.width, d.height ?? 1, d.depthOrArrayLayers ?? 1];
}

export function textureBytes(desc: GPUTextureDescriptor): number {
  const [w, h, layers] = extent(desc.size);
  const { block, bytes } = formatBytes(desc.format);
  let total = 0;
  for (let m = 0; m < (desc.mipLevelCount ?? 1); m++) {
    const mw = Math.max(1, w >> m), mh = Math.max(1, h >> m);
    total += Math.ceil(mw / block) * Math.ceil(mh / block) * bytes * (desc.dimension === "3d" ? Math.max(1, layers >> m) : layers);
  }
  return total * (desc.sampleCount ?? 1);
}

export interface GpuMemory {
  buffers: number;
  textures: number;
  /** render targets (textures with RENDER_ATTACHMENT): depth, MSAA, shadow maps */
  targets: number;
  /** with `sites`: live bytes per creating function (file:line), to find what holds the memory */
  sites?: Map<string, number>;
}

const tracked = new WeakMap<GPUDevice, GpuMemory>();

/** Count `device`'s buffers and textures from now on; returns the live totals (bytes). */
export function trackGpuMemory(device: GPUDevice, opts: { sites?: boolean } = {}): GpuMemory {
  const known = tracked.get(device);
  if (known) return known;
  const mem: GpuMemory = { buffers: 0, textures: 0, targets: 0, sites: opts.sites ? new Map() : undefined };
  tracked.set(device, mem);
  type Kind = "buffers" | "textures" | "targets";
  const site = () => {
    // the caller of device.createBuffer/createTexture (below: site, watch, the wrapper)
    const l = (new Error().stack ?? "").split("\n")[4] ?? "?";
    return l.trim().replace(/^at /, "").replace(/\(?https?:\/\/[^/]+\//, "(").replace(/\?[^:]*:/, ":");
  };
  const count = (kind: Kind, where: string | null, bytes: number) => {
    mem[kind] += bytes;
    if (where) mem.sites!.set(where, (mem.sites!.get(where) ?? 0) + bytes);
  };
  const freed = new FinalizationRegistry<{ kind: Kind; where: string | null; bytes: number; token: { done: boolean } }>((r) => { if (!r.token.done) count(r.kind, r.where, -r.bytes); });
  const watch = <T extends GPUBuffer | GPUTexture>(res: T, kind: Kind, bytes: number): T => {
    const where = mem.sites ? `${kind}: ${site()}` : null;
    count(kind, where, bytes);
    const token = { done: false };
    freed.register(res, { kind, where, bytes, token });
    const destroy = res.destroy.bind(res);
    res.destroy = () => {
      if (!token.done) { token.done = true; count(kind, where, -bytes); }
      destroy();
    };
    return res;
  };
  const createBuffer = device.createBuffer.bind(device);
  const createTexture = device.createTexture.bind(device);
  device.createBuffer = (desc) => watch(createBuffer(desc), "buffers", desc.size);
  device.createTexture = (desc) => watch(createTexture(desc), desc.usage & GPUTextureUsage.RENDER_ATTACHMENT ? "targets" : "textures", textureBytes(desc));
  return mem;
}
