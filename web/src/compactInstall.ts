// Installing the compact package straight from the GOG installers (docs/SLIM.md, phase 4): no
// copy of the game is kept, only the package and its file store.
//
// - Every .bin slice in the folder: the package and its store are built reading the paks in
//   place from the installer (installerPak.ts). Storage only ever holds what is kept.
// - Part by part (slices missing): the wanted paks are copied whole into OPFS compact-staging/ as
//   the slices allow (install.ts stops with SliceNeeded and lists the slices it is done with,
//   which may be deleted). Once every pak is there, the package is built from that copy, and the
//   store written pak by pak, each staged pak deleted as soon as its store copy is written.
//   Interrupted then (cancelled, or the tab closed), it carries on from the saved store plan: the
//   staged paks already deleted count as installed, so their slices aren't asked for again.

import { install, opfsTarget, wanted, type Target, type FoundInstaller, type InstallOptions, type Progress } from "./install.ts";
import { installerPak, PartCache } from "./installerPak.ts";
import { scanDirectory } from "./paks.ts";
import { buildSlimInBrowser, storeInProgress, type SlimVariant } from "./slimView.ts";
import { clearLevelCaches } from "./levelData.ts";

const STAGING = "compact-staging";

export interface CompactProgress {
  /** "install": copying out of the installers (progress); "build": the package and its store (line) */
  stage: "install" | "build";
  progress?: Progress;
  line?: string;
}

export async function compactInstall(
  installers: FoundInstaller[],
  options: InstallOptions,
  variant: SlimVariant,
  onProgress: (p: CompactProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const opfs = await navigator.storage.getDirectory();
  // what the package and store are made from: one voice language, no videos or HD (and no
  // repack: the store leaves out replaced files itself)
  const opts: InstallOptions = { ...options, videos: false, repack: false, hdTextures: false, hdVoice: false, hdSound: false };
  const build = (line: string) => onProgress({ stage: "build", line });
  // the level data and asset index read before were of other paks with the same paths
  clearLevelCaches();
  try {
    if (installers.every((ins) => ins.missing.length === 0)) {
      // the whole installer is here: read it in place (a part-by-part copy isn't needed any more)
      await opfs.removeEntry(STAGING, { recursive: true }).catch(() => {});
      const cache = new PartCache(64);
      const paks = installers.flatMap((ins) => ins.installer.files.filter((f) => wanted(f, opts)).map((f) => installerPak(f, ins.slice, cache)));
      return await buildSlimInBrowser(paks, variant, build, true, { workers: false, language: opts.language, signal });
    }
    // part by part: throws SliceNeeded until every wanted pak is copied
    const staging = await opfs.getDirectoryHandle(STAGING, { create: true });
    const staged = opfsTarget(staging);
    // a build interrupted while writing the store: the paks it has written (and deleted) count as here
    const written = await storeInProgress(variant);
    const target: Target = written ? { ...staged, size: async (path) => { const n = await staged.size(path); return n >= 0 ? n : written.get(path.toLowerCase()) ?? -1; } } : staged;
    await install(installers, opts, target, (progress) => onProgress({ stage: "install", progress }), signal);
    const paks = await scanDirectory(staging);
    const remove = async (path: string) => {
      const parts = path.split("/");
      let dir = staging;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      await dir.removeEntry(parts[parts.length - 1]);
    };
    const result = await buildSlimInBrowser(paks, variant, build, true, {
      afterStorePak: (source) => remove(source.path).catch(() => {}),
      language: opts.language,
      resumable: true,
      signal,
    });
    // (with what the store didn't need: paks the package holds whole)
    await opfs.removeEntry(STAGING, { recursive: true }).catch(() => {});
    return result;
  } finally {
    clearLevelCaches();
  }
}
