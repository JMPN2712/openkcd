// Builds a renderable scene of a level's static objects around a point:
// groups vegetation, brush and entity-prop (chests, beds, …) instances by model, loads each model and its
// LOD chain (x_lod1.cgf, x_lod2.cgf, …) once, and each frame picks a LOD per
// instance by distance, culling by view distance and frustum.

import type { EntityInfo } from "./levelEntities.ts";
import { poseMatrix } from "./character.ts";
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
}

export function newWorldCaches(): WorldCaches {
  return { models: new Map(), textures: new Map() };
}

async function loadLods(vfs: Vfs, path: string, caches: WorldCaches, maxTextureDim: number): Promise<LoadedModel[] | null> {
  const load = (p: string) => {
    let m = caches.models.get(p);
    if (!m) {
      m = loadModel(vfs, p, { maxTextureDim, textureCache: caches.textures }).catch(() => null);
      caches.models.set(p, m);
    }
    return m;
  };
  const base = await load(path);
  if (!base) return null;
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
  for (let i = 0; i < objects.vegGroup.length; i++) {
    const x = objects.vegPos[i * 3], y = objects.vegPos[i * 3 + 1];
    if (Math.abs(x - center[0]) > radius || Math.abs(y - center[1]) > radius) continue;
    const model = terrain.vegetation[objects.vegGroup[i]]?.model;
    if (model) add(model, "vegetation", vegetationMatrix(objects, i, tmp), x, y);
  }
  for (let i = 0; i < objects.brushName.length; i++) {
    const m = objects.brushMatrix.subarray(i * 16, i * 16 + 16);
    if (Math.abs(m[12] - center[0]) > radius || Math.abs(m[13] - center[1]) > radius) continue;
    const name = terrain.brushNames[objects.brushName[i]];
    if (name && !HIDDEN_BRUSH.test(name)) add(resolveLevelPath(name), "brush", m, m[12], m[13]);
  }
  for (const e of opts.props ?? []) {
    if (Math.abs(e.pos[0] - center[0]) > radius || Math.abs(e.pos[1] - center[1]) > radius) continue;
    const m = poseMatrix(e.pos, e.rot);
    if (e.scale) for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] *= e.scale[c];
    add(e.model!.toLowerCase().replace(/\\/g, "/"), "prop", m, e.pos[0], e.pos[1]);
  }

  const ordered = [...groups.values()].sort((a, b) => a.nearest - b.nearest);
  const max = opts.maxModels ?? 400;
  const caches = opts.caches ?? newWorldCaches();
  const failed = new Map<string, string>();
  const models: WorldModel[] = [];
  let instances = 0;
  for (const [n, g] of ordered.slice(0, max).entries()) {
    if (!caches.models.has(g.path)) opts.onStatus?.(`Loading models ${n + 1}/${Math.min(max, ordered.length)}: ${g.path.split("/").pop()}`);
    const lods = await loadLods(vfs, g.path, caches, opts.maxTextureDim ?? 256);
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
  opts: { lodScale?: number; distanceScale?: number } = {},
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
  const lodScale = opts.lodScale ?? 1, distScale = opts.distanceScale ?? 1;
  const stats: LodStats = { drawn: 0, culledDistance: 0, culledFrustum: 0, perLod: [] };
  let item = 0;
  for (const wm of scene.models) {
    const base = item;
    for (let l = 0; l < wm.lods.length; l++) counts[base + l] = 0;
    for (let i = 0; i < wm.count; i++) {
      const x = wm.spheres[i * 4], y = wm.spheres[i * 4 + 1], z = wm.spheres[i * 4 + 2], r = wm.spheres[i * 4 + 3];
      const d = Math.hypot(x - eye[0], y - eye[1], z - eye[2]);
      if (d - r > (80 + 70 * r) * distScale) { stats.culledDistance++; continue; }
      // uber-LODs are simplified stand-ins for whole town blocks: far views only, else they
      // overlap the detailed buildings they replace
      if (wm.uber && d - r < UBER_NEAR * distScale) { stats.culledDistance++; continue; }
      let inside = true;
      for (const p of planes) if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r) { inside = false; break; }
      if (!inside) { stats.culledFrustum++; continue; }
      const lod = Math.min(wm.lods.length - 1, Math.floor(Math.max(0, d - r) / ((8 * r + 10) * lodScale)));
      const dst = base + lod;
      out[dst].set(wm.matrices.subarray(i * 16, i * 16 + 16), counts[dst] * 16);
      counts[dst]++;
      stats.perLod[lod] = (stats.perLod[lod] ?? 0) + 1;
      stats.drawn++;
    }
    item += wm.lods.length;
  }
  return stats;
}
