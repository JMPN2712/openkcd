// Collision avoidance between NPCs, modelled on how the game behaves: an
// ORCA-style velocity solver (van den Berg et al., "Reciprocal n-Body Collision
// Avoidance", 2011; the RVO2 library) with the game's settings and a few
// differences in how standing NPCs and infeasible cases are handled. Per update:
//
//   - Moving NPCs are agents (at most 20). Standing ones, and agents close to
//     their path end, are obstacles: others avoid them, they don't avoid.
//   - Each agent considers every obstacle within range (plus its own radius)
//     and its 8 nearest moving agents, on the same floor. A moving agent gives
//     a reciprocal line (each side takes half the correction); something
//     standing gives a one-sided line built from the agent's preferred
//     velocity, its radius scaled by the agent's "shrink" so a boxed-in agent
//     can squeeze past.
//   - Allowed velocities form a polygon: a square of half-size maxSpeed + 1
//     cut by each line. The preferred velocity is kept if it is inside;
//     otherwise candidate velocities on the polygon are tried, nearest to the
//     preferred one first. If no velocity is allowed, the farthest agents are
//     dropped and the agent tries again.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** The game's default settings (console variables). */
export const CA = {
  range: 5,
  pathEndCutoff: 1.3,
  agentTimeHorizon: 2.5,
  obstacleTimeHorizon: 1.5,
  /** time to resolve an existing overlap */
  timestep: 0.1,
  minSpeed: 0.4,
  agentExtraFat: 0.075,
  /** shrink rates per second: down while avoiding, back up when not */
  shrinkIncreaseRate: 0.1,
  shrinkDecreaseRate: 0.15,
  shrinkMin: 0.05,
  /** height difference that counts as another floor; the smaller one applies within an agent's radius */
  sameFloor: 2,
  sameFloorMin: 1,
  maxAgents: 20,
  maxAgentNeighbours: 8,
  /** a chosen velocity must have at least this squared speed */
  minAcceptSpeedSq: 0.1,
};

/** Scripts/Entities/AI/npc_x.lua AIMovementAbility.pathRadius (humans). */
export const NPC_PATH_RADIUS = 0.25;

export interface CrowdAgent {
  /** radius (pathRadius + agentExtraFat) */
  radius: number;
  pos: Vec3;
  /** current velocity */
  vel: Vec2;
  /** preferred velocity (towards the path) */
  pref: Vec2;
  maxSpeed: number;
  /** avoiding (agent) or only avoided (obstacle) */
  avoids: boolean;
  /** scale applied to the radii of standing neighbours, CA.shrinkMin…1 (starts at 1) */
  shrink: number;
}

/** Velocities v with cross(dir, v − point) ≥ 0 (left of the directed line) are allowed. */
interface Line {
  point: Vec2;
  dir: Vec2;
  /** distance to the neighbour that produced it (for dropping the farthest) */
  dist: number;
  /** never dropped */
  keep: boolean;
}

const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const EPS = 1e-6;

/**
 * The ORCA half-plane for velocity `vel` against a neighbour at relative position
 * `rel` with relative velocity `relVel`, combined radius `r` and time horizon
 * `tau`; `share` is the part of the correction this side takes (½ reciprocal, 1
 * one-sided).
 */
function orcaLine(vel: Vec2, rel: Vec2, relVel: Vec2, r: number, tau: number, share: number): { point: Vec2; dir: Vec2 } {
  const distSq = dot(rel, rel);
  const rSq = r * r;
  let dir: Vec2;
  let u: Vec2;
  if (distSq > rSq) {
    // not touching: project relVel onto the truncated velocity-obstacle cone
    const w: Vec2 = [relVel[0] - rel[0] / tau, relVel[1] - rel[1] / tau];
    const wLenSq = dot(w, w);
    const wDotRel = dot(w, rel);
    if (wDotRel < 0 && wDotRel * wDotRel > rSq * wLenSq) {
      // nearest to the cut-off circle at the cone's tip
      const wLen = Math.sqrt(wLenSq);
      const n: Vec2 = [w[0] / wLen, w[1] / wLen];
      dir = [n[1], -n[0]];
      u = [n[0] * (r / tau - wLen), n[1] * (r / tau - wLen)];
    } else {
      // nearest to one of the cone's legs
      const leg = Math.sqrt(distSq - rSq);
      if (cross(rel, w) > 0) dir = [(rel[0] * leg - rel[1] * r) / distSq, (rel[0] * r + rel[1] * leg) / distSq];
      else dir = [-(rel[0] * leg + rel[1] * r) / distSq, -(-rel[0] * r + rel[1] * leg) / distSq];
      const along = dot(relVel, dir);
      u = [dir[0] * along - relVel[0], dir[1] * along - relVel[1]];
    }
  } else {
    // already overlapping: push apart within one timestep
    const inv = 1 / CA.timestep;
    const w: Vec2 = [relVel[0] - rel[0] * inv, relVel[1] - rel[1] * inv];
    const wLen = Math.hypot(w[0], w[1]) || EPS;
    const n: Vec2 = [w[0] / wLen, w[1] / wLen];
    dir = [n[1], -n[0]];
    u = [n[0] * (r * inv - wLen), n[1] * (r * inv - wLen)];
  }
  return { point: [vel[0] + share * u[0], vel[1] + share * u[1]], dir };
}

/** Keep the part of a convex polygon on the allowed side of a line. */
function clip(poly: Vec2[], line: Line): Vec2[] {
  const side = (p: Vec2) => cross(line.dir, [p[0] - line.point[0], p[1] - line.point[1]]);
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

const allowed = (v: Vec2, lines: Line[]) => lines.every((l) => cross(l.dir, [v[0] - l.point[0], v[1] - l.point[1]]) >= -EPS);

/** Velocities to try when the preferred one is not allowed, nearest to it first. */
function candidates(poly: Vec2[], lines: Line[], pref: Vec2, maxSpeed: number): Vec2[] {
  const out: Vec2[] = [];
  // the preferred velocity shortened until it is allowed
  let lo = 0, hi = 1;
  for (const l of lines) {
    // cross(dir, s·pref − point) ≥ 0  ⇔  s·cross(dir, pref) ≥ cross(dir, point)
    const a = cross(l.dir, pref), b = cross(l.dir, l.point);
    if (Math.abs(a) < EPS) { if (b > EPS) { hi = -1; break; } continue; }
    if (a > 0) lo = Math.max(lo, b / a);
    else hi = Math.min(hi, b / a);
  }
  if (hi >= lo && hi > 0) out.push([pref[0] * hi, pref[1] * hi]);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    // corners within reach
    if (Math.hypot(a[0], a[1]) <= maxSpeed) out.push(a);
    // where the edge crosses the max-speed circle
    const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const qa = dot(d, d), qb = 2 * dot(a, d), qc = dot(a, a) - maxSpeed * maxSpeed;
    const disc = qb * qb - 4 * qa * qc;
    if (qa < EPS || disc < 0) continue;
    for (const t of [(-qb - Math.sqrt(disc)) / (2 * qa), (-qb + Math.sqrt(disc)) / (2 * qa)]) {
      if (t >= 0 && t <= 1) out.push([a[0] + d[0] * t, a[1] + d[1] * t]);
    }
  }
  const dist = (v: Vec2) => (v[0] - pref[0]) ** 2 + (v[1] - pref[1]) ** 2;
  return out.filter((v) => Math.hypot(v[0], v[1]) >= CA.minSpeed - EPS).sort((x, y) => dist(x) - dist(y));
}

/** The chosen velocity, or null when nothing is allowed. */
function solve(lines: Line[], pref: Vec2, maxSpeed: number): Vec2 | null {
  const h = maxSpeed + 1;
  let poly: Vec2[] = [[-h, -h], [h, -h], [h, h], [-h, h]];
  for (const l of lines) {
    poly = clip(poly, l);
    if (poly.length < 3) return null;
  }
  if (allowed(pref, lines)) return pref;
  for (const v of candidates(poly, lines, pref, maxSpeed)) {
    if (dot(v, v) >= CA.minAcceptSpeedSq && allowed(v, lines)) return v;
  }
  return null;
}

function sameFloor(a: CrowdAgent, b: CrowdAgent, horizontal: number): boolean {
  const limit = horizontal < a.radius ? CA.sameFloorMin : CA.sameFloor;
  return Math.abs(a.pos[2] - b.pos[2]) < limit;
}

/**
 * New velocities for the avoiding agents (written to `vel`) and their shrink
 * updated by `dt`. Agents with no preferred velocity keep still; agents that
 * don't avoid keep their velocity.
 */
export function avoid(agents: CrowdAgent[], dt: number): void {
  const moving = agents.filter((a) => a.avoids && (a.pref[0] !== 0 || a.pref[1] !== 0));
  // over the cap, solve the agents closest to someone else (the others just follow their plans)
  const gap = (a: CrowdAgent) => Math.min(...agents.map((b) => (b === a ? Infinity : Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]))));
  const solving = moving.length > CA.maxAgents ? moving.map((a) => ({ a, g: gap(a) })).sort((x, y) => x.g - y.g).slice(0, CA.maxAgents).map((x) => x.a) : moving;
  const results: Vec2[] = [];
  for (const a of solving) {
    const lines: Line[] = [];
    const near: { b: CrowdAgent; d: number }[] = [];
    for (const b of agents) {
      if (b === a) continue;
      const rel: Vec2 = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]];
      const d = Math.hypot(rel[0], rel[1]);
      if (!sameFloor(a, b, d)) continue;
      const isMoving = moving.includes(b);
      if (isMoving) {
        if (d < CA.range) near.push({ b, d });
        continue;
      }
      if (d > CA.range + a.radius) continue;
      // one-sided, from the preferred velocity; nearer obstacles look less far ahead
      const tau = CA.obstacleTimeHorizon * Math.min(1, Math.max(0.25, (d * d) / 100));
      const r = a.radius + b.radius * a.shrink;
      const { point, dir } = orcaLine(a.pref, rel, a.pref, r, tau, 1);
      lines.push({ point, dir, dist: d, keep: true });
    }
    near.sort((x, y) => x.d - y.d);
    for (const { b, d } of near.slice(0, CA.maxAgentNeighbours)) {
      const rel: Vec2 = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]];
      const relVel: Vec2 = [a.vel[0] - b.vel[0], a.vel[1] - b.vel[1]];
      const { point, dir } = orcaLine(a.vel, rel, relVel, a.radius + b.radius, CA.agentTimeHorizon, 0.5);
      lines.push({ point, dir, dist: d, keep: d < 2 * a.radius + b.radius });
    }
    let v = solve(lines, a.pref, a.maxSpeed);
    // nothing allowed: give up on the farthest agents one at a time
    while (!v) {
      let far = -1;
      lines.forEach((l, i) => { if (!l.keep && (far < 0 || l.dist > lines[far].dist)) far = i; });
      if (far < 0) break;
      lines.splice(far, 1);
      v = solve(lines, a.pref, a.maxSpeed);
    }
    results.push(v ?? [0, 0]);
  }
  solving.forEach((a, i) => {
    const v = results[i];
    const changed = Math.hypot(v[0] - a.pref[0], v[1] - a.pref[1]) > 1e-3;
    a.shrink = changed ? Math.max(CA.shrinkMin, a.shrink - CA.shrinkIncreaseRate * dt) : Math.min(1, a.shrink + CA.shrinkDecreaseRate * dt);
    a.vel = v;
  });
  for (const a of agents) if (a.avoids && a.pref[0] === 0 && a.pref[1] === 0) a.vel = [0, 0];
  for (const a of moving) if (!solving.includes(a)) a.vel = a.pref;
}
