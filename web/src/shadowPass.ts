// One frame's shadow cascades: per cascade, pick the casters in the light's view (their own LOD
// selection, limited to the shadow distance) and draw them, with the NPCs and Henry, depth only.

import type { ModelRenderer } from "./renderer.ts";
import type { ShadowMap } from "./shadow.ts";
import { selectLods, type WorldScene } from "./world.ts";
import type { Vec3 } from "./mat4.ts";

export class ShadowCasters {
  private out: Float32Array[][] = [];
  private counts: number[][] = [];
  private scene: WorldScene | null = null;
  private frame = 0;

  /** Per-cascade instance buffers sized for a scene's items (lodItems order). */
  setScene(scene: WorldScene, capacities: number[], cascades: number): void {
    this.scene = scene;
    this.out = Array.from({ length: cascades }, () => capacities.map((c) => new Float32Array(c * 16)));
    this.counts = Array.from({ length: cascades }, () => capacities.map(() => 0));
  }

  /**
   * Place the cascades and record their passes: `world` holds the scene's items, `others` (NPCs,
   * the player) cast with all their parts. `toLight` points at the sun (or moon).
   */
  render(enc: GPUCommandEncoder, map: ShadowMap, eye: Vec3, fwd: Vec3, toLight: Vec3, world: ModelRenderer, others: ModelRenderer[], opts: { lodScale?: number } = {}): void {
    if (!map.cascades || !this.scene) return;
    if (toLight[2] < 0.03) { map.disable(); return; }
    // the far cascade is redrawn every second frame (its lag doesn't show at that distance)
    this.frame++;
    const due = (c: number) => c === 0 || map.cascades === 1 || this.frame % 2 === 0;
    map.update(eye, fwd, toLight, 250, due);
    for (let c = 0; c < map.cascades; c++) {
      if (!due(c)) continue;
      const vp = map.viewProj[c];
      if (this.out[c]) {
        // small casters (grass, clutter) barely show in shadow: none under 0.25 m near, 1 m far
        const last = c === map.cascades - 1 && map.cascades > 1;
        selectLods(this.scene, eye, vp, this.out[c], this.counts[c], { lodScale: (opts.lodScale ?? 1) * 0.5, maxDistance: map.splits[map.cascades - 1], minRadius: last ? 1 : 0.25 });
        this.counts[c].forEach((n, k) => world.setShadowInstances(c, k, this.out[c][k], n));
      }
      for (const r of [world, ...others]) r.setShadowCamera(c, vp);
      const pass = map.beginPass(enc, c);
      world.drawShadow(pass, c);
      for (const r of others) r.drawShadow(pass, c);
      pass.end();
    }
  }
}
