// The daily cycle (research note daily-cycle.md): each NPC's schedule store, a
// stack of time windows ("patches") over the soul's base schedule, which one is
// current, and what the current activity means for the NPC: the area and
// behaviour it runs. Work follows the Work link, breakfast and meals happen at
// home, free time ("fun") draws a hobby by weight and runs it on the nearest
// area of the home's settlement that offers it, and sleep goes to bed. NPCs
// have no needs: eating and sleeping happen only because the schedule says so.
// Behaviour trees (btWorld.ts) run the behaviour; this module picks it.

import type { ScheduleItem } from "./character.ts";
import type { EntityInfo, NpcEntity } from "./levelEntities.ts";
import { readTable } from "./tables.ts";
import type { AiWorld } from "./btWorld.ts";
import type { Vfs } from "./vfs.ts";

/** A window to add to the store; times in hours (0–24), `end <= start` crosses midnight. */
export interface PatchSpec {
  start: number;
  end: number;
  name: string;
  handle: string;
  /** the area that runs it (base patches have none: the land, see resolve) */
  source?: number | null;
  once?: boolean;
  immediate?: boolean;
}

interface Patch {
  id: number;
  name: string;
  handle: string;
  source: number | null;
  once: boolean;
  immediate: boolean;
  skipped: boolean;
  started: boolean;
  /** [start, end) pieces in hours: one, or two for a window across midnight (sharing the id) */
  pieces: [number, number][];
}

interface Bucket {
  priority: number;
  sub: number;
  patches: Patch[];
}

/** The current window as the daycycle tree reads it. */
export interface Activity {
  id: number;
  name: string;
  handle: string;
  source: number | null;
  priority: number;
  once: boolean;
  immediate: boolean;
  /** hours from now to the end of the window (wrapping) */
  remaining: number;
  /** start of the piece covering now, in hours */
  start: number;
}

function pieces(start: number, end: number): [number, number][] {
  if (start === end) return [[0, 24]];
  if (end < start) return end > 0 ? [[start, 24], [0, end]] : [[start, 24]];
  return [[start, end]];
}

const covers = (p: Patch, h: number) => p.pieces.some(([s, e]) => s <= h && h < e);
const overlaps = (a: Patch, b: Patch) => a.pieces.some(([s0, e0]) => b.pieces.some(([s1, e1]) => s0 < e1 && s1 < e0));

/**
 * One NPC's schedule store (note section 3). Buckets are sorted by (priority, sub-order); the base
 * schedule is bucket (0, 0). Among overlapping patches of one priority the newest wins; a skipped
 * patch hides the rest of its bucket; when nothing qualifies, the base entry after the skipped one
 * covering now takes over (skipping an activity starts the next one early). Skips last until
 * midnight.
 */
export class ScheduleStore {
  private buckets: Bucket[] = [];
  private counter = 0;
  private base: Patch[];
  private last = -1;

  constructor(schedule: ScheduleItem[]) {
    const n = schedule.length;
    this.base = n
      ? schedule.map((s, i) => this.make({ start: s.start / 60, end: schedule[(i + 1) % n].start / 60, name: s.activity, handle: `${s.activity}_${i}_GH` }))
      : [this.make({ start: 0, end: 24, name: "Sleep", handle: "Sleep_0_GH" })];
    this.buckets.push({ priority: 0, sub: 0, patches: this.base });
  }

  private make(s: PatchSpec): Patch {
    return { id: ++this.counter, name: s.name, handle: s.handle, source: s.source ?? null, once: !!s.once, immediate: !!s.immediate, skipped: false, started: false, pieces: pieces(s.start, s.end) };
  }

  private *all(): Iterable<Patch> {
    for (const b of this.buckets) yield* b.patches;
  }

  /** Add a patch at `priority`; false if one with that handle exists already. */
  add(spec: PatchSpec, priority = 10): boolean {
    for (const p of this.all()) if (p.handle === spec.handle) return false;
    const patch = this.make(spec);
    const same = this.buckets.filter((b) => b.priority === priority);
    const fit = same.find((b) => !b.patches.some((p) => overlaps(p, patch)));
    if (fit) { fit.patches.push(patch); return true; }
    const bucket = { priority, sub: same.length ? Math.max(...same.map((b) => b.sub)) + 1 : 0, patches: [patch] };
    const at = this.buckets.findIndex((b) => b.priority > priority || (b.priority === priority && b.sub > bucket.sub));
    this.buckets.splice(at < 0 ? this.buckets.length : at, 0, bucket);
    return true;
  }

  /** Remove the patch with this handle; base patches can't be removed. */
  remove(handle: string): boolean {
    for (const b of this.buckets) {
      if (b.patches === this.base) continue;
      const i = b.patches.findIndex((p) => p.handle === handle);
      if (i < 0) continue;
      b.patches.splice(i, 1);
      if (!b.patches.length) this.buckets.splice(this.buckets.indexOf(b), 1);
      return true;
    }
    return false;
  }

  /** Skip every patch with this handle until midnight. */
  skip(handle: string): void {
    for (const p of this.all()) if (p.handle === handle) p.skipped = true;
  }

  /** The behaviour of a patch started (marks once patches). */
  started(handle: string): void {
    for (const p of this.all()) if (p.handle === handle) p.started = true;
  }

  /** The behaviour of a patch ended: a once patch is removed when it succeeded. */
  ended(handle: string, success: boolean): void {
    for (const p of [...this.all()]) if (p.handle === handle && p.once && p.started && success) this.remove(handle);
  }

  /** The current activity at `hour` (0–24). Call with the clock moving forward: a wrap clears the skips. */
  current(hour: number): Activity {
    if (hour < this.last) for (const p of this.all()) p.skipped = false;
    this.last = hour;
    for (let k = this.buckets.length - 1; k >= 0; k--) {
      const b = this.buckets[k];
      const p = b.patches.find((x) => covers(x, hour));
      if (p && !p.skipped) return this.record(p, b, hour);
    }
    const i = Math.max(0, this.base.findIndex((p) => covers(p, hour)));
    for (let j = 1; j <= this.base.length; j++) {
      const p = this.base[(i + j) % this.base.length];
      if (!p.skipped) return this.record(p, this.buckets.find((b) => b.patches === this.base)!, hour);
    }
    for (const p of this.base) p.skipped = false;
    return this.record(this.base[i], this.buckets.find((b) => b.patches === this.base)!, hour);
  }

  private record(p: Patch, b: Bucket, hour: number): Activity {
    const end = p.pieces[p.pieces.length - 1][1] % 24;
    const piece = p.pieces.find(([s, e]) => s <= hour && hour < e) ?? p.pieces[0];
    const remaining = p.pieces.length === 1 && piece[0] === 0 && piece[1] === 24 ? 24 - hour : (end - hour + 24) % 24;
    return { id: p.id, name: p.name, handle: p.handle, source: p.source, priority: b.priority, once: p.once, immediate: p.immediate, remaining, start: piece[0] };
  }
}

/** What an activity has the NPC do: a behaviour on an area (or bed placement for sleep). */
export interface Target {
  area: number;
  behaviour: string;
  /** "work" | "home" | "fun" | "bed": where the schedule places the NPC (schedule.ts) */
  where: string;
  /** walk to the area first (false: start where the NPC stands, as cityWalk does) */
  moveToArea: boolean;
  /** for fun: the hobby drawn */
  hobby?: string;
}

/** The world the daily cycle reads: entities, area templates' behaviours, hobbies by soul name. */
export interface CycleWorld {
  ents: Map<number, EntityInfo>;
  /** behaviour names offered by an area template (lower case) */
  areaBehaviours: (template: string) => Set<string> | undefined;
  /** hobby_name → mass, per soul name (soul2hobby.xml + hobby.xml) */
  hobbies: Map<string, Map<string, number>>;
  /** whether an area can take another instance of a behaviour now (reservations); default yes */
  requestable?: (area: number, behaviour: string) => boolean;
  random?: () => number;
  /** false while the hobby data is still loading: free time is not skipped for want of it */
  ready?: boolean;
}

/** Hobbies whose behaviour moves the NPC nowhere first (their _data trees set moveToArea false). */
const STAY_HOBBIES = new Set(["citywalk"]);

/** Area templates of homes and rooms: a home hobby runs in the NPC's own home (see funArea). */
const isHome = (e: EntityInfo, offers: Set<string> | undefined) => !!offers?.has("sleeper");

/** Weighted draw over a name → mass map. */
export function drawWeighted(prefs: Map<string, number>, random: () => number): string | null {
  let sum = 0;
  for (const m of prefs.values()) sum += m;
  if (sum <= 0) return prefs.size ? [...prefs.keys()][0] : null;
  let r = random() * sum;
  for (const [k, m] of prefs) if ((r -= m) < 0) return k;
  return [...prefs.keys()][prefs.size - 1];
}

/**
 * Free-time areas (note section 6): the settlement containing the NPC's home, found up the
 * containment of areas (the level has no parent links: an area contains another when the other's
 * position is inside its polygon), else the home's `nearbyFun` area.
 */
export class FunAreas {
  private w: CycleWorld;
  private polys = new Map<number, number[]>();
  /** world x/y bounds per area polygon: x0, y0, x1, y1 */
  private boxes = new Map<number, [number, number, number, number]>();
  private areas: EntityInfo[];
  private homeCity = new Map<number, number | null>();
  private reach = new Map<number, number[]>();
  /** areas offering a hobby (lower case) reachable from a settlement, by "city/hobby" */
  private offering = new Map<string, number[]>();

  constructor(w: CycleWorld) {
    this.w = w;
    this.areas = [...w.ents.values()].filter((e) => e.points && e.points.length >= 6);
  }

  private poly(a: EntityInfo): number[] {
    let p = this.polys.get(a.id);
    if (!p) {
      const [w, x, y, z] = a.rot, pts = a.points!;
      p = [];
      for (let i = 0; i < pts.length; i += 2) {
        const px = pts[i], py = pts[i + 1];
        p.push(a.pos[0] + (1 - 2 * (y * y + z * z)) * px + 2 * (x * y - w * z) * py, a.pos[1] + 2 * (x * y + w * z) * px + (1 - 2 * (x * x + z * z)) * py);
      }
      this.polys.set(a.id, p);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
      this.boxes.set(a.id, [x0, y0, x1, y1]);
    }
    return p;
  }

  private contains(a: EntityInfo, x: number, y: number): boolean {
    const pts = this.poly(a);
    const [x0, y0, x1, y1] = this.boxes.get(a.id)!;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    let c = false;
    for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  private linkTargets(id: number, tag: string): number[] {
    const t = tag.toLowerCase();
    return (this.w.ents.get(id)?.links ?? []).filter((l) => l.name.split(",").some((p) => p.replace(/\[.*$/, "").trim().toLowerCase() === t)).map((l) => l.target);
  }

  /** The settlement area containing a home (the smallest), else the home's nearbyFun area. */
  city(home: number): number | null {
    if (this.homeCity.has(home)) return this.homeCity.get(home)!;
    const h = this.w.ents.get(home);
    let best: EntityInfo | null = null, bestSize = Infinity;
    if (h) for (const a of this.areas) {
      if (a.id === home || (a.category ?? "").toLowerCase() !== "settlement" || !this.contains(a, h.pos[0], h.pos[1])) continue;
      const p = this.poly(a);
      let size = 0;
      for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) size += p[j] * p[i + 1] - p[i] * p[j + 1];
      if (Math.abs(size) < bestSize) { best = a; bestSize = Math.abs(size); }
    }
    const out = best?.id ?? this.linkTargets(home, "nearbyFun")[0] ?? null;
    this.homeCity.set(home, out);
    return out;
  }

  /** Areas reachable from a settlement along self, child (contained) and nearbyFun edges, less suppressSearchHobby ones. */
  private reachable(city: number): number[] {
    let out = this.reach.get(city);
    if (out) return out;
    const ignored = new Set(this.linkTargets(city, "suppressSearchHobby"));
    const seen = new Set<number>([city]);
    // [area, whether its children are still to add]: an area found inside another adds only its
    // nearbyFun links (whatever is inside it is inside the outer one too)
    const queue: [number, boolean][] = [[city, true]];
    while (queue.length) {
      const [id, children] = queue.shift()!;
      const e = this.w.ents.get(id);
      for (const n of this.linkTargets(id, "nearbyFun")) if (!seen.has(n)) { seen.add(n); queue.push([n, true]); }
      if (children && e?.points) for (const a of this.areas) if (!seen.has(a.id) && this.contains(e as EntityInfo, a.pos[0], a.pos[1])) { seen.add(a.id); queue.push([a.id, false]); }
    }
    out = [...seen].filter((id) => !ignored.has(id) && this.w.ents.get(id)?.saTemplate);
    this.reach.set(city, out);
    return out;
  }

  /**
   * The nearest area offering `hobby` (requestable) reachable from the home's settlement. Homes are
   * left out except the NPC's own: whether a home offers its behaviours to non-residents is an open
   * point of the note (an NPC would otherwise sit in the nearest stranger's home).
   */
  area(npcPos: [number, number, number], home: number, hobby: string): number | null {
    const city = this.city(home);
    if (city === null) return null;
    const lower = hobby.toLowerCase();
    let list = this.offering.get(`${city}/${lower}`);
    if (!list) {
      list = this.reachable(city).filter((id) => {
        const e = this.w.ents.get(id)!;
        const offers = this.w.areaBehaviours(e.saTemplate ?? "");
        return !!offers?.has(lower) && !isHome(e, offers);
      });
      this.offering.set(`${city}/${lower}`, list);
    }
    const own = this.w.ents.get(home);
    const candidates = own && this.w.areaBehaviours(own.saTemplate ?? "")?.has(lower) ? [...list, home] : list;
    let best: number | null = null, bestD = Infinity;
    for (const id of candidates) {
      const e = this.w.ents.get(id)!;
      if (this.w.requestable && !this.w.requestable(id, hobby)) continue;
      const d = Math.hypot(e.pos[0] - npcPos[0], e.pos[1] - npcPos[1], e.pos[2] - npcPos[2]);
      if (d < bestD) { best = id; bestD = d; }
    }
    return best;
  }
}

const linkOf = (e: NpcEntity, role: string) => [...e.links].find(([k]) => k.split(",").some((x) => x.trim().startsWith(role)));

/** An NPC's daily cycle: its store, the activity it is on and what that has it do. */
export class NpcCycle {
  readonly store: ScheduleStore;
  readonly npc: NpcEntity;
  private w: CycleWorld;
  private fun: FunAreas;
  /** the current activity (from the store) and its target; null before the first update */
  activity: Activity | null = null;
  target: Target | null = null;
  /** the last target before the current one that took the NPC somewhere (where it walks from) */
  anchor: Target | null = null;
  /** game minute the current activity began for this NPC (its window start, or when it was pulled forward) */
  since = 0;
  /** counts target changes: a behaviour tree runs for one value (npcs.ts updateAi) */
  run = 0;
  /** the current activity interrupts the one before at once (an immediate patch with fast or instant halt speed) */
  haltNow = false;
  /** hobbies still to draw in this fun window (a hobby with no area is dropped) */
  private prefs: Map<string, number> | null = null;
  private lastHour = -1;
  /** base windows as [start, end, activity] in hours */
  private base: [number, number, string][];

  constructor(npc: NpcEntity, schedule: ScheduleItem[], w: CycleWorld, fun: FunAreas) {
    this.npc = npc;
    this.store = new ScheduleStore(schedule);
    this.base = baseWindows(schedule);
    this.w = w;
    this.fun = fun;
  }

  private get random(): () => number {
    return this.w.random ?? Math.random;
  }

  /**
   * Catch up with the clock (game minute 0–1440). On a new activity the target is resolved; an
   * activity that resolves to nothing (fun with no hobby area) is skipped and the next one starts.
   * Returns true when the activity changed.
   */
  update(minute: number): boolean {
    const hour = minute / 60;
    const first = this.activity === null;
    let changed = false;
    for (let guard = 0; guard < 12; guard++) {
      const a = this.store.current(hour);
      if (this.activity && a.id === this.activity.id) break;
      // a window with the same name and source carries on what runs (note section 4)
      if (this.activity && !first && guard === 0 && a.name === this.activity.name && a.source === this.activity.source && this.target) { this.activity = a; break; }
      // a window that began since the last update began at its start, not now (the clock jumps
      // when Henry sleeps); one pulled forward by a skip begins now
      const began = (this.lastHour < 0 || inWindow(a.start, this.lastHour, hour)) ? a.start * 60 : minute;
      if (first && guard === 0) this.target = this.resolvePrevious(a);
      this.activity = a;
      this.since = began;
      this.prefs = null;
      this.setTarget(this.resolve(a));
      changed = true;
      if (this.target || !this.skippable(a) || this.w.ready === false) break;
      this.store.skip(a.handle);
    }
    this.lastHour = hour;
    return changed;
  }

  private setTarget(t: Target | null): void {
    if (this.target?.moveToArea) this.anchor = this.target;
    this.target = t;
    this.run++;
  }

  /**
   * A `daycycle:change` message (note section 4): `add` lays a patch over the schedule
   * (priority 10 unless given; `startTime` -1 means from now, for `endTime` hours, or all day
   * from 24; immediate patches cover the whole day; `nowOrNever` patches below the current
   * priority are refused; cutscene critical priorities 100 and 95), else the patch with that
   * handle goes. The next update picks the current window as usual.
   */
  change(f: Record<string, unknown>, minute: number): void {
    const handle = String(f.handle ?? "");
    if (!handle) return;
    if (f.add !== true) { this.store.remove(handle); return; }
    const critical = String(f.criticalPriority ?? "");
    const priority = critical === "cutscene_init" ? 100 : critical === "cutscene_dialogFadingIn" ? 95 : typeof f.priority === "number" ? f.priority : 10;
    if (f.nowOrNever === true && this.activity && priority < this.activity.priority) return;
    const now = minute / 60;
    let start = typeof f.startTime === "number" ? f.startTime : 0, end = typeof f.endTime === "number" ? f.endTime : 24;
    if (start === -1) [start, end] = end >= 24 ? [0, 24] : [now, (now + end) % 24];
    if (f.immediate === true) [start, end] = [0, 24];
    const source = typeof f.sourceId === "number" ? f.sourceId : (f.sourceId as { id?: number } | null)?.id ?? null;
    this.store.add({ start, end, name: String(f.name ?? handle), handle, source, once: f.once === true, immediate: f.immediate === true }, priority);
    // an immediate patch at or above the current priority interrupts now unless it halts slowly
    const speed = String(f.immediateDaycycleHaltSpeed ?? "");
    this.haltNow = f.immediate === true && !!this.activity && priority >= this.activity.priority && /fast|instant|^[12]$/i.test(speed);
  }

  /** On first sight the NPC walks from where the base schedule's previous activity had it. */
  private resolvePrevious(a: Activity): Target | null {
    // the base window that ends where this one starts
    const t = (a.start + 24 - 1e-6) % 24;
    const prev = this.base.find(([s, e]) => (s < e ? s <= t && t < e : t >= s || t < e))?.[2];
    return prev ? this.resolve({ ...a, name: prev, handle: "" }, true) : null;
  }

  /** Activities whose failure to resolve skips them (the rest keep the schedule's placement). */
  private skippable(a: Activity): boolean {
    return a.name.toLowerCase() === "fun";
  }

  /**
   * What an activity means for this NPC (note section 5). `quiet`: no hobby bookkeeping (for the
   * activity before the first one seen).
   */
  private resolve(a: Activity, quiet = false): Target | null {
    const e = this.npc;
    const name = a.name.toLowerCase();
    const home = linkOf(e, "Home");
    if (name === "work") {
      const l = linkOf(e, "Work[") ?? linkOf(e, "Work");
      const b = l && /Work\[([^\]]+)\]/.exec(l[0])?.[1].replace(/[()'"\s]/g, "");
      return l && b ? { area: l[1], behaviour: b, where: "work", moveToArea: true } : null;
    }
    if (!home) return null;
    if (name === "morning") return { area: home[1], behaviour: "BreakfastEater", where: "home", moveToArea: true };
    // ASSUMPTION: always at home; the game sends 10% of men whose social class lunches in pubs to a
    // pub within 115 m, but where that class flag comes from isn't in the note yet
    if (name === "eat") return { area: home[1], behaviour: "Eater", where: "home", moveToArea: true };
    if (name === "sleep") return { area: home[1], behaviour: "Sleeper", where: "bed", moveToArea: true };
    if (name === "fun") return this.drawHobby(home[1], quiet);
    return null;
  }

  /** Draw hobbies by mass until one has an area (note section 6); null when none has. */
  private drawHobby(home: number, quiet = false): Target | null {
    let prefs = quiet ? null : this.prefs;
    if (!prefs) {
      prefs = new Map(this.w.hobbies.get(this.npc.name) ?? []);
      if (!quiet) this.prefs = prefs;
    }
    while (prefs.size) {
      const hobby = drawWeighted(prefs, this.random)!;
      const area = this.fun.area(this.w.ents.get(home)?.pos ?? this.npc.pos, home, hobby);
      if (area === null) { prefs.delete(hobby); continue; }
      return { area, behaviour: hobby, where: "fun", moveToArea: !STAY_HOBBIES.has(hobby.toLowerCase()), hobby };
    }
    return null;
  }

  /**
   * The behaviour of the current activity returned. Before the time changed: fun draws its next
   * hobby (if a hobby ran, whatever its outcome); any other activity is skipped, and the next base
   * entry starts now (note section 4). `minute` is the game clock.
   */
  behaviourEnded(timeChanged: boolean, success: boolean, minute: number): void {
    const a = this.activity;
    if (!a) return;
    this.store.ended(a.handle, success);
    if (timeChanged) return;
    if (a.name.toLowerCase() === "fun" && this.target) {
      const home = linkOf(this.npc, "Home");
      const next = home ? this.drawHobby(home[1]) : null;
      if (next) { this.setTarget(next); this.since = minute; return; }
    }
    this.store.skip(a.handle);
    this.update(minute);
  }
}

/** Base windows of a schedule as [start, end, activity] in hours. */
function baseWindows(schedule: ScheduleItem[]): [number, number, string][] {
  const n = schedule.length;
  return schedule.map((s, i) => [s.start / 60, schedule[(i + 1) % n].start / 60, s.activity]);
}

/** Whether hour `t` lies in (from, to], wrapping past midnight. */
function inWindow(t: number, from: number, to: number): boolean {
  return from <= to ? from < t && t <= to : t > from || t <= to;
}

/** Every NPC's daily cycle, created on first use. */
export class DayCycles {
  readonly world: CycleWorld;
  readonly fun: FunAreas;
  private cycles = new Map<number, NpcCycle>();

  constructor(world: CycleWorld) {
    this.world = world;
    this.fun = new FunAreas(world);
  }

  /** The NPC's cycle, caught up to game minute `minute`. */
  at(npc: NpcEntity, schedule: ScheduleItem[], minute: number): NpcCycle {
    let c = this.cycles.get(npc.id);
    if (!c) {
      c = new NpcCycle(npc, schedule, this.world, this.fun);
      this.cycles.set(npc.id, c);
    }
    c.update(((minute % 1440) + 1440) % 1440);
    return c;
  }

  get(id: number): NpcCycle | undefined {
    return this.cycles.get(id);
  }
}

/** Hobbies by soul name: hobby_name → mass (Libs/Tables/rpg/soul2hobby.xml, hobby.xml, soul.xml). */
export async function loadHobbies(vfs: Vfs): Promise<Map<string, Map<string, number>>> {
  const names = new Map((await readTable(vfs, "rpg/hobby")).map((r) => [r.hobby_id, r.hobby_name]));
  const souls = new Map((await readTable(vfs, "rpg/soul")).map((r) => [r.soul_id, r.soul_name]));
  const out = new Map<string, Map<string, number>>();
  for (const r of await readTable(vfs, "rpg/soul2hobby")) {
    const soul = souls.get(r.soul_id), hobby = names.get(r.hobby_id);
    if (!soul || !hobby) continue;
    const m = out.get(soul) ?? new Map<string, number>();
    m.set(hobby, (m.get(hobby) ?? 0) + Number(r.mass || 0));
    out.set(soul, m);
  }
  return out;
}

/** What daily cycles need beyond the entities: the hobby tables and the AI world's area behaviours and reservations. */
export async function cycleData(vfs: Vfs, world: AiWorld): Promise<Omit<CycleWorld, "ents">> {
  return { hobbies: await loadHobbies(vfs), areaBehaviours: (t) => world.o.ai.areaBehaviours(t), requestable: (a, b) => world.requestable(a, b) };
}
