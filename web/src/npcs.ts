// NPCs in the world view: assembles the characters near a point from their
// souls (entity name = soul_name), places them at their entity transform and
// plays a relaxed idle with a random phase. Behaviour (schedules) comes later.

import { CharacterDb, loadCharacter, poseMatrix, type LoadedCharacter } from "./character.ts";
import { parseSkeleton, type Skeleton } from "./skeleton.ts";
import { Dba } from "./dba.ts";
import { Animator } from "./pose.ts";
import type { Clip } from "./anim.ts";
import type { NpcEntity } from "./levelEntities.ts";
import type { LoadedModel } from "./model.ts";
import type { Vfs } from "./vfs.ts";
import { multiply } from "./mat4.ts";

const IDLES: Record<"male" | "female", [string, string[]]> = {
  male: ["animations/humans/male/male_general.dba", ["animations/humans/male/locomotion/relaxed_idle.caf", "animations/humans/male/behavior/_relaxed_idle_both.caf"]],
  female: ["animations/humans/female/female_general.dba", ["animations/humans/female/locomotion/relaxed_idle.caf"]],
};

export interface WorldNpc {
  entity: NpcEntity;
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
  clip: Clip | null;
}

export class NpcWorld {
  private db: Promise<CharacterDb> | null = null;
  private rigs = new Map<string, Promise<Rig | null>>();
  private chars = new Map<number, Promise<LoadedCharacter | null>>();
  private vfs: Vfs;
  readonly entities: NpcEntity[];
  constructor(vfs: Vfs, entities: NpcEntity[]) {
    this.vfs = vfs;
    this.entities = entities;
  }

  private rig(skeletonPath: string, female: boolean): Promise<Rig | null> {
    const key = skeletonPath + (female ? "#f" : "#m");
    let r = this.rigs.get(key);
    if (!r) {
      r = (async () => {
        const hit = this.vfs.lookup(skeletonPath);
        const skeleton = hit ? parseSkeleton(await this.vfs.read(hit)) : null;
        if (!skeleton) return null;
        let clip: Clip | null = null;
        const [dbPath, names] = IDLES[female ? "female" : "male"];
        const dh = this.vfs.lookup(dbPath);
        if (dh) {
          const dba = new Dba(await this.vfs.read(dh));
          const name = names.find((n) => dba.anims.some((a) => a.name === n));
          if (name) clip = dba.clip(name);
        }
        return { skeleton, clip };
      })().catch(() => null);
      this.rigs.set(key, r);
    }
    return r;
  }

  /** Assemble up to `max` NPCs within `radius` of a point, nearest first. */
  async near(center: [number, number, number], radius: number, max: number, onStatus?: (s: string) => void): Promise<WorldNpc[]> {
    this.db ??= CharacterDb.load(this.vfs);
    const db = await this.db;
    const souls = new Map(db.souls.map((s) => [s.name, s.id]));
    const candidates = this.entities
      .map((e) => ({ e, d: Math.hypot(e.pos[0] - center[0], e.pos[1] - center[1], e.pos[2] - center[2]) }))
      .filter((c) => c.d <= radius && souls.has(c.e.name))
      .sort((a, b) => a.d - b.d)
      .slice(0, max);
    const out: WorldNpc[] = [];
    for (const [k, { e }] of candidates.entries()) {
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
        character,
        world: poseMatrix(e.pos, e.rot),
        animator: new Animator(rig.skeleton),
        clip: rig.clip,
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
