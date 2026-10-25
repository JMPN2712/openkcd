// Beds for Henry (Bed entities, 1,302 in Rataje): E sleeps in the bed he faces, within its
// Properties fUsabilityDistance of the bed's origin, as the game's bed script measures
// (Scripts/Entities/WH/Bed/bed.lua). Not while an NPC sleeps in it. Time passes to the next 7:00
// and he wakes beside the bed, at its helper class's wake-up spot (WakeUp, else Budicek2, the one
// 1.69 m aside, else Budicek1; Libs/SmartObjects.xml).
//
// In the game a press on a normal bed or bench sits and holding sleeps (other kinds sleep on a
// press), the hours are chosen in a dialogue, and a bed not his (Bed bPlayerSleepIsLegal 0) is
// trespassing. Sitting waits for Henry's sitting animations; the HUD says when a bed isn't his.

import { parseSmartObjectHelpers, type SoHelper } from "./btWorld.ts";
import type { EntityInfo } from "./levelEntities.ts";
import type { Vfs } from "./vfs.ts";

type Vec3 = [number, number, number];

export interface Bed {
  entity: EntityInfo;
  useDistance: number;
  /** sleeping here is legal for the player (Bed bPlayerSleepIsLegal) */
  legal: boolean;
}

/** When Henry wakes (minutes after midnight). */
export const WAKE_MINUTE = 7 * 60;

export class Beds {
  readonly beds = new Map<number, Bed>();
  private helpers: Promise<Map<string, SoHelper[]>>;
  private loadedHelpers: Map<string, SoHelper[]> | null = null;

  constructor(vfs: Vfs, entities: Iterable<EntityInfo>) {
    for (const e of entities) {
      if (e.cls !== "Bed" || !e.model) continue;
      const p = e.propsXml ?? "";
      const use = Number(/\bfUsabilityDistance="([^"]*)"/.exec(p)?.[1] ?? 1.75);
      this.beds.set(e.id, { entity: e, useDistance: Number.isFinite(use) && use > 0 ? use : 1.75, legal: /\bbPlayerSleepIsLegal="1"/.test(p) });
    }
    this.helpers = (async () => {
      const hit = vfs.lookup("libs/smartobjects.xml");
      const m = hit ? parseSmartObjectHelpers(new TextDecoder().decode(await vfs.read(hit))) : new Map<string, SoHelper[]>();
      this.loadedHelpers = m;
      return m;
    })().catch(() => new Map());
  }

  async ready(): Promise<void> {
    await this.helpers;
  }

  /** The bed Henry faces within its use distance (nearest the middle of the view, within 45°). */
  target(feet: Vec3, eye: Vec3, forward: Vec3): Bed | null {
    let best: Bed | null = null, bestCos = Math.cos((45 * Math.PI) / 180);
    for (const b of this.beds.values()) {
      const p = b.entity.pos;
      if (Math.abs(p[0] - feet[0]) > 3 || Math.abs(p[1] - feet[1]) > 3) continue;
      if (Math.hypot(p[0] - feet[0], p[1] - feet[1], p[2] - feet[2]) > b.useDistance) continue;
      const v = [p[0] - eye[0], p[1] - eye[1], p[2] + 0.3 - eye[2]], l = Math.hypot(v[0], v[1], v[2]) || 1;
      const cos = (v[0] * forward[0] + v[1] * forward[1] + v[2] * forward[2]) / l;
      if (cos > bestCos) { bestCos = cos; best = b; }
    }
    return best;
  }

  /**
   * Where Henry stands up after sleeping in `b`, and his yaw: the first of its helper class's
   * wake-up spots (WakeUp, Budicek2, Budicek1, Budicek3, Entry1, Entry2) with floor under it
   * (`floor`: walkable height near a point, or null), else the nearest floor around the bed, else
   * the first of them.
   */
  wakeSpot(b: Bed, floor?: (p: Vec3) => number | null): { pos: Vec3; yaw: number } {
    const e = b.entity, h = this.loadedHelpers?.get((e.soHelpers ?? "Bed").toLowerCase()) ?? [];
    const spots = ["WakeUp", "Budicek2", "Budicek1", "Budicek3", "Entry1", "Entry2"].map((n) => h.find((x) => x.name === n)).filter((x): x is SoHelper => !!x);
    const place = (s: SoHelper | undefined) => this.place(e, s);
    for (const s of spots) {
      const at = place(s), z = floor?.(at.pos);
      if (z !== null && z !== undefined) return { pos: [at.pos[0], at.pos[1], z], yaw: at.yaw };
    }
    // none over a floor (a bed against a wall): the nearest floor around the bed, facing it
    if (floor) for (const r of [0.9, 1.2, 1.5, 2]) for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI, p: Vec3 = [e.pos[0] + Math.cos(a) * r, e.pos[1] + Math.sin(a) * r, e.pos[2]];
      const z = floor(p);
      if (z !== null) return { pos: [p[0], p[1], z], yaw: a + Math.PI };
    }
    return place(spots[0]);
  }

  /** A helper of bed entity `e` in the world, with the yaw it faces (−1 m on Y without one). */
  private place(e: EntityInfo, spot: SoHelper | undefined): { pos: Vec3; yaw: number } {
    const [w, x, y, z] = e.rot;
    const rot = (v: number[]) => {
      // rotate v by the bed's rotation
      const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
      return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
    };
    const off = rot(spot?.pos ?? [0, -1, 0]);
    // the helper faces +Y turned by its rotation; Henry's yaw is measured from +X
    const hr = spot?.rot ?? [1, 0, 0, 0];
    const f = rot([2 * (hr[1] * hr[2] - hr[0] * hr[3]), 1 - 2 * (hr[1] * hr[1] + hr[3] * hr[3]), 0]);
    return { pos: [e.pos[0] + off[0], e.pos[1] + off[1], e.pos[2] + off[2]], yaw: Math.atan2(f[1], f[0]) };
  }
}

/** Minutes to sleep from `minute` until the next WAKE_MINUTE (a full day at most). */
export function sleepMinutes(minute: number): number {
  const d = (WAKE_MINUTE - minute + 1440) % 1440;
  return d === 0 ? 1440 : d;
}
