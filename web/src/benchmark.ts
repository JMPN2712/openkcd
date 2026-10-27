// The in-app benchmark: a fixed camera path (a flight out of Rataje over the river and the fields
// and back, then a walk through the market at eye height) run at each quality preset, timed per
// frame on the CPU and per pass on the GPU (gpuTimer.ts), with the GPU, the browser and the
// memory in use. The report is plain text, copied to the clipboard to send.

import type { FlyCamera } from "./terrainRenderer.ts";
import type { GpuFrame } from "./gpuTimer.ts";
import type { GpuMemory } from "./gpuMemory.ts";

type Point = [x: number, y: number, z: number];

/** The path's segments: points (z above the ground) and the speed along them (m/s). */
const SEGMENTS: { name: "flight" | "walk"; speed: number; pitch: number; look: number; points: Point[] }[] = [
  // from above the market west over the river, south over the fields, and back
  { name: "flight", speed: 30, pitch: -0.25, look: 40, points: [[2577.8, 574, 45], [2450, 640, 35], [2352, 668, 25], [2250, 850, 30], [2192, 1000, 25], [2400, 900, 35], [2560, 700, 30], [2577.8, 590, 8]] },
  // through the market among the stalls and NPCs
  { name: "walk", speed: 3, pitch: -0.05, look: 3, points: [[2577.8, 580, 1.7], [2577.8, 560, 1.7], [2568, 545, 1.7], [2552, 538, 1.7], [2542, 552, 1.7], [2552, 568, 1.7], [2570, 576, 1.7]] },
];

function length(pts: Point[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}

/** The point `s` metres along `pts` (clamped to its ends). */
function along(pts: Point[], s: number): Point {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s <= d || i === pts.length - 1) {
      const k = Math.max(0, Math.min(1, s / (d || 1)));
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
    s -= d;
  }
  return pts[0];
}

/** Where the camera starts (the settling phase waits there for the world to load). */
export function benchStart(ground: (x: number, y: number) => number): FlyCamera {
  return pose(0, ground).cam;
}

/** The camera `t` seconds into the path, the segment, and whether the path is over. */
export function pose(t: number, ground: (x: number, y: number) => number): { cam: FlyCamera; segment: string; done: boolean } {
  for (const seg of SEGMENTS) {
    const len = length(seg.points), dur = len / seg.speed;
    if (t <= dur || seg === SEGMENTS[SEGMENTS.length - 1]) {
      const s = Math.min(len, t * seg.speed);
      const p = along(seg.points, s), ahead = along(seg.points, s + seg.look);
      // (the last metres: keep the heading of the path's end)
      const dx = ahead[0] - p[0], dy = ahead[1] - p[1];
      const yaw = Math.hypot(dx, dy) > 0.5 ? Math.atan2(dy, dx) : Math.atan2(p[1] - along(seg.points, s - 1)[1], p[0] - along(seg.points, s - 1)[0]);
      return { cam: { pos: [p[0], p[1], ground(p[0], p[1]) + p[2]], yaw, pitch: seg.pitch }, segment: seg.name, done: t > dur };
    }
    t -= dur;
  }
  throw new Error("unreachable");
}

/** Seconds the whole path takes. */
export const PATH_SECONDS = SEGMENTS.reduce((a, s) => a + length(s.points) / s.speed, 0);

export interface FrameSample { segment: string; ms: number; cpu: number }

export interface MemorySample { jsHeap: number; gpu: GpuMemory; pool: number }

export interface PresetResult {
  preset: string;
  resolution: string;
  frames: FrameSample[];
  gpu: GpuFrame[];
  settleSeconds: number;
  memory: { end: MemorySample; peakJs: number; peakGpu: number };
}

/** The JS heap in use (Chrome only; 0 elsewhere). */
export function jsHeap(): number {
  return (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
}

const mib = (b: number) => `${(b / 2 ** 20).toFixed(0)} MiB`;

function stats(frames: FrameSample[]): { fps: number; low1: number; cpu: number; n: number } {
  if (!frames.length) return { fps: 0, low1: 0, cpu: 0, n: 0 };
  const ms = frames.map((f) => f.ms).sort((a, b) => b - a);
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  // 1% low: the average fps over the slowest 1% of frames
  const worst = ms.slice(0, Math.max(1, Math.floor(ms.length / 100)));
  const worstMean = worst.reduce((a, b) => a + b, 0) / worst.length;
  return { fps: 1000 / mean, low1: 1000 / worstMean, cpu: frames.reduce((a, f) => a + f.cpu, 0) / frames.length, n: frames.length };
}

/** What the report says about the machine: the WebGPU adapter, the driver (WebGL names it), the browser. */
export async function systemInfo(adapter: GPUAdapterInfo | null): Promise<string[]> {
  const lines: string[] = [];
  if (adapter) lines.push(`WebGPU adapter: ${[adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter(Boolean).join(" · ") || "(not named)"}`);
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && ext) lines.push(`Driver (WebGL): ${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}`);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    // no WebGL: the adapter line has to do
  }
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ platformVersion?: string; fullVersionList?: { brand: string; version: string }[] }> } };
  let browser = navigator.userAgent;
  try {
    const ua = await nav.userAgentData?.getHighEntropyValues(["platformVersion", "fullVersionList"]);
    const chrome = ua?.fullVersionList?.find((b) => /Chrom/.test(b.brand));
    if (chrome) browser = `${chrome.brand} ${chrome.version} · ${navigator.platform} ${ua?.platformVersion ?? ""} · ${navigator.userAgent}`;
  } catch {
    // the plain user agent
  }
  lines.push(`Browser: ${browser}`);
  lines.push(`Machine: ${navigator.hardwareConcurrency} threads${nav.deviceMemory ? `, RAM ≥ ${nav.deviceMemory} GB (as the browser rounds it)` : ""}; screen ${screen.width}×${screen.height} at ${devicePixelRatio}× (devicePixelRatio)`);
  return lines;
}

/** The report: the machine, then per preset and segment fps, 1% low, CPU and GPU ms per pass, memory. */
export function report(system: string[], results: PresetResult[]): string {
  const out = [`OpenKCD benchmark, ${new Date().toISOString()}`, ...system, ""];
  // (the first frames read back may be from before the opaque pass was split)
  let passNames = [...new Set(results.flatMap((r) => r.gpu.flatMap((g) => [...g.passes.keys()])))];
  if (passNames.length > 3) passNames = passNames.filter((k) => k !== "opaque");
  out.push("preset | segment | render size | fps (avg) | 1% low | CPU ms | GPU ms | " + passNames.join(" | "));
  for (const r of results) {
    for (const seg of ["flight", "walk", "all"]) {
      const frames = seg === "all" ? r.frames : r.frames.filter((f) => f.segment === seg);
      const s = stats(frames);
      // GPU frames aren't tagged by segment (read back late); shown for the whole run
      const g = seg === "all" ? r.gpu : [];
      const pass = (k: string) => (g.length ? (g.reduce((a, f) => a + (f.passes.get(k) ?? 0), 0) / g.length).toFixed(2) : "");
      const total = g.length ? (g.reduce((a, f) => a + [...f.passes.values()].reduce((x, y) => x + y, 0), 0) / g.length).toFixed(2) : "";
      out.push([r.preset, seg, r.resolution, s.fps.toFixed(1), s.low1.toFixed(1), s.cpu.toFixed(2), total, ...passNames.map(pass)].join(" | "));
    }
  }
  out.push("");
  for (const r of results) {
    const m = r.memory.end;
    out.push(`${r.preset} memory at the end: JS heap ${mib(m.jsHeap)} (peak ${mib(r.memory.peakJs)}); GPU ${mib(m.gpu.buffers + m.gpu.textures + m.gpu.targets)} (peak ${mib(r.memory.peakGpu)}): buffers ${mib(m.gpu.buffers)}, textures ${mib(m.gpu.textures)} (streamed pool ${mib(m.pool)}), render targets ${mib(m.gpu.targets)}; loaded in ${r.settleSeconds.toFixed(0)} s`);
  }
  out.push("", "GPU ms are per frame, from timestamp queries (Chrome rounds them to 0.1 ms; averaged). The opaque pass is split by what it draws while benchmarking.");
  return out.join("\n");
}

/**
 * Typed-array memory reachable from each root (bytes of distinct ArrayBuffers; a buffer counts for
 * the first root that reaches it), walking objects, arrays, Maps and Sets. For finding what holds
 * the CPU-side memory; slow on large graphs, so for debugging only (`?mem`).
 */
export function retainedBuffers(roots: Record<string, unknown>, maxObjects = 5_000_000): Map<string, number> {
  const seen = new WeakSet<object>();
  const out = new Map<string, number>();
  let visited = 0;
  for (const [name, root] of Object.entries(roots)) {
    let bytes = 0;
    const stack: unknown[] = [root];
    while (stack.length && visited < maxObjects) {
      const v = stack.pop();
      if (!v || (typeof v !== "object" && typeof v !== "function")) continue;
      const o = v as object;
      if (seen.has(o)) continue;
      seen.add(o);
      visited++;
      if (ArrayBuffer.isView(o)) {
        const b = o.buffer as ArrayBuffer;
        if (!seen.has(b)) { seen.add(b); bytes += b.byteLength; }
        continue;
      }
      if (o instanceof ArrayBuffer) { bytes += o.byteLength; continue; }
      // (GPU objects and DOM nodes hold nothing of ours worth following)
      if (typeof GPUBuffer !== "undefined" && (o instanceof GPUBuffer || o instanceof GPUTexture || o instanceof GPUDevice)) continue;
      if (typeof Node !== "undefined" && o instanceof Node) continue;
      if (o instanceof Promise || typeof o === "function") continue;
      if (o instanceof Map) { for (const [k, x] of o) { stack.push(k); stack.push(x); } continue; }
      if (o instanceof Set) { for (const x of o) stack.push(x); continue; }
      if (Array.isArray(o)) { for (const x of o) stack.push(x); continue; }
      for (const k of Object.keys(o)) stack.push((o as Record<string, unknown>)[k]);
    }
    out.set(name, bytes);
  }
  return out;
}
