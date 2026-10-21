// The install view: lists the GOG installers found in the picked or dropped
// folder, checks the browser's storage quota, and runs the install into
// OPFS with a progress bar. Resuming is automatic (finished files are skipped).

import {
  DEFAULT_OPTIONS,
  findInstallers,
  GAME_DIR,
  install,
  installSize,
  isPak,
  opfsTarget,
  pakKind,
  voiceLanguages,
  type FoundInstaller,
  type InstallOptions,
  type PakKind,
  type Progress,
} from "./install.ts";
import { formatSize } from "./format.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function duration(s: number): string {
  if (!isFinite(s)) return "…";
  const m = Math.floor(s / 60);
  return m ? `${m} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`;
}

// Chrome grants persistent storage to installed web apps, and offers the install through this event
type InstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let installPrompt: InstallPromptEvent | null = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e as InstallPromptEvent;
});

/** Warn in `note` that storage isn't persistent, with a button to install the app (which usually fixes it). */
function persistWarning(note: HTMLElement): void {
  note.className = "note warn";
  note.textContent = "The browser didn't grant persistent storage, so it may clear the installed files when the disk runs low. Installing OpenKCD as an app (Chrome menu, Cast, save and share, Install page as app) usually fixes that. ";
  if (!installPrompt) return;
  const btn = el("button", "install-go", "Install as app");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    const prompt = installPrompt;
    if (!prompt) return;
    installPrompt = null;
    await prompt.prompt();
    if ((await prompt.userChoice).outcome !== "accepted") return;
    if (await navigator.storage.persist().catch(() => false)) {
      note.className = "note ok";
      note.textContent = "Installed as an app; the browser now keeps the installed files.";
    } else btn.remove();
  });
  note.append(btn);
}

/** Show the install view for `root` in `body`; `onInstalled` runs after a complete install. */
export async function showInstall(body: HTMLElement, root: FileSystemDirectoryHandle, onInstalled: () => void): Promise<void> {
  body.replaceChildren(el("p", "note", `Looking for GOG installers in ${root.name}…`));
  let found: FoundInstaller[];
  try {
    found = await findInstallers(root);
  } catch (err) {
    body.replaceChildren(el("p", "error", `Reading the folder failed: ${(err as Error).message}`));
    return;
  }
  if (!found.length) {
    body.replaceChildren(
      el("p", "error", `No KCD installers in "${root.name}".`),
      el("p", "note", "Pick the folder with setup_kingdom_come_deliverance_….exe and its .bin files (DLC installers can be in it or in a DLC subfolder)."),
    );
    return;
  }

  const options: InstallOptions = { ...DEFAULT_OPTIONS };
  const languages = voiceLanguages(found);
  if (!languages.includes(options.language)) options.language = languages[0] ?? "";
  const kindSize = (kind: PakKind, language?: string) =>
    found.reduce((a, ins) => a + ins.installer.files.filter((f) => isPak(f) && pakKind(f.path).kind === kind && (!language || pakKind(f.path).language === language)).reduce((b, f) => b + f.size, 0), 0);

  // options: one voice language and the optional HD packs
  const opts = el("div", "install-options");
  const langLabel = el("label", "ctl", "Voice-over");
  const lang = el("select");
  for (const l of languages) {
    const o = el("option", undefined, `${l[0].toUpperCase()}${l.slice(1)} (${formatSize(kindSize("voice", l))})`);
    o.value = l;
    lang.append(o);
  }
  lang.value = options.language;
  langLabel.append(lang);
  opts.append(langLabel);
  const optional: [keyof InstallOptions, PakKind, string][] = [
    ["hdTextures", "hd-textures", "HD textures (not needed for Potato or Low)"],
    ["hdVoice", "hd-voice", "HD voice-over"],
    ["hdSound", "hd-sound", "HD sound"],
  ];
  const optBoxes: { key: keyof InstallOptions; kind: PakKind; box: HTMLInputElement; size: HTMLSpanElement }[] = [];
  for (const [key, kind, text] of optional) {
    if (!kindSize(kind)) continue;
    const label = el("label", "ctl check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = options[key] as boolean;
    const size = el("span", "dim");
    label.append(box, el("span", undefined, text), size);
    opts.append(label);
    optBoxes.push({ key, kind, box, size });
  }
  const repackLabel = el("label", "ctl check");
  const repackBox = el("input");
  repackBox.type = "checkbox";
  repackBox.checked = options.repack;
  repackLabel.append(repackBox, el("span", undefined, "Leave out the files later patches replace (about 14 GiB with the base game)"));
  opts.append(repackLabel);

  const list = el("ul", "install-list");
  const checks: HTMLInputElement[] = [];
  const sizes: HTMLSpanElement[] = [];
  for (const f of found) {
    const li = el("li");
    const label = el("label", "ctl check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = f.problems.length === 0;
    box.disabled = f.problems.length > 0;
    checks.push(box);
    const size = el("span", "dim");
    sizes.push(size);
    label.append(box, el("span", undefined, f.label), size);
    li.append(label);
    for (const p of f.problems) li.append(el("div", "note warn", p));
    list.append(li);
  }

  const storage = el("p", "note");
  const start = el("button", "install-go", "Install");
  start.type = "button";
  const cancel = el("button", "link", "Cancel");
  cancel.type = "button";
  cancel.hidden = true;
  const bar = el("progress", "install-bar");
  bar.hidden = true;
  const line = el("p", "note install-line");
  const result = el("p", "note");

  const selected = () => found.filter((_, i) => checks[i].checked);
  async function updateStorage(): Promise<void> {
    options.language = lang.value;
    options.repack = repackBox.checked;
    for (const o of optBoxes) {
      (options[o.key] as boolean) = o.box.checked;
      o.size.textContent = formatSize(kindSize(o.kind, o.kind === "hd-voice" ? options.language : undefined));
    }
    found.forEach((f, i) => (sizes[i].textContent = formatSize(installSize(f, options))));
    const need = selected().reduce((a, f) => a + installSize(f, options), 0);
    const est = await navigator.storage.estimate().catch(() => ({ quota: undefined, usage: undefined }));
    const free = est.quota !== undefined ? est.quota - (est.usage ?? 0) : undefined;
    storage.textContent =
      `Needs up to ${formatSize(need)} of browser storage (less if some files are already installed)` +
      (free !== undefined ? `; ${formatSize(free)} available to this site.` : ".");
    storage.className = free !== undefined && free < need ? "note warn" : "note";
    start.disabled = need === 0;
  }
  for (const c of [...checks, lang, repackBox, ...optBoxes.map((o) => o.box)]) c.addEventListener("change", () => void updateStorage());
  await updateStorage();

  const persistNote = el("p", "note");
  body.replaceChildren(
    el("p", "note", "The game's .pak archives are copied out of the installers into this browser's private storage. Nothing is uploaded. Afterwards the installer files are no longer needed."),
    opts,
    list,
    storage,
    el("div", "tex-controls"),
    bar,
    line,
    result,
    persistNote,
  );
  body.querySelector(".tex-controls")!.append(start, cancel);

  start.addEventListener("click", async () => {
    const chosen = selected();
    // without persistent storage the browser may evict tens of GB under disk pressure
    const persisted = await navigator.storage.persist().catch(() => false);
    const ac = new AbortController();
    start.disabled = true;
    const controls = [lang, repackBox, ...optBoxes.map((o) => o.box)];
    checks.forEach((c) => (c.disabled = true));
    controls.forEach((c) => (c.disabled = true));
    cancel.hidden = false;
    cancel.onclick = () => ac.abort(new DOMException("Install cancelled", "AbortError"));
    bar.hidden = false;
    result.className = "note";
    result.textContent = "";
    persistNote.replaceChildren();
    if (!persisted) persistWarning(persistNote);

    const opfs = await navigator.storage.getDirectory();
    const target = opfsTarget(await opfs.getDirectoryHandle(GAME_DIR, { create: true }));
    const t0 = performance.now();
    let lastPaint = 0;
    const paint = (p: Progress, force = false) => {
      const now = performance.now();
      if (now - lastPaint < 250 && !force) return;
      lastPaint = now;
      bar.max = p.total;
      bar.value = p.done;
      if (p.phase === "plan") {
        line.textContent = `Finding the files later patches replace: ${p.done} of ${p.total} paths`;
        return;
      }
      if (p.phase === "repack") {
        line.textContent = `Rewriting the archives without them: ${formatSize(p.done)} of ${formatSize(p.total)} · ${p.file}`;
        return;
      }
      // rate from bytes actually written, so skipped files don't inflate it
      const rate = p.written / Math.max((now - t0) / 1000, 0.001);
      line.textContent = `${formatSize(p.done)} of ${formatSize(p.total)} · ${p.filesDone}/${p.files} files · ${formatSize(rate)}/s · ${duration((p.total - p.done) / rate)} left · ${p.file}`;
    };
    try {
      const p = await install(chosen, { ...options }, target, paint, ac.signal);
      paint(p, true);
      const secs = (performance.now() - t0) / 1000;
      result.className = "note ok";
      result.textContent = `Installed ${p.files - p.skipped} files in ${duration(secs)}${p.skipped ? ` (${p.skipped} were already there)` : ""}.${p.removed ? ` Left out ${formatSize(p.removed)} of files later patches replace.` : ""} You can delete the installer files now.`;
      onInstalled();
    } catch (err) {
      const e = err as Error;
      result.className = e.name === "AbortError" ? "note" : "error";
      result.textContent = e.name === "AbortError" ? "Cancelled. Finished files are kept; Install again to continue." : `Install failed: ${e.message}. Finished files are kept; Install again to continue.`;
      if (e.name === "QuotaExceededError") result.textContent = "The browser's storage is full. Free disk space (the browser allows a share of it), then Install again to continue.";
    } finally {
      cancel.hidden = true;
      start.disabled = false;
      checks.forEach((c, i) => (c.disabled = found[i].problems.length > 0));
      controls.forEach((c) => (c.disabled = false));
    }
  });
}
