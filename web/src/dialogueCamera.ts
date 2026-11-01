// The dialogue camera rig (Objects/characters/assets/dialog_cameras): a skeleton of camera bones
// attached at a character's feet (male.cdf puts it on Henry's Align), facing +Y like the
// character. Each shot is a camera bone and the bone it looks at (master, medium, close_shot,
// close_up, each with <name>_target); every one looks roughly towards the partner (within 40°),
// from beside or behind the character at head height. The clips are the patched ones
// (Data/patch/ipl_patch_010900.pak): the chest offset is 1.45 m.
//
// Its base pose is the 3D blendspace animations/assets/dialog_cameras/blendspace/
// 3d_ad_cameras_base.bspace: 45 one-pose clips named by where the partner stands,
// ad_cam_base_y<height cm>_z<distance cm>_x<angle °>, on a 5 × 3 × 3 grid of parameters (x −180…180°
// counter-clockwise from the character's facing, z 80/140/250 cm, y −45/0/45 cm higher). A partner
// between the grid's points blends its eight corners (trilinear, piecewise linear in each label);
// outside it is clamped to the edge. ShotPlanner below picks a shot per spoken line. The mood
// clips added on top (ad_cam_base_stand_calm_add, …) and the lens are left to a research note.

import { Dba } from "./dba.ts";
import { Animator, type BlendLayer } from "./pose.ts";
import { parseSkeleton } from "./skeleton.ts";
import type { Clip } from "./anim.ts";
import type { Vfs } from "./vfs.ts";

export const RIG_SKELETON = "objects/characters/assets/dialog_cameras/dialog_cameras.chr";
export const RIG_CLIPS = "animations/assets/dialog_cameras/dialog_cameras.dba";
export const RIG_BLENDSPACE = "animations/assets/dialog_cameras/blendspace/3d_ad_cameras_base.bspace";

export const SHOTS = ["master", "medium", "close_shot", "close_up"] as const;
export type Shot = (typeof SHOTS)[number];

type Vec3 = [number, number, number];

/** Where the partner stands, seen from the character the rig is on. */
export interface Partner {
  /** degrees counter-clockwise from the character's facing (−180…180) */
  angle: number;
  /** horizontal distance, cm */
  distance: number;
  /** height above the character's feet, cm */
  height: number;
}

export interface ShotPose {
  eye: Vec3;
  target: Vec3;
}

/** A blendspace example: its clip and its parameters (SetPara0…2). */
export interface BspaceExample {
  clip: string;
  params: number[];
}

/** Examples of a .bspace (<ExampleList><Example AName SetPara0 SetPara1 SetPara2/>). */
export function parseBspace(xml: string): BspaceExample[] {
  const out: BspaceExample[] = [];
  for (const m of xml.matchAll(/<Example\s([^>]*?)\/>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (!a.AName) continue;
    out.push({ clip: a.AName.toLowerCase(), params: [0, 1, 2].map((i) => Number(a[`SetPara${i}`] ?? 0)) });
  }
  return out;
}

/** The partner's position as the clip name gives it: y<height>_z<distance>_x<angle> (MINUS for −). */
function labelOf(clip: string): Partner | null {
  const m = /_y(minus)?(\d+)_z(\d+)_x(minus)?(\d+)$/.exec(clip);
  if (!m) return null;
  return { height: (m[1] ? -1 : 1) * Number(m[2]), distance: Number(m[3]), angle: (m[4] ? -1 : 1) * Number(m[5]) };
}

/** Index below `v` in a sorted axis and the fraction to the next (clamped to the ends). */
function cell(axis: number[], v: number): [number, number] {
  if (v <= axis[0]) return [0, 0];
  const n = axis.length - 1;
  if (v >= axis[n]) return [n - 1, 1];
  let i = 0;
  while (axis[i + 1] < v) i++;
  return [i, (v - axis[i]) / (axis[i + 1] - axis[i])];
}

export class DialogueCameraRig {
  private animator: Animator;
  private bones: Map<string, number>;
  /** grid axes (labels) and the clip at each point, by [height][distance][angle] */
  private axes: { height: number[]; distance: number[]; angle: number[] };
  private grid: Clip[][][];
  private layers: BlendLayer[] = [];

  private constructor(animator: Animator, bones: Map<string, number>, axes: DialogueCameraRig["axes"], grid: Clip[][][]) {
    this.animator = animator;
    this.bones = bones;
    this.axes = axes;
    this.grid = grid;
  }

  static async load(vfs: Vfs): Promise<DialogueCameraRig> {
    const read = async (p: string) => {
      const hit = vfs.lookup(p);
      if (!hit) throw new Error(`${p} not found`);
      return vfs.read(hit);
    };
    const skeleton = parseSkeleton(await read(RIG_SKELETON));
    if (!skeleton) throw new Error("dialogue camera skeleton unreadable");
    const dba = new Dba(await read(RIG_CLIPS));
    const examples = parseBspace(new TextDecoder().decode(await read(RIG_BLENDSPACE)));
    const labelled = examples.map((e) => ({ e, at: labelOf(e.clip) })).filter((x): x is { e: BspaceExample; at: Partner } => !!x.at);
    const axis = (k: keyof Partner) => [...new Set(labelled.map((x) => x.at[k]))].sort((a, b) => a - b);
    const axes = { height: axis("height"), distance: axis("distance"), angle: axis("angle") };
    const grid = axes.height.map((h) => axes.distance.map((d) => axes.angle.map((a) => {
      const x = labelled.find((l) => l.at.height === h && l.at.distance === d && l.at.angle === a);
      if (!x) throw new Error(`blendspace has no example at y${h} z${d} x${a}`);
      return dba.clip(`animations/assets/dialog_cameras/${x.e.clip}.caf`);
    })));
    return new DialogueCameraRig(new Animator(skeleton), skeleton.byName, axes, grid);
  }

  /** The grid's labels: angles (°), distances (cm), heights (cm). */
  get labels(): { angle: number[]; distance: number[]; height: number[] } {
    return this.axes;
  }

  /** Every shot's eye and target in rig space (metres, the character's feet at 0, facing +Y). */
  pose(p: Partner): Record<Shot, ShotPose> {
    const [hi, hf] = cell(this.axes.height, p.height);
    const [di, df] = cell(this.axes.distance, p.distance);
    const [ai, af] = cell(this.axes.angle, p.angle);
    const L = this.layers;
    L.length = 0;
    for (let k = 0; k < 8; k++) {
      const bh = k & 1, bd = (k >> 1) & 1, ba = (k >> 2) & 1;
      const w = (bh ? hf : 1 - hf) * (bd ? df : 1 - df) * (ba ? af : 1 - af);
      if (w <= 0) continue;
      const clip = this.grid[hi + bh][di + bd][ai + ba];
      L.push({ clip, frame: clip.start, weight: w });
    }
    const world = this.animator.evaluateLayers(L);
    const at = (name: string): Vec3 => {
      const m = world[this.bones.get(name)!];
      return [m[12], m[13], m[14]];
    };
    const out = {} as Record<Shot, ShotPose>;
    for (const s of SHOTS) out[s] = { eye: at(s), target: at(`${s}_target`) };
    return out;
  }

  /**
   * The shots in the world for a character at `feet` facing `yaw` (radians, 0 = +X) talking to
   * a partner whose feet are at `partner`.
   */
  place(feet: Vec3, yaw: number, partner: Vec3): Record<Shot, ShotPose> & { partner: Partner } {
    const dx = partner[0] - feet[0], dy = partner[1] - feet[1];
    let angle = ((Math.atan2(dy, dx) - yaw) * 180) / Math.PI;
    angle = ((((angle + 180) % 360) + 360) % 360) - 180;
    const rel: Partner = { angle, distance: Math.hypot(dx, dy) * 100, height: (partner[2] - feet[2]) * 100 };
    const local = this.pose(rel);
    // rig space faces +Y: turn it to the character's heading
    const a = yaw - Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
    const toWorld = (v: Vec3): Vec3 => [feet[0] + c * v[0] - s * v[1], feet[1] + s * v[0] + c * v[1], feet[2] + v[2]];
    const out = { partner: rel } as Record<Shot, ShotPose> & { partner: Partner };
    for (const k of SHOTS) out[k] = { eye: toWorld(local[k].eye), target: toWorld(local[k].target) };
    return out;
  }
}

/**
 * Camera types of the camera-cut command (v_dialogue_commands type 2, int_param) and of a response's
 * camera_mode. ASSUMPTION (a question for a research session): 1–4 are the rig's shots in the
 * order master, medium, close_shot, close_up; 5 is a camera placed in the level, named by
 * char_param (2,998 of the 3,001 type-5 cuts name one; quest scenes). The cut's `who` is the role
 * it frames.
 */
export const CAMERA_TYPES: Record<number, Shot> = { 1: "master", 2: "medium", 3: "close_shot", 4: "close_up" };

/** Whom the dialogue camera shows and how: the rig sits on the listener, looking at the speaker. */
export interface Framing {
  /** participant index of the one framed (the speaker) and of the one the rig is on */
  speaker: number;
  listener: number;
  shot: Shot;
  /** where the shot came from: "cut" (a camera command), "line" (its camera_mode) or "auto" */
  from: "cut" | "line" | "auto";
}

/**
 * Picks a shot for each spoken line of a conversation between two participants. The data's own
 * choices win: a camera-cut command before the line, else the line's camera_mode (non-zero on 32
 * of 84,632 lines). Every other line follows our rule (the game's default cutting isn't in the
 * data): each line frames its speaker over the listener's shoulder; the first line is a medium
 * shot, a change of speaker cuts to a close shot, and a speaker who goes on pushes in to a
 * close-up. The menu frames the NPC (medium) while the player chooses.
 */
export class ShotPlanner {
  framing: Framing | null = null;
  private pending: { shot: Shot; who: number | null } | null = null;
  private run = 0;

  /** A camera-cut command; `who` is the participant its role maps to (null: the next speaker). */
  cut(cameraType: number | undefined, who: number | null): void {
    const shot = cameraType !== undefined ? CAMERA_TYPES[cameraType] : undefined;
    if (shot) this.pending = { shot, who };
  }

  /** A line starts: `speaker` says it to `listener` (participant indices). */
  say(speaker: number, listener: number, cameraMode = 0): Framing {
    const prev = this.framing;
    const same = prev?.speaker === speaker && prev.from !== "cut";
    this.run = same ? this.run + 1 : 0;
    let f: Framing;
    if (this.pending) {
      const who = this.pending.who ?? speaker;
      f = { speaker: who, listener: who === speaker ? listener : speaker, shot: this.pending.shot, from: "cut" };
      this.pending = null;
    } else if (CAMERA_TYPES[cameraMode]) {
      f = { speaker, listener, shot: CAMERA_TYPES[cameraMode], from: "line" };
    } else {
      const shot: Shot = !prev ? "medium" : this.run === 0 ? "close_shot" : "close_up";
      f = { speaker, listener, shot, from: "auto" };
    }
    return (this.framing = f);
  }

  /** The player's menu is up: the NPC, over the player's shoulder. */
  menu(player: number, npc: number): Framing {
    this.run = 0;
    return (this.framing = { speaker: npc, listener: player, shot: "medium", from: "auto" });
  }

  reset(): void {
    this.framing = null;
    this.pending = null;
    this.run = 0;
  }
}

/** A character in a conversation: feet, facing (radians, 0 = +X). */
export interface Stand {
  feet: Vec3;
  yaw: number;
}

/**
 * The camera for a framing: the rig on the listener, aimed at the speaker. Returns the eye and the
 * point it looks at (world space).
 */
export function frame(rig: DialogueCameraRig, f: Framing, at: (participant: number) => Stand | undefined): ShotPose | null {
  const listener = at(f.listener), speaker = at(f.speaker);
  if (!listener || !speaker) return null;
  return rig.place(listener.feet, listener.yaw, speaker.feet)[f.shot];
}
