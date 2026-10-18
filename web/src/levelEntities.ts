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
