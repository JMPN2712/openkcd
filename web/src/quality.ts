// Quality presets. Every feature has a Potato setting for the low-end target (AMD Vega 7 laptop,
// 16 GB RAM). The world view and scripts/bench-presets.ts read these.

export type PresetName = "potato" | "low" | "medium" | "high";

export interface QualityPreset {
  label: string;
  /** render resolution relative to the canvas (device pixels, capped at 2× DPR) */
  renderScale: number;
  /** MSAA samples (1 or 4) */
  msaa: 1 | 4;
  /** metres of objects streamed around the player */
  streamRadius: number;
  /** object view distance and LOD switch distance multipliers (world.ts selectLods) */
  distanceScale: number;
  lodScale: number;
  /** terrain: full-resolution patches within this distance (terrainRenderer.ts) */
  terrainLod: number;
  /** NPCs shown at most */
  npcMax: number;
  /** texture side objects and characters load at first (decals, grass and leaves: 4×) */
  maxTextureDim: number;
  /** streamed textures (texturePool.ts): the largest side loaded for what is near, and the GPU memory for them */
  textures: { maxDim: number; budgetMiB: number };
  /** terrain detail layers: texture side and the distance (m) over which they fade out */
  terrainDetail: number;
  detailFade: [number, number];
  /** objects' normal maps */
  normalMaps: boolean;
  /** grass and ground plants (merged-mesh sectors): drawn within this radius (m), shrinking into the ground over its last third */
  grass: number;
  /**
   * Dynamic resolution: the scene is drawn at a scale of the canvas between `min` and `max`,
   * adjusted to keep the GPU's frame time near `targetMs`, then upscaled with sharpening
   * (upscale.ts). Without it the canvas itself is sized by renderScale.
   */
  upscale?: { min: number; max: number; targetMs: number; sharpness: number };
  /** far-tree cards drawn within this distance (m; the low presets leave the farthest hills' forests to the terrain colour) */
  farTrees: number;
  /** sun shadows: cascades (0 = off), map size, and where each cascade ends (m) */
  shadows: { cascades: 0 | 1 | 2; size: number; splits: number[] };
  /** occlusion culling by the level's occluder shells (occlusion.ts): saves GPU time where much is
   * drawn, costs about 0.3–0.7 ms of CPU a frame, more than it saves at Potato's distances */
  occlusion: boolean;
}

export const PRESETS: Record<PresetName, QualityPreset> = {
  potato: { grass: 20, farTrees: 2000, label: "Potato", renderScale: 0.5, msaa: 1, streamRadius: 200, distanceScale: 0.45, lodScale: 0.5, terrainLod: 100, npcMax: 8, maxTextureDim: 128, textures: { maxDim: 512, budgetMiB: 256 }, normalMaps: false, terrainDetail: 256, detailFade: [25, 80], shadows: { cascades: 0, size: 1, splits: [] }, occlusion: false },
  low: { grass: 35, farTrees: 3000, label: "Low", renderScale: 0.75, msaa: 1, streamRadius: 300, distanceScale: 0.65, lodScale: 0.7, terrainLod: 160, npcMax: 16, maxTextureDim: 256, textures: { maxDim: 1024, budgetMiB: 640 }, normalMaps: true, terrainDetail: 256, detailFade: [35, 120], shadows: { cascades: 1, size: 1024, splits: [40] }, occlusion: true },
  // the new Medium (2026-10-31): no MSAA, the scene drawn at 0.5–1× and upscaled, aiming at 14 ms
  // of GPU time (MSAA and full resolution each took about a fifth of the frame on the 2-CU Radeon)
  medium: { grass: 55, farTrees: Infinity, label: "Medium", renderScale: 1, msaa: 1, upscale: { min: 0.5, max: 1, targetMs: 14, sharpness: 0.5 }, streamRadius: 500, distanceScale: 1, lodScale: 1, terrainLod: 250, npcMax: 40, maxTextureDim: 256, textures: { maxDim: 1024, budgetMiB: 1024 }, normalMaps: true, terrainDetail: 512, detailFade: [40, 160], shadows: { cascades: 2, size: 2048, splits: [20, 120] }, occlusion: true },
  high: { grass: 80, farTrees: Infinity, label: "High", renderScale: 1, msaa: 4, streamRadius: 700, distanceScale: 1.4, lodScale: 1.3, terrainLod: 350, npcMax: 60, maxTextureDim: 512, textures: { maxDim: 2048, budgetMiB: 2048 }, normalMaps: true, terrainDetail: 512, detailFade: [60, 220], shadows: { cascades: 2, size: 3072, splits: [25, 160] }, occlusion: true },
};

const KEY = "openkcd.quality";

/** The saved preset (Medium when none or storage is unavailable). */
export function savedPreset(): PresetName {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    if (v && v in PRESETS) return v as PresetName;
  } catch {
    // private windows and blocked storage
  }
  return "medium";
}

export function savePreset(p: PresetName): void {
  try {
    globalThis.localStorage?.setItem(KEY, p);
  } catch {
    // not saved; the choice still applies until reload
  }
}
