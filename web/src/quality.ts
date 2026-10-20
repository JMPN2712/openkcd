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
  /** largest texture side loaded for objects and characters */
  maxTextureDim: number;
  /** terrain detail layers: texture side and the distance (m) over which they fade out */
  terrainDetail: number;
  detailFade: [number, number];
  /** sun shadows: cascades (0 = off), map size, and where each cascade ends (m) */
  shadows: { cascades: 0 | 1 | 2; size: number; splits: number[] };
}

export const PRESETS: Record<PresetName, QualityPreset> = {
  potato: { label: "Potato", renderScale: 0.5, msaa: 1, streamRadius: 200, distanceScale: 0.45, lodScale: 0.5, terrainLod: 100, npcMax: 8, maxTextureDim: 128, terrainDetail: 256, detailFade: [25, 80], shadows: { cascades: 0, size: 1, splits: [] } },
  low: { label: "Low", renderScale: 0.75, msaa: 1, streamRadius: 300, distanceScale: 0.65, lodScale: 0.7, terrainLod: 160, npcMax: 16, maxTextureDim: 256, terrainDetail: 256, detailFade: [35, 120], shadows: { cascades: 1, size: 1024, splits: [40] } },
  medium: { label: "Medium", renderScale: 1, msaa: 4, streamRadius: 500, distanceScale: 1, lodScale: 1, terrainLod: 250, npcMax: 40, maxTextureDim: 256, terrainDetail: 512, detailFade: [40, 160], shadows: { cascades: 2, size: 2048, splits: [20, 120] } },
  high: { label: "High", renderScale: 1, msaa: 4, streamRadius: 700, distanceScale: 1.4, lodScale: 1.3, terrainLod: 350, npcMax: 60, maxTextureDim: 512, terrainDetail: 512, detailFade: [60, 220], shadows: { cascades: 2, size: 3072, splits: [25, 160] } },
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
