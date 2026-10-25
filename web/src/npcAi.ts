// Runs NPCs' workplace behaviour trees (btWorld.ts) and turns their actions
// into what the renderer needs: where the NPC is, which way it faces, and which
// clip plays. A move walks in a straight line at walking speed and ends facing
// the helper; an animation plays its Mannequin fragment's clip (mannequin.ts),
// holding the last frame of one-shot clips.

import type { AiWorld, Action } from "./btWorld.ts";
import type { Task } from "./btRuntime.ts";
import type { AnimLibrary, FragmentClip } from "./mannequin.ts";
import type { NpcEntity } from "./levelEntities.ts";
import type { NavMesh } from "./navmesh.ts";

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

const WALK_SPEED = 1.4;
const yawQuat = (a: number): Quat => [Math.cos(a / 2), 0, 0, Math.sin(a / 2)];

export interface AiState {
  pos: Vec3;
  rot: Quat;
  mode: "idle" | "walk" | "act";
  /** the fragment clip while acting (null until loaded) */
  clip: FragmentClip | null;
  fragment: string;
  /** AI clock time the current move/animation started */
  since: number;
  /** move: the route (corner points, cumulative distances), duration and end orientation */
  route?: { pts: Vec3[]; cum: number[] };
  duration?: number;
  endRot?: Quat;
}

interface Driven {
  task: Task;
  state: AiState;
  done: boolean;
  /** how the tree ended (when done) */
  status?: "success" | "failure";
  /** AI clock time by which a winding-down tree is stopped (windDown) */
  deadline?: number;
  /** AI clock time of the tree's next tick */
  due: number;
}

/**
 * Trees are ticked ten times a (game) second, not every frame, spread over the frames so they
 * don't all land on one: a tree decides what comes next, and 0.1 s later is not visible, while
 * walking still moves every frame. Every frame, the trees took 6.5 ms of a 16 ms frame on High
 * (60 NPCs), mostly polling smart-object searches and Lua conditions.
 */
const TICK = 0.1;

export class NpcAi {
  readonly world: AiWorld;
  private libs: Record<"male" | "female", AnimLibrary>;
  private driven = new Map<number, Driven>();
  private female = new Map<number, boolean>();
  /** AI clock (real seconds, scaled with the game-speed setting by the caller) */
  now = 0;
  /** level navmesh: moves longer than 1.5 m follow it (else straight lines) */
  nav: NavMesh | null = null;
  private pending = new Set<Promise<unknown>>();
  private started = 0;

  constructor(world: AiWorld, libs: Record<"male" | "female", AnimLibrary>) {
    this.world = world;
    this.libs = libs;
  }

  /** Called by AiWorld when a tree starts a move or an animation: returns its duration. */
  act(a: Action): number {
    const d = this.driven.get(a.npc);
    if (!d) return 1;
    const st = d.state;
    if (a.kind === "teleport" && typeof a.target !== "string") {
      Object.assign(st, { mode: "idle", pos: [...a.target], route: undefined, clip: null, fragment: "", since: this.now });
      return 0;
    }
    if (a.kind === "turn" && typeof a.target !== "string") {
      const yaw = Math.atan2(a.target[1] - st.pos[1], a.target[0] - st.pos[0]) - Math.PI / 2;
      if (Math.hypot(a.target[0] - st.pos[0], a.target[1] - st.pos[1]) > 0.05) st.rot = yawQuat(yaw);
      if (st.mode !== "act") st.mode = "idle";
      return 0.6;
    }
    if (a.kind === "move" && typeof a.target !== "string") {
      const to = a.target;
      const straight = Math.hypot(to[0] - st.pos[0], to[1] - st.pos[1]);
      // around counters, walls and furniture: the navmesh path, bridged to the exact ends
      const path = straight > 1.5 ? this.nav?.findPath(st.pos, to, 20000) : null;
      const pts: Vec3[] = path ? [[...st.pos] as Vec3, ...path, [...to] as Vec3] : [[...st.pos] as Vec3, [...to] as Vec3];
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const length = cum[cum.length - 1];
      Object.assign(st, { mode: "walk", route: { pts, cum }, since: this.now, duration: length / WALK_SPEED, endRot: a.rot, clip: null, fragment: "" });
      return length / WALK_SPEED;
    }
    const fragment = String(a.target);
    const lib = this.libs[this.female.get(a.npc) ? "female" : "male"];
    Object.assign(st, { mode: "act", fragment, since: this.now, clip: null });
    // loaded clips give the real length (loops: three cycles); else an estimate while it loads
    const ready = lib.ready.get(fragment.toLowerCase());
    if (ready !== undefined) {
      st.clip = ready;
      return ready ? ready.seconds * (ready.loop ? 3 : 1) : 4;
    }
    const load = lib.fragment(fragment).then((c) => { if (st.fragment === fragment) st.clip = c; });
    this.pending.add(load);
    void load.finally(() => this.pending.delete(load));
    return 4;
  }

  /** Start an NPC's area behaviour at its current position. */
  start(npc: NpcEntity, area: number, behaviour: string, pos: Vec3, rot: Quat): boolean {
    this.stop(npc.id);
    this.female.set(npc.id, npc.female);
    this.world.positions.set(npc.id, [...pos]);
    this.world.beginActivity(npc.id);
    const task = this.world.startAreaBehaviour(npc.id, area, behaviour);
    if (!task) return false;
    this.driven.set(npc.id, { task, state: { pos: [...pos], rot: [...rot], mode: "idle", clip: null, fragment: "", since: this.now }, done: false, due: this.now + ((this.started++ * 0.37) % 1) * TICK });
    return true;
  }

  /** Wait until the fragment clips requested so far have loaded. */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  stop(id: number): void {
    const d = this.driven.get(id);
    if (!d) return;
    d.task.abort();
    this.driven.delete(id);
  }

  has(id: number): boolean {
    return this.driven.has(id);
  }

  /** How an NPC's tree ended: undefined while it runs (or without one). */
  result(id: number): "success" | "failure" | undefined {
    const d = this.driven.get(id);
    return d?.done ? d.status : undefined;
  }

  /**
   * The NPC's activity is over (the time changed): its behaviours see the gate open and finish
   * their step (stand up, walk off). A tree still running after `grace` real seconds is stopped.
   */
  windDown(id: number, grace: number): void {
    const d = this.driven.get(id);
    if (!d || d.deadline !== undefined) return;
    this.world.endActivity(id);
    d.deadline = this.now + grace;
  }

  /** Whether the NPC's tree is winding down (windDown) and not finished yet. */
  windingDown(id: number): boolean {
    const d = this.driven.get(id);
    return !!d && d.deadline !== undefined && !d.done;
  }

  ids(): number[] {
    return [...this.driven.keys()];
  }

  /** Advance the AI clock, every walk, and the trees that are due (TICK). */
  tick(dt: number): void {
    this.now += dt;
    for (const d of this.driven.values()) {
      const st = d.state;
      if (st.mode === "walk" && st.route && st.duration !== undefined) {
        const { pts, cum } = st.route;
        const total = cum[cum.length - 1];
        const walked = Math.min(total, (this.now - st.since) * WALK_SPEED);
        let k = 1;
        while (k < cum.length - 1 && cum[k] < walked) k++;
        const a = pts[k - 1], b = pts[k];
        const seg = cum[k] - cum[k - 1];
        const t = seg > 0 ? (walked - cum[k - 1]) / seg : 1;
        st.pos = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        if (seg > 0.05) st.rot = yawQuat(Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.PI / 2);
        if (walked >= total) { st.mode = "idle"; if (st.endRot) st.rot = [...st.endRot]; }
      }
      if (d.done) continue;
      if (d.deadline !== undefined && this.now >= d.deadline) { d.task.abort(); d.done = true; d.status = "success"; continue; }
      if (this.now < d.due) continue;
      d.due = Math.max(d.due + TICK, this.now);
      const s = d.task.tick();
      if (s !== "running") { d.done = true; d.status = s; }
    }
  }

  state(id: number): AiState | undefined {
    return this.driven.get(id)?.state;
  }
}
