// Where a scripted conversation takes place, from the cameras the level places for it. A quest
// switches on a profile of CameraSource entities for a conversation (q_skalitz loads
// q_skalitz_mother_dialog_cameras before Henry's first talk with his mother: cam_26424_mother,
// cam_26424_henry, …). Each looks at one of the two speakers, over the other's shoulder, so their
// view rays meet where the two stand.
//
// OURS (how the game uses these cameras is a research question: type-5 camera cuts, dialogue.md):
// the speakers stand 1.3 m apart either side of the point nearest every camera's view ray; the
// cameras whose names hold "henry" look at Henry, the others at the NPC.

import type { EntityInfo } from "./levelEntities.ts";

export interface ScenePlace {
  henry: [number, number];
  npc: [number, number];
  /** the cameras' height, for the floor search (eye height above the floor) */
  z: number;
}

/** A camera entity's view direction on the ground plane (CryEngine: an entity looks along its +Y). */
function look(e: EntityInfo): [number, number] {
  const [w, x, y, z] = e.rot;
  const fx = 2 * (x * y - w * z), fy = 1 - 2 * (x * x + z * z);
  const n = Math.hypot(fx, fy) || 1;
  return [fx / n, fy / n];
}

/** The place of a conversation framed by these cameras (at least two), or null. */
export function scenePlace(cameras: EntityInfo[]): ScenePlace | null {
  if (cameras.length < 2) return null;
  // least squares: the point P minimising the squared distances to every camera's view line
  let a = 0, b = 0, c = 0, d = 0, e = 0;
  for (const cam of cameras) {
    const [dx, dy] = look(cam);
    // (I − d dᵀ) projects onto the line's normal
    const m00 = 1 - dx * dx, m01 = -dx * dy, m11 = 1 - dy * dy;
    a += m00; b += m01; c += m11;
    d += m00 * cam.pos[0] + m01 * cam.pos[1];
    e += m01 * cam.pos[0] + m11 * cam.pos[1];
  }
  const det = a * c - b * b;
  if (Math.abs(det) < 1e-6) return null;
  const px = (c * d - b * e) / det, py = (a * e - b * d) / det;
  // the speakers' axis: from the cameras on Henry towards the ones on the NPC
  const mean = (list: EntityInfo[]) => list.reduce((s, x) => { const [lx, ly] = look(x); return [s[0] + lx, s[1] + ly]; }, [0, 0]);
  const onHenry = cameras.filter((x) => /henry/i.test(x.name)), onNpc = cameras.filter((x) => !/henry/i.test(x.name));
  if (!onHenry.length || !onNpc.length) return null;
  const h = mean(onHenry), n = mean(onNpc);
  let ax = n[0] - h[0], ay = n[1] - h[1];
  const len = Math.hypot(ax, ay);
  if (len < 1e-3) return null;
  ax /= len; ay /= len;
  const half = 0.65;
  return { henry: [px - ax * half, py - ay * half], npc: [px + ax * half, py + ay * half], z: cameras.reduce((s, x) => s + x.pos[2], 0) / cameras.length };
}
