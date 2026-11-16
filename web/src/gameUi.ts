// The game's own look for our menus, read at runtime from the player's copy (nothing is shipped):
// its font (fonts/alexanderquill.ttf), its menu textures (the in-game menu background, the
// dialogue selector banner, the window frame, the ornaments) and its menu strings
// (text_ui_menus: "Resume", "Settings", …). The game draws its menus with Scaleform (Libs/UI/*.gfx),
// which a browser can't run; these menus are ours, dressed in its parts.
//
// GameMenu: the in-game menu Esc opens, as the game's (Libs/UI/UIActions/MM_IngameMenu.xml lists
// Resume, Save, Load, Settings, Help, New Game, Exit; here Resume, New Game, Settings, Help, and a
// Debug page of our own).

import { decodeMip, openTexture } from "./texture.ts";
import { Localization } from "./localization.ts";
import type { PakSource } from "./paks.ts";
import type { Vfs } from "./vfs.ts";

/** CSS custom properties (url(…)) for the game's UI textures, and the font family. */
export interface GameUiAssets {
  vars: Record<string, string>;
  font: string;
  text: (key: string, fallback: string) => string;
}

const TEXTURES: Record<string, string> = {
  "--kcd-menu-bg": "libs/ui/textures/menu_backgroundingame.dds",
  "--kcd-selector": "libs/ui/textures/dialog_selector.dds",
  "--kcd-window": "libs/ui/textures/dialog_window_big.dds",
  "--kcd-ornament-left": "libs/ui/textures/menus_ornament_left.dds",
  "--kcd-ornament-right": "libs/ui/textures/menus_ornament_right.dds",
  "--kcd-deco-top": "libs/ui/textures/decoration_top.dds",
  "--kcd-deco-bottom": "libs/ui/textures/decoration_bottom.dds",
};

/** One texture as an image URL, at a mip no larger than `max` pixels. */
async function textureUrl(vfs: Vfs, path: string, max = 1024): Promise<string | null> {
  try {
    const t = await openTexture(vfs, path);
    let level = 0;
    while (level < t.header.mipCount - 1 && Math.max(t.header.width >> level, t.header.height >> level) > max) level++;
    const d = await decodeMip(vfs, t, level);
    if (d.pixels.kind !== "ldr") return null;
    const c = document.createElement("canvas");
    c.width = d.w;
    c.height = d.h;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(d.pixels.data), d.w, d.h), 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

let loaded: Promise<GameUiAssets> | null = null;

/** Load the game's UI parts once (font, textures, menu strings); missing ones fall back to ours. */
export function loadGameUi(vfs: Vfs, paks: PakSource[]): Promise<GameUiAssets> {
  return (loaded ??= (async () => {
    const vars: Record<string, string> = {};
    let font = "Georgia, 'Times New Roman', serif";
    const ttf = vfs.lookup("fonts/alexanderquill.ttf");
    if (ttf) {
      try {
        const bytes = await vfs.read(ttf);
        const face = new FontFace("KCD Quill", new Uint8Array(bytes).buffer);
        await face.load();
        document.fonts.add(face);
        font = `"KCD Quill", ${font}`;
      } catch { /* keep the fallback */ }
    }
    await Promise.all(Object.entries(TEXTURES).map(async ([k, p]) => { const u = await textureUrl(vfs, p); if (u) vars[k] = `url("${u}")`; }));
    const loc = new Localization();
    await loc.load(paks, ["text_ui_menus"]).catch(() => false);
    return { vars, font, text: (key, fallback) => loc.get(key) ?? fallback };
  })());
}

/** Dress an element (the view's stage) in the game's UI parts. */
export function applyGameUi(el: HTMLElement, a: GameUiAssets): void {
  for (const [k, v] of Object.entries(a.vars)) el.style.setProperty(k, v);
  el.style.setProperty("--kcd-font", a.font);
  el.classList.add("kcd-ui");
}

export interface MenuPage {
  title: string;
  /** buttons: a label and what it does; or a block of content (settings, help, debug) */
  items: ({ label: string; act: () => void } | { node: HTMLElement })[];
}

/** The in-game menu: a column of the game's buttons over its menu background; keys and mouse. */
export class GameMenu {
  readonly el: HTMLDivElement;
  private list: HTMLDivElement;
  private store: HTMLDivElement;
  private titleEl: HTMLHeadingElement;
  private buttons: HTMLButtonElement[] = [];
  private sel = 0;
  private pages: Record<string, MenuPage> = {};
  private page = "main";
  /** Esc (or Resume) closes it: the view takes the mouse back */
  onResume: (() => void) | null = null;
  /** the page Back and Esc return to ("main" in play, "start" for the main menu) */
  home = "main";

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "kcd-menu";
    this.el.hidden = true;
    this.el.tabIndex = -1;
    const panel = document.createElement("div");
    panel.className = "kcd-menu-panel";
    this.titleEl = document.createElement("h2");
    this.list = document.createElement("div");
    this.list.className = "kcd-menu-list";
    // (blocks of pages not shown wait here, still in the document: scripts and tests reach their controls)
    this.store = document.createElement("div");
    this.store.hidden = true;
    panel.append(this.titleEl, this.list);
    this.el.append(panel, this.store);
    this.el.addEventListener("keydown", (e) => this.key(e));
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  setPages(pages: Record<string, MenuPage>): void {
    this.pages = pages;
    for (const p of Object.values(pages)) for (const it of p.items) if ("node" in it) this.store.append(it.node);
    if (this.isOpen) this.show(this.page);
  }

  open(page = "main"): void {
    this.el.hidden = false;
    this.show(page);
    this.el.focus({ preventScroll: true });
  }

  close(): void {
    this.el.hidden = true;
  }

  show(page: string): void {
    const p = this.pages[page];
    if (!p) return;
    this.page = page;
    // the main menu sits over the game's artwork
    this.el.classList.toggle("start", this.home === "start");
    this.titleEl.textContent = p.title;
    this.buttons = [];
    for (const n of [...this.list.children]) if (n instanceof HTMLElement && !n.classList.contains("kcd-menu-button")) this.store.append(n);
    this.list.replaceChildren();
    for (const it of p.items) {
      if ("node" in it) { this.list.append(it.node); continue; }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kcd-menu-button";
      b.textContent = it.label;
      const i = this.buttons.length;
      b.addEventListener("click", () => it.act());
      b.addEventListener("mouseenter", () => this.mark(i));
      this.buttons.push(b);
      this.list.append(b);
    }
    this.mark(0);
  }

  private mark(i: number): void {
    if (!this.buttons.length) return;
    this.sel = (i + this.buttons.length) % this.buttons.length;
    this.buttons.forEach((b, k) => b.classList.toggle("on", k === this.sel));
  }

  private key(e: KeyboardEvent): void {
    // (keys typed into a field of a settings page are the field's)
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) { if (e.code !== "Escape") return; }
    if (e.code === "Escape" || e.code === "Backspace") {
      e.preventDefault();
      if (this.page !== this.home) this.show(this.home); else if (this.home === "main") this.onResume?.();
    } else if (e.code === "ArrowDown" || e.code === "KeyS") { e.preventDefault(); this.mark(this.sel + 1); }
    else if (e.code === "ArrowUp" || e.code === "KeyW") { e.preventDefault(); this.mark(this.sel - 1); }
    else if (e.code === "Enter" || e.code === "Space" || e.code === "KeyE") { e.preventDefault(); this.buttons[this.sel]?.click(); }
  }
}

/** Capture the mouse for the view (needs a click or key press; refused otherwise, quietly). */
export function lockPointer(el: HTMLElement): void {
  try {
    const r = el.requestPointerLock?.() as unknown as Promise<void> | undefined;
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch { /* not allowed now */ }
}

/** The game's loading artwork (Libs/UI/Textures/Video/artwork0–6), one at random per screen. */
const ARTWORK = Array.from({ length: 7 }, (_, i) => `libs/ui/textures/video/artwork${i}.dds`);

/**
 * A loading screen with the game's own artwork and a line of what is loading; it covers the view
 * while the world loads, and while a new game moves Henry and builds the scene around him.
 */
export class LoadingScreen {
  readonly el: HTMLDivElement;
  private text: HTMLParagraphElement;
  private art: string | null = null;
  private picking = false;
  private readonly vfs: Vfs;

  constructor(vfs: Vfs) {
    this.vfs = vfs;
    this.el = document.createElement("div");
    this.el.className = "kcd-loading";
    this.el.hidden = true;
    this.text = document.createElement("p");
    const gate = document.createElement("i");
    gate.className = "kcd-loading-gate";
    this.el.append(gate, this.text);
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  /** Show it (a new artwork each time it appears) with `text` under it. */
  show(text: string): void {
    if (this.el.hidden) {
      this.el.hidden = false;
      this.pick();
    }
    if (this.text.textContent !== text) this.text.textContent = text;
  }

  hide(): void {
    this.el.hidden = true;
  }

  private pick(): void {
    if (this.picking) return;
    this.picking = true;
    const path = ARTWORK[Math.floor(Math.random() * ARTWORK.length)];
    void textureUrl(this.vfs, path, 2048).then((u) => {
      this.picking = false;
      if (!u) return;
      if (this.art) URL.revokeObjectURL(this.art);
      this.art = u;
      this.el.style.backgroundImage = `url("${u}")`;
    });
  }
}

/** One of the game's loading paintings as an image URL (the main menu's background). */
export function artworkUrl(vfs: Vfs): Promise<string | null> {
  return textureUrl(vfs, ARTWORK[Math.floor(Math.random() * ARTWORK.length)], 2048);
}
