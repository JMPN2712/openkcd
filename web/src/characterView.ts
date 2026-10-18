// Character UI: a searchable list of NPC souls and clothing presets from the
// game database, and loaders that turn a soul / preset / .cdf into a scene.

import { CharacterDb, loadCharacter, parseCdf, type CharacterSpec } from "./character.ts";
import { showScene } from "./modelView.ts";
import type { TextureContext } from "./textureView.ts";
import type { Vfs } from "./vfs.ts";
import { formatCount } from "./format.ts";

const dbCache = new WeakMap<Vfs, Promise<CharacterDb>>();

function characterDb(vfs: Vfs): Promise<CharacterDb> {
  let p = dbCache.get(vfs);
  if (!p) {
    p = CharacterDb.load(vfs);
    p.catch(() => dbCache.delete(vfs));
    dbCache.set(vfs, p);
  }
  return p;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Render a character spec (resolved lazily against the VFS) in the 3D panel. */
export function showCharacter(
  host: HTMLElement,
  ctx: TextureContext,
  resolve: (vfs: Vfs) => Promise<CharacterSpec>,
  openTexture: (stem: string) => void,
): Promise<void> {
  return showScene(host, ctx, async (vfs, onStatus) => {
    const spec = await resolve(vfs);
    const ch = await loadCharacter(vfs, spec, { onStatus });
    return {
      title: `${spec.name} · ${ch.parts.length}/${spec.parts.length} parts`,
      parts: ch.parts.map(({ part, model, transform }) => ({ model, transform, layer: part.layer, label: `${part.kind}: ${part.label}` })),
      notes: ch.notes,
    };
  }, openTexture);
}

export function showCdf(host: HTMLElement, ctx: TextureContext, path: string, openTexture: (stem: string) => void): Promise<void> {
  return showCharacter(host, ctx, async (vfs) => {
    const hit = vfs.lookup(path);
    if (!hit) throw new Error(`${path} not found`);
    return parseCdf(new TextDecoder().decode(await vfs.read(hit)), path.slice(path.lastIndexOf("/") + 1));
  }, openTexture);
}

const LIST_LIMIT = 400;

/**
 * Searchable soul / preset list. `onPick` receives a resolver for the chosen
 * character and its display name.
 */
export async function showCharacterBrowser(
  host: HTMLElement,
  ctx: TextureContext,
  onPick: (name: string, resolve: (vfs: Vfs) => Promise<CharacterSpec>) => void,
): Promise<void> {
  host.replaceChildren(el("p", "note pad", "Loading character tables…"));
  let db: CharacterDb;
  try {
    const vfs = await ctx.vfs(ctx.includeHd, (d, t) => host.replaceChildren(el("p", "note pad", `Indexing assets across all archives… ${d}/${t}`)));
    db = await characterDb(vfs);
  } catch (err) {
    host.replaceChildren(el("p", "error pad", (err as Error).message));
    return;
  }
  const search = el("input", "char-search");
  search.type = "search";
  search.placeholder = `Filter ${formatCount(db.souls.length)} souls and ${formatCount(db.presets.length)} clothing presets…`;
  const kind = el("select", "char-kind");
  for (const [v, t] of [["souls", "NPC souls"], ["presets", "Clothing presets"]]) {
    const o = el("option", undefined, t);
    o.value = v;
    kind.append(o);
  }
  const bar = el("div", "char-bar");
  bar.append(kind, search);
  const list = el("ul", "tree-list");
  const note = el("p", "dim filter-note");
  host.replaceChildren(bar, note, list);

  let selected: HTMLElement | null = null;
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const rows = kind.value === "souls"
      ? db.souls.map((s) => ({ id: s.id, name: s.name, sub: s.gender, pick: (v: Vfs) => characterDb(v).then((d) => d.soul(s.id)) }))
      : db.presets.map((p) => ({ id: p.id, name: p.name, sub: p.gender, pick: (v: Vfs) => characterDb(v).then((d) => d.preset(p.id)) }));
    const hits = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
    list.replaceChildren();
    for (const r of hits.slice(0, LIST_LIMIT)) {
      const li = el("li");
      const b = el("button", "row file");
      b.type = "button";
      b.title = r.id;
      b.append(el("span", "name", r.name), el("span", "dim", r.sub));
      b.addEventListener("click", () => {
        selected?.classList.remove("selected");
        b.classList.add("selected");
        selected = b;
        onPick(r.name, r.pick);
      });
      li.append(b);
      list.append(li);
    }
    note.textContent = hits.length > LIST_LIMIT ? `${formatCount(hits.length)} matches; showing the first ${LIST_LIMIT}.` : `${formatCount(hits.length)} matches.`;
  };
  let timer = 0;
  search.addEventListener("input", () => { clearTimeout(timer); timer = window.setTimeout(render, 120); });
  kind.addEventListener("change", render);
  render();
  search.focus();
}
