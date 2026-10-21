import "./style.css";
import { readCentralDirectory, type PakEntry } from "./zip.ts";
import { buildTree, sortedDirs, sortedFiles, baseName, type TreeDir } from "./tree.ts";
import { classify, looksLikeGameRoot, scanDirectory, OWNER_ORDER, type Owner, type PakSource } from "./paks.ts";
import { showPreview, type PreviewHooks } from "./preview.ts";
import { showTexture, type TextureContext } from "./textureView.ts";
import { showCharacter, showCharacterBrowser } from "./characterView.ts";
import { showLevel } from "./levelView.ts";
import { ASSET_RE } from "./assets.ts";
import { Vfs } from "./vfs.ts";
import { formatCount, formatSize } from "./format.ts";
import { dirFromFiles, installedGame } from "./install.ts";
import { showInstall } from "./installView.ts";

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLSpanElement>("status");
const paksEl = $<HTMLElement>("pak-groups");
const charactersBtn = $<HTMLButtonElement>("characters");
const worldBtn = $<HTMLButtonElement>("world");
const treeEl = $<HTMLDivElement>("tree");
const previewEl = $<HTMLElement>("preview");
const titleEl = $<HTMLSpanElement>("pak-title");
const filterEl = $<HTMLInputElement>("filter");

const CHILD_PAGE = 500;
const FILTER_LIMIT = 2000;

interface LoadedPak {
  source: PakSource;
  blob: Blob;
  entries: PakEntry[];
  tree: TreeDir;
}

const cache = new Map<string, Promise<LoadedPak>>();
let current: LoadedPak | null = null;
let selectedRow: HTMLElement | null = null;
let allPaks: PakSource[] = [];

// Asset VFS (textures, models, materials) over every pak, built on first use.
const vfsCache = new Map<boolean, Promise<Vfs>>();
const textures: TextureContext = {
  hasHd: false,
  includeHd: true,
  setIncludeHd(v) {
    this.includeHd = v;
  },
  vfs(includeHd, onProgress) {
    let v = vfsCache.get(includeHd);
    if (!v) {
      v = Vfs.build(allPaks, { filter: (n) => ASSET_RE.test(n), includeHd, onProgress });
      v.catch(() => vfsCache.delete(includeHd));
      vfsCache.set(includeHd, v);
    }
    return v;
  },
};

const hooks: PreviewHooks = {
  textures,
  openTexture(stem) {
    selectedRow?.classList.remove("selected");
    selectedRow = null;
    const head = el("div", "preview-head");
    head.append(el("div", "preview-path", stem));
    const body = el("div", "preview-body");
    previewEl.replaceChildren(head, body);
    void showTexture(body, textures, stem, hooks.openTexture);
  },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setStatus(msg: string, kind: "" | "error" = ""): void {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

// ---------- open folder ----------

$<HTMLButtonElement>("open").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    setStatus("This browser has no File System Access API. Use Chrome or Chromium.", "error");
    return;
  }
  let root: FileSystemDirectoryHandle;
  try {
    root = await window.showDirectoryPicker({ id: "kcd-root", mode: "read" });
  } catch {
    return; // user cancelled
  }
  await openGame(root, root.name);
});

/** Open a game root: a picked game folder, or the copy installed into browser storage. */
async function openGame(root: FileSystemDirectoryHandle, label: string, installed = false): Promise<void> {
  setStatus(`Scanning ${label}…`);
  try {
    // the installed copy holds only the paks, so it has Data but no bin
    if (!installed && !(await looksLikeGameRoot(root))) {
      setStatus(`"${label}" has no Data and bin folders. Pick the game root (e.g. ~/kcd1).`, "error");
      return;
    }
    const paks = await scanDirectory(root);
    cache.clear();
    vfsCache.clear();
    allPaks = paks;
    textures.hasHd = paks.some((p) => p.path.toLowerCase().includes("_hd"));
    charactersBtn.disabled = false;
    worldBtn.disabled = !paks.some((p) => p.path.toLowerCase() === "data/levels/rataje/level.pak");
    renderPakList(paks);
    const total = paks.reduce((s, p) => s + p.size, 0);
    setStatus(`${label}: ${paks.length} archives, ${formatSize(total)}. Read locally, nothing uploaded.`);
  } catch (err) {
    setStatus(`Scan failed: ${(err as Error).message}`, "error");
  }
}

// ---------- install from the GOG installer ----------

const installedBtn = $<HTMLButtonElement>("installed");

async function refreshInstalled(): Promise<FileSystemDirectoryHandle | null> {
  const game = await installedGame().catch(() => null);
  let ok = false;
  if (game) for await (const [name, h] of game.entries()) if (h.kind === "directory" && name.toLowerCase() === "data") ok = true;
  installedBtn.hidden = !ok;
  return ok ? game : null;
}

installedBtn.addEventListener("click", async () => {
  const game = await refreshInstalled();
  if (game) await openGame(game, "Installed copy (browser storage)", true);
});

function startInstall(dir: FileSystemDirectoryHandle): void {
  document.querySelectorAll(".pak.active, .side-action.active").forEach((b) => b.classList.remove("active"));
  const head = el("div", "preview-head");
  head.append(el("div", "preview-path", `Install from the GOG installer: ${dir.name}`));
  const body = el("div", "preview-body");
  previewEl.replaceChildren(head, body);
  void showInstall(body, dir, async () => {
    const game = await refreshInstalled();
    if (game) await openGame(game, "Installed copy (browser storage)", true);
  });
}

// without the File System Access API, a plain folder input does the same job
const installInput = $<HTMLInputElement>("install-input");
installInput.addEventListener("change", () => {
  const files = [...(installInput.files ?? [])];
  if (files.length) startInstall(dirFromFiles(files));
});

$<HTMLButtonElement>("install").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    installInput.click();
    return;
  }
  try {
    startInstall(await window.showDirectoryPicker({ id: "kcd-installer", mode: "read" }));
  } catch {
    // user cancelled
  }
});

// dropping the installer folder anywhere on the page starts the same flow
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const item = [...(e.dataTransfer?.items ?? [])].find((i) => i.kind === "file");
  const handle = await (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })?.getAsFileSystemHandle?.();
  if (handle?.kind === "directory") startInstall(handle as FileSystemDirectoryHandle);
  else setStatus("Drop the folder that holds the installer (setup_….exe and its .bin files), not single files.", "error");
});

void refreshInstalled();

// ---------- pak list ----------

// ---------- world ----------

worldBtn.addEventListener("click", () => {
  document.querySelectorAll(".pak.active, .side-action.active").forEach((b) => b.classList.remove("active"));
  worldBtn.classList.add("active");
  const head = el("div", "preview-head");
  head.append(el("div", "preview-path", "data/levels/rataje: terrain"));
  const body = el("div", "preview-body");
  previewEl.replaceChildren(head, body);
  void showLevel(body, allPaks, "rataje");
});

// ---------- characters (game database) ----------

charactersBtn.addEventListener("click", () => {
  document.querySelectorAll(".pak.active").forEach((b) => b.classList.remove("active"));
  charactersBtn.classList.add("active");
  current = null;
  titleEl.textContent = "Characters: NPC souls and clothing presets, assembled from Libs/Tables";
  filterEl.value = "";
  filterEl.disabled = true;
  void showCharacterBrowser(treeEl, textures, (name, resolve) => {
    const head = el("div", "preview-head");
    head.append(el("div", "preview-path", name));
    const body = el("div", "preview-body");
    previewEl.replaceChildren(head, body);
    void showCharacter(body, textures, resolve, hooks.openTexture);
  });
});

function renderPakList(paks: PakSource[]): void {
  paksEl.replaceChildren();
  const groups = new Map<Owner, PakSource[]>();
  for (const p of paks) {
    const o = classify(p.path);
    if (!groups.has(o)) groups.set(o, []);
    groups.get(o)!.push(p);
  }
  for (const owner of OWNER_ORDER) {
    const list = groups.get(owner);
    if (!list) continue; // DLC is optional: show whatever is installed
    const size = list.reduce((s, p) => s + p.size, 0);
    const details = el("details", "group");
    details.open = owner === "Base" || owner.startsWith("DLC");
    const summary = el("summary");
    summary.append(el("span", "group-name", owner), el("span", "dim", `${list.length} · ${formatSize(size)}`));
    details.append(summary);
    const ul = el("ul", "pak-list");
    for (const p of list) {
      const li = el("li");
      const btn = el("button", "pak", undefined);
      btn.type = "button";
      btn.title = p.path;
      btn.append(el("span", "pak-name", p.path), el("span", "dim", formatSize(p.size)));
      btn.addEventListener("click", () => {
        charactersBtn.classList.remove("active");
        paksEl.querySelectorAll(".pak.active").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        void openPak(p);
      });
      li.append(btn);
      ul.append(li);
    }
    details.append(ul);
    paksEl.append(details);
  }
  if (!paks.length) paksEl.append(el("p", "dim", "No .pak files found."));
}

function loadPak(source: PakSource): Promise<LoadedPak> {
  let p = cache.get(source.path);
  if (!p) {
    p = (async () => {
      const blob = await source.open();
      const entries = await readCentralDirectory(blob);
      return { source, blob, entries, tree: buildTree(entries) };
    })();
    p.catch(() => cache.delete(source.path));
    cache.set(source.path, p);
  }
  return p;
}

async function openPak(source: PakSource): Promise<void> {
  titleEl.textContent = `${source.path}: reading central directory…`;
  treeEl.replaceChildren();
  previewEl.replaceChildren();
  filterEl.value = "";
  filterEl.disabled = true;
  const t0 = performance.now();
  try {
    const pak = await loadPak(source);
    current = pak;
    const ms = Math.round(performance.now() - t0);
    titleEl.textContent = `${source.path}: ${formatCount(pak.entries.length)} files, ${formatSize(pak.tree.size)} uncompressed (${ms} ms)`;
    filterEl.disabled = false;
    renderTree();
  } catch (err) {
    titleEl.textContent = `${source.path}: ${(err as Error).message}`;
  }
}

// ---------- tree ----------

function renderTree(): void {
  if (!current) return;
  treeEl.replaceChildren(renderChildren(current.tree, 0));
}

function renderChildren(dir: TreeDir, depth: number): HTMLUListElement {
  const ul = el("ul", "tree-list");
  const items: (TreeDir | PakEntry)[] = [...sortedDirs(dir), ...sortedFiles(dir)];
  appendPage(ul, items, 0, depth);
  return ul;
}

function appendPage(ul: HTMLUListElement, items: (TreeDir | PakEntry)[], start: number, depth: number): void {
  const end = Math.min(items.length, start + CHILD_PAGE);
  for (let i = start; i < end; i++) {
    const it = items[i];
    ul.append("dirs" in it ? dirRow(it, depth) : fileRow(it, depth, baseName(it.name)));
  }
  if (end < items.length) {
    const li = el("li");
    const more = el("button", "more", `Show ${Math.min(CHILD_PAGE, items.length - end)} more of ${formatCount(items.length - end)}…`);
    more.type = "button";
    more.style.paddingLeft = `${depth * 16 + 22}px`;
    more.addEventListener("click", () => {
      li.remove();
      appendPage(ul, items, end, depth);
    });
    li.append(more);
    ul.append(li);
  }
}

function dirRow(d: TreeDir, depth: number): HTMLLIElement {
  const li = el("li");
  const row = el("button", "row dir");
  row.type = "button";
  row.style.paddingLeft = `${depth * 16 + 4}px`;
  row.append(el("span", "twisty", "▸"), el("span", "name", d.name + "/"), el("span", "dim", `${formatCount(d.fileCount)} · ${formatSize(d.size)}`));
  let child: HTMLUListElement | null = null;
  row.addEventListener("click", () => {
    if (child) {
      child.remove();
      child = null;
      row.classList.remove("open");
    } else {
      child = renderChildren(d, depth + 1);
      li.append(child);
      row.classList.add("open");
    }
  });
  li.append(row);
  return li;
}

function fileRow(e: PakEntry, depth: number, label: string): HTMLLIElement {
  const li = el("li");
  const row = el("button", "row file");
  row.type = "button";
  row.title = e.name;
  row.style.paddingLeft = `${depth * 16 + 22}px`;
  row.append(el("span", "name", label), el("span", "dim", formatSize(e.usize)));
  row.addEventListener("click", () => {
    selectedRow?.classList.remove("selected");
    row.classList.add("selected");
    selectedRow = row;
    if (current) void showPreview(previewEl, current.blob, e, hooks);
  });
  li.append(row);
  return li;
}

// ---------- filter ----------

let filterTimer = 0;
filterEl.addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = window.setTimeout(applyFilter, 150);
});

function applyFilter(): void {
  if (!current) return;
  const q = filterEl.value.trim().toLowerCase().replaceAll("\\", "/");
  if (!q) return renderTree();
  const hits: PakEntry[] = [];
  let total = 0;
  for (const e of current.entries) {
    if (e.name.toLowerCase().includes(q)) {
      total++;
      if (hits.length < FILTER_LIMIT) hits.push(e);
    }
  }
  const ul = el("ul", "tree-list");
  for (const e of hits) ul.append(fileRow(e, 0, e.name));
  const note = el("p", "dim filter-note", total > hits.length
    ? `${formatCount(total)} matches; showing the first ${formatCount(hits.length)}.`
    : `${formatCount(total)} matches.`);
  treeEl.replaceChildren(note, ul);
}
