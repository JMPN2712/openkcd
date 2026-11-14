// Level profiles: named sets of editor layers that quests switch on and off (EnableProfile in the
// behaviour trees, ProfileLoadedGate waits for one). The level's `whdata_1` file lists them:
//   <GameProfileManager><GameProfiles><GameProfile><Name>q_skalitz_normal</Name><Id>814</Id>
//     <GameLayers><GameLayer>ska_hans{5A07B719-…}</GameLayer>…
// Rataje has 927 profiles over 2,183 layer references. A layer's entities are in
// `layers/<layer>.xml` of the level pak (lower case), each entity carrying its Layer attribute.
// Alternative states of a place are separate profiles (q_skalitz_normal, q_skalitz_burned).

import { parseEntityIndex, type EntityInfo } from "./levelEntities.ts";
import type { PakEntry } from "./zip.ts";

export interface Profile {
  name: string;
  id: number;
  /** its layers, as their files are named: "ska_hans{5a07b719-…}" (lower case) */
  layers: string[];
}

/** The profiles of a level, by lower-case name. */
export function parseProfiles(whdata: string): Map<string, Profile> {
  const out = new Map<string, Profile>();
  const i = whdata.indexOf("<GameProfiles>"), j = whdata.indexOf("</GameProfiles>");
  if (i < 0 || j < 0) return out;
  for (const m of whdata.slice(i, j).matchAll(/<GameProfile>([\s\S]*?)<\/GameProfile>/g)) {
    const name = /<Name>([^<]*)<\/Name>/.exec(m[1])?.[1] ?? "";
    if (!name) continue;
    const layers = [...m[1].matchAll(/<GameLayer>([^<]*)<\/GameLayer>/g)].map((l) => l[1].trim().toLowerCase());
    out.set(name.toLowerCase(), { name, id: Number(/<Id>(\d+)<\/Id>/.exec(m[1])?.[1] ?? -1), layers });
  }
  return out;
}

/** A layer file's layer ("ska_hans{5a07b719-…}"), or undefined for other entries. */
export function layerOfEntry(name: string): string | undefined {
  return /^layers\/(.+)\.xml$/i.exec(name)?.[1].toLowerCase();
}

/**
 * The entities of the layer files, each with its layer (EntityInfo.layer). `want` picks layers
 * (default: all). Reading and indexing all 1,831 of Rataje's files takes a few seconds, so
 * callers that need few layers should say which.
 */
export async function layerEntities(entries: PakEntry[], read: (e: PakEntry) => Promise<Uint8Array>, want?: (layer: string) => boolean): Promise<EntityInfo[]> {
  const out: EntityInfo[] = [];
  const dec = new TextDecoder();
  for (const e of entries) {
    const layer = layerOfEntry(e.name);
    if (!layer || (want && !want(layer))) continue;
    for (const ent of parseEntityIndex(dec.decode(await read(e))).values()) { ent.layer = layer; out.push(ent); }
  }
  return out;
}
