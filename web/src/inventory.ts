// Items and the player's inventory: what Henry carries, by item id, with money as the item named
// "money" counted in tenths of a groschen (research notes, economy.md "Money units"). The quest
// state counts tracked items here and pays item and money rewards into it; shops trade with it.
// No weights, health, equipment or stolen marks yet.

import { readTable, type Row } from "./tables.ts";
import type { Vfs } from "./vfs.ts";

export interface Item {
  id: string;
  /** the table's name ("Charcoal") */
  name: string;
  /** localisation key of the shown name (item/player_item), or "" */
  uiName: string;
  /** base price in tenths of a groschen (item/pickable_item), 0 when the table gives none */
  price: number;
  weight: number;
  category: number;
}

export class ItemDb {
  private items = new Map<string, Item>();
  /** the money item's id ("" when the tables have none) */
  money = "";

  static async load(vfs: Vfs): Promise<ItemDb> {
    const t = (n: string) => readTable(vfs, n).catch(() => [] as Row[]);
    const [items, ui, pickable] = await Promise.all([t("item/item"), t("item/player_item"), t("item/pickable_item")]);
    return ItemDb.from({ items, ui, pickable });
  }

  /** Build from table rows (tests build small ones by hand). */
  static from(t: { items: Row[]; ui?: Row[]; pickable?: Row[] }): ItemDb {
    const db = new ItemDb();
    const ui = new Map((t.ui ?? []).map((r) => [r.item_id, r.ui_name ?? ""]));
    const pick = new Map((t.pickable ?? []).map((r) => [r.item_id, r]));
    for (const r of t.items) {
      const p = pick.get(r.item_id);
      db.items.set(r.item_id, { id: r.item_id, name: r.item_name ?? "", uiName: ui.get(r.item_id) ?? "", price: Number(p?.price || 0), weight: Number(p?.weight || 0), category: Number(r.item_category_id || 0) });
      if (r.item_name === "money") db.money = r.item_id;
    }
    return db;
  }

  get(id: string): Item | undefined {
    return this.items.get(id);
  }

  /** An item by its table name (case-insensitive). */
  byName(name: string): Item | undefined {
    const n = name.toLowerCase();
    for (const i of this.items.values()) if (i.name.toLowerCase() === n) return i;
    return undefined;
  }
}

/** Counts of items by id. `onChange` runs after every change (the quests re-check tracked items). */
export class Inventory {
  private counts = new Map<string, number>();
  onChange: (() => void) | null = null;

  count(item: string): number {
    return this.counts.get(item) ?? 0;
  }

  /** Add `n` of an item (n > 0). */
  add(item: string, n = 1): void {
    if (!(n > 0)) return;
    this.counts.set(item, this.count(item) + n);
    this.onChange?.();
  }

  /** Take `n` of an item away; false (and nothing taken) when there are fewer. */
  remove(item: string, n = 1): boolean {
    const have = this.count(item);
    if (!(n > 0) || have < n) return false;
    if (have === n) this.counts.delete(item); else this.counts.set(item, have - n);
    this.onChange?.();
    return true;
  }

  /** Everything carried, as [item id, count]. */
  entries(): [string, number][] {
    return [...this.counts];
  }

  save(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  load(data: Record<string, number>): void {
    this.counts = new Map(Object.entries(data));
    this.onChange?.();
  }
}
