// The compact package's file store (docs/SLIM.md, phase 3): every file the engine reads that the
// package doesn't hold in converted form (animations, tables, scripts, level files, materials,
// skeletons, audio, …), repacked into paks with the original paths, so that the engine runs from
// the package alone: the paks' own reader, asset index and read workers open them unchanged.
//
// Left out of the store:
// - files a later patch replaces (the installer's repack: repack.ts);
// - models the package holds, and every part of a texture it holds (split mips, attached alpha);
// - cutscene videos (installed on demand later: docs/SLIM.md), other voice languages, HD paks
//   unless asked for (storeSkips).

import type { PakSource } from "./paks.ts";
import { planRepack, repackable, repackedSize, type PakPlan } from "./repack.ts";
import { readZip } from "./zip.ts";
import { openTexture, textureStem, TEXTURE_RE, type Texture } from "./texture.ts";
import { mipDims } from "./dds.ts";
import { Vfs } from "./vfs.ts";
import type { SlimIndex } from "./slim.ts";

/** Paks left out of the store entirely: videos; voice in other languages than `language` (the
 *  small *_xml text paks of every language stay); HD texture paks unless `hd`. */
export function storeSkips(path: string, opts: { language?: string; hd?: boolean } = {}): boolean {
  const p = path.toLowerCase();
  if (/(^|\/)(ipl_)?videos/.test(p)) return true;
  if (!opts.hd && /_hd[-_.]/.test(p)) return true;
  const loc = /^localization\/(ipl_)?([a-z]+)/.exec(p);
  if (loc && LANGUAGES.has(loc[2]) && !p.endsWith("_xml.pak") && loc[2] !== (opts.language ?? "english").toLowerCase()) return true;
  return false;
}

/** Languages the localisation paks are named after (common.pak and patches aren't one). */
const LANGUAGES = new Set(["chinese", "chineses", "czech", "english", "french", "german", "italian", "japanese", "korean", "polish", "portuguese", "russian", "spanish", "turkish", "ukrainian"]);

export interface StorePlan {
  plans: PakPlan[];
  /** bytes kept, and left out because the package holds them in converted form */
  keptBytes: number;
  convertedBytes: number;
  /** texture mips left out above textureCap */
  cappedBytes: number;
  skippedPaks: string[];
}

/** Work out the store's paks from the install's, and the package's index. */
export async function planFileStore(paks: PakSource[], index: SlimIndex, opts: { language?: string; hd?: boolean; textureCap?: number } = {}, onProgress?: (what: string, done: number, total: number) => void): Promise<StorePlan> {
  const kept = paks.filter((p) => !storeSkips(p.path, opts));
  const repack = await planRepack(kept, (d, t) => onProgress?.("Finding replaced files", d, t));
  const byPak = new Map<PakSource, PakPlan>(repack.map((p) => [p.pak, p]));
  // level and HD paks aren't repacked: whole, apart from what the package holds
  for (const pak of kept) {
    if (byPak.has(pak) || repackable(pak.path)) continue;
    const { entries, cdOffset } = await readZip(await pak.open());
    byPak.set(pak, { pak, entries, cdOffset, dead: new Set(), deadBytes: 0 });
  }
  const textures = new Set(Object.keys(index.textures).map((k) => k.split("|")[0]));
  // textureCap (a Potato store): split mip parts larger than it are left out too (part n of K
  // holds level K - n; the reader then starts at the largest level it has)
  const cap = opts.textureCap ?? Infinity;
  const headers = cap < Infinity ? await Vfs.build(kept, { filter: (n) => TEXTURE_RE.test(n), includeHd: !!opts.hd }) : null;
  const opened = new Map<string, Promise<Texture | null>>();
  const tooLarge = async (name: string, stem: string): Promise<boolean> => {
    const m = /\.(\d+)a?$/.exec(name);
    if (!headers || !m) return false;
    let t = opened.get(stem);
    if (!t) opened.set(stem, (t = openTexture(headers, stem).catch(() => null)));
    const tex = await t;
    if (!tex) return false;
    const level = tex.splitParts - Number(m[1]);
    return level >= 0 && Math.max(...mipDims(tex.header, level)) > cap;
  };
  let convertedBytes = 0, cappedBytes = 0, done = 0;
  for (const plan of byPak.values()) {
    for (const e of plan.entries) {
      if (plan.dead.has(e)) continue;
      const name = e.name.toLowerCase();
      const stem = textureStem(name);
      const base = stem?.endsWith(".a") ? stem.slice(0, -2) : stem;
      if (name in index.models || (base && textures.has(base))) {
        plan.dead.add(e);
        plan.deadBytes += e.csize;
        convertedBytes += e.csize;
      } else if (stem && stem !== name && await tooLarge(name, stem)) {
        plan.dead.add(e);
        plan.deadBytes += e.csize;
        cappedBytes += e.csize;
      }
    }
    onProgress?.("Planning the file store", ++done, byPak.size);
  }
  const plans = [...byPak.values()].filter((p) => p.entries.length > p.dead.size);
  return { plans, keptBytes: plans.reduce((a, p) => a + repackedSize(p), 0), convertedBytes, cappedBytes, skippedPaks: paks.filter((p) => storeSkips(p.path, opts)).map((p) => p.path) };
}
