// NPC daily schedules: which activity a soul is doing at a given time (its
// daily cycle, src/daycycle.ts: the soul table's baked activity_N/time_N
// windows, skips and patches, hobbies in free time) and where that puts them
// (bed, work area, home area, a hobby's area or spawn point, via the NPC
// entity's links). At the start of each activity the NPC walks there from the
// previous activity's place, along the level's navmesh when one is set
// (src/navmesh.ts), else in a straight line. Once there, the activity's
// behaviour tree drives NPCs near the player (npcs.ts updateAi).

import type { ScheduleItem } from "./character.ts";
import { DayCycles, type CycleWorld, type NpcCycle, type Target } from "./daycycle.ts";
import type { EntityInfo, NpcEntity } from "./levelEntities.ts";
import type { NavMesh, Vec3 } from "./navmesh.ts";

export type Pose = "stand" | "sleep" | "walk" | "act";

export interface Placement {
  activity: string;
  /** what the position came from: "bed" | "work" | "home" | "spawn", or "→ work" etc. while walking there */
  where: string;
  pos: [number, number, number];
  /** quaternion w, x, y, z */
  rot: [number, number, number, number];
  pose: Pose;
  /** in bed: the bed entity, and the Mannequin `Lying` fragment's tag for it (see lyingTag) */
  bed?: EntityInfo;
  lying?: string;
}

/**
 * The `Lying` fragment tag (kcd_male_database.adb) for a bed: its kind (Properties Script
 * esBedTypes) picks the place, its helper class's _Left/_Right the side, matching the lie-down
 * fragments' tags (liePlaceBench+lieSideLeft → laydown_bench_left, then `lyingLeft` →
 * sleeping_bench_idle_left). Rataje's 1,302 beds: ground 560, bench 319, normal 244, shelter 138,
 * tent 41.
 */
export function lyingTag(bed: EntityInfo): string {
  const kind = /\besBedTypes="([^"]*)"/.exec(bed.propsXml ?? "")?.[1] ?? "normal";
  const side = /right$/i.test(bed.soHelpers ?? "") ? "Right" : "Left";
  switch (kind) {
    case "bench": return `lying${side}`;
    case "ground": return `lyingGround${side}`;
    case "shelter": return "lyingShelter";
    case "tent": return "lyingTent";
    default: return "lying";
  }
}

/** Activity at `minute` (0–1439): the last item started at or before it, wrapping past midnight. */
export function activityAt(schedule: ScheduleItem[], minute: number): string {
  if (!schedule.length) return "";
  let cur = schedule[schedule.length - 1];
  for (const s of schedule) if (s.start <= minute) cur = s;
  return cur.activity;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a ^= a << 13; a ^= a >>> 17; a ^= a << 5;
    return (a >>> 0) / 4294967296;
  };
}

function inside(pts: number[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Area polygon in world x/y (points are in the entity's frame; 202 of Rataje's 6,770 areas are rotated). */
function areaPolygon(area: EntityInfo): number[] {
  const [w, x, y, z] = area.rot;
  const pts = area.points ?? [];
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const px = pts[i], py = pts[i + 1];
    // rotate (px, py, 0) by the quaternion
    const rx = (1 - 2 * (y * y + z * z)) * px + 2 * (x * y - w * z) * py;
    const ry = 2 * (x * y + w * z) * px + (1 - 2 * (x * x + z * z)) * py;
    out.push(area.pos[0] + rx, area.pos[1] + ry);
  }
  return out;
}

/** Whether a world x/y point lies inside an area's polygon. */
export function areaContains(area: EntityInfo, x: number, y: number): boolean {
  return inside(areaPolygon(area), x, y);
}

/** A stable pseudo-random point inside an area polygon (one `accept` takes, when given). */
function pointInArea(area: EntityInfo, seed: string, accept?: (x: number, y: number) => boolean): [number, number] {
  const pts = areaPolygon(area);
  if (pts.length < 6) return [area.pos[0], area.pos[1]];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
  }
  const r = rng(hash(seed));
  for (let k = 0; k < 64; k++) {
    const x = x0 + r() * (x1 - x0), y = y0 + r() * (y1 - y0);
    if (inside(pts, x, y) && (!accept || accept(x, y))) return [x, y];
  }
  return [area.pos[0], area.pos[1]];
}

const yawQuat = (a: number): [number, number, number, number] => [Math.cos(a / 2), 0, 0, Math.sin(a / 2)];

const roles = (linkName: string) => linkName.split(",").map((p) => p.replace(/\[.*$/, ""));

/** Link targets of an NPC by role. Link names look like "Home,owner", "Work[('Guard')]", "preferedBed", "owner". */
function linked(npc: NpcEntity, ents: Map<number, EntityInfo>, test: (name: string, e: EntityInfo) => boolean): EntityInfo | undefined {
  for (const [name, id] of npc.links) {
    const e = ents.get(id);
    if (e && test(name, e)) return e;
  }
  return undefined;
}

/** Real seconds per game minute: KCD's clock runs at 15× real time. */
export const REAL_SECONDS_PER_GAME_MINUTE = 4;

/** Per-level schedule state: entity index plus each NPC's bed. */
/** A walk route: corner points and the cumulative horizontal distance at each. */
interface Route {
  pts: Vec3[];
  cum: number[];
}

function route(pts: Vec3[]): Route {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum };
}

export class Schedules {
  private ents: Map<number, EntityInfo>;
  private nav: NavMesh | null = null;
  /** the navmesh set with setNavMesh (shared with the behaviour-tree driver) */
  get navMesh(): NavMesh | null {
    return this.nav;
  }
  private routes = new Map<string, Route>();
  private beds = new Map<number, EntityInfo>();
  /** each NPC's spot in an area (by "npc/area"), found once: picking one searches the navmesh */
  private spots = new Map<string, [number, number, number]>();
  /** each NPC's daily cycle; free time waits for setCycleData (hobbies, area behaviours) */
  private cycles: DayCycles;
  /** where an NPC left its last activity's behaviour tree, by NPC id: the next walk starts there */
  private departures = new Map<number, { activity: number; pos: [number, number, number] }>();
  constructor(npcs: NpcEntity[], ents: Map<number, EntityInfo>) {
    this.ents = ents;
    this.cycles = new DayCycles({ ents, hobbies: new Map(), areaBehaviours: () => undefined, ready: false });
    // explicit bed links first; then the homes' remaining beds (Bed entities inside the home
    // polygon), handed out to that home's residents in name order
    const taken = new Set<number>();
    for (const n of npcs) {
      const b = linked(n, ents, (name, e) => e.cls === "Bed" && (name === "preferedBed" || roles(name).includes("owner")));
      if (b && !taken.has(b.id)) { this.beds.set(n.id, b); taken.add(b.id); }
    }
    const residents = new Map<EntityInfo, NpcEntity[]>();
    for (const n of [...npcs].sort((a, b) => a.name.localeCompare(b.name))) {
      if (this.beds.has(n.id)) continue;
      const h = linked(n, ents, (name, e) => roles(name).includes("Home") && !!e.points);
      if (h) residents.set(h, [...(residents.get(h) ?? []), n]);
    }
    const allBeds = [...ents.values()].filter((e) => e.cls === "Bed");
    for (const [home, people] of residents) {
      const poly = areaPolygon(home);
      const beds = allBeds.filter((b) => !taken.has(b.id) && inside(poly, b.pos[0], b.pos[1]) && Math.abs(b.pos[2] - home.pos[2]) < 8);
      people.forEach((n, k) => {
        if (k < beds.length) { this.beds.set(n.id, beds[k]); taken.add(beds[k].id); }
      });
    }
  }

  /**
   * The data free time needs (hobbies by soul, the behaviours area templates offer, reservations):
   * daily cycles start afresh with it.
   */
  setCycleData(d: Omit<CycleWorld, "ents">): void {
    this.cycles = new DayCycles({ ...d, ents: this.ents });
    this.routes.clear();
    this.departures.clear();
  }

  /** An NPC's daily cycle as it stands, if it has one yet (messages from its trees). */
  cycleOf(id: number): NpcCycle | undefined {
    return this.cycles.get(id);
  }

  /** An NPC's daily cycle, caught up to game minute `minute`. */
  cycle(npc: NpcEntity, schedule: ScheduleItem[], minute: number): NpcCycle {
    return this.cycles.at(npc, schedule, minute);
  }

  /** The NPC left its activity's behaviour tree at `pos`: the walk to its next activity starts there. */
  depart(npc: NpcEntity, schedule: ScheduleItem[], minute: number, pos: [number, number, number]): void {
    const c = this.cycles.at(npc, schedule, minute);
    if (c.activity) this.departures.set(npc.id, { activity: c.activity.id, pos: [...pos] });
  }

  /** Walk along this navmesh from now on (clears cached routes). */
  setNavMesh(nav: NavMesh | null): void {
    this.nav = nav;
    this.routes.clear();
    this.spots.clear();
  }

  private routeFor(key: string, from: Vec3, to: Vec3): Route {
    let r = this.routes.get(key);
    if (!r) {
      const path = this.nav?.findPath(from, to);
      // bridge from the exact places to the mesh (beds, area points just off it)
      r = route(path ? [from, ...path, to] : [from, to]);
      if (this.routes.size > 5000) this.routes.clear();
      this.routes.set(key, r);
    }
    return r;
  }

  get bedCount(): number {
    return this.beds.size;
  }

  /**
   * Where the NPC is at `minute`, including the walk between places: the current activity
   * starts with a walk from the previous one's place at `speed` m/s (real time).
   */
  at(npc: NpcEntity, schedule: ScheduleItem[], minute: number, groundAt: (x: number, y: number) => number, speed: number): Placement {
    const c = this.cycles.at(npc, schedule, minute);
    const activity = c.activity?.name ?? "";
    const dep = this.departures.get(npc.id);
    const left = dep && dep.activity === c.activity?.id ? dep.pos : null;
    const anchor = c.anchor ? this.placeFor(npc, activity, c.anchor, null, groundAt) : null;
    let to = this.placeFor(npc, activity, c.target, anchor, groundAt);
    // a hobby that starts where the NPC stands (cityWalk) starts where its last tree left it
    if (left && c.target && !c.target.moveToArea) to = { ...to, pos: left };
    const from = left ?? anchor?.pos ?? null;
    if (!from || Math.hypot(to.pos[0] - from[0], to.pos[1] - from[1]) < 1) return to;
    const elapsed = (minute - c.since + 1440) % 1440;
    const walked0 = elapsed * REAL_SECONDS_PER_GAME_MINUTE * speed;
    // long arrived even by a route four times the straight line: no route search (selection
    // places every NPC of the level twice a second)
    if (walked0 > 4 * Math.hypot(to.pos[0] - from[0], to.pos[1] - from[1]) + 50) return to;
    const r = this.routeFor(`${npc.id}/${c.activity?.id}/${from.map((v) => v.toFixed(1)).join(",")}>${to.pos.map((v) => v.toFixed(1)).join(",")}`, from, to.pos);
    const total = r.cum[r.cum.length - 1];
    const walked = elapsed * REAL_SECONDS_PER_GAME_MINUTE * speed;
    if (walked >= total) return to;
    let k = 1;
    while (k < r.cum.length - 1 && r.cum[k] < walked) k++;
    const a = r.pts[k - 1], b = r.pts[k];
    const seg = r.cum[k] - r.cum[k - 1];
    const t = seg > 0 ? (walked - r.cum[k - 1]) / seg : 1;
    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    let z = a[2] + (b[2] - a[2]) * t;
    // without a navmesh the straight line can run below the terrain between the ends
    if (!this.nav) z = Math.max(groundAt(x, y), z);
    // the walk clip moves along model +Y: turn +Y to the walking direction
    return { activity, where: `→ ${to.where}`, pos: [x, y, z], rot: yawQuat(Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.PI / 2), pose: "walk" };
  }

  /**
   * Where an activity's target puts the NPC: in bed, at a spot in the work, home or hobby area,
   * or (a hobby started where the NPC stands, or no target) at `stay`, the place it came from.
   * Activities without a target fall back by name: other work-like activities (monk_pray,
   * serveMeal, …) at the work area, the rest at home.
   */
  private placeFor(npc: NpcEntity, activity: string, target: Target | null, stay: Placement | null, groundAt: (x: number, y: number) => number): Placement {
    const ents = this.ents;
    const home = linked(npc, ents, (n, e) => roles(n).includes("Home") && !!e.points);
    const work = linked(npc, ents, (n, e) => roles(n).includes("Work") && !!e.points);
    const bed = this.beds.get(npc.id);
    const spawn: Placement = { activity, where: "spawn", pos: npc.pos, rot: npc.rot, pose: "stand" };
    const inArea = (area: EntityInfo, where: string): Placement => {
      // the designer's spawn spot when it is in this area (about half of NPCs spawn at their workplace
      // or home); also for huge areas (10% of work areas span kilometres) where a random point is meaningless
      const poly = areaPolygon(area);
      let w = 0;
      for (let i = 2; i < poly.length; i += 2) w = Math.max(w, Math.abs(poly[i] - poly[0]), Math.abs(poly[i + 1] - poly[1]));
      if (inside(poly, npc.pos[0], npc.pos[1]) || w > 200) return { ...spawn, where };
      // the floor: the area's base height, or the terrain if that is higher (sloped yards). With a
      // navmesh, only points with walkable floor near that height, standing on it: an area can reach
      // past its floor (the tailor's home, upstairs, spans the ground-floor shop below, where he stood
      // 3.4 m up in the air)
      const key = `${npc.id}/${area.id}`;
      const cached = this.spots.get(key);
      if (cached) return { activity, where, pos: cached, rot: yawQuat(rng(hash(npc.name + activity))() * 2 * Math.PI), pose: "stand" };
      const nav = this.nav;
      const floor = (x: number, y: number) => {
        const ref = Math.max(area.pos[2], groundAt(x, y));
        const hit = nav?.findPoly([x, y, ref], 0.2);
        const z = hit?.point?.[2];
        return z !== undefined && Math.abs(z - ref) < 1.5 ? z : null;
      };
      const seed = `${npc.name}/${where}`;
      const [x, y] = nav ? pointInArea(area, seed, (x, y) => floor(x, y) !== null) : pointInArea(area, seed);
      const z = floor(x, y) ?? Math.max(area.pos[2], groundAt(x, y));
      this.spots.set(key, [x, y, z]);
      return { activity, where, pos: [x, y, z], rot: yawQuat(rng(hash(npc.name + activity))() * 2 * Math.PI), pose: "stand" };
    };
    const atHome = () => (home ? inArea(home, "home") : spawn);
    if (target) {
      const area = ents.get(target.area);
      if (target.where === "bed") return bed ? { activity, where: "bed", pos: bed.pos, rot: bed.rot, pose: "sleep", bed, lying: lyingTag(bed) } : atHome();
      if (!target.moveToArea) return stay ? { ...stay, activity, where: target.where, pose: "stand" } : { ...spawn, where: target.where };
      return area?.points ? inArea(area, target.where) : { ...spawn, where: target.where };
    }
    const a = activity.toLowerCase();
    if (a.includes("sleep")) return bed ? { activity, where: "bed", pos: bed.pos, rot: bed.rot, pose: "sleep", bed, lying: lyingTag(bed) } : atHome();
    if (a.endsWith("work") || a === "monk_pray" || a === "servemeal" || a === "tidymeal") return work ? inArea(work, "work") : atHome();
    if (a === "fun" && stay) return { ...stay, activity };
    if (a === "morning" || a === "eat" || a === "fun") return home ? atHome() : work ? inArea(work, "work") : spawn;
    return spawn;
  }
}
