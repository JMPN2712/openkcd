// Editor layers of a level (leveldata.xml <Layers><Layer Name="re_executioner_state0{guid}" Id="1269"/>…).
// Brushes carry their layer id (levelObjects.ts brushLayer, 0 = no layer). The game switches
// layers on and off through quest-driven "layer profiles" (not found in the shipped data), so
// alternative versions of places coexist in the file: re_executioner_state0 / _state1,
// hall_state0 / hall_state2 / hall_state12, cutscene set dressing (cin_*), event obstacles.
// Drawing them all at once doubles buildings up and leaves objects floating; this picks a
// plausible game-start set by name.

import { parseEntityIndex, type EntityInfo } from "./levelEntities.ts";
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
  const stateOf = (n: string) => /^(.*?)_?state_?(\d+)$/i.exec(n);
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
  }
  return hidden;
}

/**
 * Doors (AnimDoor entities) in the layer files (layers/<name>{guid}.xml) of layers shown at game
 * start. The mission file holds 866 of Rataje's doors; 160 more live in 46 layer files, among
 * them Skalitz's around Henry's home (sv_state0_prefabs) and Rattay castle's hall (hall_door_state0).
 * Reading every layer file (87 MiB) takes about half a second; only those with doors are parsed.
 */
export async function layerDoors(entries: PakEntry[], read: (e: PakEntry) => Promise<Uint8Array>, names: Map<number, string>, hidden: Set<number>): Promise<EntityInfo[]> {
  const ids = new Map([...names].map(([id, n]) => [n.toLowerCase(), id]));
  const out: EntityInfo[] = [];
  for (const e of entries) {
    const m = /^layers\/([^{/]+)(\{[^}]*\})?\.xml$/i.exec(e.name);
    if (!m) continue;
    const id = ids.get(m[1].toLowerCase());
    if (id === undefined || hidden.has(id)) continue;
    const text = new TextDecoder().decode(await read(e));
    if (!text.includes('EntityClass="AnimDoor"')) continue;
    for (const ent of parseEntityIndex(text).values()) if (ent.cls === "AnimDoor" && ent.model) out.push(ent);
  }
  return out;
}
