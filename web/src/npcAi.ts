// Runs NPCs' workplace behaviour trees (btWorld.ts) and turns their actions
// into what the renderer needs: where the NPC is, which way it faces, and which
// clip plays. A move walks in a straight line at walking speed and ends facing
// the helper; an animation plays its Mannequin fragment's clip (mannequin.ts),
// holding the last frame of one-shot clips.

import type { AiWorld, Action } from "./btWorld.ts";
import type { Task } from "./btRuntime.ts";
import type { AnimLibrary, FragmentClip } from "./mannequin.ts";
import type { NpcEntity } from "./levelEntities.ts";

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
  /** move: from, to and duration */
  from?: Vec3;
  to?: Vec3;
  duration?: number;
  endRot?: Quat;
}

interface Driven {
  task: Task;
  state: AiState;
  done: boolean;
}

export class NpcAi {
  readonly world: AiWorld;
  private libs: Record<"male" | "female", AnimLibrary>;
  private driven = new Map<number, Driven>();
  private female = new Map<number, boolean>();
  /** AI clock (real seconds, scaled with the game-speed setting by the caller) */
  now = 0;
  private pending = new Set<Promise<unknown>>();

  constructor(world: AiWorld, libs: Record<"male" | "female", AnimLibrary>) {
    this.world = world;
    this.libs = libs;
  }

  /** Called by AiWorld when a tree starts a move or an animation: returns its duration. */
  act(a: Action): number {
    const d = this.driven.get(a.npc);
    if (!d) return 1;
    const st = d.state;
    if (a.kind === "move" && typeof a.target !== "string") {
      const to = a.target;
      const dist = Math.hypot(to[0] - st.pos[0], to[1] - st.pos[1]);
      Object.assign(st, { mode: "walk", from: [...st.pos], to: [...to], since: this.now, duration: dist / WALK_SPEED, endRot: a.rot, clip: null, fragment: "" });
      if (dist > 0.05) st.rot = yawQuat(Math.atan2(to[1] - st.pos[1], to[0] - st.pos[0]) - Math.PI / 2);
      return dist / WALK_SPEED;
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
    const task = this.world.startAreaBehaviour(npc.id, area, behaviour);
    if (!task) return false;
    this.driven.set(npc.id, { task, state: { pos: [...pos], rot: [...rot], mode: "idle", clip: null, fragment: "", since: this.now }, done: false });
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

  ids(): number[] {
    return [...this.driven.keys()];
  }

  /** Advance the AI clock and every driven tree. */
  tick(dt: number): void {
    this.now += dt;
    for (const d of this.driven.values()) {
      const st = d.state;
      if (st.mode === "walk" && st.from && st.to && st.duration !== undefined) {
        const t = st.duration > 0 ? Math.min(1, (this.now - st.since) / st.duration) : 1;
        st.pos = [st.from[0] + (st.to[0] - st.from[0]) * t, st.from[1] + (st.to[1] - st.from[1]) * t, st.from[2] + (st.to[2] - st.from[2]) * t];
        if (t >= 1) { st.mode = "idle"; if (st.endRot) st.rot = [...st.endRot]; }
      }
      if (!d.done && d.task.tick() !== "running") d.done = true;
    }
  }

  state(id: number): AiState | undefined {
    return this.driven.get(id)?.state;
  }
}
