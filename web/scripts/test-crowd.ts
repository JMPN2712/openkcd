// Collision avoidance (src/crowd.ts) in the classic cases: two NPCs walking
// head-on, one walking past a standing NPC, four crossing at a point. Checks
// that nobody overlaps (centres ≥ 2 radii apart, 5 cm slack) and that all arrive.
// usage: node scripts/test-crowd.ts

import { avoid, CA, NPC_PATH_RADIUS, type CrowdAgent, type Vec2 } from "../src/crowd.ts";

const R = NPC_PATH_RADIUS + CA.agentExtraFat;
const SPEED = 1.4;
let failed = false;

function run(name: string, starts: Vec2[], goals: (Vec2 | null)[]): void {
  const agents: CrowdAgent[] = starts.map((p) => ({ radius: R, pos: [p[0], p[1], 0], vel: [0, 0], pref: [0, 0], maxSpeed: SPEED * 1.3, avoids: false, shrink: 1 }));
  const dt = 1 / 30;
  let minGap = Infinity;
  let t = 0;
  for (; t < 30; t += dt) {
    agents.forEach((a, i) => {
      const g = goals[i];
      if (!g) { a.pref = [0, 0]; a.avoids = false; a.vel = [0, 0]; return; }
      const dx = g[0] - a.pos[0], dy = g[1] - a.pos[1], d = Math.hypot(dx, dy);
      const v = Math.min(SPEED, d / dt);
      a.pref = d > 0.02 ? [(dx / d) * v, (dy / d) * v] : [0, 0];
      a.avoids = d > CA.pathEndCutoff;
      if (!a.avoids) a.vel = a.pref;
    });
    avoid(agents, dt);
    for (const a of agents) { a.pos[0] += a.vel[0] * dt; a.pos[1] += a.vel[1] * dt; }
    for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
      minGap = Math.min(minGap, Math.hypot(agents[i].pos[0] - agents[j].pos[0], agents[i].pos[1] - agents[j].pos[1]));
    }
    if (agents.every((a, i) => !goals[i] || Math.hypot(goals[i]![0] - a.pos[0], goals[i]![1] - a.pos[1]) < 0.05)) break;
  }
  const arrived = agents.every((a, i) => !goals[i] || Math.hypot(goals[i]![0] - a.pos[0], goals[i]![1] - a.pos[1]) < 0.05);
  const ok = minGap >= 2 * R - 0.05 && arrived;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: closest ${minGap.toFixed(2)} m (bodies touch at ${(2 * R).toFixed(2)}), ${arrived ? `all arrived in ${t.toFixed(1)} s` : "not all arrived"}`);
}

run("head-on", [[-5, 0], [5, 0]], [[5, 0], [-5, 0]]);
run("past a standing NPC", [[-5, 0.1], [0, 0]], [[5, 0.1], null]);
run("four crossing", [[-5, 0], [5, 0], [0, -5], [0, 5]], [[5, 0], [-5, 0], [0, 5], [0, -5]]);
run("overtaking a slower plan", [[-6, 0], [-4, 0]], [[6, 0], [4, 0]]);
console.log(failed ? "FAILED" : "OK");
if (failed) process.exit(1);
