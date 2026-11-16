// Editor layers of a level (leveldata.xml <Layers><Layer Name="re_executioner_state0{guid}" Id="1269"/>…).
// Brushes carry their layer id (levelObjects.ts brushLayer, 0 = no layer). The game switches
// layers on and off through quest-driven profiles (profiles.ts: the level's whdata_1 lists them), so
// alternative versions of places coexist in the file: re_executioner_state0 / _state1,
// hall_state0 / hall_state2 / hall_state12, cutscene set dressing (cin_*), event obstacles.
// Drawing them all at once doubles buildings up and leaves objects floating; this picks a
// plausible game-start set by name.

import { parseEntityIndex, propEntities, type EntityInfo } from "./levelEntities.ts";
import type { PakEntry } from "./zip.ts";

export function parseLayerNames(levelDataXml: string): Map<number, string> {
  const out = new Map<number, string>();
  const i = levelDataXml.indexOf("<Layers>"), j = levelDataXml.indexOf("</Layers>");
  if (i < 0 || j < 0) return out;
  for (const m of levelDataXml.slice(i, j).matchAll(/<Layer\s[^>]*?Name="([^"{]+)[^"]*"[^>]*?\sId="(\d+)"/g)) out.set(Number(m[2]), m[1]);
  return out;
}

/**
 * Layers hidden at game start (approximation): cutscene sets (cin_*), random-event and test
 * layers, barriers, and every state layer except state 0 when the same prefix has a state 0
 * (hall_state0 stays, hall_state2 / hall_state12 go).
 */
export function defaultHiddenLayers(names: Map<number, string>): Set<number> {
  const hidden = new Set<number>();
  // a state layer: "<place>_state<n>", optionally with a part after it ("sv_state1_uberlod",
  // the burned village's far merged mesh: missed before, its charred ground covered Skalitz)
  const stateOf = (n: string) => /^(.*?)_?state_?(\d+)(_[a-z]+)?$/i.exec(n);
  const hasState0 = new Set<string>();
  for (const n of names.values()) {
    const m = stateOf(n);
    if (m && Number(m[2]) === 0) hasState0.add(m[1].toLowerCase());
  }
  for (const [id, n] of names) {
    const l = n.toLowerCase();
    const m = stateOf(n);
    if (l.startsWith("cin_") || l.startsWith("event") || l.startsWith("test") || l.includes("barrier") || l.startsWith("_dream")) hidden.add(id);
    else if (m && Number(m[2]) > 0 && hasState0.has(m[1].toLowerCase())) hidden.add(id);
    // the state-0 place's own state-n layers are the after-states (burned, destroyed) too
    // quest and event content by name (the dead, raiders, the after-state of a house): quests
    // switch these on with their profiles; free roam leaves them off
    else if (/corpse|dead_?bod|deadbod|dead_body|attackers?$|(^|_)cumans?(_|$)|campcumans|^ruins$|loot|interiors_decals_state_?[1-9]|^q_/.test(l)) hidden.add(id);
    // (layers of a later state by name: burned, destroyed, after a battle; not the "before" ones)
    else if (/burn|destroyed|afterbattle|(^|_)after(_|$)/.test(l) && !/before|state_?0|burning|_hide$/.test(l)) hidden.add(id);
  }
  return hidden;
}

/**
 * Doors and props (levelEntities.ts propEntities) in the layer files (layers/<name>{guid}.xml) of
 * layers shown at game start. The mission file holds 866 of Rataje's doors; 160 more live in 46
 * layer files, among them Skalitz's around Henry's home (sv_state0_prefabs) and Rattay castle's
 * hall (hall_door_state0). Skalitz's furnishings before the raid live there too: sv_state0_prefabs
 * has 241 props (chests, shelves, the items on them) and sv_state0 25; without them its houses
 * stood half empty, as if looted. Each entity keeps its layer id (`layerId`). Reading every layer
 * file (87 MiB) takes about half a second; only those with models are parsed.
 */
export async function layerProps(entries: PakEntry[], read: (e: PakEntry) => Promise<Uint8Array>, names: Map<number, string>, hidden: Set<number>): Promise<EntityInfo[]> {
  const ids = new Map([...names].map(([id, n]) => [n.toLowerCase(), id]));
  const out: EntityInfo[] = [];
  for (const e of entries) {
    const m = /^layers\/([^{/]+)(\{[^}]*\})?\.xml$/i.exec(e.name);
    if (!m) continue;
    const id = ids.get(m[1].toLowerCase());
    if (id === undefined || hidden.has(id)) continue;
    const text = new TextDecoder().decode(await read(e));
    if (!text.includes("object_Model=")) continue;
    for (const ent of propEntities(parseEntityIndex(text))) {
      ent.layerId = id;
      out.push(ent);
    }
  }
  return out;
}

/**
 * The layers shown in a story: those in no quest profile as `base` has them, and of the profiled
 * ones only those of a profile switched on (profiles.ts; EnableProfile in the quests' trees).
 * `profiles` maps profile name → its layers ("name{guid}", lower case).
 */
export function storyHiddenLayers(names: Map<number, string>, base: Set<number>, profiles: Map<string, { layers: string[] }>, enabled: Set<string>): Set<number> {
  const strip = (l: string) => l.replace(/\{.*$/, "").toLowerCase();
  const profiled = new Set<string>(), on = new Set<string>();
  for (const [name, p] of profiles) for (const l of p.layers) { profiled.add(strip(l)); if (enabled.has(name)) on.add(strip(l)); }
  const out = new Set<number>();
  for (const [id, n] of names) {
    const l = n.toLowerCase();
    if (profiled.has(l) ? !on.has(l) : base.has(id)) out.add(id);
  }
  return out;
}
