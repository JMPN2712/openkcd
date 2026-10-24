// Install the game from GOG's installers into the browser's private storage
// (OPFS): the installers' .pak files are streamed out, inflated and written
// under game/, in the game's folder layout, so the engine opens that copy
// like an installed game folder. Nothing is uploaded. Interrupted runs
// resume: a file that is already there at its full size is skipped, and a
// file being written only appears once it is complete. Afterwards the paks
// can be repacked without the files later patches replace (repack.ts).

import { planRepack, repackedPak, repackedSize } from "./repack.ts";
import { checkSlice, readFile, readInstaller, sliceName, sliceSource, type Installer, type InstallerFile } from "./inno.ts";

export const GAME_DIR = "game";
/** Repacked paks and their original sizes, so a rerun doesn't take them for unfinished copies. */
const REPACKED = "repacked.json";

/** One installer found in the picked folder. */
export interface FoundInstaller {
  name: string; // .exe file name
  label: string; // product name from the installer
  installer: Installer;
  /** bytes of all its .pak files */
  size: number;
  /** damaged .bin files; the installer can't be used while this is non-empty */
  problems: string[];
  /** .bin slices not in the folder (yet): the install goes as far as it can without them (part by part) */
  missing: number[];
  /** whether slice `i` is in the folder */
  has(index: number): boolean;
  slice: (index: number) => Promise<Blob>;
}

/** The engine only reads .pak archives; executables, DLLs and GOG's metadata stay behind. */
export function isPak(f: InstallerFile): boolean {
  return f.path.toLowerCase().endsWith(".pak");
}

/** What an optional pak is for; "core" paks are always installed. */
export type PakKind = "core" | "voice" | "hd-textures" | "hd-voice" | "hd-sound";

/**
 * Sort a pak by what it holds. Localization paks are voice-over per
 * language ("English.pak", "IPL_English.pak", "English_DLC4.pak",
 * "english_patch_010900.pak", …) except "*_xml.pak", the text and subtitles
 * of every language (a few MB each), and common.pak; those always go in.
 */
export function pakKind(path: string): { kind: PakKind; language?: string } {
  const p = path.toLowerCase();
  const name = p.slice(p.lastIndexOf("/") + 1);
  if (p.startsWith("localization/")) {
    if (name.includes("_xml") || name === "common.pak") return { kind: "core" };
    if (name.includes("_hd")) return { kind: "hd-voice", language: voiceLanguage(name) };
    return { kind: "voice", language: voiceLanguage(name) };
  }
  if (name.includes("_hd")) return { kind: name.startsWith("sounds_hd") ? "hd-sound" : "hd-textures" };
  return { kind: "core" };
}

function voiceLanguage(name: string): string {
  return name.replace(/^ipl_/, "").split(/[_.-]/)[0];
}

/** What to install: one voice language, and the optional HD packs. */
export interface InstallOptions {
  language: string; // lower case, e.g. "english"
  hdTextures: boolean;
  hdVoice: boolean;
  hdSound: boolean;
  /** leave out the files later patches replace */
  repack: boolean;
  /** the cutscene videos (about 15 GiB; left out of the compact package) */
  videos?: boolean;
}

export const DEFAULT_OPTIONS: InstallOptions = { language: "english", hdTextures: false, hdVoice: false, hdSound: false, repack: true };

/** Cutscene video paks. */
export const isVideoPak = (path: string) => /(^|\/)(ipl_)?videos/i.test(path);

export function wanted(f: InstallerFile, o: InstallOptions): boolean {
  if (!isPak(f)) return false;
  if (o.videos === false && isVideoPak(f.path)) return false;
  const { kind, language } = pakKind(f.path);
  switch (kind) {
    case "core": return true;
    case "voice": return language === o.language;
    case "hd-voice": return o.hdVoice && language === o.language;
    case "hd-textures": return o.hdTextures;
    case "hd-sound": return o.hdSound;
  }
}

/** Voice languages the installers offer, by size, largest first. */
export function voiceLanguages(installers: FoundInstaller[]): string[] {
  const size = new Map<string, number>();
  for (const ins of installers) for (const f of ins.installer.files.filter(isPak)) {
    const { kind, language } = pakKind(f.path);
    if (kind === "voice" && language) size.set(language, (size.get(language) ?? 0) + f.size);
  }
  return [...size].sort((a, b) => b[1] - a[1]).map(([l]) => l);
}

/** Bytes an installer would install with these options. */
export function installSize(ins: FoundInstaller, o: InstallOptions): number {
  return ins.installer.files.filter((f) => wanted(f, o)).reduce((a, f) => a + f.size, 0);
}

type Dir = FileSystemDirectoryHandle;

/**
 * A read-only directory handle over files picked with <input webkitdirectory>
 * (no File System Access API, or a scripted test): just what
 * findInstallers and opening a game folder need. Paths come from webkitRelativePath.
 */
export function dirFromFiles(picked: File[]): Dir {
  type Node = { dirs: Map<string, Node>; files: Map<string, File> };
  const top: Node = { dirs: new Map(), files: new Map() };
  for (const f of picked) {
    const parts = f.webkitRelativePath.split("/").slice(1); // drop the picked folder's own name
    let n = top;
    for (const p of parts.slice(0, -1)) {
      if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), files: new Map() });
      n = n.dirs.get(p)!;
    }
    n.files.set(parts[parts.length - 1] ?? f.name, f);
  }
  const wrap = (n: Node, name: string): Dir =>
    ({
      kind: "directory",
      name,
      async *entries() {
        for (const [k, d] of n.dirs) yield [k, wrap(d, k)];
        for (const [k, f] of n.files) yield [k, { kind: "file", name: k, getFile: async () => f }];
      },
      async *keys() {
        yield* n.dirs.keys();
        yield* n.files.keys();
      },
    }) as unknown as Dir;
  return wrap(top, picked[0]?.webkitRelativePath.split("/")[0] ?? "");
}

async function files(dir: Dir): Promise<Map<string, FileSystemFileHandle>> {
  const out = new Map<string, FileSystemFileHandle>();
  for await (const [name, h] of dir.entries()) if (h.kind === "file") out.set(name.toLowerCase(), h as FileSystemFileHandle);
  return out;
}

/** Look for setup_*.exe installers in a folder and its DLC subfolder (any case). */
export async function findInstallers(root: Dir): Promise<FoundInstaller[]> {
  const dirs: Dir[] = [root];
  for await (const [name, h] of root.entries()) if (h.kind === "directory" && name.toLowerCase() === "dlc") dirs.push(h as Dir);
  const out: FoundInstaller[] = [];
  for (const dir of dirs) {
    const inDir = await files(dir);
    for (const [lower, handle] of inDir) {
      if (!lower.startsWith("setup_") || !lower.endsWith(".exe")) continue;
      const exe = await handle.getFile();
      let installer: Installer;
      try {
        installer = await readInstaller(exe);
      } catch {
        continue; // not one of the GOG installers we can read
      }
      const problems: string[] = [];
      const missing: number[] = [];
      const bins: Blob[] = [];
      for (let i = 0; i < installer.sliceCount; i++) {
        const bin = sliceName(exe.name, i);
        const h = inDir.get(bin.toLowerCase());
        if (!h) {
          missing.push(i);
          continue;
        }
        bins[i] = await h.getFile();
        await checkSlice(bins[i], i).catch((err: Error) => problems.push(err.message));
      }
      const size = installer.files.filter(isPak).reduce((a, f) => a + f.size, 0);
      if (size === 0) continue;
      out.push({
        name: exe.name,
        label: installer.appName,
        installer,
        size,
        problems,
        missing,
        has: (i) => !!bins[i] || (installer.dataOffset > 0 && i === 0),
        slice: sliceSource(installer, exe, async (i) => bins[i]),
      });
    }
  }
  // the base game first, then the DLC by name
  out.sort((a, b) => b.size - a.size);
  return out;
}

/** Where the installed files go; OPFS in the browser, a folder in the Node test. */
export interface Target {
  /** size of the file at `path`, or -1 */
  size(path: string): Promise<number>;
  /** the file at `path`, or null */
  file(path: string): Promise<Blob | null>;
  /** every file's path */
  list(): Promise<string[]>;
  /** write a file; it must only become visible at `path` once complete */
  write(path: string, data: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void>;
}

/** Case-insensitive directory walk, so Hans Capon's "localization/" merges with "Localization/". */
async function subdir(dir: Dir, name: string, create: boolean): Promise<Dir | null> {
  const lower = name.toLowerCase();
  for await (const [n, h] of dir.entries()) if (h.kind === "directory" && n.toLowerCase() === lower) return h as Dir;
  return create ? dir.getDirectoryHandle(name, { create: true }) : null;
}

async function resolve(root: Dir, path: string, create: boolean): Promise<{ dir: Dir; name: string } | null> {
  const parts = path.split("/");
  let dir: Dir | null = root;
  for (const p of parts.slice(0, -1)) {
    dir = await subdir(dir, p, create);
    if (!dir) return null;
  }
  return { dir, name: parts[parts.length - 1] };
}

/** OPFS target: createWritable() writes to a swap file and only replaces the file on close. */
export function opfsTarget(root: Dir): Target {
  async function file(path: string): Promise<File | null> {
    const at = await resolve(root, path, false);
    if (!at) return null;
    for await (const [n, h] of at.dir.entries()) {
      if (h.kind === "file" && n.toLowerCase() === at.name.toLowerCase()) return (h as FileSystemFileHandle).getFile();
    }
    return null;
  }
  return {
    file,
    size: async (path) => (await file(path))?.size ?? -1,
    async list() {
      const out: string[] = [];
      async function walk(dir: Dir, prefix: string): Promise<void> {
        for await (const [n, h] of dir.entries()) {
          if (h.kind === "directory") await walk(h as Dir, `${prefix}${n}/`);
          else out.push(prefix + n);
        }
      }
      await walk(root, "");
      return out;
    },
    async write(path, data, signal) {
      const at = (await resolve(root, path, true))!;
      const fh = await at.dir.getFileHandle(at.name, { create: true });
      const w = await fh.createWritable();
      try {
        for await (const chunk of data) {
          if (signal?.aborted) throw signal.reason;
          await w.write(chunk as Uint8Array<ArrayBuffer>);
        }
        await w.close();
      } catch (err) {
        await w.abort().catch(() => {});
        // a never-completed new file is left empty; drop it so it doesn't look installed
        if ((await fh.getFile()).size === 0) await at.dir.removeEntry(at.name).catch(() => {});
        throw err;
      }
    },
  };
}

/** The installed copy in OPFS, or null if nothing has been installed. */
export async function installedGame(): Promise<Dir | null> {
  const opfs = await navigator.storage.getDirectory();
  return opfs.getDirectoryHandle(GAME_DIR).catch(() => null);
}

export interface Progress {
  /** copying out of the installers, finding replaced files, or rewriting paks without them */
  phase: "copy" | "plan" | "repack";
  done: number; // bytes written or skipped
  written: number; // bytes written in this run
  total: number;
  file: string; // current file
  filesDone: number;
  files: number;
  skipped: number; // files already installed
  /** paks the repack rewrote, and the bytes it left out (this run) */
  repacked: number;
  removed: number;
  /** .bin slices every wanted file of has been installed from: they may be deleted */
  doneSlices: string[];
}

/**
 * The install needs a .bin slice that isn't in the folder (part by part: every file the slices
 * here hold is installed; add this one, and those after it, and install again to continue).
 */
export class SliceNeeded extends Error {
  readonly slice: string;
  readonly progress: Progress;
  constructor(slice: string, progress: Progress) {
    super(`${slice} is needed next`);
    this.name = "SliceNeeded";
    this.slice = slice;
    this.progress = progress;
  }
}

/** "setup_…-3.bin to -5.bin" style listing of an installer's slices (0-based indexes). */
export function sliceListing(ins: FoundInstaller, slices: number[]): string {
  const names = slices.map((i) => sliceName(ins.name, i));
  return names.length > 3 ? `${names[0]} … ${names[names.length - 1]} (${names.length} files)` : names.join(", ");
}

/** Slices of an installer from which every wanted file has been installed. */
function doneSlices(ins: FoundInstaller, files: InstallerFile[], installed: Set<InstallerFile>): string[] {
  const pending = new Set<number>();
  for (const f of files) if (!installed.has(f)) for (const p of f.parts) for (let s = p.slice; s <= p.lastSlice; s++) pending.add(s);
  const out: string[] = [];
  for (let i = 0; i < ins.installer.sliceCount; i++) if (!pending.has(i) && ins.has(i)) out.push(sliceName(ins.name, i));
  return out;
}

type Repacked = Record<string, { from: number; to: number }>; // by lower-case path

async function readRepacked(target: Target): Promise<Repacked> {
  const f = await target.file(REPACKED);
  return f ? (JSON.parse(await f.text()) as Repacked) : {};
}

async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/** Install every wanted file of the given installers into `target`. */
export async function install(
  installers: FoundInstaller[],
  options: InstallOptions,
  target: Target,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<Progress> {
  const jobs = installers.flatMap((ins) => ins.installer.files.filter((f) => wanted(f, options)).map((f) => ({ ins, f })));
  const p: Progress = { phase: "copy", done: 0, total: jobs.reduce((a, j) => a + j.f.size, 0), written: 0, file: "", filesDone: 0, files: jobs.length, skipped: 0, repacked: 0, removed: 0, doneSlices: [] };
  const repacked = await readRepacked(target);
  const installed = new Set<InstallerFile>();
  const slicesDone = () => installers.flatMap((ins) => doneSlices(ins, jobs.filter((j) => j.ins === ins).map((j) => j.f), installed));
  let needed: { ins: FoundInstaller; slice: number } | null = null;
  for (const { ins, f } of jobs) {
    if (signal?.aborted) throw signal.reason;
    p.file = f.path;
    onProgress(p);
    const size = await target.size(f.path);
    const r = repacked[f.path.toLowerCase()];
    if (size === f.size || (r && r.from === f.size && r.to === size)) {
      p.skipped++;
      installed.add(f);
    } else {
      // part by part: a file whose data is in a slice that isn't here waits for the next run
      const absent = f.parts.flatMap((part) => Array.from({ length: part.lastSlice - part.slice + 1 }, (_, k) => part.slice + k)).filter((s) => !ins.has(s));
      if (absent.length) {
        const first = Math.min(...absent);
        if (!needed || first < needed.slice || needed.ins !== ins) needed = { ins, slice: first };
        continue;
      }
      const before = p.done;
      async function* counted(): AsyncGenerator<Uint8Array> {
        for await (const chunk of readFile(f, ins.slice)) {
          p.done += chunk.byteLength;
          p.written += chunk.byteLength;
          onProgress(p);
          yield chunk;
        }
      }
      await target.write(f.path, counted(), signal);
      p.done = before; // the line below adds the whole file
    }
    p.done += f.size;
    p.filesDone++;
    installed.add(f);
    p.doneSlices = slicesDone();
    onProgress(p);
  }
  if (needed) throw new SliceNeeded(sliceName(needed.ins.name, needed.slice), p);
  if (options.repack) await repack(target, repacked, p, onProgress, signal);
  return p;
}

/** Rewrite the installed paks without the files that later patches replace. */
async function repack(target: Target, repacked: Repacked, p: Progress, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
  const paks = [];
  for (const path of await target.list()) {
    if (!path.toLowerCase().endsWith(".pak")) continue;
    const size = await target.size(path);
    paks.push({ path, size, open: async () => (await target.file(path))! });
  }
  Object.assign(p, { phase: "plan", file: "", done: 0, total: 1 });
  onProgress(p);
  const plans = (await planRepack(paks, (done, total) => {
    p.done = done;
    p.total = total;
    onProgress(p);
  })).filter((plan) => plan.dead.size);
  Object.assign(p, { phase: "repack", done: 0, total: plans.reduce((a, plan) => a + repackedSize(plan), 0) });
  for (const plan of plans) {
    if (signal?.aborted) throw signal.reason;
    p.file = plan.pak.path;
    const before = p.done;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const chunk of repackedPak(await plan.pak.open(), plan)) {
        p.done += chunk.byteLength;
        onProgress(p);
        yield chunk;
      }
    }
    await target.write(plan.pak.path, counted(), signal);
    const key = plan.pak.path.toLowerCase();
    const to = repackedSize(plan);
    repacked[key] = { from: repacked[key]?.from ?? plan.pak.size, to };
    await target.write(REPACKED, bytes(JSON.stringify(repacked)));
    p.done = before + to;
    p.removed += plan.pak.size - to;
    p.repacked++;
    onProgress(p);
  }
}
