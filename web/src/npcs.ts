// NPCs in the world view: assembles the characters near a point from their
// souls (entity name = soul_name), places them where their daily schedule puts
// them at the given time (src/schedule.ts, including walks between places) and
// plays a relaxed idle, the walk cycle in place, or the sleeping clip in bed.

import { CharacterDb, loadCharacter, poseMatrix, type LoadedCharacter, type ScheduleItem } from "./character.ts";
import { parseSkeleton, skeletonKey, type Skeleton } from "./skeleton.ts";
import { Dba } from "./dba.ts";
import { Animator } from "./pose.ts";
import type { Clip } from "./anim.ts";
import type { NpcEntity } from "./levelEntities.ts";
import type { Placement, Pose, Schedules } from "./schedule.ts";
import type { NpcAi } from "./npcAi.ts";
import type { LoadedModel } from "./model.ts";
import type { Vfs } from "./vfs.ts";
import { multiply } from "./mat4.ts";
import { avoid, CA, NPC_PATH_RADIUS, type CrowdAgent, type Vec3 } from "./crowd.ts";

const CLIPS: Record<"male" | "female", [string, Record<Pose, string[]>]> = {
  male: ["animations/humans/male/male_general.dba", {
    stand: ["animations/humans/male/locomotion/relaxed_idle.caf", "animations/humans/male/behavior/_relaxed_idle_both.caf"],
    sleep: ["animations/humans/male/behavior/sleeping_bed_idle.caf"],
    walk: ["animations/humans/male/locomotion/relaxed_walk_medium.caf"],
    act: [], // behaviour-tree animations come from the Mannequin fragments (npcAi.ts)
  }],
  female: ["animations/humans/female/female_general.dba", {
    stand: ["animations/humans/female/locomotion/relaxed_idle.caf"],
    sleep: ["animations/humans/female/behavior/sleeping_bed_idle.caf"],
    walk: ["animations/humans/female/locomotion/relaxed_walk_medium.caf"],
    act: [],
  }],
};

/** An NPC moved by stepCrowd: its avoidance agent, the plan it follows and what is drawn. */
interface Mover {
  agent: CrowdAgent;
  ref: Placement;
  shown?: Placement;
  yaw: number;
  goalZ?: number;
}

/** Body (physics capsule) radius for NPC-NPC contact: the avoidance radius less a little give. */
const BODY_RADIUS = 0.3;

/** Plans further than this (m) from where an NPC is restart it there instead of walking. */
const SNAP_DISTANCE = 8;

const yawOf = (q: [number, number, number, number]) => 2 * Math.atan2(q[3], q[0]);

/** Selection advantage (m) of NPCs already shown, see NpcWorld.select. */
const SHOWN_BONUS = 25;

/** Walking speed (m/s) of relaxed_walk_medium: its root moves 3.03 m in 65 frames (male), 2.63 m in 61 (female) at 30 fps. */
const WALK_SPEED = { male: 1.40, female: 1.29 };

export interface WorldNpc {
  entity: NpcEntity;
  placement: Placement;
  schedule: ScheduleItem[];
  character: LoadedCharacter;
  /** entity world matrix (column-major) */
  world: Float32Array;
  animator: Animator;
  clips: Record<Pose, Clip | null>;
  phase: number;
  /** walk-cycle position (frames) and the clock of the last animateNpcs, so the cycle follows the distance walked */
  walkFrame?: number;
  lastSeconds?: number;
  /** renderer item index of each part (same order as character.parts) */
  items: number[];
}

export interface NpcRenderItem {
  model: LoadedModel;
  transform: Float32Array;
  layer: number;
  /** the parts of one NPC with the same bones share a skinning palette */
  paletteKey?: string;
}

interface Rig {
  skeleton: Skeleton;
  clips: Record<Pose, Clip | null>;
}

export class NpcWorld {
  private db: Promise<CharacterDb> | null = null;
  private rigs = new Map<string, Promise<Rig | null>>();
  private chars = new Map<number, Promise<LoadedCharacter | null>>();
  private vfs: Vfs;
  readonly entities: NpcEntity[];
  private schedules: Schedules | null;
  private groundAt: (x: number, y: number) => number;
  /**
   * The walkable surface under (x, y) near height z (terrain, streets, bridges, floors: the player's
   * collision world), or null. Set by the world view; without it NPCs stand at their planned height,
   * which on routes comes from the navmesh and sinks their feet into slopes and cobbles.
   */
  surface: ((x: number, y: number, z: number) => number | null) | null = null;
  constructor(vfs: Vfs, entities: NpcEntity[], schedules: Schedules | null = null, groundAt: (x: number, y: number) => number = () => 0) {
    this.vfs = vfs;
    this.entities = entities;
    this.schedules = schedules;
    this.groundAt = groundAt;
  }

  private rig(skeletonPath: string, female: boolean): Promise<Rig | null> {
    const key = skeletonPath + (female ? "#f" : "#m");
    let r = this.rigs.get(key);
    if (!r) {
      r = (async () => {
        const hit = this.vfs.lookup(skeletonPath);
        const skeleton = hit ? parseSkeleton(await this.vfs.read(hit)) : null;
        if (!skeleton) return null;
        const clips: Record<Pose, Clip | null> = { stand: null, sleep: null, walk: null, act: null };
        const [dbPath, names] = CLIPS[female ? "female" : "male"];
        const dh = this.vfs.lookup(dbPath);
        if (dh) {
          const dba = new Dba(await this.vfs.read(dh));
          for (const pose of ["stand", "sleep", "walk"] as const) {
            const name = names[pose].find((n) => dba.anims.some((a) => a.name === n));
            if (name) clips[pose] = dba.clip(name);
          }
        }
        return { skeleton, clips };
      })().catch(() => null);
      this.rigs.set(key, r);
    }
    return r;
  }

  /** per NPC id: the area/behaviour its tree runs (updateAi; "!…" when it could not start) */
  readonly running = new Map<number, string>();
  /** actual movement with collision avoidance, per NPC id (stepCrowd) */
  private movers = new Map<number, Mover>();
  /** NPCs' planned spots moved off one another (key: planned spot), see stepCrowd */
  private freeSpots = new Map<string, Vec3>();

  /** NPCs whose workplace behaviour trees drive them while at work (null = schedule placement only). */
  ai: NpcAi | null = null;

  /** Where an NPC is at `minute`: its behaviour tree's state when one drives it, else the schedule. */
  placeAt(e: NpcEntity, schedule: ScheduleItem[], minute: number): Placement {
    const st = this.ai?.state(e.id);
    if (st) {
      const p = this.scheduled(e, schedule, minute);
      return { ...p, where: `${p.where} (behaviour tree)`, pos: st.pos, rot: st.rot, pose: st.mode === "walk" ? "walk" : st.mode === "act" ? "act" : "stand" };
    }
    return this.scheduled(e, schedule, minute);
  }

  /** Schedule placement (walks included), or the spawn point without schedules. */
  scheduled(e: NpcEntity, schedule: ScheduleItem[], minute: number): Placement {
    return this.schedules
      ? this.schedules.at(e, schedule, minute, this.groundAt, WALK_SPEED[e.female ? "female" : "male"])
      : { activity: "", where: "spawn", pos: e.pos, rot: e.rot, pose: "stand" };
  }

  /** NPCs returned by the last near(): they keep their place in later selections (see select). */
  private shown = new Set<number>();

  /**
   * The NPCs (with their placement at `minute`) within `radius` of a point, nearest first. Cheap: no loading.
   * NPCs already shown count as SHOWN_BONUS metres nearer and stay up to SHOWN_BONUS beyond the radius,
   * so a full selection doesn't swap a visible NPC for one barely nearer (they vanished mid-street).
   */
  async select(center: [number, number, number], radius: number, max: number, minute: number): Promise<{ e: NpcEntity; p: Placement }[]> {
    this.db ??= CharacterDb.load(this.vfs);
    const db = await this.db;
    const souls = new Map(db.souls.map((s) => [s.name, s]));
    return this.entities
      .flatMap((e) => {
        const soul = souls.get(e.name);
        if (!soul) return [];
        const p = this.placeAt(e, soul.schedule, minute);
        const bonus = this.shown.has(e.id) ? SHOWN_BONUS : 0;
        const d = Math.hypot(p.pos[0] - center[0], p.pos[1] - center[1], p.pos[2] - center[2]) - bonus;
        return d <= radius ? [{ e, p, d }] : [];
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, max);
  }

  /**
   * Move the shown NPCs for `dt` real seconds: each chases its planned placement (schedule or
   * behaviour tree) at walking speed, steering around the others with the game's collision
   * avoidance (crowd.ts). The result is what animateNpcs draws.
   */
  stepCrowd(npcs: WorldNpc[], minute: number, dt: number): void {
    const inView = new Set(npcs.map((n) => n.entity.id));
    for (const id of this.movers.keys()) if (!inView.has(id)) this.movers.delete(id);
    if (dt <= 0) return;
    const planned = npcs.map((n) => this.placeAt(n.entity, n.schedule, minute));
    const goals = this.separateSpots(npcs, planned);
    const agents: CrowdAgent[] = [];
    npcs.forEach((n, i) => {
      const ref = planned[i], goal = goals[i];
      let m = this.movers.get(n.entity.id);
      const far = m && (Math.hypot(goal[0] - m.agent.pos[0], goal[1] - m.agent.pos[1]) > SNAP_DISTANCE || Math.abs(goal[2] - m.agent.pos[2]) > 2);
      if (!m || far) {
        // new, or the plan jumped (clock moved, activity elsewhere): start at the planned spot
        m = { agent: { radius: NPC_PATH_RADIUS + CA.agentExtraFat, pos: [...goal], vel: [0, 0], pref: [0, 0], maxSpeed: 0, avoids: false, shrink: m?.agent.shrink ?? 1 }, ref, yaw: yawOf(ref.rot) };
        this.movers.set(n.entity.id, m);
      }
      m.ref = ref;
      const a = m.agent;
      const speed = WALK_SPEED[n.entity.female ? "female" : "male"];
      const dx = goal[0] - a.pos[0], dy = goal[1] - a.pos[1], dist = Math.hypot(dx, dy);
      a.maxSpeed = speed * 1.3;
      if (ref.pose === "walk") {
        // follow the moving plan, catching up when behind (0.3 m lag at walking speed)
        const v = dist > 1e-3 ? Math.min(a.maxSpeed, speed + 0.5 * (dist - 0.3)) : 0;
        a.pref = dist > 1e-3 ? [(dx / dist) * Math.max(0, v), (dy / dist) * Math.max(0, v)] : [0, 0];
        a.avoids = true;
      } else {
        // arriving: within ai_CollisionAvoidancePathEndCutoffRange the agent stops avoiding; a goal
        // someone stands on is reached at body contact (waiting beside them, not pushing in)
        const blocked = dist < 2 * BODY_RADIUS + 0.2 && npcs.some((o) => o !== n && this.bodyAt(o.entity.id, goal));
        const v = Math.min(speed, dist / dt);
        a.pref = dist > 0.02 && !blocked ? [(dx / dist) * v, (dy / dist) * v] : [0, 0];
        a.avoids = dist > CA.pathEndCutoff;
      }
      a.vel = a.avoids ? a.vel : a.pref;
      m.goalZ = goal[2];
      agents.push(a);
    });
    avoid(agents, dt);
    for (const n of npcs) {
      const m = this.movers.get(n.entity.id)!;
      m.agent.pos[0] += m.agent.vel[0] * dt;
      m.agent.pos[1] += m.agent.vel[1] * dt;
      const z = m.goalZ ?? m.agent.pos[2];
      m.agent.pos[2] = this.surface?.(m.agent.pos[0], m.agent.pos[1], z) ?? z;
    }
    this.collideBodies(npcs);
    npcs.forEach((n) => {
      const m = this.movers.get(n.entity.id)!;
      const a = m.agent;
      const moving = Math.hypot(a.vel[0], a.vel[1]) > 0.15;
      // turn towards the walking direction (up to 2 turns a second), else the planned facing
      const want = moving ? Math.atan2(a.vel[1], a.vel[0]) - Math.PI / 2 : yawOf(m.ref.rot);
      const d = ((want - m.yaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      m.yaw += Math.sign(d) * Math.min(Math.abs(d), 4 * Math.PI * dt);
      const settled = !moving && Math.hypot(a.pref[0], a.pref[1]) === 0;
      const pose: Pose = moving ? "walk" : settled && m.ref.pose !== "walk" ? m.ref.pose : "stand";
      m.shown = { ...m.ref, pos: [...a.pos], rot: [Math.cos(m.yaw / 2), 0, 0, Math.sin(m.yaw / 2)], pose };
    });
  }

  /** NPC `id`'s current walking speed (m/s) from the crowd step, if it has moved. */
  speed(id: number): number | undefined {
    const a = this.movers.get(id)?.agent;
    return a ? Math.hypot(a.vel[0], a.vel[1]) : undefined;
  }

  /** Whether NPC `id`'s body covers point `p` (same floor). */
  private bodyAt(id: number, p: Vec3): boolean {
    const a = this.movers.get(id)?.agent;
    return !!a && Math.hypot(a.pos[0] - p[0], a.pos[1] - p[1]) < 2 * BODY_RADIUS && Math.abs(a.pos[2] - p[2]) < 1;
  }

  /**
   * Bodies don't pass through one another (in the game, the characters' physics capsules): overlapping
   * pairs are pushed apart, the moving one taking the push, and NPCs at work, eating or in bed (playing
   * a behaviour animation) not at all.
   */
  private collideBodies(npcs: WorldNpc[]): void {
    const ms = npcs.map((n) => this.movers.get(n.entity.id)!);
    const fixed = (m: Mover) => m.ref.pose === "act" || m.ref.pose === "sleep";
    const moving = (m: Mover) => Math.hypot(m.agent.vel[0], m.agent.vel[1]) > 0.05;
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
      const a = ms[i].agent, b = ms[j].agent;
      if (Math.abs(a.pos[2] - b.pos[2]) > 1) continue;
      let dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1];
      let d = Math.hypot(dx, dy);
      const overlap = 2 * BODY_RADIUS - d;
      if (overlap <= 0) continue;
      if (d < 1e-4) { dx = 1; dy = 0; d = 1; }
      // share of the push each takes
      let wa = fixed(ms[i]) ? 0 : moving(ms[i]) ? 2 : 1, wb = fixed(ms[j]) ? 0 : moving(ms[j]) ? 2 : 1;
      if (wa + wb === 0) continue;
      const k = overlap / d / (wa + wb);
      a.pos[0] -= dx * k * wa; a.pos[1] -= dy * k * wa;
      b.pos[0] += dx * k * wb; b.pos[1] += dy * k * wb;
    }
  }

  /** The placement stepCrowd last produced for an NPC (undefined before it runs). */
  drawn(id: number): Placement | undefined {
    return this.movers.get(id)?.shown;
  }

  /**
   * Standing spots for the shown NPCs. APPROXIMATION: in the game every NPC at work or home runs its
   * area's behaviour tree, which hands out distinct spots (locks, semaphores); NPCs we don't run a tree
   * for stand on their planned spot, which can be another NPC's (the tailor's wife on his table spot).
   * Those move to the nearest free navmesh point within 1.5 m; NPCs driven by trees, walking, acting or
   * in bed keep theirs.
   */
  private separateSpots(npcs: WorldNpc[], planned: Placement[]): Vec3[] {
    const nav = this.schedules?.navMesh ?? null;
    const minGap = 2 * (NPC_PATH_RADIUS + CA.agentExtraFat);
    const taken: Vec3[] = [];
    const goals: Vec3[] = planned.map((p) => [...p.pos] as Vec3);
    const flexible = (i: number) => planned[i].pose === "stand" && !planned[i].where.includes("behaviour tree");
    npcs.forEach((_, i) => { if (!flexible(i)) taken.push(goals[i]); });
    const free = (p: Vec3) => taken.every((t) => Math.hypot(t[0] - p[0], t[1] - p[1]) >= minGap || Math.abs(t[2] - p[2]) > 2);
    const order = npcs.map((_, i) => i).filter(flexible).sort((a, b) => npcs[a].entity.id - npcs[b].entity.id);
    for (const i of order) {
      const p = goals[i];
      if (!free(p)) {
        const key = `${npcs[i].entity.id}@${p.map((v) => v.toFixed(1)).join(",")}`;
        let spot = this.freeSpots.get(key);
        if (!spot || !free(spot)) {
          spot = undefined;
          for (const r of [0.7, 1.0, 1.5]) {
            for (let k = 0; k < 12 && !spot; k++) {
              const ang = (k / 12) * 2 * Math.PI;
              const q: Vec3 = [p[0] + Math.cos(ang) * r, p[1] + Math.sin(ang) * r, p[2]];
              const at = nav ? nav.findPoly(q, 0.05)?.point : undefined;
              if ((!nav || (at && Math.abs(at[2] - p[2]) < 0.5)) && free(q)) spot = at ? [q[0], q[1], at[2]] : q;
            }
            if (spot) break;
          }
          if (spot) this.freeSpots.set(key, spot);
        }
        if (spot) goals[i] = spot;
      }
      taken.push(goals[i]);
    }
    return goals;
  }

  /** Identifies a selection: changes when an NPC enters or leaves it (movement is per frame, see animateNpcs). */
  static key(sel: { e: NpcEntity; p: Placement }[]): string {
    return sel.map(({ e }) => e.id).sort((a, b) => a - b).join(" ");
  }

  /** Assemble up to `max` NPCs within `radius` of a point at time `minute` (0–1439), nearest first. */
  async near(center: [number, number, number], radius: number, max: number, minute = 720, onStatus?: (s: string) => void): Promise<WorldNpc[]> {
    const db = await (this.db ??= CharacterDb.load(this.vfs));
    const souls = new Map(db.souls.map((s) => [s.name, s]));
    const candidates = await this.select(center, radius, max, minute);
    // start the character loads up front, four at a time, so file reads and decoding overlap
    const missing = candidates.filter(({ e }) => !this.chars.has(e.id));
    let started = 0, done = 0;
    const startNext = (): Promise<void> | undefined => {
      const c = missing[started++];
      if (!c) return undefined;
      const p = loadCharacter(this.vfs, db.soul(souls.get(c.e.name)!.id), { maxTextureDim: 256 }).catch(() => null);
      this.chars.set(c.e.id, p);
      return p.then(() => { onStatus?.(`Assembling NPCs ${++done}/${missing.length}`); return startNext(); });
    };
    await Promise.all([startNext(), startNext(), startNext(), startNext()]);
    const out: WorldNpc[] = [];
    for (const { e, p: placement } of candidates) {
      const p = this.chars.get(e.id)!;
      const character = await p;
      if (!character?.parts.length) continue;
      const rig = await this.rig(character.spec.skeleton, e.female);
      if (!rig) continue;
      out.push({
        entity: e,
        placement,
        schedule: souls.get(e.name)!.schedule,
        character,
        world: poseMatrix(placement.pos, placement.rot),
        animator: new Animator(rig.skeleton),
        clips: rig.clips,
        phase: Math.random() * 1000,
        items: [],
      });
    }
    this.shown = new Set(out.map((n) => n.entity.id));
    return out;
  }
}

/**
 * The area behaviour an NPC runs for a schedule activity, as the game's daily cycle maps them
 * (Libs/AI/final/sa_city.xml interpretBehavior): work → the Work link's area and the behaviour
 * its link names (Work[tailor], Work['tailor'], Work[('merchant')]); morning → home
 * "BreakfastEater"; eat → home "Eater" (the game may send them to a pub instead). fun → home
 * "hangingOut" is an APPROXIMATION: the game picks a fun setting (pub, bench, walk) in its "fun"
 * tree. Sleep stays with the schedule's bed placement.
 */
export function activityBehaviour(e: NpcEntity, activity: string): { area: number; behaviour: string; where: string } | null {
  const a = activity.toLowerCase();
  const link = (role: string) => [...e.links].find(([k]) => k.split(",").some((x) => x.trim().startsWith(role)));
  if (a === "work") {
    const l = link("Work[") ?? link("Work");
    const name = l && /Work\[([^\]]+)\]/.exec(l[0])?.[1].replace(/[()'"\s]/g, "");
    return l && name ? { area: l[1], behaviour: name, where: "work" } : null;
  }
  const home = link("Home");
  if (!home) return null;
  if (a === "morning") return { area: home[1], behaviour: "BreakfastEater", where: "home" };
  if (a === "eat") return { area: home[1], behaviour: "Eater", where: "home" };
  if (a === "fun") return { area: home[1], behaviour: "hangingOut", where: "home" };
  return null;
}

/**
 * Start or stop the NPCs' area behaviour trees: an NPC that has arrived where its schedule puts it
 * (not walking) runs the behaviour for its current activity (activityBehaviour); when the activity
 * changes, the tree stops and the next one starts on arrival.
 */
export function updateAi(npcs: WorldNpc[], world: NpcWorld, minute: number): void {
  const ai = world.ai;
  if (!ai) return;
  const inView = new Set(npcs.map((n) => n.entity.id));
  for (const id of ai.ids()) if (!inView.has(id)) ai.stop(id);
  for (const n of npcs) {
    const p = world.scheduled(n.entity, n.schedule, minute);
    const want = p.pose === "stand" ? activityBehaviour(n.entity, p.activity) : null;
    const key = want && want.where === p.where ? `${want.area}/${want.behaviour}` : "";
    if (!key) { ai.stop(n.entity.id); world.running.delete(n.entity.id); continue; }
    if (ai.has(n.entity.id) && world.running.get(n.entity.id) === key) continue;
    // a tree that could not start (no such behaviour in the area) is not retried every check
    if (world.running.get(n.entity.id) === `!${key}`) continue;
    const ok = ai.start(n.entity, want!.area, want!.behaviour, p.pos, p.rot);
    world.running.set(n.entity.id, ok ? key : `!${key}`);
  }
}

/** Renderer items for a set of NPCs; fills each NPC's `items` with its item indices (offset by `base`). */
export function npcItems(npcs: WorldNpc[], base = 0): NpcRenderItem[] {
  const items: NpcRenderItem[] = [];
  for (const n of npcs) {
    n.items = [];
    for (const { model, part, transform } of n.character.parts) {
      n.items.push(base + items.length);
      items.push({ model, transform: transform ? multiply(n.world, transform) : n.world, layer: part.layer, paletteKey: model.skeleton ? `${n.entity.id}:${skeletonKey(model.skeleton)}` : undefined });
    }
  }
  return items;
}

/** Renderer operations animateNpcs needs (ModelRenderer's). */
export interface NpcRendererOps {
  setPalette(item: number, m: Float32Array): void;
  /** the item's palette is set through another item's (shared: skip it) */
  paletteShared?(item: number): boolean;
  /** hide an item from the camera only (it still casts a shadow); false when unsupported */
  setItemHidden?(item: number, hidden: boolean): boolean;
  paletteSize(item: number): number;
  setItemTransform(item: number, m: Float32Array): void;
}

/** Pose updates by distance from the viewer: every frame within 25 m, every 2nd to 50 m, every 4th beyond. */
const POSE_RATE: [number, number][] = [[25, 1], [50, 2], [Infinity, 4]];
let animFrame = 0;

/**
 * Per frame: place each NPC at game time `minute` (they move while walking between
 * places), pick the clip for the pose, advance it by real `seconds`, upload transforms
 * and skinning palettes. With `eye`, distant NPCs re-pose less often (they still move every
 * frame; the pose is held in between).
 */
export function animateNpcs(npcs: WorldNpc[], world: NpcWorld, minute: number, seconds: number, r: NpcRendererOps, eye?: [number, number, number]): void {
  animFrame++;
  for (const [k, n] of npcs.entries()) {
    const p = world.drawn(n.entity.id) ?? world.placeAt(n.entity, n.schedule, minute);
    // the walk cycle advances with the distance actually walked (the clip's own speed is the NPCs'
    // walking speed, but they catch up and slow down around others): no sliding feet
    const walk = n.clips.walk, dt = seconds - (n.lastSeconds ?? seconds);
    n.lastSeconds = seconds;
    if (walk) {
      const clipSpeed = walk.motion?.moveSpeed || 1;
      n.walkFrame = (n.walkFrame ?? n.phase) + dt * walk.fps * ((world.speed(n.entity.id) ?? clipSpeed) / clipSpeed);
    }
    const moved = p.pos.some((v, i) => v !== n.placement.pos[i]) || p.rot.some((v, i) => v !== n.placement.rot[i]);
    n.placement = p;
    if (moved) {
      n.world = poseMatrix(p.pos, p.rot);
      n.character.parts.forEach(({ transform }, k) => r.setItemTransform(n.items[k], transform ? multiply(n.world, transform) : n.world));
    }
    if (eye) {
      const d = Math.hypot(p.pos[0] - eye[0], p.pos[1] - eye[1], p.pos[2] - eye[2]);
      const every = POSE_RATE.find(([max]) => d < max)![1];
      // spread the skipped NPCs over the frames
      if ((animFrame + k) % every !== 0) continue;
    }
    const st = p.pose === "act" ? world.ai?.state(n.entity.id) : undefined;
    let c = n.clips[p.pose] ?? n.clips.stand;
    let frame = c ? c.start + (((c === walk ? n.walkFrame ?? 0 : seconds * c.fps + n.phase)) % Math.max(1, c.end - c.start)) : 0;
    if (st?.clip && world.ai) {
      // a behaviour-tree animation: from its start, looping or holding the last frame
      c = st.clip.clip;
      const f = (world.ai.now - st.since) * c.fps;
      frame = c.start + (st.clip.loop ? f % Math.max(1, c.end - c.start) : Math.min(f, c.end - c.start));
    }
    n.animator.evaluate(c, frame, p.pose === "walk");
    n.character.parts.forEach(({ model }, k) => {
      if (model.skeleton && r.paletteSize(n.items[k]) && !r.paletteShared?.(n.items[k])) r.setPalette(n.items[k], n.animator.palette(model.skeleton));
    });
  }
}
