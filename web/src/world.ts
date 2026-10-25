// Builds a renderable scene of a level's static objects around a point:
// groups vegetation, brush and entity-prop (chests, beds, …) instances by model, loads each model and its
// LOD chain (x_lod1.cgf, x_lod2.cgf, …) once, and each frame picks a LOD per
// instance by distance, culling by view distance and frustum.

import { parseAnm } from "./anm.ts";
import type { EntityInfo } from "./levelEntities.ts";
import { parseCdf, poseMatrix, type CharacterSpec } from "./character.ts";
import { loadModel, meshModel, modelExists, type LoadedModel, type MipChain } from "./model.ts";
import type { CgfMesh } from "./cgf.ts";

/** Meshes laid on the ground, streamed by distance and merged per (priority, material): roads, decals. */
export interface GroundSource {
  near(center: [number, number], radius: number): number[];
  center(i: number): [number, number, number];
  priority(i: number): number;
  material(i: number): number;
  merged(ids: number[]): Promise<CgfMesh>;
}
import { vegetationMatrix, type LevelObjects } from "./levelObjects.ts";
import type { Terrain } from "./terrain.ts";
import type { Vfs } from "./vfs.ts";
import type { MergedMeshes } from "./mergedMeshes.ts";
import type { SlimPackage } from "./slim.ts";

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
  /**
   * Instances are sorted along a Morton curve, so each run of CLUSTER of them lies close
   * together: per run, the centre and radius around their centres, and their largest radius.
   */
  clusters: Float32Array; // 5 per run
  /** around all its clusters, as one: centre, radius around the cluster centres, largest instance radius */
  bound: Float32Array; // 5
  /** an uber-LOD (town-block stand-in), drawn only from afar */
  uber: boolean;
  /** per instance, the entity it draws (doors, which move: doors.ts), or -1; absent when none do */
  entities?: Int32Array;
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
  /** per instance: entity id or -1 (only kept when some instance has one) */
  entities?: number[];
}

/** Editor-only geometry that the game never draws (helper boxes, test sky). */
const HIDDEN_BRUSH = /^objects\/editor\/|_nodraw\.cgf$|\/sky\//;

/**
 * Brush material overrides (the level's material table, per brush) applied so far:
 * - on editor primitives (objects/default/: box.cgf, primitive_cube…), always: their own
 *   editorprimitive.mtl is a plain light grey, and the override is their look. Uzhitz's outhouse
 *   has two black cubes (materials/color/dark), and 160 more serve as invisible walls (Nodraw,
 *   collision proxies); all were drawn as white cubes;
 * - on any brush, the overrides that make it invisible: Nodraw-shader materials and the collision
 *   proxies. They keep colliding.
 * Other overrides (texture swaps on 16,143 brushes, mostly rocks and ground pieces) are not
 * applied yet.
 */
const INVISIBLE_OVERRIDE = /^(objects\/editor\/nodraw|materials\/special\/|materials\/material_rain_occluder)/;
const EDITOR_PRIMITIVE = /^objects\/default\//;

/** "%level%/brush/x.cgf" -> "brush/x.cgf" (resolved through the level pak overlay). */
export function resolveLevelPath(name: string): string {
  return name.replace(/^%level%\//, "");
}

export interface WorldCaches {
  models: Map<string, Promise<LoadedModel | null>>;
  textures: Map<string, Promise<MipChain | null>>;
  /** parsed .cdf of door / AnimObject props */
  cdfs: Map<string, Promise<CharacterSpec | null>>;
  /** per chest model (.cga): the node its _open.anm moves (the lid), or null (chests.ts) */
  lids: Map<string, Promise<string | null>>;
  /** chest models split in body and lid ("x.cga#lid:node"), with the base LODs they came from */
  parts: Map<string, { from: LoadedModel; lods: LoadedModel[] }>;
  /** a compact package (slim.ts): models it holds are loaded from it, the rest from the paks */
  slim?: SlimPackage;
  /** scene builds so far, and the build that last used each model (trimWorldCaches) */
  generation: number;
  usedAt: Map<string, number>;
  /** models once loaded (to find the textures still referenced) */
  loaded: Map<string, LoadedModel | null>;
}

export function newWorldCaches(): WorldCaches {
  return { models: new Map(), textures: new Map(), cdfs: new Map(), lids: new Map(), parts: new Map(), generation: 0, usedAt: new Map(), loaded: new Map() };
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

/** The node a chest model's <model>_open.anm moves (its lid), or null without one. */
export function chestLid(vfs: Vfs, path: string, caches: WorldCaches): Promise<string | null> {
  let p = caches.lids.get(path);
  if (!p) {
    const hit = vfs.lookup(path.replace(/\.cga$/, "_open.anm"));
    p = hit ? vfs.read(hit).then((b) => parseAnm(b)[0]?.name ?? null).catch(() => null) : Promise.resolve(null);
    caches.lids.set(path, p);
  }
  return p;
}

/** Group key for a character skin with its material override (.cdf parts): "skin|mtl". */
const skinKey = (skin: string, mtl: string | null) => `${skin}|${mtl ?? ""}`;

/** Ground meshes are merged per tile of this size (metres), see buildWorldScene. */
const GROUND_TILE = 512;

/** Group key of a batch of ground meshes (same source, priority, material) merged into one model. */
const groundKey = (source: number, ids: number[]) => `ground${source}:${ids.join(",")}`;

async function loadLods(vfs: Vfs, path: string, caches: WorldCaches, maxTextureDim: number, normalMaps = true, ground?: { sources: GroundSource[]; terrain: Terrain }): Promise<LoadedModel[] | null> {
  // a chest's body or lid ("x.cga#body:node", "#lid:node"): the model's meshes without or with
  // the node its _open.anm moves; the body keeps the LODs (without nodes named like the lid)
  const part = /^(.*)#(body|lid):(.*)$/.exec(path);
  if (part) {
    const lods = await loadLods(vfs, part[1], caches, maxTextureDim, normalMaps);
    if (!lods) return null;
    const known = caches.parts.get(path);
    if (known && known.from === lods[0]) return known.lods;
    const lid = part[3].toLowerCase();
    const pick = (m: LoadedModel, keep: (node: string) => boolean): LoadedModel => ({ ...m, cgf: { ...m.cgf, meshes: m.cgf.meshes.filter((x) => keep(x.nodeName.toLowerCase())) } });
    const out = part[2] === "lid"
      ? [pick(lods[0], (n) => n === lid)]
      : lods.map((m, k) => pick(m, (n) => n !== lid && (k === 0 || !n.includes("lid"))));
    caches.parts.set(path, { from: lods[0], lods: out });
    return out;
  }
  const load = (p: string) => {
    caches.usedAt.set(p, caches.generation);
    let m = caches.models.get(p);
    if (!m) {
      const [file, material] = p.split("|");
      const g = ground && /^ground(\d+):/.exec(p);
      if (ground && g) {
        const src = ground.sources[Number(g[1])];
        const ids = p.slice(g[0].length).split(",").map(Number);
        const mtl = `${ground.terrain.materials[src.material(ids[0])] ?? ""}.mtl`.toLowerCase();
        m = src.merged(ids).then((mesh) => meshModel(vfs, p, mesh, mtl, { maxTextureDim, textureCache: caches.textures, normalMaps })).catch(() => null);
      } else if (caches.slim?.hasModel(file) && !material) {
        m = caches.slim.model(file, { maxTextureDim, textureCache: caches.textures, normalMaps }).catch(() => null);
      } else m = loadModel(vfs, file, { maxTextureDim, textureCache: caches.textures, material: material || undefined, normalMaps }).catch(() => null);
      caches.models.set(p, m);
      void m.then((x) => { if (caches.models.get(p) === m) caches.loaded.set(p, x); });
    }
    return m;
  };
  const base = await load(path);
  if (!base) return null;
  if (path.includes("|") || path.startsWith("ground")) return [base];
  const lods = [base];
  for (let k = 1; k < 6; k++) {
    const p = path.replace(/\.(cgf|cga)$/, `_lod${k}.$1`);
    if (p === path || !(caches.slim?.hasModel(p) || modelExists(vfs, p))) break;
    const m = await load(p);
    if (!m) break;
    // the last LOD of trees is a ~10-triangle billboard card for the engine's
    // sprite/impostor path; with a generic shader it renders nearly invisible,
    // so stop at the previous LOD
    if (m.cgf.meshes.reduce((t, x) => t + x.indices.length / 3, 0) < 32) break;
    lods.push(alignLod(m, base));
  }
  return lods;
}

/**
 * A LOD's parts where the base model has them. LOD files keep the artist's scene, where the LODs
 * sat side by side (bridge_wooden_01_lod1 at +5.4 m x; cgf.ts leaves the main root's place out),
 * and an animated model's moving parts (a chest's lid, a cabinet's doors) may sit elsewhere in it:
 * a part named as one of the base model's takes that part's transform.
 */
function alignLod(lod: LoadedModel, base: LoadedModel): LoadedModel {
  const at = new Map(base.cgf.meshes.map((m) => [m.nodeName, m.transform]));
  if (!lod.cgf.meshes.some((m) => at.has(m.nodeName) && at.get(m.nodeName) !== m.transform)) return lod;
  const meshes = lod.cgf.meshes.map((m) => (at.has(m.nodeName) ? { ...m, transform: at.get(m.nodeName)! } : m));
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
    /** meshes laid on the ground (roads.ts, decals.ts), drawn blended over the terrain in this order */
    ground?: GroundSource[];
  } = {},
): Promise<WorldScene> {
  const groups = new Map<string, Group>();
  const r2 = radius * radius;
  const add = (path: string, kind: Group["kind"], m: ArrayLike<number>, x: number, y: number, entity = -1) => {
    const d2 = (x - center[0]) ** 2 + (y - center[1]) ** 2;
    if (d2 > r2) return;
    let g = groups.get(path);
    if (!g) groups.set(path, (g = { path, kind, matrices: [], nearest: Infinity }));
    if (entity >= 0 && !g.entities) g.entities = new Array<number>(g.matrices.length / 16).fill(-1);
    g.entities?.push(entity);
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
    if (!name || HIDDEN_BRUSH.test(name) || (opts.onlyBrushes && !opts.onlyBrushes(name))) continue;
    const override = objects.brushMaterial[i] >= 0 ? (terrain.materials[objects.brushMaterial[i]] ?? "").toLowerCase() : "";
    const path = resolveLevelPath(name);
    const apply = override && override !== "default" && (INVISIBLE_OVERRIDE.test(override) || EDITOR_PRIMITIVE.test(path.toLowerCase()));
    add(apply ? `${path}|${override}.mtl` : path, "brush", m, m[12], m[13]);
  }
  // ground meshes (roads, then decals), merged by (priority, material, GROUND_TILE tile), lowest
  // priority first so higher ones blend over them. Whole tiles (any part within the radius): a
  // tile's batch is the same at every position, so its merged mesh is reused (model cache) and
  // keeps its geometry; merged over the whole radius, every streaming step built and uploaded all
  // of them again (the largest frame spikes while moving)
  for (const [s, src] of (opts.onlyBrushes ? [] : opts.ground ?? []).entries()) {
    const batches = new Map<string, number[]>();
    for (const i of src.near(center, radius + GROUND_TILE * 1.5)) {
      const c = src.center(i), tx = Math.floor(c[0] / GROUND_TILE), ty = Math.floor(c[1] / GROUND_TILE);
      const dx = Math.max(tx * GROUND_TILE - center[0], 0, center[0] - (tx + 1) * GROUND_TILE);
      const dy = Math.max(ty * GROUND_TILE - center[1], 0, center[1] - (ty + 1) * GROUND_TILE);
      if (Math.hypot(dx, dy) > radius) continue;
      const k = `${String(src.priority(i)).padStart(5, "0")}/${src.material(i)}/${tx},${ty}`;
      const b = batches.get(k);
      if (b) b.push(i); else batches.set(k, [i]);
    }
    for (const [, ids] of [...batches].sort((a, b) => a[0].localeCompare(b[0]))) {
      ids.sort((a, b) => a - b);
      const c = src.center(ids[0]), key = groundKey(s, ids);
      groups.set(key, { path: key, kind: "brush", matrices: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, c[0], c[1], c[2], 1], nearest: 0 });
    }
  }
  const caches = opts.caches ?? newWorldCaches();
  caches.generation++;
  for (const e of opts.onlyBrushes ? [] : opts.props ?? []) {
    if (Math.abs(e.pos[0] - center[0]) > radius || Math.abs(e.pos[1] - center[1]) > radius) continue;
    const m = poseMatrix(e.pos, e.rot);
    if (e.scale) for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] *= e.scale[c];
    const path = e.model!.toLowerCase().replace(/\\/g, "/");
    if (!path.endsWith(".cdf")) {
      // chests with an opening animation: body and lid apart, the lid keeping its entity (chests.ts)
      const lid = e.cls === "Stash" && path.endsWith(".cga") ? await chestLid(vfs, path, caches) : null;
      if (lid) {
        add(`${path}#body:${lid}`, "prop", m, e.pos[0], e.pos[1]);
        add(`${path}#lid:${lid}`, "prop", m, e.pos[0], e.pos[1], e.id);
      } else add(path, "prop", m, e.pos[0], e.pos[1]);
      continue;
    }
    // doors, wells, flags: the .cdf's skins in bind pose (closed / at rest)
    let spec = caches.cdfs.get(path);
    if (!spec) {
      const hit = vfs.lookup(path);
      spec = hit ? vfs.read(hit).then((b) => parseCdf(new TextDecoder().decode(b), path)).catch(() => null) : Promise.resolve(null);
      caches.cdfs.set(path, spec);
    }
    // (doors keep their entity id: they open, doors.ts)
    const id = e.cls === "AnimDoor" ? e.id : -1;
    for (const part of (await spec)?.parts ?? []) if (!part.attach) add(skinKey(part.skin, part.material), "prop", m, e.pos[0], e.pos[1], id);
  }

  return sceneFromGroups(vfs, groups, caches, { ...opts, ground: opts.ground ? { sources: opts.ground, terrain } : undefined });
}

/**
 * The grass, ground plants and debris of the merged-mesh sectors (mergedMeshes.ts) within
 * `radius`: a separate, small scene, rebuilt every few metres.
 */
export async function buildGrassScene(
  vfs: Vfs,
  terrain: Terrain,
  merged: MergedMeshes,
  center: [number, number],
  radius: number,
  opts: { maxTextureDim?: number; caches?: WorldCaches; normalMaps?: boolean } = {},
): Promise<WorldScene> {
  const groups = new Map<string, Group>();
  await merged.near(center, radius, (group, m) => {
    const path = terrain.vegetation[group]?.model;
    if (!path) return;
    let g = groups.get(path);
    if (!g) groups.set(path, (g = { path, kind: "vegetation", matrices: [], nearest: 0 }));
    for (let k = 0; k < 16; k++) g.matrices.push(m[k]);
  });
  const caches = opts.caches ?? newWorldCaches();
  caches.generation++;
  return sceneFromGroups(vfs, groups, caches, { ...opts, maxModels: Infinity });
}

/** Load the models of instance groups (nearest first, up to maxModels) into a scene. */
async function sceneFromGroups(
  vfs: Vfs,
  groups: Map<string, Group>,
  caches: WorldCaches,
  opts: { maxModels?: number; maxTextureDim?: number; onStatus?: (s: string) => void; normalMaps?: boolean; ground?: { sources: GroundSource[]; terrain: Terrain } },
): Promise<WorldScene> {
  // nearest first (roads, at 0, come first and keep their priority order: the sort is stable)
  const ordered = [...groups.values()].sort((a, b) => a.nearest - b.nearest);
  const max = opts.maxModels ?? 400;
  const chosen = ordered.slice(0, max);
  // with a compact package: the region chunks holding much of what isn't loaded yet, in a few
  // reads first (the rest is read entry by entry); let go once the scene is built
  if (caches.slim) await caches.slim.prefetch(chosen.map((g) => g.path).filter((p) => !caches.models.has(p)));
  try {
    return await sceneModels(vfs, chosen, caches, ordered.length - max, opts);
  } finally {
    caches.slim?.release();
  }
}

async function sceneModels(vfs: Vfs, chosen: Group[], caches: WorldCaches, skipped: number, opts: Parameters<typeof sceneFromGroups>[3]): Promise<WorldScene> {
  const failed = new Map<string, string>();
  const models: WorldModel[] = [];
  let instances = 0;
  // load eight models at a time (reads and decoding overlap; one at a time left the CPU idle half the time)
  const lodsOf: Promise<LoadedModel[] | null>[] = new Array(chosen.length);
  let next = 0, loaded = 0;
  const worker = async () => {
    while (next < chosen.length) {
      const k = next++;
      lodsOf[k] = loadLods(vfs, chosen[k].path, caches, opts.maxTextureDim ?? 256, opts.normalMaps ?? true, opts.ground);
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
    const count = g.matrices.length / 16;
    // nearby instances next to each other (8 m cells along a Morton curve), for the clusters
    const morton = (x: number, y: number) => {
      const cx = Math.max(0, Math.min(1023, Math.floor(x / 8))), cy = Math.max(0, Math.min(1023, Math.floor(y / 8)));
      let k = 0;
      for (let b = 0; b < 10; b++) k |= (((cx >> b) & 1) << (2 * b)) | (((cy >> b) & 1) << (2 * b + 1));
      return k;
    };
    const order = Array.from({ length: count }, (_, i) => [morton(g.matrices[i * 16 + 12], g.matrices[i * 16 + 13]), i]).sort((a, b) => a[0] - b[0]);
    const matrices = new Float32Array(count * 16);
    order.forEach(([, i], j) => { for (let k = 0; k < 16; k++) matrices[j * 16 + k] = g.matrices[i * 16 + k]; });
    const entities = g.entities && Int32Array.from(order, ([, i]) => g.entities![i]);
    const spheres = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const m = matrices.subarray(i * 16, i * 16 + 16);
      spheres[i * 4] = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12];
      spheres[i * 4 + 1] = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13];
      spheres[i * 4 + 2] = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
      spheres[i * 4 + 3] = r * Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
    }
    const clusters = clustersOf(spheres, count);
    models.push({ path: g.path, kind: g.kind, lods, center: c, radius: r, count, matrices, spheres, clusters, bound: boundOf(clusters), uber: g.path.startsWith("objects/uberlods/"), entities });
    instances += count;
  }
  return { models, instances, modelsSkipped: Math.max(0, skipped), failed };
}

/** Instances per culling cluster (WorldModel.clusters). */
export const CLUSTER = 16;

function clustersOf(S: Float32Array, count: number): Float32Array {
  const out = new Float32Array(Math.ceil(count / CLUSTER) * 5);
  for (let j = 0, o = 0; j < count; j += CLUSTER, o += 5) {
    const end = Math.min(count, j + CLUSTER);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, rmax = 0;
    for (let i = j; i < end; i++) {
      const x = S[i * 4], y = S[i * 4 + 1], z = S[i * 4 + 2];
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
      rmax = Math.max(rmax, S[i * 4 + 3]);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    let R = 0;
    for (let i = j; i < end; i++) R = Math.max(R, Math.hypot(S[i * 4] - cx, S[i * 4 + 1] - cy, S[i * 4 + 2] - cz));
    out[o] = cx; out[o + 1] = cy; out[o + 2] = cz; out[o + 3] = R; out[o + 4] = rmax;
  }
  return out;
}

/** A sphere around a model's clusters (same layout as one cluster). */
function boundOf(C: Float32Array): Float32Array {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, rmax = 0;
  for (let o = 0; o < C.length; o += 5) {
    const r = C[o + 3];
    x0 = Math.min(x0, C[o] - r); y0 = Math.min(y0, C[o + 1] - r); z0 = Math.min(z0, C[o + 2] - r);
    x1 = Math.max(x1, C[o] + r); y1 = Math.max(y1, C[o + 1] + r); z1 = Math.max(z1, C[o + 2] + r);
    rmax = Math.max(rmax, C[o + 4]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  return new Float32Array([cx, cy, cz, Math.hypot(x1 - cx, y1 - cy, z1 - cz), rmax]);
}

/** Uber-LODs: simplified stand-ins for whole town blocks (objects/uberlods/<town>/…). */
export const isUberLod = (path: string) => path.startsWith("objects/uberlods/");

/** Renderer items for a scene: one per (model, LOD), sized for all of the model's instances. */
export function lodItems(scene: WorldScene): { model: LoadedModel; capacity: number }[] {
  return scene.models.flatMap((m) => m.lods.map((model) => ({ model, capacity: m.count })));
}

/** Every instance's matrix, model after model: what selectLods' indices point into. */
export function sceneMatrices(scene: WorldScene): Float32Array {
  const out = new Float32Array(scene.models.reduce((n, m) => n + m.count, 0) * 16);
  let at = 0;
  for (const m of scene.models) { out.set(m.matrices.subarray(0, m.count * 16), at); at += m.count * 16; }
  return out;
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
  out: (Float32Array | Uint32Array)[],
  counts: number[],
  opts: {
    lodScale?: number; distanceScale?: number; maxDistance?: number; minRadius?: number; uberNear?: number;
    /** out holds instance indices into sceneMatrices(scene) (Uint32Array), not matrices (no fade) */
    indices?: boolean;
    /** shrink instances into the ground between these distances (grass: no hard edge where it ends) */
    fade?: [number, number];
  } = {},
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
  const lodScale = opts.lodScale ?? 1, distScale = opts.distanceScale ?? 1, maxD = opts.maxDistance ?? Infinity, minR = opts.minRadius ?? 0, fade = opts.fade;
  const stats: LodStats = { drawn: 0, culledDistance: 0, culledFrustum: 0, perLod: [] };
  const P = new Float64Array(24);
  planes.forEach((p, k) => P.set(p, k * 4));
  const ex = eye[0], ey = eye[1], ez = eye[2];
  let item = 0, first = 0;
  const indices = !!opts.indices && !fade;
  for (const wm of scene.models) {
    const base = item;
    for (let l = 0; l < wm.lods.length; l++) counts[base + l] = 0;
    const S = wm.spheres, M = wm.matrices, C = wm.clusters, nl = wm.lods.length - 1;
    // the whole model first (most are local: a building, a market stall), as for one cluster
    {
      const B = wm.bound, bx = B[0], by = B[1], bz = B[2], R = B[3], rmax = B[4];
      const near = Math.sqrt((bx - ex) * (bx - ex) + (by - ey) * (by - ey) + (bz - ez) * (bz - ez)) - R - rmax;
      let outside = rmax < minR || (!wm.uber && near > (80 + 70 * rmax) * distScale) || near > maxD;
      for (let k = 0; k < 24 && !outside; k += 4) if (P[k] * bx + P[k + 1] * by + P[k + 2] * bz + P[k + 3] < -(R + rmax)) outside = true;
      if (outside) { stats.culledDistance += wm.count; item += wm.lods.length; first += wm.count; continue; }
    }
    for (let j = 0, co = 0; j < wm.count; j += CLUSTER, co += 5) {
      const end = Math.min(wm.count, j + CLUSTER);
      // a whole cluster out of reach (every instance is at least D − R away and at most rmax in
      // radius) or outside a frustum plane is skipped; one inside every plane skips the planes
      const cx = C[co], cy = C[co + 1], cz = C[co + 2], R = C[co + 3], rmax = C[co + 4];
      const near = Math.sqrt((cx - ex) * (cx - ex) + (cy - ey) * (cy - ey) + (cz - ez) * (cz - ez)) - R - rmax;
      if (rmax < minR || (!wm.uber && near > (80 + 70 * rmax) * distScale) || near > maxD) { stats.culledDistance += end - j; continue; }
      let allInside = true, outside = false;
      for (let k = 0; k < 24; k += 4) {
        const s = P[k] * cx + P[k + 1] * cy + P[k + 2] * cz + P[k + 3];
        if (s < -(R + rmax)) { outside = true; break; }
        if (s < R + rmax) allInside = false;
      }
      if (outside) { stats.culledFrustum += end - j; continue; }
      for (let i = j; i < end; i++) {
        const x = S[i * 4], y = S[i * 4 + 1], z = S[i * 4 + 2], r = S[i * 4 + 3];
        const d = Math.sqrt((x - ex) * (x - ex) + (y - ey) * (y - ey) + (z - ez) * (z - ez));
        if (r < minR || (!wm.uber && d - r > (80 + 70 * r) * distScale) || d - r > maxD) { stats.culledDistance++; continue; }
        // uber-LODs are simplified stand-ins for whole town blocks: far views only, else they
        // overlap the detailed buildings they replace
        if (wm.uber && d - r < (opts.uberNear ?? UBER_NEAR * distScale)) { stats.culledDistance++; continue; }
        let inside = true;
        if (!allInside) for (let k = 0; k < 24; k += 4) if (P[k] * x + P[k + 1] * y + P[k + 2] * z + P[k + 3] < -r) { inside = false; break; }
        if (!inside) { stats.culledFrustum++; continue; }
        const lod = Math.min(nl, Math.floor(Math.max(0, d - r) / ((8 * r + 10) * lodScale)));
        const dst = base + lod;
        if (indices) {
          out[dst][counts[dst]++] = first + i;
          stats.perLod[lod] = (stats.perLod[lod] ?? 0) + 1;
          stats.drawn++;
          continue;
        }
        // copy the 16 floats by hand (a subarray per instance kept the garbage collector busy)
        const o = out[dst], to = counts[dst] * 16, from = i * 16;
        for (let c = 0; c < 16; c++) o[to + c] = M[from + c];
        if (fade && d > fade[0]) {
          const f = Math.max(0, 1 - (d - fade[0]) / (fade[1] - fade[0]));
          if (f === 0) { stats.culledDistance++; continue; }
          for (let c = 0; c < 12; c++) if ((c & 3) !== 3) o[to + c] *= f;
        }
        counts[dst]++;
        stats.perLod[lod] = (stats.perLod[lod] ?? 0) + 1;
        stats.drawn++;
      }
    }
    item += wm.lods.length;
    first += wm.count;
  }
  return stats;
}
