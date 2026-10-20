// Player locomotion from the game's blend spaces (docs/ANIMATION.md "Blend spaces", "Mannequin").
//
// A .bspace lists example clips and quads (<Face p0..p3>) over 1–2 parameters; each example's
// parameter values come from its clip's motion parameters (speed, travel direction, turn), times
// its PlaybackScale, unless SetParaN overrides them. A query point is located in a quad by
// inverse bilinear interpolation (clamped to the nearest quad when outside), and the quad's
// corner weights blend the examples, all playing at one normalised phase (the cycles stay in
// step). A .comb joins 2D spaces: the strafe space (MoveSpeed × TravelAngle) and the turn space
// (MoveSpeed × TurnSpeed) are mixed by how much the body is turning; start/stop combs choose a
// left- or right-foot space ("ChooseBlendSpace" on TurnAngle).
//
// Which space plays comes from the Mannequin database (kcd_male_database.adb): MotionIdle,
// MotionMovement (walk/run/sprint, +backward), IdleToMove and MoveToIdle, by best tag match with
// the "player" tag. Crossfades use the fragments' 0.2 s blends.
//
// Movement is code-driven (player.ts): the animation follows the controller. Loops run at the
// controller's speed (the MoveSpeed parameter, then a playback rate for whatever the space can't
// reach); start and stop clips are advanced by the distance actually travelled along their root
// motion, so the planted foot stays put.

import { parseXml, type XmlNode } from "./xml.ts";
import { parseAdb, type FragmentVariant } from "./mannequin.ts";
import type { Clip } from "./anim.ts";
import type { Animator, BlendLayer } from "./pose.ts";
import type { Vfs } from "./vfs.ts";

export type ParamName = "MoveSpeed" | "TravelAngle" | "TurnSpeed" | "TurnAngle";

interface Dim {
  name: string;
  min: number;
  max: number;
}

export interface Example {
  name: string;
  clip: Clip;
  /** PlaybackScale: the example plays (and moves) this much faster */
  scale: number;
  /** one value per dimension */
  params: number[];
  /** clip length in frames and seconds at its scale */
  frames: number;
  seconds: number;
  /** cumulative horizontal root distance per frame (for distance-driven playback) */
  rootDistance: Float32Array;
}

export interface BlendSpace {
  path: string;
  dims: Dim[];
  examples: Example[];
  faces: number[][];
}

/** A .comb: several 2D spaces joined. */
export interface CombinedSpace {
  path: string;
  spaces: BlendSpace[];
  /** start/stop combs pick one space by a parameter's range instead of mixing */
  choose: ParamName | null;
}

export type Space = BlendSpace | CombinedSpace;

const attr = (n: XmlNode, k: string): string | undefined => {
  const lk = k.toLowerCase();
  for (const [a, v] of Object.entries(n.attrs)) if (a.toLowerCase() === lk) return v;
  return undefined;
};
const child = (n: XmlNode, tag: string) => n.children.find((c) => c.tag.toLowerCase() === tag.toLowerCase());

/** The value of a parameter for a clip played at `scale` (from its motion parameters). */
export function clipParam(clip: Clip, name: string, scale = 1): number {
  const m = clip.motion;
  if (!m) return 0;
  const seconds = Math.max(1e-3, (clip.end - clip.start) / clip.fps);
  switch (name) {
    case "MoveSpeed": return (Math.hypot(m.travel[0], m.travel[1]) / seconds) * scale;
    case "TravelAngle": return Math.hypot(m.travel[0], m.travel[1]) < 0.05 ? 0 : Math.atan2(-m.travel[0], m.travel[1]);
    case "TurnSpeed": return (m.turn / seconds) * scale;
    case "TurnAngle": return m.turn;
    default: return 0;
  }
}

/** Cumulative horizontal path length of the root (locator) bone, per frame from clip.start. */
function rootDistance(clip: Clip, rootController: number): Float32Array {
  const frames = Math.max(1, Math.round(clip.end - clip.start));
  const out = new Float32Array(frames + 1);
  const t = clip.tracks.get(rootController);
  if (!t || t.positions.length < 2) return out;
  const at = (f: number): [number, number] => {
    const times = t.posTimes;
    let i = 0;
    while (i < times.length - 2 && times[i + 1] <= f) i++;
    const a = t.positions[i], b = t.positions[Math.min(i + 1, t.positions.length - 1)];
    const span = times[Math.min(i + 1, times.length - 1)] - times[i] || 1;
    const u = Math.max(0, Math.min(1, (f - times[i]) / span));
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  let prev = at(clip.start);
  for (let f = 1; f <= frames; f++) {
    const p = at(clip.start + f);
    out[f] = out[f - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
  }
  return out;
}

/** Parse a .bspace and resolve its examples (null for unknown clips is an error). */
export function parseBlendSpace(path: string, xml: string, clipOf: (name: string) => Clip | null, rootController: number): BlendSpace {
  const root = parseXml(xml).children.find((c) => c.tag === "ParaGroup");
  if (!root) throw new Error(`${path}: no <ParaGroup>`);
  const dims: Dim[] = (child(root, "Dimensions")?.children ?? []).filter((c) => c.tag === "Param").map((p) => ({
    name: attr(p, "name") ?? "",
    min: Number(attr(p, "min") ?? -Infinity),
    max: Number(attr(p, "max") ?? Infinity),
  }));
  const examples: Example[] = [];
  for (const e of child(root, "ExampleList")?.children.filter((c) => c.tag === "Example") ?? []) {
    const name = (attr(e, "AName") ?? "").toLowerCase();
    const clip = clipOf(name);
    if (!clip) throw new Error(`${path}: example clip ${name} not found`);
    const scale = Number(attr(e, "PlaybackScale") ?? 1) || 1;
    const params = dims.map((d, k) => {
      const set = attr(e, `SetPara${k}`);
      return set !== undefined ? Number(set) : clipParam(clip, d.name, scale);
    });
    const frames = Math.max(1, clip.end - clip.start);
    examples.push({ name, clip, scale, params, frames, seconds: frames / clip.fps / scale, rootDistance: rootDistance(clip, rootController) });
  }
  const faces = (child(root, "Blendable")?.children ?? []).filter((c) => c.tag === "Face").map((f) => [0, 1, 2, 3].map((k) => Number(attr(f, `p${k}`))).filter((i) => Number.isInteger(i) && i >= 0 && i < examples.length));
  return { path, dims, examples, faces: faces.filter((f) => f.length >= 3) };
}

/** Example weights for a query (parameters by name; missing ones count as 0). */
export function blendWeights(space: BlendSpace, q: Partial<Record<string, number>>): number[] {
  const w = new Array<number>(space.examples.length).fill(0);
  if (space.examples.length === 1 || !space.faces.length) {
    w[0] = 1;
    return w;
  }
  const nd = space.dims.length;
  const range = space.dims.map((d) => (Number.isFinite(d.max - d.min) && d.max > d.min ? d.max - d.min : 1));
  const point = space.dims.map((d) => Math.max(d.min, Math.min(d.max, q[d.name] ?? 0)));
  const P = (i: number) => space.examples[i].params;
  let best = { err: Infinity, face: [] as number[], u: 0, v: 0 };
  for (const face of space.faces) {
    const [a, b, c, d = face[2]] = face;
    // bilinear p(u, v) = (1-u)(1-v)A + u(1-v)B + uv C + (1-u)v D; Newton from the centre
    let u = 0.5, v = 0.5;
    const ev = (uu: number, vv: number) => space.dims.map((_, k) => ((1 - uu) * (1 - vv) * P(a)[k] + uu * (1 - vv) * P(b)[k] + uu * vv * P(c)[k] + (1 - uu) * vv * P(d)[k]) / range[k]);
    const target = point.map((x, k) => x / range[k]);
    for (let it = 0; it < 12; it++) {
      const f = ev(u, v).map((x, k) => x - target[k]);
      if (nd === 1) {
        // a 1D "quad" is a segment: solve along u
        const du = (ev(u + 1e-3, v)[0] - ev(u, v)[0]) / 1e-3;
        if (Math.abs(du) < 1e-9) break;
        u -= f[0] / du;
        continue;
      }
      const e = 1e-3;
      const fu = ev(u + e, v).map((x, k) => (x - (f[k] + target[k])) / e);
      const fv = ev(u, v + e).map((x, k) => (x - (f[k] + target[k])) / e);
      const det = fu[0] * fv[1] - fu[1] * fv[0];
      if (Math.abs(det) < 1e-12) break;
      u -= (f[0] * fv[1] - f[1] * fv[0]) / det;
      v -= (fu[0] * f[1] - fu[1] * f[0]) / det;
    }
    u = Math.max(0, Math.min(1, u));
    v = Math.max(0, Math.min(1, v));
    const r = ev(u, v);
    const err = Math.hypot(...r.map((x, k) => x - point[k] / range[k]));
    if (err < best.err - 1e-9) best = { err, face, u, v };
  }
  const [a, b, c, d] = best.face;
  const { u, v } = best;
  w[a] += (1 - u) * (1 - v);
  w[b] += u * (1 - v);
  w[c] += u * v;
  if (d !== undefined) w[d] += (1 - u) * v;
  else w[a] += (1 - u) * v;
  return w;
}

export interface LoadedLocomotion {
  /** blend space (or plain clip, as a one-example space) by animation name */
  spaces: Map<string, Space>;
  adb: Map<string, FragmentVariant[]>;
}

/** Mannequin tag matching: the variant whose tags are all requested, with the most of them. */
export function pickVariant(variants: FragmentVariant[], tags: Set<string>): FragmentVariant | null {
  let best: FragmentVariant | null = null, bestN = -1;
  for (const v of variants) {
    if (!v.anims.length) continue;
    const vt = v.tags ? v.tags.split("+").map((t) => t.toLowerCase()) : [];
    if (!vt.every((t) => tags.has(t))) continue;
    if (vt.length > bestN) { best = v; bestN = vt.length; }
  }
  return best;
}

const FRAGMENTS = {
  idle: "motionidle",
  move: "motionmovement",
  start: "idletomove",
  stop: "movetoidle",
};

/**
 * Load the player's locomotion spaces: every animation named by the fragments a walking player
 * uses (with the "player" tag), resolved to .bspace/.comb files or plain clips.
 */
export async function loadLocomotion(vfs: Vfs, clipOf: (name: string) => Clip | null, rootController: number, gender = "male"): Promise<LoadedLocomotion> {
  const adbPath = `animations/mannequin/adb/kcd_${gender}_database.adb`;
  const hit = vfs.lookup(adbPath);
  if (!hit) throw new Error(`${adbPath} not found`);
  const adb = parseAdb(new TextDecoder().decode(await vfs.read(hit)));
  const files = new Map<string, string>();
  const dir = `animations/humans/${gender}/`;
  for (const p of vfs.paths()) if (p.startsWith(dir) && /\.(bspace|comb)$/.test(p)) files.set(p.slice(p.lastIndexOf("/") + 1).replace(/\.(bspace|comb)$/, ""), p);
  const read = async (p: string) => new TextDecoder().decode(await vfs.read(vfs.lookup(p)!));
  const spaces = new Map<string, Space>();
  const loadSpace = async (name: string): Promise<Space | null> => {
    const path = files.get(name);
    if (!path) {
      const clip = clipOf(name);
      if (!clip) return null;
      const frames = Math.max(1, clip.end - clip.start);
      return { path: name, dims: [], faces: [], examples: [{ name, clip, scale: 1, params: [], frames, seconds: frames / clip.fps, rootDistance: rootDistance(clip, rootController) }] };
    }
    if (path.endsWith(".bspace")) return parseBlendSpace(path, await read(path), clipOf, rootController);
    const root = parseXml(await read(path)).children.find((c) => c.tag === "CombinedBlendSpace");
    if (!root) throw new Error(`${path}: no <CombinedBlendSpace>`);
    const choose = (child(root, "Dimensions")?.children ?? []).find((p) => attr(p, "ChooseBlendSpace") === "1");
    const subs: BlendSpace[] = [];
    for (const b of child(root, "BlendSpaces")?.children ?? []) {
      const sub = (attr(b, "AName") ?? "").replaceAll("\\", "/").toLowerCase();
      if (!vfs.lookup(sub)) throw new Error(`${path}: ${sub} not found`);
      subs.push(parseBlendSpace(sub, await read(sub), clipOf, rootController));
    }
    return { path, spaces: subs, choose: choose ? ((attr(choose, "name") ?? null) as ParamName | null) : null };
  };
  const tagsets: [keyof typeof FRAGMENTS, string[]][] = [
    ["idle", ["player"]],
    ...(["walk", "run", "sprint"] as const).flatMap((g): [keyof typeof FRAGMENTS, string[]][] => [
      ["move", [g, "player"]], ["move", [g, "backward", "player"]], ["start", [g, "player"]], ["stop", [g, "player"]],
    ]),
  ];
  for (const [frag, tags] of tagsets) {
    const v = pickVariant(adb.get(FRAGMENTS[frag]) ?? [], new Set(tags));
    const name = v?.anims[0]?.name;
    if (!name || spaces.has(name)) continue;
    const s = await loadSpace(name);
    if (s) spaces.set(name, s);
  }
  return { spaces, adb };
}

/** The animation a fragment plays for a tag set (null when no variant matches). */
export function fragmentAnim(loco: LoadedLocomotion, fragment: keyof typeof FRAGMENTS, tags: string[]): Space | null {
  const v = pickVariant(loco.adb.get(FRAGMENTS[fragment]) ?? [], new Set(tags));
  return v ? loco.spaces.get(v.anims[0].name) ?? null : null;
}

/** Weights over a space's examples (flattened across a .comb's spaces). */
export function spaceWeights(space: Space, q: Partial<Record<ParamName, number>>, prefer = 0): { ex: Example; w: number }[] {
  if ("examples" in space) return blendWeights(space, q).map((w, i) => ({ ex: space.examples[i], w })).filter((x) => x.w > 1e-4);
  if (space.choose) {
    // the space whose range holds the chooser parameter; ties (a straight 0) go to `prefer`
    const v = q[space.choose] ?? 0;
    const fits = space.spaces.filter((s) => { const d = s.dims.find((x) => x.name === space.choose); return !d || (v >= d.min - 1e-6 && v <= d.max + 1e-6); });
    const s = fits[Math.min(prefer, fits.length - 1)] ?? space.spaces[0];
    return spaceWeights(s, q);
  }
  // strafe (TravelAngle) and turn (TurnSpeed) spaces: mix by how much the body turns while
  // moving straight. APPROXIMATION of the engine's 3D combination.
  const strafe = space.spaces.find((s) => s.dims.some((d) => d.name === "TravelAngle"));
  const turn = space.spaces.find((s) => s.dims.some((d) => d.name === "TurnSpeed"));
  if (!strafe || !turn) return spaceWeights(space.spaces[0], q);
  const tdim = turn.dims.find((d) => d.name === "TurnSpeed")!;
  const turnAmount = Math.min(1, Math.abs(q.TurnSpeed ?? 0) / Math.max(1e-3, tdim.max));
  const straight = 1 - Math.min(1, Math.abs(q.TravelAngle ?? 0) / (Math.PI / 4));
  const t = turnAmount * straight;
  const out = new Map<Example, number>();
  for (const { ex, w } of spaceWeights(strafe, q)) out.set(ex, (out.get(ex) ?? 0) + w * (1 - t));
  if (t > 1e-3) for (const { ex, w } of spaceWeights(turn, q)) out.set(ex, (out.get(ex) ?? 0) + w * t);
  return [...out].map(([ex, w]) => ({ ex, w })).filter((x) => x.w > 1e-4);
}

/** All examples of a space (flattened). */
function examplesOf(space: Space): Example[] {
  return "examples" in space ? space.examples : space.spaces.flatMap((s) => s.examples);
}

/** A playing space: its weights and the normalised time shared by its examples. */
interface Track {
  space: Space;
  kind: "loop" | "once";
  /** normalised time 0..1 (loops wrap) */
  t: number;
  weights: { ex: Example; w: number }[];
  /** crossfade weight and its rate (per second; negative = fading out) */
  fade: number;
  fadeRate: number;
  /** "once": distance travelled along the blended root motion so far */
  dist?: number;
  /** loops: whole gait cycles completed (t is the phase within the current one) */
  cyc: number;
  label: string;
  prefer?: number;
}

export type LocoState = "idle" | "start" | "move" | "stop";

export interface LocoInput {
  /** horizontal speed (m/s) and travel angle relative to the facing (radians, left positive) */
  speed: number;
  travelAngle: number;
  /** body yaw rate (rad/s, left positive) */
  turnSpeed: number;
  /** speed the input asks for (0 = no input) and the gait */
  wantSpeed: number;
  gait: "walk" | "run" | "sprint";
  /** metres moved this frame */
  moved: number;
}

const BLEND = 0.2; // the fragments' Blend Duration / BlendOutDuration
const BACKWARD_ON = (100 * Math.PI) / 180, BACKWARD_OFF = (80 * Math.PI) / 180;
const START_MAX_ANGLE = Math.PI / 6;
/** Inertia of the controller (player.ts): a stop from speed v covers v / INERTIA metres. */
const INERTIA = 11;

/**
 * The player's locomotion state machine: idle ↔ start → move → stop → idle, with crossfades.
 * Call update() each frame, then layers() for the Animator.
 */
export class LocomotionPlayer {
  state: LocoState = "idle";
  private loco: LoadedLocomotion;
  private tracks: Track[] = [];
  private backward = false;
  private gait: "walk" | "run" | "sprint" = "run";
  private animator: Animator;
  private scratch: BlendLayer[] = [];
  /** the space each state played last (for the HUD and tests) */
  current = "";

  constructor(loco: LoadedLocomotion, animator: Animator) {
    this.loco = loco;
    this.animator = animator;
    const idle = fragmentAnim(loco, "idle", ["player"]);
    if (idle) this.push(idle, "loop", "idle", 1e9);
  }

  private push(space: Space, kind: Track["kind"], label: string, fadeIn = 1 / BLEND, t = 0, prefer = 0): Track {
    for (const tr of this.tracks) tr.fadeRate = -1 / BLEND;
    const tr: Track = { space, kind, t, weights: [], fade: fadeIn >= 1e8 ? 1 : 0, fadeRate: fadeIn, dist: 0, cyc: 0, label, prefer };
    this.tracks.push(tr);
    this.current = `${label}: ${space.path.slice(space.path.lastIndexOf("/") + 1)}`;
    return tr;
  }

  private top(): Track | undefined {
    return this.tracks[this.tracks.length - 1];
  }

  update(dt: number, inp: LocoInput): void {
    const moving = inp.wantSpeed > 0.05;
    const angle = inp.travelAngle;
    if (Math.abs(angle) > BACKWARD_ON) this.backward = true;
    else if (Math.abs(angle) < BACKWARD_OFF) this.backward = false;
    const forwardish = Math.abs(angle) < START_MAX_ANGLE;
    const top = this.top();

    switch (this.state) {
      case "idle":
        if (moving) {
          const start = forwardish && !this.backward ? fragmentAnim(this.loco, "start", [inp.gait, "player"]) : null;
          if (start) { this.push(start, "once", "start"); this.state = "start"; } else this.enterMove(inp);
        }
        break;
      case "start":
        if (!moving) { this.enterIdleOrStop(inp); break; }
        // into the loop once the start has run most of its course, or when the move changes
        if ((top && top.t >= 0.7) || !forwardish || this.backward || inp.gait !== this.gait) this.enterMove(inp);
        break;
      case "move":
        if (!moving) { this.enterIdleOrStop(inp); break; }
        if (inp.gait !== this.gait || (top && this.isBackwardSpace(top.space) !== this.backward)) this.enterMove(inp);
        break;
      case "stop":
        if (moving) { this.enterMove(inp); break; }
        if (top && top.t >= 1) this.enterIdle();
        break;
    }
    this.gait = this.state === "idle" ? inp.gait : this.gait;

    // advance every track
    for (const tr of this.tracks) {
      tr.fade = Math.max(0, Math.min(1, tr.fade + tr.fadeRate * dt));
      const q = { MoveSpeed: Math.max(inp.speed, inp.wantSpeed * 0.5), TravelAngle: angle, TurnSpeed: inp.turnSpeed, TurnAngle: 0 };
      if (tr.kind === "loop") {
        tr.weights = spaceWeights(tr.space, q, tr.prefer);
        // t is the gait-cycle phase (left foot down at 0): clips hold one or two cycles
        const cycle = tr.weights.reduce((s, x) => s + (x.w * x.ex.seconds) / this.gaitOf(x.ex).cycles, 0) || 1;
        // whatever speed the space can't reach is made up by the playback rate
        const spaceSpeed = tr.weights.reduce((s, x) => s + x.w * clipParam(x.ex.clip, "MoveSpeed", x.ex.scale), 0);
        const rate = tr.label === "idle" || spaceSpeed < 0.1 || inp.speed < 0.1 ? 1 : Math.max(0.5, Math.min(2, inp.speed / spaceSpeed));
        tr.t += (dt / cycle) * rate;
        while (tr.t >= 1) { tr.t -= 1; tr.cyc++; }
      } else {
        if (!tr.weights.length) tr.weights = spaceWeights(tr.space, { ...q, MoveSpeed: tr.label === "start" ? inp.wantSpeed : inp.speed }, tr.prefer);
        tr.dist = (tr.dist ?? 0) + inp.moved;
        const byDist = this.timeAtDistance(tr, tr.dist);
        const cycle = tr.weights.reduce((s, x) => s + x.w * x.ex.seconds, 0) || 1;
        // still (or the clip's root has stopped moving): run on by time
        const byTime = inp.speed < 0.1 || byDist === null ? tr.t + dt / cycle : tr.t;
        tr.t = Math.min(1, Math.max(tr.t, byDist ?? 0, byTime));
      }
    }
    this.tracks = this.tracks.filter((tr) => tr.fade > 0 || tr.fadeRate > 0);
  }

  /** Normalised time at which the blended root motion has covered `d` metres (null past its end). */
  private timeAtDistance(tr: Track, d: number): number | null {
    const at = (t: number) => tr.weights.reduce((s, { ex, w }) => {
      const f = Math.min(ex.frames, t * ex.frames);
      const i = Math.floor(f), u = f - i;
      const rd = ex.rootDistance;
      return s + w * (rd[Math.min(i, rd.length - 1)] * (1 - u) + rd[Math.min(i + 1, rd.length - 1)] * u);
    }, 0);
    if (d >= at(1) - 1e-4) return null;
    let lo = 0, hi = 1;
    for (let it = 0; it < 24; it++) {
      const mid = (lo + hi) / 2;
      if (at(mid) < d) lo = mid; else hi = mid;
    }
    return lo;
  }

  private isBackwardSpace(space: Space): boolean {
    return /_bwd/.test(space.path);
  }

  private enterMove(inp: LocoInput): void {
    this.gait = inp.gait;
    const tags = this.backward && inp.gait !== "sprint" ? [inp.gait, "backward", "player"] : [inp.gait, "player"];
    const space = fragmentAnim(this.loco, "move", tags);
    if (!space) return;
    // keep the step phase when changing gait or direction (all cycles start on the same foot)
    const prev = [...this.tracks].reverse().find((t) => t.kind === "loop" && t.label !== "idle");
    this.push(space, "loop", "move", 1 / BLEND, prev && this.state === "move" ? prev.t : 0);
    this.state = "move";
  }

  private enterIdle(): void {
    const idle = fragmentAnim(this.loco, "idle", ["player"]);
    if (idle) this.push(idle, "loop", "idle");
    this.state = "idle";
  }

  /**
   * Input released: from a forward walk, run or sprint, the stop clip whose stance matches the
   * current pose (left- or right-foot stop), entered so that the rest of its root motion equals
   * the controller's stopping distance; otherwise straight to idle.
   */
  private enterIdleOrStop(inp: LocoInput): void {
    const space = !this.backward && inp.speed > 1 && Math.abs(inp.travelAngle) < START_MAX_ANGLE ? fragmentAnim(this.loco, "stop", [this.gait, "player"]) : null;
    if (!space || "examples" in space || !space.choose) { this.enterIdle(); return; }
    const stopDist = inp.speed / INERTIA;
    let best: { prefer: number; t: number; err: number } | null = null;
    for (let prefer = 0; prefer < space.spaces.length; prefer++) {
      const probe: Track = { space, kind: "once", t: 0, cyc: 0, weights: spaceWeights(space, { MoveSpeed: inp.speed, TurnAngle: 0 }, prefer), fade: 0, fadeRate: 0, label: "stop", prefer };
      const total = probe.weights.reduce((s, { ex, w }) => s + w * ex.rootDistance[ex.rootDistance.length - 1], 0);
      const t = this.timeAtDistance(probe, Math.max(0, total - stopDist)) ?? 0;
      const err = this.poseError(probe.weights, t);
      if (!best || err < best.err) best = { prefer, t, err };
    }
    this.push(space, "once", "stop", 1 / BLEND, best!.t, best!.prefer);
    this.state = "stop";
  }

  /** How far the feet (relative to the hips) are from where a clip blend puts them at time t. */
  private poseError(weights: { ex: Example; w: number }[], t: number): number {
    const sk = this.animator.skeleton;
    const ids = ["LeftFoot", "RightFoot", "Hips"].map((n) => sk.byName.get(n.toLowerCase()));
    if (ids.some((i) => i === undefined)) return 0;
    const now = ids.map((i) => [this.animator.world[i!][12], this.animator.world[i!][13]]);
    const saved = this.animator.world.map((m) => new Float32Array(m));
    this.animator.evaluateLayers(weights.map(({ ex, w }) => ({ clip: ex.clip, frame: ex.clip.start + Math.min(1, t) * ex.frames, weight: w })), true);
    const then = ids.map((i) => [this.animator.world[i!][12], this.animator.world[i!][13]]);
    saved.forEach((m, i) => this.animator.world[i].set(m));
    let e = 0;
    for (let k = 0; k < 2; k++) e += Math.hypot(now[k][0] - now[2][0] - (then[k][0] - then[2][0]), now[k][1] - now[2][1] - (then[k][1] - then[2][1]));
    return e;
  }

  /** The blended layers for Animator.evaluateLayers (in place). */
  layers(): BlendLayer[] {
    const out = this.scratch;
    out.length = 0;
    for (const tr of this.tracks) {
      if (tr.fade <= 0) continue;
      for (const { ex, w } of tr.weights) out.push({ clip: ex.clip, frame: ex.clip.start + this.clipTime(tr, ex) * ex.frames, weight: w * tr.fade });
    }
    return out;
  }

  /** Normalised clip time of an example in a track (loops: by gait phase). */
  private clipTime(tr: Track, ex: Example): number {
    if (tr.kind === "once") return Math.min(tr.t, 0.9999);
    const g = this.gaitOf(ex);
    const u = ((tr.cyc % g.cycles) + tr.t + g.offset) / g.cycles;
    return Math.min(u - Math.floor(u), 0.9999);
  }

  private gaits = new WeakMap<Example, { cycles: number; offset: number }>();

  /**
   * Gait cycles in a looping clip and where (in cycles) its left foot comes down: the lower toe
   * sampled over the clip. relaxed_walk_medium_player and run_slow hold two cycles (four steps),
   * run_medium one; syncing them by clip time would blend opposite feet.
   */
  private gaitOf(ex: Example): { cycles: number; offset: number } {
    let g = this.gaits.get(ex);
    if (g) return g;
    const sk = this.animator.skeleton;
    const l = sk.byName.get("lefttoebase"), r = sk.byName.get("righttoebase");
    g = { cycles: 1, offset: 0 };
    if (l !== undefined && r !== undefined && ex.clip.motion && ex.clip.motion.moveSpeed > 0.05) {
      const saved = this.animator.world.map((m) => new Float32Array(m));
      const N = 64;
      const left: boolean[] = [];
      for (let i = 0; i < N; i++) {
        this.animator.evaluate(ex.clip, ex.clip.start + (i / N) * ex.frames, true);
        left.push(this.animator.world[l][14] < this.animator.world[r][14]);
      }
      saved.forEach((m, i) => this.animator.world[i].set(m));
      const downs: number[] = [];
      for (let i = 0; i < N; i++) if (left[i] && !left[(i + N - 1) % N]) downs.push(i / N);
      if (downs.length) g = { cycles: downs.length, offset: downs[0] * downs.length };
    }
    this.gaits.set(ex, g);
    return g;
  }

  /** Examples currently playing, strongest first (for tests and the HUD). */
  playing(): { name: string; weight: number }[] {
    const m = new Map<string, number>();
    for (const tr of this.tracks) for (const { ex, w } of tr.weights) m.set(ex.name, (m.get(ex.name) ?? 0) + w * tr.fade);
    return [...m].map(([name, weight]) => ({ name, weight })).sort((a, b) => b.weight - a.weight);
  }

  static examples(space: Space): Example[] {
    return examplesOf(space);
  }
}
