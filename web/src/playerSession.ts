// Walking as Henry: keyboard and mouse input → character controller → avatar animation →
// camera. The world view (levelView.ts) owns rendering; this owns the player.
//
// Controls: WASD move · mouse look · Shift sprint · X / Caps Lock walk ↔ run · Space jump.

import { PlayerController, type MoveInput, type Surroundings, type Vec3 } from "./player.ts";
import { PlayerAvatar } from "./playerAvatar.ts";
import { LocomotionPlayer } from "./locomotion.ts";
import type { FlyCamera } from "./terrainRenderer.ts";

const DEG = Math.PI / 180;
/** Pitch limits (PlayerRotation in the player scripts): look down 70°, up 80°; −35° to +45° while sprinting. */
export const PITCH = { min: -70 * DEG, max: 80 * DEG, sprintMin: -35 * DEG, sprintMax: 45 * DEG };

/** Parts not drawn in first person: the game hides the head and its attachments (player.lua). */
const FIRST_PERSON_HIDDEN = new Set(["head", "hair", "beard"]);

export type ViewMode = "first" | "third";

/** Share of the look pitch the head turns about the neck (first person), looking down / up. */
const NOD_DOWN = 0.8, NOD_UP = 0.4;

export class PlayerSession {
  readonly controller: PlayerController;
  readonly avatar: PlayerAvatar;
  readonly loco: LocomotionPlayer;
  /** smoothed body yaw rate (rad/s) for the turn blend spaces */
  private turnRate = 0;
  private lastYaw: number;
  private lastPos: Vec3;
  /** look direction (the body turns with the view's yaw) */
  pitch = 0;
  walk = false;
  private view: ViewMode = "third";
  /** third-person camera distance (mouse wheel), and the arm length after collision (eased) */
  thirdDistance = 3.2;
  private arm = 3.2;
  private world: Surroundings;

  constructor(world: Surroundings, avatar: PlayerAvatar, spawn: Vec3, yaw: number) {
    this.world = world;
    this.controller = new PlayerController(world, spawn, yaw);
    this.avatar = avatar;
    this.loco = new LocomotionPlayer(avatar.locomotion, avatar.animator);
    this.lastYaw = yaw;
    this.lastPos = [...this.controller.pos];
    this.setView("first");
  }

  get viewMode(): ViewMode {
    return this.view;
  }

  /** First person draws Henry's body without his head; third person draws all of him. */
  setView(view: ViewMode): void {
    this.view = view;
    this.avatar.hidden.clear();
    if (view === "first") this.avatar.character.parts.forEach((p, k) => { if (FIRST_PERSON_HIDDEN.has(p.part.kind)) this.avatar.hidden.add(k); });
  }

  get yaw(): number {
    return this.controller.yaw;
  }

  /** Mouse movement in radians. */
  look(dYaw: number, dPitch: number): void {
    this.controller.yaw += dYaw;
    this.pitch = this.clampPitch(this.pitch + dPitch);
  }

  private clampPitch(p: number): number {
    const sprint = this.controller.gait === "sprint" && this.controller.speed() > 0.5;
    return Math.max(sprint ? PITCH.sprintMin : PITCH.min, Math.min(sprint ? PITCH.sprintMax : PITCH.max, p));
  }

  /** Input from held keys (KeyboardEvent.code). */
  input(keys: Set<string>): MoveInput {
    const f = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    const r = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
    return { forward: f, right: r, gait: this.walk ? "walk" : "run", sprint: keys.has("ShiftLeft") || keys.has("ShiftRight"), jump: keys.has("Space") };
  }

  update(dt: number, input: MoveInput): void {
    this.controller.update(dt, input);
    const c = this.controller;
    this.avatar.place([c.pos[0], c.pos[1], c.viewZ], c.yaw);
    // body yaw rate, smoothed over ~0.15 s (mouse input arrives in bursts)
    const dyaw = Math.atan2(Math.sin(c.yaw - this.lastYaw), Math.cos(c.yaw - this.lastYaw));
    this.lastYaw = c.yaw;
    if (dt > 0) this.turnRate += (dyaw / dt - this.turnRate) * Math.min(1, dt / 0.15);
    const moved = Math.hypot(c.pos[0] - this.lastPos[0], c.pos[1] - this.lastPos[1]);
    this.lastPos = [...c.pos];
    const [lx, ly] = c.localVelocity();
    const travel = Math.hypot(lx, ly) > 0.1 ? Math.atan2(-lx, ly) : Math.atan2(-input.right, input.forward || (input.right ? 0 : 1));
    this.loco.update(dt, { speed: c.speed(), travelAngle: travel, turnSpeed: this.turnRate, wantSpeed: c.wantSpeed, gait: c.gait, moved });
    this.avatar.animator.evaluateLayers(this.loco.layers(), true);
    // sprinting narrows the pitch range: ease into it rather than snapping the view
    const want = this.clampPitch(this.pitch);
    this.pitch += (want - this.pitch) * Math.min(1, dt * 8);
  }

  /** The view for the current mode. */
  camera(dt = 0): FlyCamera {
    return this.view === "first" ? this.firstPerson() : this.thirdPerson(dt);
  }

  /**
   * Henry's eyes: the skeleton's camera bone (it follows the head through the animation),
   * pivoted about the neck by the look pitch. APPROXIMATION of the game's look IK (male.chrparams
   * bends Neck, Neck1, Head and Look towards the look target): nodding carries the eye forward
   * over the collar, so looking down shows the chest and feet rather than the inside of a hood.
   */
  firstPerson(): FlyCamera {
    const c = this.controller;
    const eye = this.avatar.bonePos("camera");
    const neck = this.avatar.bonePos("Neck");
    if (!eye || !neck) return { pos: [c.pos[0], c.pos[1], c.viewZ + 1.625], yaw: c.yaw, pitch: this.pitch };
    const fx = Math.cos(c.yaw), fy = Math.sin(c.yaw);
    const dx = eye[0] - neck[0], dy = eye[1] - neck[1], up = eye[2] - neck[2];
    const fwd = dx * fx + dy * fy, side = -dx * fy + dy * fx;
    // the head takes most of a downward look and less of an upward one (the neck bends back less)
    const a = -this.pitch * (this.pitch < 0 ? NOD_DOWN : NOD_UP);
    const f2 = fwd * Math.cos(a) + up * Math.sin(a), u2 = -fwd * Math.sin(a) + up * Math.cos(a);
    return { pos: [neck[0] + f2 * fx - side * fy, neck[1] + f2 * fy + side * fx, neck[2] + u2], yaw: c.yaw, pitch: this.pitch };
  }

  /** Mouse wheel in third person: closer or further (1–8 m). */
  zoom(steps: number): void {
    this.thirdDistance = Math.max(1, Math.min(8, this.thirdDistance * Math.pow(1.15, steps)));
  }

  /**
   * Chase camera behind and above Henry, looking where he looks. The arm from his head is cast
   * against the world: walls and the ground pull the camera in at once, and it eases back out.
   */
  thirdPerson(dt = 0): FlyCamera {
    const c = this.controller;
    const pitch = this.pitch;
    const pivot: Vec3 = [c.pos[0], c.pos[1], c.viewZ + 1.7];
    const cp = Math.cos(pitch);
    const dir: Vec3 = [-Math.cos(c.yaw) * cp, -Math.sin(c.yaw) * cp, -Math.sin(pitch)];
    const want = this.thirdDistance;
    const far: Vec3 = [pivot[0] + dir[0] * (want + 0.3), pivot[1] + dir[1] * (want + 0.3), pivot[2] + dir[2] * (want + 0.3)];
    const hit = this.world.raycast?.(pivot, far) ?? null;
    // keep 0.3 m off whatever the arm hits
    const free = hit === null ? want : Math.max(0.4, hit * (want + 0.3) - 0.3);
    this.arm = free < this.arm || dt <= 0 ? free : this.arm + (free - this.arm) * Math.min(1, dt * 4);
    const d = this.arm;
    return { pos: [pivot[0] + dir[0] * d, pivot[1] + dir[1] * d, pivot[2] + dir[2] * d], yaw: c.yaw, pitch };
  }
}
