// NPCs in the world view: assembles the characters near a point from their
// souls (entity name = soul_name), places them where their daily schedule puts
// them at the given time (src/schedule.ts, including walks between places) and
// plays a relaxed idle, the walk cycle in place, or the sleeping clip in bed.

import { CharacterDb, loadCharacter, poseMatrix, type LoadedCharacter, type ScheduleItem } from "./character.ts";
import { parseSkeleton, type Skeleton } from "./skeleton.ts";
import { Dba } from "./dba.ts";
import { Animator } from "./pose.ts";
import type { Clip } from "./anim.ts";
import type { NpcEntity } from "./levelEntities.ts";
import type { Placement, Pose, Schedules } from "./schedule.ts";
import type { NpcAi } from "./npcAi.ts";
import type { LoadedModel } from "./model.ts";
import type { Vfs } from "./vfs.ts";
import { multiply } from "./mat4.ts";

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
  /** renderer item index of each part (same order as character.parts) */
  items: number[];
}

export interface NpcRenderItem {
  model: LoadedModel;
  transform: Float32Array;
  layer: number;
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

  /** The NPCs (with their placement at `minute`) within `radius` of a point, nearest first. Cheap: no loading. */
  async select(center: [number, number, number], radius: number, max: number, minute: number): Promise<{ e: NpcEntity; p: Placement }[]> {
    this.db ??= CharacterDb.load(this.vfs);
    const db = await this.db;
    const souls = new Map(db.souls.map((s) => [s.name, s]));
    return this.entities
      .flatMap((e) => {
        const soul = souls.get(e.name);
        if (!soul) return [];
        const p = this.placeAt(e, soul.schedule, minute);
        const d = Math.hypot(p.pos[0] - center[0], p.pos[1] - center[1], p.pos[2] - center[2]);
        return d <= radius ? [{ e, p, d }] : [];
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, max);
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
    const out: WorldNpc[] = [];
    for (const [k, { e, p: placement }] of candidates.entries()) {
      let p = this.chars.get(e.id);
      if (!p) {
        onStatus?.(`Assembling NPC ${k + 1}/${candidates.length}: ${e.name}`);
        p = loadCharacter(this.vfs, db.soul(souls.get(e.name)!.id), { maxTextureDim: 256 }).catch(() => null);
        this.chars.set(e.id, p);
      }
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
    return out;
  }
}

/**
 * Start or stop the NPCs' workplace behaviour trees: an NPC that has arrived at work (schedule
 * activity "work", not walking) runs its work area's behaviour named by its Work link
 * (Work['tailor'] → "tailor"); when the activity changes, the tree stops.
 */
export function updateAi(npcs: WorldNpc[], world: NpcWorld, minute: number): void {
  const ai = world.ai;
  if (!ai) return;
  const inView = new Set(npcs.map((n) => n.entity.id));
  for (const id of ai.ids()) if (!inView.has(id)) ai.stop(id);
  for (const n of npcs) {
    const p = world.scheduled(n.entity, n.schedule, minute);
    const atWork = p.where === "work" && p.pose === "stand";
    if (!atWork) { ai.stop(n.entity.id); continue; }
    if (ai.has(n.entity.id)) continue;
    const link = [...n.entity.links].find(([k]) => k.split(",").some((x) => x.startsWith("Work")));
    if (!link) continue;
    const behaviour = /Work\['?([^'\]]+)'?\]/.exec(link[0])?.[1];
    if (behaviour) ai.start(n.entity, link[1], behaviour, p.pos, p.rot);
  }
}

/** Renderer items for a set of NPCs; fills each NPC's `items` with its item indices (offset by `base`). */
export function npcItems(npcs: WorldNpc[], base = 0): NpcRenderItem[] {
  const items: NpcRenderItem[] = [];
  for (const n of npcs) {
    n.items = [];
    for (const { model, part, transform } of n.character.parts) {
      n.items.push(base + items.length);
      items.push({ model, transform: transform ? multiply(n.world, transform) : n.world, layer: part.layer });
    }
  }
  return items;
}

/** Renderer operations animateNpcs needs (ModelRenderer's). */
export interface NpcRendererOps {
  setPalette(item: number, m: Float32Array): void;
  paletteSize(item: number): number;
  setItemTransform(item: number, m: Float32Array): void;
}

/**
 * Per frame: place each NPC at game time `minute` (they move while walking between
 * places), pick the clip for the pose, advance it by real `seconds`, upload transforms
 * and skinning palettes.
 */
export function animateNpcs(npcs: WorldNpc[], world: NpcWorld, minute: number, seconds: number, r: NpcRendererOps): void {
  for (const n of npcs) {
    const p = world.placeAt(n.entity, n.schedule, minute);
    const moved = p.pos.some((v, i) => v !== n.placement.pos[i]) || p.rot.some((v, i) => v !== n.placement.rot[i]);
    n.placement = p;
    if (moved) {
      n.world = poseMatrix(p.pos, p.rot);
      n.character.parts.forEach(({ transform }, k) => r.setItemTransform(n.items[k], transform ? multiply(n.world, transform) : n.world));
    }
    const st = p.pose === "act" ? world.ai?.state(n.entity.id) : undefined;
    let c = n.clips[p.pose] ?? n.clips.stand;
    let frame = c ? c.start + ((seconds * c.fps + n.phase) % Math.max(1, c.end - c.start)) : 0;
    if (st?.clip && world.ai) {
      // a behaviour-tree animation: from its start, looping or holding the last frame
      c = st.clip.clip;
      const f = (world.ai.now - st.since) * c.fps;
      frame = c.start + (st.clip.loop ? f % Math.max(1, c.end - c.start) : Math.min(f, c.end - c.start));
    }
    n.animator.evaluate(c, frame, p.pose === "walk");
    n.character.parts.forEach(({ model }, k) => {
      if (model.skeleton && r.paletteSize(n.items[k])) r.setPalette(n.items[k], n.animator.palette(model.skeleton));
    });
  }
}
