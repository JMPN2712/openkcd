// NPCs in the world view: assembles the characters near a point from their
// souls (entity name = soul_name), places them where their daily schedule puts
// them at the given time (src/schedule.ts) and plays a relaxed idle, or the
// sleeping clip in bed, with a random phase.

import { CharacterDb, loadCharacter, poseMatrix, type LoadedCharacter } from "./character.ts";
import { parseSkeleton, type Skeleton } from "./skeleton.ts";
import { Dba } from "./dba.ts";
import { Animator } from "./pose.ts";
import type { Clip } from "./anim.ts";
import type { NpcEntity } from "./levelEntities.ts";
import type { Placement, Pose, Schedules } from "./schedule.ts";
import type { LoadedModel } from "./model.ts";
import type { Vfs } from "./vfs.ts";
import { multiply } from "./mat4.ts";

const CLIPS: Record<"male" | "female", [string, Record<Pose, string[]>]> = {
  male: ["animations/humans/male/male_general.dba", {
    stand: ["animations/humans/male/locomotion/relaxed_idle.caf", "animations/humans/male/behavior/_relaxed_idle_both.caf"],
    sleep: ["animations/humans/male/behavior/sleeping_bed_idle.caf"],
  }],
  female: ["animations/humans/female/female_general.dba", {
    stand: ["animations/humans/female/locomotion/relaxed_idle.caf"],
    sleep: ["animations/humans/female/behavior/sleeping_bed_idle.caf"],
  }],
};

export interface WorldNpc {
  entity: NpcEntity;
  placement: Placement;
  character: LoadedCharacter;
  /** entity world matrix (column-major) */
  world: Float32Array;
  animator: Animator;
  clip: Clip | null;
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
        const clips: Record<Pose, Clip | null> = { stand: null, sleep: null };
        const [dbPath, names] = CLIPS[female ? "female" : "male"];
        const dh = this.vfs.lookup(dbPath);
        if (dh) {
          const dba = new Dba(await this.vfs.read(dh));
          for (const pose of ["stand", "sleep"] as const) {
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

  /** The NPCs (with their placement at `minute`) within `radius` of a point, nearest first. Cheap: no loading. */
  async select(center: [number, number, number], radius: number, max: number, minute: number): Promise<{ e: NpcEntity; p: Placement }[]> {
    this.db ??= CharacterDb.load(this.vfs);
    const db = await this.db;
    const souls = new Map(db.souls.map((s) => [s.name, s]));
    return this.entities
      .flatMap((e) => {
        const soul = souls.get(e.name);
        if (!soul) return [];
        const p: Placement = this.schedules
          ? this.schedules.place(e, soul.schedule, minute, this.groundAt)
          : { activity: "", where: "spawn", pos: e.pos, rot: e.rot, pose: "stand" };
        const d = Math.hypot(p.pos[0] - center[0], p.pos[1] - center[1], p.pos[2] - center[2]);
        return d <= radius ? [{ e, p, d }] : [];
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, max);
  }

  /** Identifies a selection: changes when an NPC enters/leaves it or moves to another place. */
  static key(sel: { e: NpcEntity; p: Placement }[]): string {
    return sel.map(({ e, p }) => `${e.id}:${p.where}:${p.pose}`).sort().join(" ");
  }

  /** Assemble up to `max` NPCs within `radius` of a point at time `minute` (0–1439), nearest first. */
  async near(center: [number, number, number], radius: number, max: number, minute = 720, onStatus?: (s: string) => void): Promise<WorldNpc[]> {
    const db = await (this.db ??= CharacterDb.load(this.vfs));
    const souls = new Map(db.souls.map((s) => [s.name, s.id]));
    const candidates = await this.select(center, radius, max, minute);
    const out: WorldNpc[] = [];
    for (const [k, { e, p: placement }] of candidates.entries()) {
      let p = this.chars.get(e.id);
      if (!p) {
        onStatus?.(`Assembling NPC ${k + 1}/${candidates.length}: ${e.name}`);
        p = loadCharacter(this.vfs, db.soul(souls.get(e.name)!), { maxTextureDim: 256 }).catch(() => null);
        this.chars.set(e.id, p);
      }
      const character = await p;
      if (!character?.parts.length) continue;
      const rig = await this.rig(character.spec.skeleton, e.female);
      if (!rig) continue;
      out.push({
        entity: e,
        placement,
        character,
        world: poseMatrix(placement.pos, placement.rot),
        animator: new Animator(rig.skeleton),
        clip: rig.clips[placement.pose] ?? rig.clips.stand,
        phase: Math.random() * 1000,
        items: [],
      });
    }
    return out;
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

/** Advance each NPC's idle and upload skinning palettes. */
export function animateNpcs(
  npcs: WorldNpc[],
  seconds: number,
  setPalette: (item: number, m: Float32Array) => void,
  paletteSize: (item: number) => number,
): void {
  for (const n of npcs) {
    const c = n.clip;
    const frame = c ? c.start + ((seconds * c.fps + n.phase) % Math.max(1, c.end - c.start)) : 0;
    n.animator.evaluate(c, frame);
    n.character.parts.forEach(({ model }, k) => {
      if (model.skeleton && paletteSize(n.items[k])) setPalette(n.items[k], n.animator.palette(model.skeleton));
    });
  }
}
