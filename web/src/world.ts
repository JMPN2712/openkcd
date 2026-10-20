// Builds a renderable scene of a level's static objects around a point:
// groups vegetation, brush and entity-prop (chests, beds, …) instances by model, loads each model and its
// LOD chain (x_lod1.cgf, x_lod2.cgf, …) once, and each frame picks a LOD per
// instance by distance, culling by view distance and frustum.

import type { EntityInfo } from "./levelEntities.ts";
import { parseCdf, poseMatrix, type CharacterSpec } from "./character.ts";
import { loadModel, type LoadedModel, type MipChain } from "./model.ts";
import { vegetationMatrix, type LevelObjects } from "./levelObjects.ts";
import type { Terrain } from "./terrain.ts";
import type { Vfs } from "./vfs.ts";

export interface WorldModel {
  path: string;
  kind: "vegetation" | "brush" | "prop";
  /** LOD 0 (the base model), then _lod1, _lod2, … as present */
  lods: LoadedModel[];
  /** model-space bounding sphere */
  center: [number, number, number];
  radius: number;
  count: number;
  matrices: Float32Array; // 16 per instance
  /** per instance: world-space sphere centre (xyz) and radius */
  spheres: Float32Array; // 4 per instance
  /** an uber-LOD (town-block stand-in), drawn only from afar */
  uber: boolean;
}

export interface WorldScene {
  models: WorldModel[];
  instances: number;
  modelsSkipped: number; // over the cap
  failed: Map<string, string>;
}

interface Group {
  path: string;
  kind: WorldModel["kind"];
  matrices: number[];
  nearest: number;
}

/** Editor-only geometry that the game never draws (helper boxes, test sky). */
const HIDDEN_BRUSH = /^objects\/editor\/|_nodraw\.cgf$|\/sky\//;

/** "%level%/brush/x.cgf" -> "brush/x.cgf" (resolved through the level pak overlay). */
export function resolveLevelPath(name: string): string {
  return name.replace(/^%level%\//, "");
}

export interface WorldCaches {
  models: Map<string, Promise<LoadedModel | null>>;
  textures: Map<string, Promise<MipChain | null>>;
  /** parsed .cdf of door / AnimObject props */
  cdfs: Map<string, Promise<CharacterSpec | null>>;
  /** scene builds so far, and the build that last used each model (trimWorldCaches) */
  generation: number;
  usedAt: Map<string, number>;
  /** models once loaded (to find the textures still referenced) */
  loaded: Map<string, LoadedModel | null>;
}

export function newWorldCaches(): WorldCaches {
  return { models: new Map(), textures: new Map(), cdfs: new Map(), generation: 0, usedAt: new Map(), loaded: new Map() };
}

/**
 * Forget models no scene used in the last `keep` builds, and textures no remaining model uses.
 * Without this a long walk keeps every model and texture it ever loaded (CPU memory grows with
 * the distance travelled; GPU copies are freed by ModelRenderer.setModels anyway).
 */
export function trimWorldCaches(caches: WorldCaches, keep = 3): { models: number } {
  const oldest = caches.generation - keep + 1;
  let models = 0;
  for (const key of [...caches.models.keys()]) {
    if ((caches.usedAt.get(key) ?? -Infinity) >= oldest) continue;
    caches.models.delete(key);
    caches.usedAt.delete(key);
    caches.loaded.delete(key);
    models++;
  }
  const live = new Set<MipChain>();
  for (const m of caches.loaded.values()) if (m) for (const list of [m.diffuse, m.specular, m.normal]) for (const c of list ?? []) if (c) live.add(c);
  for (const [key, p] of [...caches.textures]) {
    // (a model still loading may share it: it keeps its own copy, only the de-duplication is lost)
    void p.then((c) => {
      if (c && !live.has(c) && caches.textures.get(key) === p) caches.textures.delete(key);
    });
  }
  return { models };
}

/** Group key for a character skin with its material override (.cdf parts): "skin|mtl". */
const skinKey = (skin: string, mtl: string | null) => `${skin}|${mtl ?? ""}`;

async function loadLods(vfs: Vfs, path: string, caches: WorldCaches, maxTextureDim: number, normalMaps = true): Promise<LoadedModel[] | null> {
  const load = (p: string) => {
    caches.usedAt.set(p, caches.generation);
    let m = caches.models.get(p);
    if (!m) {
      const [file, material] = p.split("|");
      m = loadModel(vfs, file, { maxTextureDim, textureCache: caches.textures, material: material || undefined, normalMaps }).catch(() => null);
      caches.models.set(p, m);
      void m.then((x) => { if (caches.models.get(p) === m) caches.loaded.set(p, x); });
    }
    return m;
  };
  const base = await load(path);
  if (!base) return null;
  if (path.includes("|")) return [base];
  const lods = [base];
  for (let k = 1; k < 6; k++) {
    const p = path.replace(/\.(cgf|cga)$/, `_lod${k}.$1`);
    if (p === path || !vfs.lookup(p)) break;
    const m = await load(p);
    if (!m) break;
    // the last LOD of trees is a ~10-triangle billboard card for the engine's
    // sprite/impostor path; with a generic shader it renders nearly invisible,
    // so stop at the previous LOD
    if (m.cgf.meshes.reduce((t, x) => t + x.indices.length / 3, 0) < 32) break;
    lods.push(anchorLod(m, base));
  }
  return lods;
}

/**
 * LOD files keep the node offset from the artist's scene, where the LODs sat
 * side by side (bridge_wooden_01_lod1 at +5.4 m x, _lod2 at +10.8 m; the
 * engine ignores it). Shift the LOD's nodes so its root lines up with the
 * base model's root.
 */
function anchorLod(lod: LoadedModel, base: LoadedModel): LoadedModel {
  const a = lod.cgf.meshes[0]?.transform, b = base.cgf.meshes[0]?.transform;
  if (!a || !b) return lod;
  const d = [b[12] - a[12], b[13] - a[13], b[14] - a[14]];
  if (Math.hypot(d[0], d[1], d[2]) < 1e-4) return lod;
  const meshes = lod.cgf.meshes.map((m) => {
    const t = new Float32Array(m.transform);
    t[12] += d[0]; t[13] += d[1]; t[14] += d[2];
    return { ...m, transform: t };
  });
  return { ...lod, cgf: { ...lod.cgf, meshes } };
}

function boundingSphere(m: LoadedModel): { center: [number, number, number]; radius: number } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of m.cgf.meshes) {
    for (let c = 0; c < 8; c++) {
      const v = [c & 1 ? mesh.bboxMax[0] : mesh.bboxMin[0], c & 2 ? mesh.bboxMax[1] : mesh.bboxMin[1], c & 4 ? mesh.bboxMax[2] : mesh.bboxMin[2]];
      const t = mesh.transform;
      for (let r = 0; r < 3; r++) {
        const w = t[r] * v[0] + t[4 + r] * v[1] + t[8 + r] * v[2] + t[12 + r];
        min[r] = Math.min(min[r], w);
        max[r] = Math.max(max[r], w);
      }
    }
  }
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return { center, radius: Math.max(0.1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2) };
}

export async function buildWorldScene(
  vfs: Vfs,
  terrain: Terrain,
  objects: LevelObjects,
  center: [number, number],
  radius: number,
  opts: {
    maxModels?: number; maxTextureDim?: number; onStatus?: (s: string) => void; caches?: WorldCaches;
    /** entity props (src/levelEntities.ts propEntities) */
    props?: EntityInfo[];
    /** brush layers not drawn (levelLayers.ts defaultHiddenLayers) */
    hiddenLayers?: Set<number>;
    /** load normal maps (default true; caches must not mix the two) */
    normalMaps?: boolean;
    /** only brushes whose path passes (no vegetation or props): e.g. the uber-LOD far field */
    onlyBrushes?: (path: string) => boolean;
  } = {},
): Promise<WorldScene> {
  const groups = new Map<string, Group>();
  const r2 = radius * radius;
  const add = (path: string, kind: Group["kind"], m: ArrayLike<number>, x: number, y: number) => {
    const d2 = (x - center[0]) ** 2 + (y - center[1]) ** 2;
    if (d2 > r2) return;
    let g = groups.get(path);
    if (!g) groups.set(path, (g = { path, kind, matrices: [], nearest: Infinity }));
    for (let k = 0; k < 16; k++) g.matrices.push(m[k]);
    g.nearest = Math.min(g.nearest, Math.sqrt(d2));
  };
  const tmp = new Float32Array(16);
  for (let i = 0; i < (opts.onlyBrushes ? 0 : objects.vegGroup.length); i++) {
    const x = objects.vegPos[i * 3], y = objects.vegPos[i * 3 + 1];
    if (Math.abs(x - center[0]) > radius || Math.abs(y - center[1]) > radius) continue;
    const model = terrain.vegetation[objects.vegGroup[i]]?.model;
    if (model) add(model, "vegetation", vegetationMatrix(objects, i, tmp), x, y);
  }
  for (let i = 0; i < objects.brushName.length; i++) {
    const m = objects.brushMatrix.subarray(i * 16, i * 16 + 16);
    if (Math.abs(m[12] - center[0]) > radius || Math.abs(m[13] - center[1]) > radius) continue;
    if (opts.hiddenLayers?.has(objects.brushLayer[i])) continue;
    const name = terrain.brushNames[objects.brushName[i]];
    if (name && !HIDDEN_BRUSH.test(name) && (!opts.onlyBrushes || opts.onlyBrushes(name))) add(resolveLevelPath(name), "brush", m, m[12], m[13]);
  }
  const caches = opts.caches ?? newWorldCaches();
  caches.generation++;
  for (const e of opts.onlyBrushes ? [] : opts.props ?? []) {
    if (Math.abs(e.pos[0] - center[0]) > radius || Math.abs(e.pos[1] - center[1]) > radius) continue;
    const m = poseMatrix(e.pos, e.rot);
    if (e.scale) for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] *= e.scale[c];
    const path = e.model!.toLowerCase().replace(/\\/g, "/");
    if (!path.endsWith(".cdf")) {
      add(path, "prop", m, e.pos[0], e.pos[1]);
      continue;
    }
    // doors, wells, flags: the .cdf's skins in bind pose (closed / at rest)
    let spec = caches.cdfs.get(path);
    if (!spec) {
      const hit = vfs.lookup(path);
      spec = hit ? vfs.read(hit).then((b) => parseCdf(new TextDecoder().decode(b), path)).catch(() => null) : Promise.resolve(null);
      caches.cdfs.set(path, spec);
    }
    for (const part of (await spec)?.parts ?? []) if (!part.attach) add(skinKey(part.skin, part.material), "prop", m, e.pos[0], e.pos[1]);
  }

  const ordered = [...groups.values()].sort((a, b) => a.nearest - b.nearest);
  const max = opts.maxModels ?? 400;
  const failed = new Map<string, string>();
  const models: WorldModel[] = [];
  let instances = 0;
  // load eight models at a time (reads and decoding overlap; one at a time left the CPU idle half the time)
  const chosen = ordered.slice(0, max);
  const lodsOf: Promise<LoadedModel[] | null>[] = new Array(chosen.length);
  let next = 0, loaded = 0;
  const worker = async () => {
    while (next < chosen.length) {
      const k = next++;
      lodsOf[k] = loadLods(vfs, chosen[k].path, caches, opts.maxTextureDim ?? 256, opts.normalMaps ?? true);
      await lodsOf[k];
      opts.onStatus?.(`Loading models ${++loaded}/${chosen.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  for (const [n, g] of chosen.entries()) {
    const lods = await lodsOf[n];
    if (!lods) {
      failed.set(g.path, "failed to load");
      continue;
    }
    const { center: c, radius: r } = boundingSphere(lods[0]);
    const matrices = new Float32Array(g.matrices);
    const count = matrices.length / 16;
    const spheres = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const m = matrices.subarray(i * 16, i * 16 + 16);
      spheres[i * 4] = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12];
      spheres[i * 4 + 1] = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13];
      spheres[i * 4 + 2] = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
      spheres[i * 4 + 3] = r * Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
    }
    models.push({ path: g.path, kind: g.kind, lods, center: c, radius: r, count, matrices, spheres, uber: g.path.startsWith("objects/uberlods/") });
    instances += count;
  }
  return { models, instances, modelsSkipped: Math.max(0, ordered.length - max), failed };
}

/** Uber-LODs: simplified stand-ins for whole town blocks (objects/uberlods/<town>/…). */
export const isUberLod = (path: string) => path.startsWith("objects/uberlods/");

/** Renderer items for a scene: one per (model, LOD), sized for all of the model's instances. */
export function lodItems(scene: WorldScene): { model: LoadedModel; capacity: number }[] {
  return scene.models.flatMap((m) => m.lods.map((model) => ({ model, capacity: m.count })));
}

export interface LodStats {
  drawn: number;
  culledDistance: number;
  culledFrustum: number;
  perLod: number[];
}

/**
 * Pick a LOD for every instance and fill per-item matrix arrays (same order as
 * lodItems). LOD k is used from k × step metres, step = 8 × radius + 10; an
 * instance is dropped beyond 80 + 70 × radius metres or outside the frustum.
 * (Tuned on headless renders: half these distances emptied aerial views of
 * hedgerows and forest.)
 */
/** Uber-LOD meshes (objects/uberlods/…) are drawn only beyond this distance from their bounds. */
const UBER_NEAR = 300;

export function selectLods(
  scene: WorldScene,
  eye: [number, number, number],
  viewProj: Float32Array,
  out: Float32Array[],
  counts: number[],
  opts: { lodScale?: number; distanceScale?: number; maxDistance?: number; minRadius?: number; uberNear?: number } = {},
): LodStats {
  const m = viewProj;
  // frustum planes (a, b, c, d) from the column-major view-projection; WebGPU depth is 0..1
  const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const planes = [
    r3.map((v, k) => v + r0[k]), r3.map((v, k) => v - r0[k]),
    r3.map((v, k) => v + r1[k]), r3.map((v, k) => v - r1[k]),
    r2, r3.map((v, k) => v - r2[k]),
  ].map((p) => { const l = Math.hypot(p[0], p[1], p[2]) || 1; return p.map((v) => v / l); });
  const lodScale = opts.lodScale ?? 1, distScale = opts.distanceScale ?? 1, maxD = opts.maxDistance ?? Infinity, minR = opts.minRadius ?? 0;
  const stats: LodStats = { drawn: 0, culledDistance: 0, culledFrustum: 0, perLod: [] };
  const P = new Float64Array(24);
  planes.forEach((p, k) => P.set(p, k * 4));
  const ex = eye[0], ey = eye[1], ez = eye[2];
  let item = 0;
  for (const wm of scene.models) {
    const base = item;
    for (let l = 0; l < wm.lods.length; l++) counts[base + l] = 0;
    const S = wm.spheres, M = wm.matrices, nl = wm.lods.length - 1;
    for (let i = 0; i < wm.count; i++) {
      const x = S[i * 4], y = S[i * 4 + 1], z = S[i * 4 + 2], r = S[i * 4 + 3];
      const d = Math.sqrt((x - ex) * (x - ex) + (y - ey) * (y - ey) + (z - ez) * (z - ez));
      if (r < minR || (!wm.uber && d - r > (80 + 70 * r) * distScale) || d - r > maxD) { stats.culledDistance++; continue; }
      // uber-LODs are simplified stand-ins for whole town blocks: far views only, else they
      // overlap the detailed buildings they replace
      if (wm.uber && d - r < (opts.uberNear ?? UBER_NEAR * distScale)) { stats.culledDistance++; continue; }
      let inside = true;
      for (let k = 0; k < 24; k += 4) if (P[k] * x + P[k + 1] * y + P[k + 2] * z + P[k + 3] < -r) { inside = false; break; }
      if (!inside) { stats.culledFrustum++; continue; }
      const lod = Math.min(nl, Math.floor(Math.max(0, d - r) / ((8 * r + 10) * lodScale)));
      const dst = base + lod;
      // copy the 16 floats by hand (a subarray per instance kept the garbage collector busy)
      const o = out[dst], to = counts[dst] * 16, from = i * 16;
      for (let c = 0; c < 16; c++) o[to + c] = M[from + c];
      counts[dst]++;
      stats.perLod[lod] = (stats.perLod[lod] ?? 0) + 1;
      stats.drawn++;
    }
    item += wm.lods.length;
  }
  return stats;
}
