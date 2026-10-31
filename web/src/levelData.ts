// A level's data (terrain, objects, entities, layers, navmesh, time of day, ground meshes) and the
// asset index (VFS) its models come from, read from the paks once per level pak and shared by
// the world view (levelView.ts) and the compact package builder (slimView.ts).

import { dataStart, readCentralDirectory, readEntry } from "./zip.ts";
import { parseTerrain, type Terrain } from "./terrain.ts";
import type { PakSource } from "./paks.ts";
import { parseLevelObjects, type LevelObjects } from "./levelObjects.ts";
import { parseCover, type Cover } from "./cover.ts";
import { MergedMeshes } from "./mergedMeshes.ts";
import { Roads } from "./roads.ts";
import { Decals } from "./decals.ts";
import { Vfs } from "./vfs.ts";
import { ReadWorkers } from "./readWorkers.ts";
import { parseNpcEntities, parseEntityIndex, propEntities, type EntityInfo, type NpcEntity } from "./levelEntities.ts";
import { Schedules } from "./schedule.ts";
import { NavMesh } from "./navmesh.ts";
import { parseLayerNames, defaultHiddenLayers, layerDoors } from "./levelLayers.ts";
import { ASSET_RE } from "./assets.ts";
import { parseTimeOfDay, type TimeOfDay } from "./tod.ts";
import { parseSurfaceTypes } from "./terrainDetail.ts";
import { parseOccluders, type Occluders } from "./occlusion.ts";

export interface LevelData {
  terrain: Terrain;
  objects: LevelObjects;
  cover?: Cover;
  npcEntities: NpcEntity[];
  schedules: Schedules;
  props: EntityInfo[];
  ents: Map<number, EntityInfo>;
  hiddenLayers: Set<number>;
  tod: TimeOfDay | null;
  surfaceTypes: Map<number, string>;
  merged: MergedMeshes;
  roads: Roads;
  decals: Decals;
  /** the level's occluder shells (occluder.ocm), for occlusion culling; null when missing or unreadable */
  occluders: Occluders | null;
}

const dataCache = new Map<string, Promise<LevelData>>();
const vfsCache = new Map<string, Promise<Vfs>>();

/** Forget the level data and asset indexes read (their paks were replaced or deleted). */
export function clearLevelCaches(): void {
  dataCache.clear();
  vfsCache.clear();
}

const levelPak = (paks: PakSource[], level: string) => {
  const pakPath = `data/levels/${level}/level.pak`;
  const pak = paks.find((p) => p.path.toLowerCase() === pakPath);
  if (!pak) throw new Error(`${pakPath} not found`);
  return { pak, pakPath };
};

/** The level's data, read once per level pak (`status`: what is being read). */
export function levelData(paks: PakSource[], level: string, status: (s: string) => void = () => {}): Promise<LevelData> {
  const { pak, pakPath } = levelPak(paks, level);
  let p = dataCache.get(pakPath);
  if (!p) {
    p = (async (): Promise<LevelData> => {
      const blob = await pak.open();
      const entries = await readCentralDirectory(blob);
      const entry = entries.find((e) => e.name.toLowerCase() === "terrain/terrain.dat");
      const ctc = entries.find((e) => e.name.toLowerCase() === "terrain/cover.ctc");
      if (!entry) throw new Error("terrain/terrain.dat not found in the level pak");
      status(`Reading terrain (${Math.round(entry.usize / 2 ** 20)} MiB)…`);
      const bytes = await readEntry(blob, entry, undefined, false);
      status("Decoding heightmap and object octree…");
      await new Promise((r) => setTimeout(r, 0));
      const terrain = parseTerrain(bytes);
      const objects = parseLevelObjects(bytes, terrain.objectsOffset);
      status("Reading terrain colour…");
      const cover = ctc ? parseCover(await readEntry(blob, ctc, undefined, false), terrain.size) : undefined;
      const mission = entries.find((e) => e.name.toLowerCase() === "objects_mission0.xml");
      status("Reading entities (NPCs, furniture)…");
      const xml = mission ? new TextDecoder().decode(await readEntry(blob, mission, undefined, false)) : "";
      // editor layers: alternative states and cutscene sets hidden at game start (levelLayers.ts)
      const ld = entries.find((e) => e.name.toLowerCase() === "leveldata.xml");
      const ldText = ld ? new TextDecoder().decode(await readEntry(blob, ld, undefined, false)) : "";
      const layerNames = parseLayerNames(ldText);
      const hiddenLayers = ld ? defaultHiddenLayers(layerNames) : new Set<number>();
      const surfaceTypes = parseSurfaceTypes(ldText);
      const npcEntities = parseNpcEntities(xml);
      const ents = parseEntityIndex(xml);
      // the doors of the layers shown at game start (Skalitz's, Rattay castle hall's): drawn and usable
      status("Reading doors from the editor layers…");
      for (const d of await layerDoors(entries, (e) => readEntry(blob, e, undefined, false), layerNames, hiddenLayers)) if (!ents.has(d.id)) ents.set(d.id, d);
      const schedules = new Schedules(npcEntities, ents);
      // the level's navmesh (recast.pak), for NPC walking routes
      const recast = paks.find((x) => x.path.toLowerCase() === `data/levels/${level}/recast.pak`);
      if (recast) {
        try {
          const rb = await recast.open();
          const ne = (await readCentralDirectory(rb)).find((e) => e.name.toLowerCase() === "recast/rdnavmesh_1.nav");
          if (ne) {
            status(`Reading navigation mesh (${Math.round(ne.usize / 2 ** 20)} MiB)…`);
            schedules.setNavMesh(new NavMesh(await readEntry(rb, ne, undefined, false)));
          }
        } catch (err) {
          console.warn("navmesh:", err);
        }
      }
      // the level's time of day (sun, sky, fog over the day, per weather profile)
      const me = entries.find((e) => e.name.toLowerCase() === "mission_mission0.xml");
      const tod = me ? parseTimeOfDay(new TextDecoder().decode(await readEntry(blob, me, undefined, false))) : null;
      // the occluder shells hide interiors and what stands behind buildings (occlusion.ts)
      const ocm = entries.find((e) => e.name.toLowerCase() === "occluder.ocm");
      let occluders: Occluders | null = null;
      try {
        if (ocm) occluders = parseOccluders(await readEntry(blob, ocm, undefined, false));
      } catch (err) {
        console.warn("occluder.ocm:", err);
      }
      return { occluders, terrain, objects, cover, npcEntities, schedules, props: propEntities(ents), ents, hiddenLayers, tod, surfaceTypes, merged: new MergedMeshes(blob, entries), roads: new Roads(blob, dataStart(blob, entry), objects.roads), decals: new Decals(objects.decalIndex, terrain) };
    })();
    p.catch(() => dataCache.delete(pakPath));
    dataCache.set(pakPath, p);
  }
  return p;
}

/**
 * The assets of every non-level pak, with this level's own files (brush/*.cgf, …) on top; pak
 * reads on worker threads (unless `workers` is false: paks read in place from an installer).
 */
export async function levelVfs(paks: PakSource[], level: string, status: (s: string) => void = () => {}, workers = true): Promise<Vfs> {
  const { pak, pakPath } = levelPak(paks, level);
  let v = vfsCache.get(pakPath);
  if (!v) {
    v = Vfs.build(paks.filter((x) => !x.path.toLowerCase().startsWith("data/levels/")), {
      filter: (n) => ASSET_RE.test(n),
      includeHd: true,
      onProgress: (d, t) => { status(`Indexing assets… ${d}/${t}`); },
    }).then((base) => base.extend(pak, (n) => ASSET_RE.test(n)));
    v.catch(() => vfsCache.delete(pakPath));
    vfsCache.set(pakPath, v);
  }
  const vfs = await v;
  // large reads (models, textures) inflate on worker threads, off the frame
  if (workers) vfs.workers ??= ReadWorkers.browser();
  return vfs;
}
