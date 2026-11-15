// Shops (research notes, economy.md sections 1, 2 and 5; the tables shop/shop, shop_type2item and
// shopkeeper): a shop's stock comes from its type's item list, its money is the money in its own
// inventory, and prices follow the note's formula. Buying moves items to the player's inventory
// and money to the shop's; selling the other way.
//
// ASSUMPTIONs (each is a research question in docs/HANDOFF.md):
// - stock: every item its type lists, at `amount` × the shop's `amount_multiplier`, whatever the
//   row's `default_on` says (the collier's charcoal and every shop's money row are "off"); the
//   random addition and restocking are not run;
// - the player's `sma` / `bma` trade stats are 0, barter is 0, nobody is angry, no haggling;
// - the shop table's price multipliers multiply the result;
// - prices are cut down to whole tenths of a groschen.

import { readTable, type Row } from "./tables.ts";
import type { Inventory, ItemDb } from "./inventory.ts";
import type { Vfs } from "./vfs.ts";

export interface ShopInfo {
  id: number;
  name: string;
  type: number;
  /** business hours (6 … 21); begin = end means always open */
  opens: number;
  closes: number;
  buyMultiplier: number;
  sellMultiplier: number;
  amountMultiplier: number;
  /** keepers' soul ids */
  keepers: string[];
}

export class ShopDb {
  readonly shops = new Map<number, ShopInfo>();
  /** shop type → its item list */
  private stock = new Map<number, { item: string; amount: number; defaultOn: boolean }[]>();
  private byKeeper = new Map<string, number>();

  static async load(vfs: Vfs): Promise<ShopDb> {
    const t = (n: string) => readTable(vfs, n).catch(() => [] as Row[]);
    const [shops, items, keepers] = await Promise.all([t("shop/shop"), t("shop/shop_type2item"), t("shop/shopkeeper")]);
    return ShopDb.from({ shops, items, keepers });
  }

  static from(t: { shops: Row[]; items: Row[]; keepers?: Row[] }): ShopDb {
    const db = new ShopDb();
    const num = (s: string | undefined, d: number) => (s === undefined || s === "" || !Number.isFinite(Number(s)) ? d : Number(s));
    for (const r of t.shops) {
      const id = Number(r.shop_id);
      db.shops.set(id, { id, name: r.shop_name ?? "", type: Number(r.shop_type_id), opens: num(r.business_hours_begin, 0), closes: num(r.business_hours_end, 24), buyMultiplier: num(r.price_buy_multiplier, 1), sellMultiplier: num(r.price_sell_multiplier, 1), amountMultiplier: num(r.amount_multiplier, 1), keepers: [] });
    }
    for (const r of t.items) {
      const type = Number(r.shop_type_id);
      db.stock.set(type, [...(db.stock.get(type) ?? []), { item: r.item_id, amount: num(r.amount, 1), defaultOn: r.default_on === "True" }]);
    }
    for (const r of t.keepers ?? []) {
      const shop = db.shops.get(Number(r.shop_id));
      if (!shop) continue;
      shop.keepers.push(r.keeper_id);
      if (!db.byKeeper.has(r.keeper_id)) db.byKeeper.set(r.keeper_id, shop.id);
    }
    return db;
  }

  /** The shop a soul keeps (shop/shopkeeper; the first when it keeps several). */
  shopOf(keeperSoul: string): number | undefined {
    return this.byKeeper.get(keeperSoul);
  }

  /** A shop type's item list. */
  listed(type: number): { item: string; amount: number; defaultOn: boolean }[] {
    return this.stock.get(type) ?? [];
  }
}

/** The item-health price curve (economy.md section 1): 1 at full health, 0.2 at none. */
export function healthFactor(health: number, c = 0.8): number {
  return Math.round((Math.sqrt(Math.max(0, Math.min(1, health))) * c + 1 - c) * 100) / 100;
}

export interface Offer {
  item: string;
  /** how many the shop has */
  amount: number;
  /** what one costs the player, in tenths of a groschen */
  price: number;
}

/** The shops' state in a game: stock (filled when a shop is first used) and who is open. */
export class Shops {
  readonly db: ShopDb;
  readonly items: ItemDb;
  private stocks = new Map<number, Map<string, number>>();
  /** shops a script opened (Shops.OpenShop) */
  readonly open = new Set<number>();
  /** the merchant's relationship to the player, 0 … 1 (economy.md section 2); 0.5 until reputation exists */
  relationship: (shop: number) => number = () => 0.5;

  constructor(db: ShopDb, items: ItemDb) {
    this.db = db;
    this.items = items;
  }

  /** A shop's inventory (item id → count, its money included), filled from its type on first use. */
  stockOf(shop: number): Map<string, number> {
    let s = this.stocks.get(shop);
    if (!s) {
      s = new Map();
      const info = this.db.shops.get(shop);
      for (const r of info ? this.db.listed(info.type) : []) {
        const n = Math.floor(r.amount * info!.amountMultiplier);
        if (n > 0) s.set(r.item, (s.get(r.item) ?? 0) + n);
      }
      this.stocks.set(shop, s);
    }
    // extra stock (diet mode's grants): each is added once, when it first applies
    for (const g of this.grants?.(shop) ?? []) {
      const k = `${shop}/${g.item}`;
      if (this.granted.has(k)) continue;
      this.granted.add(k);
      s.set(g.item, (s.get(g.item) ?? 0) + g.amount);
    }
    return s;
  }

  /** items stocked beyond the tables (diet mode: what a cut quest unlocked); read whenever a shop is used */
  grants: ((shop: number) => { item: string; amount: number }[]) | null = null;
  private granted = new Set<string>();

  /** The shop's money, in tenths of a groschen. */
  money(shop: number): number {
    return this.stockOf(shop).get(this.items.money) ?? 0;
  }

  /** f = 1.5 − 0.5 r, the reputation factor of both prices. */
  private f(shop: number): number {
    return 1.5 - 0.5 * Math.max(0, Math.min(1, this.relationship(shop)));
  }

  /** Barter coefficient with barter 0, no anger and no haggle: 0.875. */
  private static COEFFICIENT = 0 / 80 + 0.875;

  private price(shop: number, item: string, multiplier: number, shopMultiplier: number, health: number): number {
    const value = ((this.items.get(item)?.price ?? 0) / 10) * healthFactor(health);
    return Math.max(1, Math.floor(value * multiplier * Shops.COEFFICIENT * shopMultiplier * 10));
  }

  /** What one of an item costs the player here, in tenths of a groschen (at least 1). */
  buyPrice(shop: number, item: string, health = 1): number {
    const f = this.f(shop);
    return this.price(shop, item, Math.max(1.5 - f, f), this.db.shops.get(shop)?.buyMultiplier ?? 1, health);
  }

  /** What the shop pays the player for one of an item, in tenths of a groschen (at least 1). */
  sellPrice(shop: number, item: string, health = 1): number {
    const f = this.f(shop);
    return this.price(shop, item, Math.min(f, 1.5 - f), this.db.shops.get(shop)?.sellMultiplier ?? 1, health);
  }

  /** What the shop offers (its money left out), in its table's order. */
  offers(shop: number): Offer[] {
    const out: Offer[] = [];
    for (const [item, amount] of this.stockOf(shop)) if (item !== this.items.money && amount > 0) out.push({ item, amount, price: this.buyPrice(shop, item) });
    return out;
  }

  /** Whether the shop is open at `hour` (its business hours, or opened by a script). */
  isOpen(shop: number, hour: number): boolean {
    const s = this.db.shops.get(shop);
    if (!s) return false;
    if (this.open.has(shop) || s.opens === s.closes) return true;
    return s.opens < s.closes ? hour >= s.opens && hour < s.closes : hour >= s.opens || hour < s.closes;
  }

  /**
   * The player buys `n` of an item: null when done, else why not ("not in stock", "not enough
   * money").
   */
  buy(shop: number, item: string, n: number, player: Inventory): string | null {
    const stock = this.stockOf(shop);
    if (!(n > 0) || item === this.items.money || (stock.get(item) ?? 0) < n) return "not in stock";
    const cost = this.buyPrice(shop, item) * n;
    if (player.count(this.items.money) < cost) return "not enough money";
    stock.set(item, stock.get(item)! - n);
    stock.set(this.items.money, this.money(shop) + cost);
    // (the money goes first, so the quests' re-check on the item's arrival sees the paid state)
    player.remove(this.items.money, cost);
    player.add(item, n);
    return null;
  }

  /** The player sells `n` of an item: null when done, else why not. */
  sell(shop: number, item: string, n: number, player: Inventory): string | null {
    if (!(n > 0) || item === this.items.money || player.count(item) < n) return "not carried";
    const pay = this.sellPrice(shop, item) * n;
    if (this.money(shop) < pay) return "the shop has not enough money";
    const stock = this.stockOf(shop);
    stock.set(this.items.money, this.money(shop) - pay);
    stock.set(item, (stock.get(item) ?? 0) + n);
    player.remove(item, n);
    player.add(this.items.money, pay);
    return null;
  }

  /**
   * The Shops script functions (luaHost.ts `shops`): `soulOf` gives a keeper entity's soul id.
   * OpenShop / CloseShop / IsShopOpened take a shop id; GetShopDBIdByKeeper, GetShopMoney (in
   * tenths of a groschen) and OpenInventory (the trade screen) a keeper's entity id.
   */
  script(soulOf: (entity: number) => string | undefined, openInventory?: (shop: number, keeper: number) => void): (fn: string, a?: number) => number | boolean | null {
    return (fn, a) => {
      const id = Number(a);
      const kept = () => this.db.shopOf(soulOf(id) ?? "");
      switch (fn) {
        case "OpenShop": if (this.db.shops.has(id)) this.open.add(id); return null;
        case "CloseShop": this.open.delete(id); return null;
        case "IsShopOpened": return this.open.has(id);
        case "GetShopDBIdByKeeper": return kept() ?? null;
        // the trade screen with a keeper (dialogue scripts: Shops.OpenInventory(dc.MERCHANT.id, true))
        case "OpenInventory": { const s = kept(); if (s !== undefined) openInventory?.(s, id); return null; }
        case "GetShopMoney": { const s = kept(); return s === undefined ? 0 : this.money(s); }
      }
      return null;
    };
  }

  save(): { stocks: Record<number, Record<string, number>>; open: number[]; granted: string[] } {
    return { stocks: Object.fromEntries([...this.stocks].map(([k, v]) => [k, Object.fromEntries(v)])), open: [...this.open], granted: [...this.granted] };
  }

  load(data: { stocks: Record<number, Record<string, number>>; open: number[]; granted?: string[] }): void {
    this.stocks = new Map(Object.entries(data.stocks).map(([k, v]) => [Number(k), new Map(Object.entries(v))]));
    this.granted = new Set(data.granted ?? []);
    this.open.clear();
    for (const s of data.open) this.open.add(s);
  }
}
