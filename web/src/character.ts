// Character assembly: turns an NPC "soul", a clothing preset or a .cdf into a
// list of skinned parts drawn together in bind pose. See docs/CHARACTERS.md.
//
// Database chain (Libs/Tables):
//   rpg/soul ─┬─ character_body/head/hair/beard_id ─> character_* (model, material names)
//             └─ initial_clothing_preset_id ─> item/armor2clothing_preset ─> item/armor (item_id)
//                  ├─ clothing_id, clothing2_id ─> item/clothing (model, material, armor_archetype_id)
//                  │     armor_archetype_id ─> item/armor_archetype2body_subpart ─> item/body_layer.layer_order
//                  └─ item/armor2clothing_attachment ─> item/clothing_attachment (model, material)
// Names resolve to Objects/characters/<root>/<kind>/<name>.skin|.mtl, root
// "humans" or "animals/horse" (race 1, names starting "sh").

import { parseXml, type XmlNode } from "./xml.ts";
import { readTable, indexBy, groupBy, type Row } from "./tables.ts";
import type { Vfs } from "./vfs.ts";
import { loadModel, type LoadedModel } from "./model.ts";

export type PartKind = "body" | "head" | "hair" | "beard" | "cloth" | "attachment";

export interface CharacterPart {
  kind: PartKind;
  /** human-readable label (clothing name, attachment name, CDF AName) */
  label: string;
  skin: string;
  material: string | null;
  /** draw layer: outer layers are nudged towards the camera to win depth ties */
  layer: number;
}

export interface CharacterSpec {
  name: string;
  skeleton: string;
  parts: CharacterPart[];
  /** unresolved references, for display */
  notes: string[];
}

export const SKELETON = {
  male: "objects/characters/humans/skeleton/male.chr",
  female: "objects/characters/humans/skeleton/female.chr",
  horse: "objects/characters/animals/horse/horse.chr",
};

// Layer for parts that are not clothing. Hair sits just above the head and
// below hoods (cloth layers start at 1).
const BASE_LAYER: Record<PartKind, number> = { body: 0, head: 0, beard: 0.5, hair: 0.5, cloth: 1, attachment: 9.5 };

function partRoot(name: string, race: string | undefined): string {
  return race === "1" || /^sh\d/i.test(name) ? "objects/characters/animals/horse" : "objects/characters/humans";
}

function partPaths(kind: PartKind, model: string, material: string, race?: string): { skin: string; material: string | null } {
  const dir = `${partRoot(model, race)}/${kind === "cloth" ? "cloth" : kind}`;
  return { skin: `${dir}/${model}.skin`.toLowerCase(), material: material ? `${dir}/${material}.mtl`.toLowerCase() : null };
}

export interface SoulInfo {
  id: string;
  name: string;
  gender: "male" | "female" | "horse";
  presetId: string;
}

export interface PresetInfo {
  id: string;
  name: string;
  gender: "male" | "female";
}

/** Indexed character tables. Load once per VFS. */
export class CharacterDb {
  souls: SoulInfo[] = [];
  presets: PresetInfo[] = [];
  private soulRows = new Map<string, Row>();
  private body = new Map<string, Row>();
  private head = new Map<string, Row>();
  private hair = new Map<string, Row>();
  private beard = new Map<string, Row>();
  private armor = new Map<string, Row>();
  private clothing = new Map<string, Row>();
  private attachment = new Map<string, Row>();
  private presetItems = new Map<string, Row[]>();
  private itemAttachments = new Map<string, Row[]>();
  private archetypeLayer = new Map<string, number>();
  private presetRows = new Map<string, Row>();

  static async load(vfs: Vfs): Promise<CharacterDb> {
    const db = new CharacterDb();
    const [soul, body, head, hair, beard, armor, clothing, attachment, a2p, a2att, arch, layers, presets] = await Promise.all([
      "rpg/soul", "character_body", "character_head", "character_hair", "character_beard",
      "item/armor", "item/clothing", "item/clothing_attachment", "item/armor2clothing_preset",
      "item/armor2clothing_attachment", "item/armor_archetype2body_subpart", "item/body_layer", "item/clothing_preset",
    ].map((t) => readTable(vfs, t)));
    db.soulRows = indexBy(soul, "soul_id");
    db.body = indexBy(body, "character_body_id");
    db.head = indexBy(head, "character_head_id");
    db.hair = indexBy(hair, "character_hair_id");
    db.beard = indexBy(beard, "character_beard_id");
    db.armor = indexBy(armor, "item_id");
    db.clothing = indexBy(clothing, "clothing_id");
    db.attachment = indexBy(attachment, "clothing_attachment_id");
    db.presetItems = groupBy(a2p, "clothing_preset_id");
    db.itemAttachments = groupBy(a2att, "item_id");
    db.presetRows = indexBy(presets, "clothing_preset_id");
    // a clothing piece's layer is the outermost body layer its archetype covers
    const layerOrder = new Map(layers.map((r) => [r.body_layer_id, Number(r.layer_order)]));
    for (const r of arch) {
      const o = layerOrder.get(r.body_layer_id) ?? 1;
      db.archetypeLayer.set(r.armor_archetype_id, Math.max(db.archetypeLayer.get(r.armor_archetype_id) ?? 0, o));
    }
    for (const r of soul) {
      const b = db.body.get(r.character_body_id);
      const gender = b?.race_id === "1" ? "horse" : b?.gender_id === "2" ? "female" : "male";
      db.souls.push({ id: r.soul_id, name: r.soul_name, gender, presetId: r.initial_clothing_preset_id });
    }
    db.souls.sort((a, b) => a.name.localeCompare(b.name));
    for (const r of presets) db.presets.push({ id: r.clothing_preset_id, name: r.clothing_preset_name, gender: r.gender_id === "2" ? "female" : "male" });
    db.presets.sort((a, b) => a.name.localeCompare(b.name));
    return db;
  }

  /** Clothing parts for a preset (armor items → clothing meshes + attachments). */
  presetParts(presetId: string, notes: string[]): CharacterPart[] {
    const parts: CharacterPart[] = [];
    for (const link of this.presetItems.get(presetId) ?? []) {
      const item = this.armor.get(link.armor_id);
      if (!item) {
        notes.push(`armor item ${link.armor_id} not in item/armor`);
        continue;
      }
      for (const cid of [item.clothing_id, item.clothing2_id]) {
        if (!cid) continue;
        const c = this.clothing.get(cid);
        if (!c?.model) {
          notes.push(`clothing ${cid} missing`);
          continue;
        }
        const layer = BASE_LAYER.cloth - 1 + (this.archetypeLayer.get(c.armor_archetype_id) ?? 1);
        parts.push({ kind: "cloth", label: c.clothing_name, layer, ...partPaths("cloth", c.model, c.material, c.race_id) });
      }
      for (const a of this.itemAttachments.get(link.armor_id) ?? []) {
        const att = this.attachment.get(a.clothing_attachment_id);
        if (!att?.model) continue;
        parts.push({ kind: "attachment", label: att.clothing_attachment_name, layer: BASE_LAYER.attachment, ...partPaths("attachment", att.model, att.material, att.race_id) });
      }
    }
    return parts;
  }

  soul(id: string): CharacterSpec {
    const r = this.soulRows.get(id);
    if (!r) throw new Error(`soul ${id} not found`);
    const notes: string[] = [];
    const parts: CharacterPart[] = [];
    const add = (kind: PartKind, table: Map<string, Row>, rowId: string) => {
      if (!rowId) return;
      const row = table.get(rowId);
      if (!row?.model) {
        notes.push(`${kind} ${rowId} missing`);
        return;
      }
      parts.push({ kind, label: row[`character_${kind}_name`] ?? kind, layer: BASE_LAYER[kind], ...partPaths(kind, row.model, row.material, row.race_id) });
    };
    add("body", this.body, r.character_body_id);
    add("head", this.head, r.character_head_id);
    add("hair", this.hair, r.character_hair_id);
    add("beard", this.beard, r.character_beard_id);
    if (r.initial_clothing_preset_id) parts.push(...this.presetParts(r.initial_clothing_preset_id, notes));
    const body = this.body.get(r.character_body_id);
    const skeleton = body?.race_id === "1" ? SKELETON.horse : body?.gender_id === "2" ? SKELETON.female : SKELETON.male;
    return { name: r.soul_name, skeleton, parts, notes };
  }

  /** A clothing preset on the default body and head for its gender. */
  preset(id: string): CharacterSpec {
    const p = this.presetRows.get(id);
    if (!p) throw new Error(`clothing preset ${id} not found`);
    const female = p.gender_id === "2";
    const notes: string[] = [];
    const parts: CharacterPart[] = [
      { kind: "body", label: "default body", layer: 0, ...partPaths("body", female ? "s2_body" : "s1_body", female ? "s2_body_normal" : "s1_body_normal") },
      { kind: "head", label: "default head", layer: 0, ...partPaths("head", female ? "s2_head_v001" : "s1_head_v001", female ? "s2_head_v001" : "s1_head_v001") },
      ...this.presetParts(id, notes),
    ];
    return { name: p.clothing_preset_name, skeleton: female ? SKELETON.female : SKELETON.male, parts, notes };
  }
}

/** Character definition (.cdf): skeleton plus CA_SKIN attachments. Bone attachments are ignored (no geometry). */
export function parseCdf(text: string, name: string): CharacterSpec {
  const root = parseXml(text).children.find((c) => c.tag === "CharacterDefinition");
  if (!root) throw new Error("no <CharacterDefinition> element");
  const model = root.children.find((c) => c.tag === "Model");
  const list = root.children.find((c) => c.tag === "AttachmentList")?.children ?? [];
  const notes: string[] = [];
  const parts: CharacterPart[] = [];
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
  for (const a of list as XmlNode[]) {
    const { Type: type, AName: aname = "", Binding: binding, Material: material } = a.attrs;
    if (type !== "CA_SKIN") continue;
    if (!binding) {
      notes.push(`attachment ${aname} has no binding`);
      continue;
    }
    const kind: PartKind = /^(body|head|hair|beard)/i.test(aname) ? (aname.toLowerCase().replace(/s$/, "").match(/body|head|hair|beard/)![0] as PartKind) : "cloth";
    const mtl = material ? norm(material).replace(/(\.mtl)?$/, ".mtl") : null;
    parts.push({ kind, label: aname, skin: norm(binding), material: mtl, layer: BASE_LAYER[kind] });
  }
  return { name, skeleton: norm(model?.attrs.File ?? SKELETON.male), parts, notes };
}

export interface LoadedCharacter {
  spec: CharacterSpec;
  parts: { part: CharacterPart; model: LoadedModel }[];
  notes: string[];
}

/** Load every part's .skin with its material override. Missing parts become notes. */
export async function loadCharacter(
  vfs: Vfs,
  spec: CharacterSpec,
  opts: { maxTextureDim?: number; onStatus?: (s: string) => void } = {},
): Promise<LoadedCharacter> {
  const notes = [...spec.notes];
  const parts: LoadedCharacter["parts"] = [];
  for (const part of spec.parts) {
    opts.onStatus?.(`Loading ${part.kind} ${part.label}…`);
    try {
      const model = await loadModel(vfs, part.skin, { ...opts, material: part.material });
      parts.push({ part, model });
      for (const n of model.notes) notes.push(`${part.label}: ${n}`);
    } catch (err) {
      notes.push(`${part.kind} ${part.label} (${part.skin}): ${(err as Error).message}`);
    }
  }
  return { spec, parts, notes };
}
