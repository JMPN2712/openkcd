// Builds a renderable scene of a level's static objects around a point:
// groups vegetation and brush instances by model, loads each model once and
// hands the renderer one instanced item per model.

import { loadModel, type LoadedModel } from "./model.ts";
import { vegetationMatrix, type LevelObjects } from "./levelObjects.ts";
import type { Terrain } from "./terrain.ts";
import type { Vfs } from "./vfs.ts";

export interface WorldItem {
  model: LoadedModel;
  instances: Float32Array; // 16 floats per instance
  kind: "vegetation" | "brush";
}

export interface WorldScene {
  items: WorldItem[];
  instances: number;
  modelsLoaded: number;
  modelsSkipped: number; // over the cap
  failed: Map<string, string>;
}

interface Group {
  path: string;
  kind: WorldItem["kind"];
  matrices: number[];
  nearest: number;
}

/** Editor-only geometry that the game never draws (helper boxes, test sky). */
const HIDDEN_BRUSH = /^objects\/editor\/|_nodraw\.cgf$|\/sky\//;

/** "%level%/brush/x.cgf" -> "brush/x.cgf" (resolved through the level pak overlay). */
export function resolveLevelPath(name: string): string {
  return name.replace(/^%level%\//, "");
}

export async function buildWorldScene(
  vfs: Vfs,
  terrain: Terrain,
  objects: LevelObjects,
  center: [number, number],
  radius: number,
  opts: { maxModels?: number; maxTextureDim?: number; onStatus?: (s: string) => void; cache?: Map<string, Promise<LoadedModel | null>> } = {},
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

  const ordered = [...groups.values()].sort((a, b) => a.nearest - b.nearest);
  const max = opts.maxModels ?? 400;
  const cache = opts.cache ?? new Map<string, Promise<LoadedModel | null>>();
  const failed = new Map<string, string>();
  const items: WorldItem[] = [];
  let instances = 0;
  for (const [n, g] of ordered.slice(0, max).entries()) {
    let p = cache.get(g.path);
    if (!p) {
      opts.onStatus?.(`Loading models ${n + 1}/${Math.min(max, ordered.length)}: ${g.path.split("/").pop()}`);
      p = loadModel(vfs, g.path, { maxTextureDim: opts.maxTextureDim ?? 256 }).catch((err) => {
        failed.set(g.path, (err as Error).message);
        return null;
      });
      cache.set(g.path, p);
    }
    const model = await p;
    if (!model) continue;
    items.push({ model, instances: new Float32Array(g.matrices), kind: g.kind });
    instances += g.matrices.length / 16;
  }
  return { items, instances, modelsLoaded: items.length, modelsSkipped: Math.max(0, ordered.length - max), failed };
}
