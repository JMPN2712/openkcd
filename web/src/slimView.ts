// The compact package in the browser (docs/SLIM.md, phase 2): building it into OPFS from the
// opened game (the installed copy, or a picked folder), and opening it for the world view.
//
// Each variant has its own folder in OPFS: slim-full/ and slim-potato/ (index.json is written
// last: a folder without it is an interrupted build and is not used).

import type { PakSource } from "./paks.ts";
import { levelData, levelVfs } from "./levelData.ts";
import type { SlimSink } from "./slimBuild.ts";
import { SlimPackage, type SlimFiles } from "./slim.ts";
import type { ReadWorkers } from "./readWorkers.ts";

export type SlimVariant = "full" | "potato";
const dirName = (v: SlimVariant) => `slim-${v}`;

async function opfs(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/** A folder handle for a path inside `root` ("tiles/x.bin" -> tiles/), created on the way when asked. */
async function dirOf(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split("/");
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name: parts[parts.length - 1] };
}

/** Writing a package into an OPFS folder. */
function opfsSink(root: FileSystemDirectoryHandle): SlimSink {
  return {
    async create(file) {
      const { dir, name } = await dirOf(root, file, true);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      return {
        write: (bytes, at) => w.write({ type: "write", position: at, data: bytes as Uint8Array<ArrayBuffer> }),
        close: () => w.close(),
      };
    },
    async writeText(file, text) {
      const { dir, name } = await dirOf(root, file, true);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    },
  };
}

/**
 * Reading a package from an OPFS folder. With read workers, deflated entries are read, inflated
 * and decoded on them (off the main thread); without, here.
 */
export function opfsSlimFiles(root: FileSystemDirectoryHandle, workers?: ReadWorkers): SlimFiles {
  const files = new Map<string, Promise<File>>();
  const file = (path: string) => {
    let f = files.get(path);
    if (!f) files.set(path, (f = dirOf(root, path, false).then(({ dir, name }) => dir.getFileHandle(name)).then((h) => h.getFile())));
    return f;
  };
  return {
    async read(path, at, size) {
      return new Uint8Array(await (await file(path)).slice(at, at + size).arrayBuffer());
    },
    async text(path) {
      return (await file(path)).text();
    },
    decodeOnWorker: workers ? async (path, piece, entries) => workers.slimDecode(path, await file(path), piece, entries) : undefined,
  };
}

/** The variants built (with their index), in OPFS. */
export async function builtSlims(): Promise<SlimVariant[]> {
  const root = await opfs();
  const out: SlimVariant[] = [];
  for (const v of ["full", "potato"] as SlimVariant[]) {
    try {
      const d = await root.getDirectoryHandle(dirName(v));
      await d.getFileHandle("index.json");
      out.push(v);
    } catch {
      // not built (or interrupted)
    }
  }
  return out;
}

/** Open a built package (`prefer` first, else the other one), or null. */
export async function openSlim(prefer: SlimVariant, workers?: ReadWorkers): Promise<SlimPackage | null> {
  const built = await builtSlims();
  const v = built.includes(prefer) ? prefer : built[0];
  if (!v) return null;
  const dir = await (await opfs()).getDirectoryHandle(dirName(v));
  return SlimPackage.open(opfsSlimFiles(dir, workers));
}

/** Deflate with the browser's CompressionStream. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** Build a package into OPFS from the opened game's paks. */
export async function buildSlimInBrowser(paks: PakSource[], variant: SlimVariant, onProgress: (s: string) => void): Promise<string> {
  const t0 = performance.now();
  const data = await levelData(paks, "rataje", onProgress);
  const vfs = await levelVfs(paks, "rataje", onProgress);
  const root = await opfs();
  await root.removeEntry(dirName(variant), { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle(dirName(variant), { create: true });
  let lastShown = 0;
  // (loaded when building: the meshoptimizer encoder stays out of the start-up bundle)
  const { buildSlim } = await import("./slimBuild.ts");
  const { index, sizes } = await buildSlim({ vfs, terrain: data.terrain, objects: data.objects, props: data.props, hiddenLayers: data.hiddenLayers }, opfsSink(dir), {
    potato: variant === "potato",
    deflate,
    onProgress: (what, done, total) => {
      const now = performance.now();
      if (now - lastShown < 200 && done < total) return;
      lastShown = now;
      onProgress(`${what}: ${done}/${total}`);
    },
  });
  const G = (n: number) => `${(n / 2 ** 30).toFixed(2)} GiB`;
  return `${variant} package: ${Object.keys(index.models).length} models, ${Object.keys(index.textures).length} textures, ${G(sizes.models + sizes.inline + sizes.packs)} in ${((performance.now() - t0) / 1000).toFixed(0)} s`;
}

/** The builder's view: pick a variant, build, see the result. */
export function showSlimBuild(host: HTMLElement, paks: PakSource[]): void {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const intro = el("p", "dim", "The world's models, materials and textures, converted once into region chunks in browser storage, so the world loads from a few large reads. Full keeps textures at full resolution; Potato caps them at 512 px for low-end laptops. The game itself is still needed for everything else.");
  const line = el("p", "slim-line note", "");
  const built = el("p", "dim slim-built", "");
  const refresh = () => void builtSlims().then((b) => { built.textContent = b.length ? `Built: ${b.join(", ")}` : "Nothing built yet."; });
  const button = (v: SlimVariant) => {
    const b = el("button", `slim-go slim-${v}`, `Build ${v === "full" ? "Full" : "Potato"} package`);
    b.type = "button";
    b.addEventListener("click", async () => {
      host.querySelectorAll("button").forEach((x) => (x.disabled = true));
      line.className = "slim-line note";
      try {
        line.textContent = await buildSlimInBrowser(paks, v, (s) => { line.textContent = s; });
        line.className = "slim-line note ok";
      } catch (err) {
        line.textContent = `Failed: ${(err as Error).message}`;
        line.className = "slim-line error";
      } finally {
        host.querySelectorAll("button").forEach((x) => (x.disabled = false));
        refresh();
      }
    });
    return b;
  };
  host.replaceChildren(intro, button("full"), button("potato"), line, built);
  refresh();
}
