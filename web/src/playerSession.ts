// Walking as Henry: keyboard and mouse input → character controller → avatar animation →
// camera. The world view (levelView.ts) owns rendering; this owns the player.
//
// Controls: WASD move · mouse look · Shift sprint · X / Caps Lock walk ↔ run · Space jump.

import { PlayerController, type MoveInput, type Surroundings, type Vec3 } from "./player.ts";
import { PlayerAvatar, SimpleLocomotion } from "./playerAvatar.ts";
import type { FlyCamera } from "./terrainRenderer.ts";

/** Pitch limits (PlayerRotation in the player scripts), degrees: look down 70°, up 80°. */
export const PITCH_MIN = (-70 * Math.PI) / 180;
export const PITCH_MAX = (80 * Math.PI) / 180;

export class PlayerSession {
  readonly controller: PlayerController;
  readonly avatar: PlayerAvatar;
  private loco: SimpleLocomotion;
  /** look direction (the body turns with the view's yaw) */
  pitch = 0;
  walk = false;

  constructor(world: Surroundings, avatar: PlayerAvatar, spawn: Vec3, yaw: number) {
    this.controller = new PlayerController(world, spawn, yaw);
    this.avatar = avatar;
    this.loco = new SimpleLocomotion(avatar);
  }

  get yaw(): number {
    return this.controller.yaw;
  }

  /** Mouse movement in radians. */
  look(dYaw: number, dPitch: number): void {
    this.controller.yaw += dYaw;
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch + dPitch));
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
    this.loco.update(dt, c.speed(), c.gait);
  }

  /** Chase camera behind and above Henry, looking where he looks. */
  thirdPerson(distance = 3.2): FlyCamera {
    const c = this.controller;
    const pitch = this.pitch;
    const target: Vec3 = [c.pos[0], c.pos[1], c.viewZ + 1.6];
    const cp = Math.cos(pitch);
    return {
      pos: [target[0] - Math.cos(c.yaw) * cp * distance, target[1] - Math.sin(c.yaw) * cp * distance, target[2] - Math.sin(pitch) * distance + 0.3],
      yaw: c.yaw,
      pitch,
    };
  }
}
