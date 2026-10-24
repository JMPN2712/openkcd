// Installing the compact package straight from the GOG installers (docs/SLIM.md, phase 4): no
// copy of the game is kept, only the package and its file store.
//
// - Every .bin slice in the folder: the package and its store are built reading the paks in
//   place from the installer (installerPak.ts). Storage only ever holds what is kept.
// - Part by part (slices missing): each wanted pak whose slices are all here is copied into OPFS
//   compact-staging/ without what the package will never need: the files a higher-ranked pak
//   already seen replaces, and for Potato the texture mips above 512 px (kept in the staging
//   record by size only, as phantom entries, so the build still picks the same texture versions).
//   Paks staged earlier lose the files a pak added later replaces. The slices are asked for last
//   to first, base game then DLC: the patches are in the base game's last slices, so they come
//   first and little is staged that a patch then replaces. The install stops with SliceNeeded,
//   naming the next slice and the ones done with (which may be deleted).
//   Once every pak is staged, the package is built from the staging copy and the store written
//   pak by pak, each staged pak deleted as soon as its store copy is written. Interrupted then
//   (cancelled, or the tab closed), it carries on from the saved store plan.

import { DEFAULT_OPTIONS, install, isVideoPak, opfsTarget, SliceNeeded, wanted, type FoundInstaller, type InstallOptions, type Progress } from "./install.ts";
import { readFile, sliceName, type InstallerFile } from "./inno.ts";
import { installerPak, PartCache } from "./installerPak.ts";
import { scanDirectory, type PakSource } from "./paks.ts";
import { planRepack, repackedPak, type PakPlan } from "./repack.ts";
import { openTexture, splitCount, TEXTURE_RE, textureStem } from "./texture.ts";
import { mipDims, parseDdsHeader, type DdsHeader } from "./dds.ts";
import { Vfs } from "./vfs.ts";
import type { PakEntry } from "./zip.ts";
import { buildSlimInBrowser, packageStore, storeInProgress, type SlimVariant } from "./slimView.ts";
import { clearLevelCaches } from "./levelData.ts";

const STAGING = "compact-staging";
/** What is staged: by lower-case path, the pak's original size and its phantom entries. */
const STAGED = "staged.json";
/** Texture size above which a Potato package and store keep no mips (as slimStore's textureCap). */
const POTATO_CAP = 512;
/** A staged pak is rewritten without newly replaced files once they reach this size. */
const REWRITE_AT = 16 * 2 ** 20;

interface StagedRecord {
  paks: Record<string, { path: string; from: number; phantoms: [name: string, usize: number, csize: number][] }>;
}

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
    const staging = await opfs.getDirectoryHandle(STAGING, { create: true });
    // part by part: throws SliceNeeded until every wanted pak is staged (unless a build was
    // interrupted while writing the store: everything was staged then)
    if (!(await storeInProgress(variant))) await stage(installers, opts, staging, variant === "potato", (progress) => onProgress({ stage: "install", progress }), signal);
    const paks = await stagedPaks(staging, await readRecord(staging));
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

/**
 * The cutscene videos, added to a built package's store on demand (the package is made without
 * them): their paks as they are, part by part like any install (SliceNeeded) when slices are
 * missing.
 */
export async function addVideos(installers: FoundInstaller[], variant: SlimVariant, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<Progress> {
  const store = await packageStore(variant);
  if (!store) throw new Error(`no ${variant} compact package to add the videos to`);
  return install(installers, { ...DEFAULT_OPTIONS, videos: true, repack: false, only: isVideoPak }, opfsTarget(store), onProgress, signal);
}

export async function readRecord(staging: FileSystemDirectoryHandle): Promise<StagedRecord> {
  try {
    return JSON.parse(await (await (await staging.getFileHandle(STAGED)).getFile()).text()) as StagedRecord;
  } catch {
    return { paks: {} };
  }
}

async function writeRecord(staging: FileSystemDirectoryHandle, record: StagedRecord): Promise<void> {
  const w = await (await staging.getFileHandle(STAGED, { create: true })).createWritable();
  await w.write(JSON.stringify(record));
  await w.close();
}

const phantomEntries = (list: StagedRecord["paks"][string]["phantoms"]): PakEntry[] =>
  // (offsets that match no real entry)
  list.map(([name, usize, csize], i) => ({ name, usize, csize, method: 8, flags: 0, crc: 0, offset: -1 - i, record: 0, recordLen: 0 }));

/** The staged paks the record lists (a pak written but not yet recorded is staged again), with their phantoms. */
export async function stagedPaks(staging: FileSystemDirectoryHandle, record: StagedRecord): Promise<PakSource[]> {
  const out: PakSource[] = [];
  for (const pak of await scanDirectory(staging)) {
    const r = record.paks[pak.path.toLowerCase()];
    if (!r) continue;
    if (r.phantoms.length) pak.phantoms = phantomEntries(r.phantoms);
    out.push(pak);
  }
  return out;
}

const slicesOf = (f: InstallerFile) => [...new Set(f.parts.flatMap((p) => Array.from({ length: p.lastSlice - p.slice + 1 }, (_, k) => p.slice + k)))];

/** Stage every wanted pak the slices here hold; SliceNeeded while some are left. */
export async function stage(
  installers: FoundInstaller[],
  opts: InstallOptions,
  staging: FileSystemDirectoryHandle,
  potato: boolean,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const target = opfsTarget(staging);
  const record = await readRecord(staging);
  const jobs = installers.flatMap((ins) => ins.installer.files.filter((f) => wanted(f, opts)).map((f) => ({ ins, f })));
  const isStaged = (f: InstallerFile) => !!record.paks[f.path.toLowerCase()];
  const p: Progress = { phase: "copy", done: 0, total: jobs.reduce((a, j) => a + j.f.size, 0), written: 0, file: "", filesDone: 0, files: jobs.length, skipped: 0, repacked: 0, removed: 0, doneSlices: [] };
  for (const j of jobs) if (isStaged(j.f)) { p.done += j.f.size; p.filesDone++; p.skipped++; }
  const ready = jobs.filter((j) => !isStaged(j.f) && slicesOf(j.f).every((s) => j.ins.has(s)));
  if (ready.length) {
    p.file = "what the new archives replace";
    onProgress(p);
    const cache = new PartCache(64);
    const fresh = new Map<PakSource, { ins: FoundInstaller; f: InstallerFile }>(ready.map((j) => [installerPak(j.f, j.ins.slice, cache), j]));
    const staged = await stagedPaks(staging, record);
    const all = [...staged, ...fresh.keys()];
    // what the paks seen so far replace, in the new paks and the staged ones
    const plans = new Map<PakSource, PakPlan>((await planRepack(all, undefined, new Set(fresh.keys()))).map((plan) => [plan.pak, plan]));
    signal?.throwIfAborted();
    const texVfs = potato ? await Vfs.build(all, { filter: (n) => TEXTURE_RE.test(n), includeHd: false }) : null;
    const headers = new Map<string, Promise<{ header: DdsHeader; K: number }[] | null>>();
    for (const [src, { ins, f }] of fresh) {
      signal?.throwIfAborted();
      p.file = f.path;
      onProgress(p);
      // (no plan for level paks: never repacked)
      const plan = plans.get(src);
      const phantoms: PakEntry[] = [];
      if (plan && texVfs) for (const e of plan.entries) if (!plan.dead.has(e) && (await tooLarge(texVfs, headers, e.name))) phantoms.push(e);
      const before = p.done;
      const count = async function* (chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
        for await (const chunk of chunks) {
          p.done = Math.min(before + f.size, p.done + chunk.byteLength);
          p.written += chunk.byteLength;
          onProgress(p);
          yield chunk;
        }
      };
      if (plan && (plan.dead.size || phantoms.length)) {
        for (const e of phantoms) plan.dead.add(e);
        await target.write(f.path, count(repackedPak(await src.open(), plan)), signal);
      } else {
        // nothing to leave out (level paks among them): as it comes
        await target.write(f.path, count(readFile(f, ins.slice)), signal);
      }
      record.paks[f.path.toLowerCase()] = { path: f.path, from: f.size, phantoms: phantoms.map((e) => [e.name, e.usize, e.csize]) };
      await writeRecord(staging, record);
      p.done = before + f.size;
      p.filesDone++;
      p.doneSlices = doneSlices(installers, jobs, isStaged);
      onProgress(p);
    }
    // staged paks that the new ones make partly dead: rewritten without those files
    for (const src of staged) {
      const plan = plans.get(src);
      if (!plan || plan.deadBytes < REWRITE_AT) continue;
      signal?.throwIfAborted();
      p.file = `${src.path} (without what the new archives replace)`;
      onProgress(p);
      // (the write goes to a new copy that replaces the file once complete; the old one is read meanwhile)
      await target.write(src.path, repackedPak(await src.open(), plan), signal);
      p.removed += plan.deadBytes;
    }
  }
  p.doneSlices = doneSlices(installers, jobs, isStaged);
  // the next slice: last to first, the base game's installer (listed first) before the DLC's
  for (const ins of installers) {
    const missing = jobs.filter((j) => j.ins === ins && !isStaged(j.f)).flatMap((j) => slicesOf(j.f)).filter((s) => !ins.has(s));
    if (missing.length) throw new SliceNeeded(sliceName(ins.name, Math.max(...missing)), p);
  }
}

/** Slices here that no pak left to stage needs: they may be deleted. */
function doneSlices(installers: FoundInstaller[], jobs: { ins: FoundInstaller; f: InstallerFile }[], isStaged: (f: InstallerFile) => boolean): string[] {
  const out: string[] = [];
  for (const ins of installers) {
    const pending = new Set(jobs.filter((j) => j.ins === ins && !isStaged(j.f)).flatMap((j) => slicesOf(j.f)));
    for (let i = 0; i < ins.installer.sliceCount; i++) if (!pending.has(i) && ins.has(i)) out.push(sliceName(ins.name, i));
  }
  return out;
}

/**
 * A split mip above the Potato cap under every version of its texture's header seen so far, the
 * highest complete one among them: the package and store will never hold it, whichever wins.
 */
async function tooLarge(vfs: Vfs, cache: Map<string, Promise<{ header: DdsHeader; K: number }[] | null>>, name: string): Promise<boolean> {
  const n = name.toLowerCase();
  const stem = textureStem(n);
  const m = /\.(\d+)a?$/.exec(n);
  if (!stem || stem === n || !m) return false;
  let versions = cache.get(stem);
  if (!versions) {
    cache.set(stem, (versions = (async () => {
      const tex = await openTexture(vfs, stem).catch(() => null);
      if (!tex || tex.partHits.length < tex.splitParts) return null;
      const out = [];
      for (const hit of vfs.lookupAll(stem)) {
        const bytes = await vfs.read(hit);
        const header = parseDdsHeader(bytes);
        out.push({ header, K: splitCount(header, bytes) });
      }
      return out;
    })().catch(() => null)));
  }
  const list = await versions;
  return !!list && list.every(({ header, K }) => {
    const level = K - Number(m[1]);
    return level >= 0 && Math.max(...mipDims(header, level)) > POTATO_CAP;
  });
}
