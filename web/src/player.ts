// The player's character controller: a kinematic capsule that follows the ground, climbs slopes
// up to a limit, slides off steeper ones, falls under gravity and is pushed out of static
// geometry. Movement is code-driven (velocity from input at the locomotion clips' speeds);
// the animation follows it. Parameters come from the game's actor scripts
// (Scripts/Entities/actor/BasicActor.lua physicsParams.Living and gameParams.stance, read as
// CryEngine living-entity settings, docs/ANIMATION.md "Character controller").

export type Vec3 = [number, number, number];

/** What the controller collides with (terrain plus static objects, see collision.ts). */
export interface Surroundings {
  /**
   * Highest walkable surface under (x, y) between zTop and zBottom: its height and normal, or
   * null when there is none (open air, or a hole).
   */
  ground(x: number, y: number, zTop: number, zBottom: number): { z: number; normal: Vec3 } | null;
  /**
   * Push a vertical capsule (segment from a to b, radius r) out of solid geometry. Returns the
   * total correction and the most upward-facing contact normal (null without contact).
   */
  depenetrate?(a: Vec3, b: Vec3, r: number): { push: Vec3; normal: Vec3 | null };
  /** Fraction (0..1) of the segment from → to before it hits anything, null when clear (camera arms). */
  raycast?(from: Vec3, to: Vec3): number | null;
  /** The terrain height: nothing walks below it (holes aside, which Rataje's heightmap has none of). */
  floor?(x: number, y: number): number;
}

export const PLAYER = {
  /** capsule radius (stance normal size.x, 0.3; the player's own Properties say 0.35) */
  radius: 0.3,
  /** capsule centre above the feet (heightCollider) and the cylinder half-height (size.z) */
  heightCollider: 1.05,
  halfHeight: 0.4,
  /** m/s² (physicsParams.Living.gravity) */
  gravity: 13,
  /** speed changes towards the target at this rate (inertia, inertiaAccel) */
  inertia: 11,
  airControl: 0.1,
  /** degrees: no walking up steeper ground; sliding down from slideFrom */
  maxClimbDeg: 50,
  slideFromDeg: 49,
  maxGroundSpeed: 16,
  /** eye height in the stance (viewOffset z) */
  eyeHeight: 1.625,
} as const;

/**
 * Base speeds (m/s). The game's base speeds live in its code (an open question in
 * docs/ANIMATION.md); until a research note settles them, walk and run are the player
 * clips' own speeds (relaxed_walk_medium_player 1.40, relaxed_run_medium_player 3.57) and
 * sprint is run × the script's sprint multiplier.
 */
export const GAIT_SPEED = { walk: 1.4, run: 3.57 } as const;

/** Movement multipliers from Player_Params.xml / player.lua. */
export const MOVE_MULT = { sprint: 1.5, strafe: 0.75, backward: 0.7 } as const;

export type Gait = "walk" | "run" | "sprint";

export interface MoveInput {
  /** -1..1: forward / backward */
  forward: number;
  /** -1..1: right / left */
  right: number;
  /** walk or run (the walk toggle); sprint is a held key and only goes forwards */
  gait: "walk" | "run";
  sprint: boolean;
  jump?: boolean;
}

/**
 * Speed for a move direction: forward ×1, sideways ×strafe, backwards ×backward, interpolated by
 * the angle between the move and the facing; sprint only while moving mostly forwards.
 */
export function targetSpeed(input: MoveInput): { speed: number; gait: Gait } {
  const len = Math.min(1, Math.hypot(input.forward, input.right));
  if (len < 1e-3) return { speed: 0, gait: input.gait };
  const angle = Math.abs(Math.atan2(input.right, input.forward)); // 0 forward .. π backward
  const dirMult = angle <= Math.PI / 2
    ? 1 + (MOVE_MULT.strafe - 1) * (angle / (Math.PI / 2))
    : MOVE_MULT.strafe + (MOVE_MULT.backward - MOVE_MULT.strafe) * ((angle - Math.PI / 2) / (Math.PI / 2));
  const sprint = input.sprint && angle < Math.PI / 4;
  const base = GAIT_SPEED[input.gait] * (sprint ? (input.gait === "walk" ? GAIT_SPEED.run / GAIT_SPEED.walk : 1) * MOVE_MULT.sprint : 1);
  return { speed: base * dirMult * len, gait: sprint ? "sprint" : input.gait };
}

const STEP = 1 / 120;
/** Highest ledge stepped onto without a jump: the gap under the capsule (centre 1.05 − 0.4 − 0.3). */
const STEP_UP = PLAYER.heightCollider - PLAYER.halfHeight - PLAYER.radius;
const COS_CLIMB = Math.cos((PLAYER.maxClimbDeg * Math.PI) / 180);
const COS_SLIDE = Math.cos((PLAYER.slideFromDeg * Math.PI) / 180);
/** Jump take-off speed for a 1 m jump (Player_Params jump height) at this gravity. */
const JUMP_SPEED = Math.sqrt(2 * PLAYER.gravity * 1.0);

export class PlayerController {
  /** feet position */
  pos: Vec3;
  vel: Vec3 = [0, 0, 0];
  /** facing, radians about Z (0 = +X, the fly camera's convention) */
  yaw: number;
  grounded = false;
  groundNormal: Vec3 = [0, 0, 1];
  /** current gait and the speed the input asks for (the animation follows these) */
  gait: Gait = "run";
  wantSpeed = 0;
  /** smoothed feet height for the camera (steps and snaps would jolt the view) */
  viewZ: number;
  private acc = 0;
  private world: Surroundings;

  constructor(world: Surroundings, pos: Vec3, yaw = 0) {
    this.world = world;
    // spawn on the highest surface at (x, y) below `pos` (or anywhere, for z = 0)
    const g = world.ground(pos[0], pos[1], pos[2] || 1e5, -1e5);
    this.pos = [pos[0], pos[1], g ? g.z : pos[2]];
    this.viewZ = this.pos[2];
    this.yaw = yaw;
  }

  /** Horizontal speed (m/s). */
  speed(): number {
    return Math.hypot(this.vel[0], this.vel[1]);
  }

  /** Movement relative to the facing: x right, y forward (m/s). */
  localVelocity(): [number, number] {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return [this.vel[0] * s - this.vel[1] * c, this.vel[0] * c + this.vel[1] * s];
  }

  /** Advance by dt seconds (fixed 120 Hz substeps). */
  update(dt: number, input: MoveInput): void {
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= STEP) {
      this.step(STEP, input);
      this.acc -= STEP;
    }
    // the view follows the feet, easing over step-ups and snaps but never lagging a fall
    const k = 1 - Math.exp(-dt * 18);
    this.viewZ = this.pos[2] < this.viewZ ? this.pos[2] : this.viewZ + (this.pos[2] - this.viewZ) * k;
    if (Math.abs(this.pos[2] - this.viewZ) > 1) this.viewZ = this.pos[2];
  }

  private step(dt: number, input: MoveInput): void {
    const { speed, gait } = targetSpeed(input);
    this.gait = gait;
    this.wantSpeed = speed;
    // desired horizontal velocity in world space
    const len = Math.hypot(input.forward, input.right) || 1;
    const fx = Math.cos(this.yaw), fy = Math.sin(this.yaw);
    let tx = ((fx * input.forward + fy * input.right) / len) * speed;
    let ty = ((fy * input.forward - fx * input.right) / len) * speed;
    const n = this.groundNormal;
    if (this.grounded && n[2] < COS_CLIMB) {
      // too steep to climb: drop the uphill part of the move
      const hl = Math.hypot(n[0], n[1]) || 1;
      const dx = -n[0] / hl, dy = -n[1] / hl; // uphill
      const up = tx * dx + ty * dy;
      if (up > 0) { tx -= dx * up; ty -= dy * up; }
    }
    const rate = Math.min(1, PLAYER.inertia * (this.grounded ? 1 : PLAYER.airControl) * dt);
    this.vel[0] += (tx - this.vel[0]) * rate;
    this.vel[1] += (ty - this.vel[1]) * rate;
    if (this.grounded && n[2] < COS_SLIDE) {
      // sliding: gravity along the slope
      const g = PLAYER.gravity;
      this.vel[0] += n[0] * n[2] * g * dt;
      this.vel[1] += n[1] * n[2] * g * dt;
    }
    const hs = Math.hypot(this.vel[0], this.vel[1]);
    if (hs > PLAYER.maxGroundSpeed) { this.vel[0] *= PLAYER.maxGroundSpeed / hs; this.vel[1] *= PLAYER.maxGroundSpeed / hs; }

    if (this.grounded && input.jump && n[2] >= COS_CLIMB) {
      this.vel[2] = JUMP_SPEED;
      this.grounded = false;
    }
    if (!this.grounded) this.vel[2] -= PLAYER.gravity * dt;

    const p = this.pos;
    const prevZ = p[2];
    p[0] += this.vel[0] * dt;
    p[1] += this.vel[1] * dt;
    p[2] += this.vel[2] * dt;
    this.resolve();

    // ground: snap down while walking (over the drop the climb limit allows for this step), up
    // onto anything below the capsule's lower end
    const stepDown = this.grounded ? Math.max(0.05, hs * dt * 1.2 + 0.02) : 0;
    const g = this.world.ground(p[0], p[1], p[2] + STEP_UP, p[2] - Math.max(stepDown, -Math.min(0, this.vel[2] * dt)) - 1e-3);
    if (g && (this.grounded || this.vel[2] <= 0) && g.z >= p[2] - stepDown - Math.max(0, prevZ - p[2])) {
      p[2] = g.z;
      this.groundNormal = g.normal;
      if (this.vel[2] < 0 || !this.grounded) this.vel[2] = 0;
      this.grounded = true;
    } else {
      if (this.grounded) this.vel[2] = Math.min(this.vel[2], 0);
      this.grounded = false;
      this.groundNormal = [0, 0, 1];
    }
    const floor = this.world.floor?.(p[0], p[1]);
    if (floor !== undefined && p[2] < floor - 0.05) {
      p[2] = floor;
      if (this.vel[2] < 0) this.vel[2] = 0;
    }
    // a step up or a snap can lift the capsule into an overhang (eaves, beams): push out again
    if (Math.abs(p[2] - prevZ) > 1e-4) this.resolve();
  }

  /** Capsule end points (sphere centres) for feet position `p`. */
  capsule(p: Vec3 = this.pos): [Vec3, Vec3] {
    const c = p[2] + PLAYER.heightCollider;
    return [[p[0], p[1], c - PLAYER.halfHeight], [p[0], p[1], c + PLAYER.halfHeight]];
  }

  /** Push the capsule out of static geometry; contacts facing up count as floor, not wall. */
  private resolve(): void {
    if (!this.world.depenetrate) return;
    for (let it = 0; it < 4; it++) {
      const [a, b] = this.capsule();
      const { push, normal } = this.world.depenetrate(a, b, PLAYER.radius);
      if (!normal) return;
      // walls push sideways only (the ground probe owns the height); ceilings stop a jump
      this.pos[0] += push[0];
      this.pos[1] += push[1];
      if (push[2] < 0 && this.vel[2] > 0) { this.pos[2] += push[2]; this.vel[2] = 0; }
      const pl = Math.hypot(push[0], push[1]);
      if (pl > 1e-6) {
        // remove the velocity going into the wall
        const nx = push[0] / pl, ny = push[1] / pl;
        const into = this.vel[0] * nx + this.vel[1] * ny;
        if (into < 0) { this.vel[0] -= nx * into; this.vel[1] -= ny * into; }
      }
    }
  }
}

/** Terrain-only surroundings: the heightmap (and its normal) under a point. */
export function terrainSurroundings(heightAt: (x: number, y: number) => number): Surroundings {
  return {
    floor: heightAt,
    ground(x, y, zTop, zBottom) {
      const z = heightAt(x, y);
      if (z > zTop || z < zBottom) return null;
      const e = 0.5;
      const nx = heightAt(x - e, y) - heightAt(x + e, y), ny = heightAt(x, y - e) - heightAt(x, y + e);
      const l = Math.hypot(nx, ny, 2 * e);
      return { z, normal: [nx / l, ny / l, (2 * e) / l] };
    },
  };
}
