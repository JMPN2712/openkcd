// Entities from a level's mission file (objects_mission0.xml, 52 MB for
// Rataje, 55k entities in 71 classes). Only NPCs are extracted for now:
//   <Entity Name="rat_konrad_hagen" Pos="x,y,z" Rotate="w,x,y,z" EntityClass="NPC"|"NPC_Female" EntityId=…>
//     <EntityLinks><Link TargetId=… Name="Home,owner"/> <Link … Name="Work[merchant]"/> <Link … Name="preferedBed"/></EntityLinks>
//     <Properties … esModularBehaviorTree="IdleSeq" fileModel="…/male.cdf"> <BB dayFrom=… dayTo=… …/> …
// 929 of Rataje's 952 NPC entity names equal a soul_name in Libs/Tables/rpg/soul.

export interface NpcEntity {
  id: number;
  name: string;
  female: boolean;
  pos: [number, number, number];
  /** quaternion w, x, y, z */
  rot: [number, number, number, number];
  /** link name -> target entity id (Home,owner / Work[…] / preferedBed / …) */
  links: Map<string, number>;
  behaviorTree: string;
}

const num = (s: string | undefined, n: number, d: number[]) => {
  const v = (s ?? "").split(",").map(Number);
  return v.length === n && v.every(Number.isFinite) ? v : d;
};

/** Pull NPC entities out of the mission XML without building a DOM of the whole file. */
export function parseNpcEntities(xml: string): NpcEntity[] {
  const out: NpcEntity[] = [];
  const re = /<Entity\s([^>]*EntityClass="(NPC|NPC_Female)"[^>]*)>([\s\S]*?)<\/Entity>/g;
  const attr = (s: string, k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(s)?.[1];
  for (const m of xml.matchAll(re)) {
    const head = m[1], body = m[3];
    const links = new Map<string, number>();
    for (const l of body.matchAll(/<Link\s([^>]*)\/>/g)) {
      const name = attr(l[1], "Name")?.replace(/&apos;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&"), target = Number(attr(l[1], "TargetId"));
      if (name && Number.isFinite(target)) links.set(name, target);
    }
    out.push({
      id: Number(attr(head, "EntityId") ?? -1),
      name: attr(head, "Name") ?? "",
      female: m[2] === "NPC_Female",
      pos: num(attr(head, "Pos"), 3, [0, 0, 0]) as [number, number, number],
      rot: num(attr(head, "Rotate"), 4, [1, 0, 0, 0]) as [number, number, number, number],
      links,
      behaviorTree: attr(body, "esModularBehaviorTree") ?? "",
    });
  }
  return out;
}

/** Any entity, reduced to what placement needs. Area shapes keep their polygon (relative to `pos`). */
export interface EntityInfo {
  id: number;
  cls: string;
  name: string;
  pos: [number, number, number];
  rot: [number, number, number, number];
  /** area polygon, x/y pairs relative to pos (AreaShape, SmartAreaShape, …) */
  points?: number[];
  /** the entity's own mesh (Properties object_Model), e.g. a bed's .cgf */
  model?: string;
  scale?: [number, number, number];
  /** outgoing EntityLinks: target id and the link name (tags, e.g. "Home,owner", "Lean", "inside") */
  links?: { target: number; name: string }[];
  /** AI category (Properties sWH_AI_EntityCategory), e.g. "tailor_measuring", "Seat", "Bed" */
  category?: string;
  /** smart-object type (guidSmartObjectType) or smart-area template (guidSmartAreaTemplate) */
  soType?: string;
  saTemplate?: string;
  /** smart-object helper class (soclasses_SmartObjectHelpers), e.g. "tailorTable", "Bed" */
  soHelpers?: string;
}

/** Index every entity in the mission XML by EntityId (Rataje: 55k entities, ~0.5 s). */
export function parseEntityIndex(xml: string): Map<number, EntityInfo> {
  const out = new Map<number, EntityInfo>();
  const attr = (s: string, k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(s)?.[1];
  const re = /<Entity\s([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const head = m[1];
    const id = Number(attr(head, "EntityId"));
    if (!Number.isFinite(id)) continue;
    const cls = attr(head, "EntityClass") ?? "";
    const info: EntityInfo = {
      id, cls, name: attr(head, "Name") ?? "",
      pos: num(attr(head, "Pos"), 3, [0, 0, 0]) as [number, number, number],
      rot: num(attr(head, "Rotate"), 4, [1, 0, 0, 0]) as [number, number, number, number],
    };
    const end = xml.indexOf("</Entity>", re.lastIndex);
    const body = xml.slice(re.lastIndex, end < 0 ? undefined : end);
    const model = /<Properties\b[^>]*\bobject_Model="([^"]+)"/.exec(body)?.[1];
    if (model) info.model = model;
    const linkText = body.slice(0, body.indexOf("</EntityLinks>") + 1);
    if (linkText) {
      info.links = [];
      for (const l of linkText.matchAll(/<Link\s+TargetId="(\d+)"[^>]*?Name="([^"]*)"/g)) {
        info.links.push({ target: Number(l[1]), name: l[2].replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&") });
      }
    }
    const props = /<Properties\b([^>]*)>/.exec(body)?.[1] ?? "";
    const pa = (k: string) => new RegExp(`\\b${k}="([^"]+)"`).exec(props)?.[1];
    const category = pa("sWH_AI_EntityCategory"), soType = pa("guidSmartObjectType"), saTemplate = pa("guidSmartAreaTemplate");
    if (category) info.category = category;
    if (soType) info.soType = soType;
    if (saTemplate) info.saTemplate = saTemplate;
    const soHelpers = pa("soclasses_SmartObjectHelpers");
    if (soHelpers) info.soHelpers = soHelpers;
    const scale = attr(head, "Scale");
    if (scale) info.scale = num(scale, 3, [1, 1, 1]) as [number, number, number];
    if (cls.endsWith("AreaShape")) {
      const pts = body.slice(body.indexOf("<Points>"), body.indexOf("</Points>"));
      info.points = [];
      for (const p of pts.matchAll(/<Point\s+Pos="([^"]*)"/g)) {
        const [x, y] = p[1].split(",").map(Number);
        info.points.push(x, y);
      }
    }
    out.set(id, info);
  }
  return out;
}

/**
 * Entities drawn as static props: their object_Model when it is a static mesh
 * (.cgf/.cga) and not an editor helper. Rataje: chests and shelves (Stash),
 * beds, chairs, nests, alchemy tables, grindstones, … Triggers and areas carry
 * editor shapes (primitive_cylinder, box_nodraw) and are skipped. Doors
 * (AnimDoor) and AnimObjects (wells, flags) use a .cdf: drawn in bind pose,
 * i.e. closed / at rest. Other .cdf/.chr entities (NPCs, graves) are not props.
 */
export function propEntities(ents: Map<number, EntityInfo>): EntityInfo[] {
  return [...ents.values()].filter((e) =>
    e.model &&
    (/\.(cgf|cga)$/i.test(e.model) || (/\.cdf$/i.test(e.model) && /^(AnimDoor|AnimObject)$/.test(e.cls))) &&
    !/^objects[\\/](default|editor)[\\/]/i.test(e.model) &&
    !/Trigger|Area|CaptionObject/.test(e.cls));
}
