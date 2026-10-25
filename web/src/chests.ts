// Chests (Stash entities with a .cga model and a <model>_open.anm, ~900 of Rataje's 2,596 stashes):
// E opens the lid with the model's own animation and shows what the chest holds; E again, or
// walking away, closes it. The world scene draws the lid apart from the body (world.ts, keys
// "x.cga#lid:node"), keeping the chest's entity id, so the lid's instance turns about its node's
// axis: entity × node × rotation × node⁻¹.
//
// Contents come from the database: the chest's Properties/Database guidInventoryDBId names an
// inventory (Libs/Tables/inventory/inventory.xml) with items of its own (inventory2item: amount,
// plus up to amount_random_add more) and presets (inventory2inventory_preset → inventory_preset2item)
// it draws from, up to its max_items. How the game rolls those presets is not known yet (a research
// note): the panel lists the fixed items and what the presets can add. Taking items waits for the
// inventory. Locked chests (Lock bLocked) stay shut until lockpicking exists.

import { parseAnm, swing } from "./anm.ts";
import type { EntityInfo } from "./levelEntities.ts";
import type { Localization } from "./localization.ts";
import { multiply } from "./mat4.ts";
import { invertRigid } from "./pose.ts";
import { groupBy, indexBy, readTable, type Row } from "./tables.ts";
import type { Vfs } from "./vfs.ts";
import type { WorldScene } from "./world.ts";

type Vec3 = [number, number, number];

export interface Chest {
  entity: EntityInfo;
  locked: boolean;
  useDistance: number;
  inventory: string | null;
  open: boolean;
  /** time along the opening swing (s) and where it is heading: 1 opening, −1 closing, 0 at rest */
  time: number;
  dir: number;
}

export interface ChestItem {
  name: string;
  /** amount, or a range "1–2" */
  amount: string;
  /** from one of the inventory's presets: may or may not be there */
  maybe: boolean;
}

interface Lid {
  swing: ReturnType<typeof swing>;
  axis: Vec3;
}

interface Placed {
  index: number;
  matrices: Float32Array;
  i: number;
  base: Float32Array;
  /** the lid node's transform (node → model) and its inverse */
  node: Float32Array;
  inv: Float32Array;
}

export class Chests {
  private vfs: Vfs;
  readonly chests = new Map<number, Chest>();
  private lids = new Map<string, Promise<Lid | null>>();
  private ready = new Map<string, Lid | null>();
  private placed = new Map<number, Placed>();
  private moving = new Set<number>();
  private db: Promise<{ inv: Map<string, Row>; items: Map<string, Row[]>; presets: Map<string, Row[]>; presetItems: Map<string, Row[]>; ui: Map<string, Row>; names: Map<string, Row> } | null> | null = null;

  constructor(vfs: Vfs, entities: EntityInfo[]) {
    this.vfs = vfs;
    for (const e of entities) {
      if (e.cls !== "Stash" || !/\.cga$/i.test(e.model ?? "")) continue;
      const p = e.propsXml ?? "";
      const use = Number(/\bfUseDistance="([^"]*)"/.exec(p)?.[1] ?? 2.5);
      this.chests.set(e.id, {
        entity: e,
        locked: /<Lock\b[^>]*\bbLocked="1"/.test(p),
        useDistance: Number.isFinite(use) && use > 0 ? use : 2.5,
        inventory: /\bguidInventoryDBId="([^"]+)"/.exec(p)?.[1] ?? null,
        open: false, time: 0, dir: 0,
      });
    }
  }

  private model(c: Chest): string {
    return c.entity.model!.toLowerCase().replace(/\\/g, "/");
  }

  /** The lid's swing for a chest model (its _open.anm), loaded once. */
  private lid(c: Chest): Lid | null {
    const path = this.model(c);
    if (!this.lids.has(path)) {
      const hit = this.vfs.lookup(path.replace(/\.cga$/, "_open.anm"));
      const p = hit ? this.vfs.read(hit).then((b) => { const n = parseAnm(b)[0]; return n ? { swing: swing(n), axis: n.axis } : null; }).catch(() => null) : Promise.resolve(null);
      this.lids.set(path, p);
      void p.then((l) => this.ready.set(path, l));
    }
    return this.ready.get(path) ?? null;
  }

  /** Wait for the lids of the chests placed so far. */
  async settle(): Promise<void> {
    await Promise.all([...this.lids.values()]);
  }

  /** Find the chests' lids in a new scene (sceneMatrices order), and load their animations. */
  attach(scene: WorldScene): number[] {
    this.placed.clear();
    let index = 0;
    for (const wm of scene.models) {
      if (wm.entities && wm.path.includes("#lid:")) {
        const mesh = wm.lods[0].cgf.meshes[0];
        for (let i = 0; i < wm.count; i++) {
          const id = wm.entities[i], c = this.chests.get(id);
          if (!c || !mesh) continue;
          this.lid(c);
          this.placed.set(id, { index: index + i, matrices: wm.matrices, i, base: wm.matrices.slice(i * 16, i * 16 + 16), node: mesh.transform, inv: invertRigid(mesh.transform) });
        }
      }
      index += wm.count;
    }
    return [...this.placed.keys()].filter((id) => this.chests.get(id)!.time > 0);
  }

  /** The chest Henry faces within its use distance (nearest the middle of the view, within 40°). */
  target(feet: Vec3, eye: Vec3, forward: Vec3): Chest | null {
    let best: Chest | null = null, bestCos = Math.cos((40 * Math.PI) / 180);
    for (const id of this.placed.keys()) {
      const c = this.chests.get(id)!, p = c.entity.pos;
      const centre = [p[0], p[1], p[2] + 0.4];
      if (Math.hypot(centre[0] - feet[0], centre[1] - feet[1], centre[2] - feet[2]) > c.useDistance) continue;
      const v = [centre[0] - eye[0], centre[1] - eye[1], centre[2] - eye[2]], l = Math.hypot(v[0], v[1], v[2]) || 1;
      const cos = (v[0] * forward[0] + v[1] * forward[1] + v[2] * forward[2]) / l;
      if (cos > bestCos) { bestCos = cos; best = c; }
    }
    return best;
  }

  action(c: Chest): "open" | "close" | "locked" | "busy" {
    if (c.dir !== 0) return "busy";
    if (c.open) return "close";
    return c.locked ? "locked" : "open";
  }

  /** Open or close a chest (E). */
  use(c: Chest): boolean {
    const act = this.action(c);
    if ((act !== "open" && act !== "close") || !this.lid(c)) return false;
    c.dir = act === "open" ? 1 : -1;
    c.open = act === "open";
    this.moving.add(c.entity.id);
    return true;
  }

  /** Advance the moving lids by `dt` seconds; returns the ids that moved. */
  step(dt: number): number[] {
    const out: number[] = [];
    for (const id of this.moving) {
      const c = this.chests.get(id)!, l = this.lid(c);
      if (!l) { this.moving.delete(id); continue; }
      c.time = Math.max(0, Math.min(l.swing.duration, c.time + c.dir * dt));
      if ((c.dir > 0 && c.time >= l.swing.duration) || (c.dir < 0 && c.time <= 0)) { c.dir = 0; this.moving.delete(id); }
      out.push(id);
    }
    return out;
  }

  /** A chest's lid instance with its current matrix (entity × node × turn × node⁻¹). */
  *matrices(id: number): Generator<{ index: number; m: Float32Array }> {
    const p = this.placed.get(id), c = this.chests.get(id);
    if (!p || !c) return;
    const l = this.lid(c);
    const a = l ? l.swing.at(c.time) : 0;
    const [x, y, z] = l?.axis ?? [1, 0, 0];
    const s = Math.sin(a), co = Math.cos(a), t = 1 - co;
    // rotation by a about the (unit) axis, column-major
    const r = new Float32Array([
      t * x * x + co, t * x * y + s * z, t * x * z - s * y, 0,
      t * x * y - s * z, t * y * y + co, t * y * z + s * x, 0,
      t * x * z + s * y, t * y * z - s * x, t * z * z + co, 0,
      0, 0, 0, 1,
    ]);
    const m = multiply(p.base, multiply(p.node, multiply(r, p.inv)));
    p.matrices.set(m, p.i * 16);
    yield { index: p.index, m };
  }

  /** What a chest holds, by name: its own items, then what its presets can add. */
  async contents(c: Chest, text: Localization | null): Promise<ChestItem[]> {
    if (!c.inventory) return [];
    this.db ??= (async () => {
      const t = (n: string) => readTable(this.vfs, n).catch(() => [] as Row[]);
      const [inv, items, presets, presetItems, ui, names] = await Promise.all([t("inventory/inventory"), t("inventory/inventory2item"), t("inventory/inventory2inventory_preset"), t("inventory/inventory_preset2item"), t("item/player_item"), t("item/item")]);
      return { inv: indexBy(inv, "inventory_id"), items: groupBy(items, "inventory_id"), presets: groupBy(presets, "inventory_id"), presetItems: groupBy(presetItems, "inventory_preset_id"), ui: indexBy(ui, "item_id"), names: indexBy(names, "item_id") };
    })().catch(() => null);
    const db = await this.db;
    if (!db) return [];
    const name = (id: string) => {
      const key = db.ui.get(id)?.ui_name;
      return (key && text?.get(key)) || db.names.get(id)?.item_name || id.slice(0, 8);
    };
    const amount = (r: Row) => {
      const a = Number(r.amount || 1), extra = Number(r.amount_random_add || 0);
      return extra > 0 ? `${a}–${a + extra}` : `${a}`;
    };
    const out: ChestItem[] = (db.items.get(c.inventory) ?? []).map((r) => ({ name: name(r.item_id), amount: amount(r), maybe: false }));
    const seen = new Set(out.map((x) => x.name));
    for (const p of db.presets.get(c.inventory) ?? []) for (const r of db.presetItems.get(p.inventory_preset_id) ?? []) {
      const n = name(r.item_id);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push({ name: n, amount: amount(r), maybe: true });
    }
    return out;
  }
}
