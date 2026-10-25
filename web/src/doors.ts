// Doors (AnimDoor entities, 866 in Rataje): a door leaf is a .cdf whose skin hangs rigidly on its
// skeleton's pivot bone (objects/characters/assets/doors/anim_door_<left|right>.chr). Using a door
// plays an animation on that skeleton from Animations/assets/doors/doors.dba, named as the game's
// door script (Scripts/Entities/Doors/AnimDoor.lua) builds it for the player:
//
//   door_<r|l>_<f|b>_<o|c>_player
//
// r/l: the model's name contains "right"; f/b: the user stands in front ("IsAccessedFromFront":
// the door's +Y axis points away from them, e.g. inside the tailor's house) or behind; o/c:
// opening or closing. The clips swing the leaf 0° → 90° (open, 52–70 frames at 30 fps) and back. A door is usable within Properties fUseDistance (2.5 m)
// of its leaf's centre, and not while it moves; Lock bLocked doors don't open (keys and
// lockpicking come with the inventory).
//
// The world scene keeps each door instance's entity id (WorldModel.entities): a moving door
// rewrites its instances' matrices (entity × leaf) and its collision shape (the leaf's box).

import { parseCdf } from "./character.ts";
import { Dba } from "./dba.ts";
import type { Clip } from "./anim.ts";
import type { EntityInfo } from "./levelEntities.ts";
import { multiply } from "./mat4.ts";
import { Animator, invertRigid } from "./pose.ts";
import { parseSkeleton, type Skeleton } from "./skeleton.ts";
import type { Vfs } from "./vfs.ts";
import type { WorldScene } from "./world.ts";

type Vec3 = [number, number, number];

const DBA = "animations/assets/doors/doors.dba";

interface Side {
  skeleton: Skeleton;
  animator: Animator;
  pivot: number;
  /** inverse bind pose of the pivot bone */
  invBind: Float32Array;
  /** door_<s>_<f|b>_<o|c>_player clips by "f_o" etc. */
  clips: Map<string, Clip>;
}

export interface Door {
  entity: EntityInfo;
  right: boolean;
  locked: boolean;
  useDistance: number;
  open: boolean;
  /** the clip playing (null at rest) and its time in seconds */
  clip: Clip | null;
  time: number;
  /** the leaf's rigid transform in model space (identity when closed) */
  leaf: Float32Array;
}

/** A door's instances in the current scene: global index (sceneMatrices order), its model and instance. */
interface Placed {
  index: number;
  matrices: Float32Array;
  i: number;
  base: Float32Array;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class Doors {
  private vfs: Vfs;
  readonly doors = new Map<number, Door>();
  private sides = new Map<string, Side | null>();
  private loading: Promise<void>[] = [];
  private dba: Promise<Dba | null> | null = null;
  private placed = new Map<number, Placed[]>();
  /** each door's leaf box in its model space (lo xyz, hi xyz), from the scene's skin */
  private boxes = new Map<number, Float32Array>();
  private moving = new Set<number>();

  constructor(vfs: Vfs, entities: EntityInfo[]) {
    this.vfs = vfs;
    for (const e of entities) {
      if (e.cls !== "AnimDoor" || !e.model) continue;
      const p = e.propsXml ?? "";
      const lock = /<Lock\b[^>]*\bbLocked="1"/.test(p);
      const use = Number(/\bfUseDistance="([^"]*)"/.exec(p)?.[1] ?? 2.5);
      this.doors.set(e.id, { entity: e, right: /right/i.test(e.model), locked: lock, useDistance: Number.isFinite(use) ? use : 2.5, open: false, clip: null, time: 0, leaf: IDENTITY });
    }
  }

  /** The skeleton and clips for a door model (one per .chr, shared). */
  private side(door: Door): Side | null {
    const model = door.entity.model!.toLowerCase();
    const key = door.right ? "r" : "l";
    if (this.sides.has(key)) return this.sides.get(key)!;
    this.sides.set(key, null);
    const load = (async () => {
      const cdf = this.vfs.lookup(model);
      if (!cdf) return;
      const spec = parseCdf(new TextDecoder().decode(await this.vfs.read(cdf)), model);
      const sk = this.vfs.lookup(spec.skeleton);
      const skeleton = sk ? parseSkeleton(await this.vfs.read(sk)) : null;
      this.dba ??= (async () => { const h = this.vfs.lookup(DBA); return h ? new Dba(await this.vfs.read(h)) : null; })().catch(() => null);
      const dba = await this.dba;
      if (!skeleton || !dba) return;
      const pivot = skeleton.bones.findIndex((b) => /pivot/i.test(b.name));
      if (pivot < 0) return;
      const clips = new Map<string, Clip>();
      const dir = door.right ? "right" : "left";
      for (const fb of ["f", "b"]) for (const oc of ["o", "c"]) {
        const name = `animations/assets/doors/${dir}/door_${key}_${fb}_${oc}_player.caf`;
        if (dba.anims.some((a) => a.name === name)) clips.set(`${fb}_${oc}`, dba.clip(name));
      }
      this.sides.set(key, { skeleton, animator: new Animator(skeleton), pivot, invBind: invertRigid(skeleton.bones[pivot].bindPose), clips });
    })().catch(() => {});
    this.loading.push(load);
    return null;
  }

  /** Wait for the skeletons and clips preload() started. */
  async ready(): Promise<void> {
    await Promise.all(this.loading);
  }

  /** Put a door open or shut at once (the end of its front clip), e.g. for tests and renders. */
  set(d: Door, open: boolean): boolean {
    const side = this.sides.get(d.right ? "r" : "l");
    const clip = side?.clips.get("f_o");
    if (!side || !clip) return false;
    d.clip = null;
    d.open = open;
    d.leaf = open ? multiply(side.animator.evaluate(clip, clip.end)[side.pivot], side.invBind) : IDENTITY;
    return true;
  }

  /** Start loading both door skeletons and the clips. */
  preload(): void {
    for (const right of [true, false]) {
      const d = [...this.doors.values()].find((x) => x.right === right);
      if (d) this.side(d);
    }
  }

  /** The leaf's centre in the world (its box under its current transform). */
  private centre(d: Door): Vec3 {
    const b = this.boxes.get(d.entity.id);
    const local: Vec3 = b ? [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2] : [0, 0, 1];
    const p = this.placed.get(d.entity.id)?.[0];
    const m = p ? multiply(p.base, d.leaf) : null;
    if (!m) return [d.entity.pos[0], d.entity.pos[1], d.entity.pos[2] + 1];
    return [m[0] * local[0] + m[4] * local[1] + m[8] * local[2] + m[12], m[1] * local[0] + m[5] * local[1] + m[9] * local[2] + m[13], m[2] * local[0] + m[6] * local[1] + m[10] * local[2] + m[14]];
  }

  /**
   * The door Henry would use: within its use distance of his feet (as the door script measures),
   * and the one nearest the middle of the view within 50°. Null when none.
   */
  target(feet: Vec3, eye: Vec3, forward: Vec3): Door | null {
    let best: Door | null = null, bestCos = Math.cos((50 * Math.PI) / 180);
    for (const id of this.placed.keys()) {
      const d = this.doors.get(id);
      if (!d) continue;
      const c = this.centre(d);
      if (Math.hypot(c[0] - feet[0], c[1] - feet[1], c[2] - feet[2]) > d.useDistance) continue;
      const v = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]], l = Math.hypot(v[0], v[1], v[2]) || 1;
      const cos = (v[0] * forward[0] + v[1] * forward[1] + v[2] * forward[2]) / l;
      if (cos > bestCos) { bestCos = cos; best = d; }
    }
    return best;
  }

  /** Whether a door can be used now (not moving, not locked shut), and what using it does. */
  action(d: Door): "open" | "close" | "locked" | "busy" {
    if (d.clip) return "busy";
    if (d.open) return "close";
    return d.locked ? "locked" : "open";
  }

  /** Use a door from `user`'s position: open or close it with the clip for that side. */
  use(d: Door, user: Vec3): boolean {
    const act = this.action(d);
    if (act !== "open" && act !== "close") return false;
    const side = this.side(d);
    if (!side) return false;
    // in front: the door's +Y axis (its forward direction) points away from the user
    const [w, x, y, z] = d.entity.rot;
    const fwd = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z)];
    const front = (d.entity.pos[0] - user[0]) * fwd[0] + (d.entity.pos[1] - user[1]) * fwd[1] >= 0;
    const clip = side.clips.get(`${front ? "f" : "b"}_${act === "open" ? "o" : "c"}`);
    if (!clip) return false;
    d.clip = clip;
    d.time = 0;
    d.open = act === "open";
    this.moving.add(d.entity.id);
    return true;
  }

  /** Whether a door is swinging now. */
  isMoving(id: number): boolean {
    return this.moving.has(id);
  }

  /**
   * Where `user` should stand while door `d` opens towards them: out of the leaf's sweep, along the
   * line from the hinge (the entity origin), 0.4 m beyond the leaf's length; null when the door
   * doesn't swing their way or they are clear. In the game Henry's own animation steps him back
   * (the DoorLeft/DoorRight "Front" helper, 0.7 m out from the leaf's middle, is inside the sweep);
   * until he has it, the world view slides him there.
   */
  clearSpot(d: Door, user: Vec3): Vec3 | null {
    const box = this.boxes.get(d.entity.id);
    if (!box || !d.clip || !d.open) return null;
    const [w, x, y, z] = d.entity.rot;
    const fwd = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z)];
    const h = d.entity.pos, dx = user[0] - h[0], dy = user[1] - h[1];
    // opening from the front: the leaf swings into the user's (−Y) half
    if (dx * fwd[0] + dy * fwd[1] > 0) return null;
    const reach = Math.max(Math.abs(box[0]), Math.abs(box[3])) + 0.4, dist = Math.hypot(dx, dy);
    if (dist >= reach) return null;
    const ux = dist > 1e-3 ? dx / dist : -fwd[0], uy = dist > 1e-3 ? dy / dist : -fwd[1];
    return [h[0] + ux * reach, h[1] + uy * reach, user[2]];
  }

  /** Advance the moving doors by `dt` seconds; returns the ids whose leaf moved. */
  step(dt: number): number[] {
    const out: number[] = [];
    for (const id of this.moving) {
      const d = this.doors.get(id)!;
      const side = this.sides.get(d.right ? "r" : "l");
      if (!d.clip || !side) { this.moving.delete(id); continue; }
      d.time += dt;
      const c = d.clip, length = (c.end - c.start) / c.fps;
      const frame = c.start + Math.min(d.time, length) * c.fps;
      const w = side.animator.evaluate(c, frame);
      d.leaf = multiply(w[side.pivot], side.invBind);
      if (d.time >= length) {
        d.clip = null;
        // closed: back to the bind pose exactly
        if (!d.open) d.leaf = IDENTITY;
        this.moving.delete(id);
      }
      out.push(id);
    }
    return out;
  }

  /**
   * Find the doors' instances in a new scene (keep the global indices of sceneMatrices order) and
   * their leaf boxes; doors already open get their open matrices back.
   */
  attach(scene: WorldScene): number[] {
    this.placed.clear();
    let index = 0;
    for (const wm of scene.models) {
      if (wm.entities) for (let i = 0; i < wm.count; i++) {
        const id = wm.entities[i];
        if (id < 0 || !this.doors.has(id)) continue;
        const list = this.placed.get(id) ?? [];
        list.push({ index: index + i, matrices: wm.matrices, i, base: wm.matrices.slice(i * 16, i * 16 + 16) });
        this.placed.set(id, list);
        if (!this.boxes.has(id)) {
          const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
          for (const mesh of wm.lods[0].cgf.meshes) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], mesh.bboxMin[k]); hi[k] = Math.max(hi[k], mesh.bboxMax[k]); }
          if (lo[0] <= hi[0]) this.boxes.set(id, new Float32Array([...lo, ...hi]));
        }
      }
      index += wm.count;
    }
    return [...this.placed.keys()].filter((id) => this.doors.get(id)!.leaf !== IDENTITY);
  }

  /** A door's instances with their current matrices (entity × leaf), for the renderer. */
  *matrices(id: number): Generator<{ index: number; m: Float32Array }> {
    const d = this.doors.get(id);
    for (const p of this.placed.get(id) ?? []) {
      const m = d ? multiply(p.base, d.leaf) : p.base;
      p.matrices.set(m, p.i * 16);
      yield { index: p.index, m };
    }
  }

  /** The leaf's box as world triangles (12), for the collision world; null without a box. */
  collider(id: number): Float32Array | null {
    const b = this.boxes.get(id), p = this.placed.get(id)?.[0], d = this.doors.get(id);
    if (!b || !p || !d) return null;
    const m = multiply(p.base, d.leaf);
    const corner = (i: number): Vec3 => {
      const x = b[i & 1 ? 3 : 0], y = b[i & 2 ? 4 : 1], z = b[i & 4 ? 5 : 2];
      return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    };
    const v = Array.from({ length: 8 }, (_, i) => corner(i));
    // the six faces as two triangles each (corner bits: x 1, y 2, z 4)
    const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    const out = new Float32Array(faces.length * 18);
    faces.forEach(([a, b2, c, e], f) => {
      for (const [k, i] of [a, b2, c, a, c, e].entries()) out.set(v[i], f * 18 + k * 3);
    });
    return out;
  }

  /** Ids of the doors in the scene within `r` metres of a point. */
  near(p: Vec3, r: number): number[] {
    const out: number[] = [];
    for (const id of this.placed.keys()) {
      const e = this.doors.get(id)!.entity;
      if (Math.abs(e.pos[0] - p[0]) < r && Math.abs(e.pos[1] - p[1]) < r && Math.abs(e.pos[2] - p[2]) < r) out.push(id);
    }
    return out;
  }
}
