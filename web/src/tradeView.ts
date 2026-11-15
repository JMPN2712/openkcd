// The trade panel of the world view: a shop's stock with prices on one side, what Henry carries
// on the other, bought and sold one at a time (shops.ts, inventory.ts). A plain list for now; the
// game's inventory screen, haggling and repairs come later.

import type { Inventory, ItemDb } from "./inventory.ts";
import type { Shops } from "./shops.ts";

const groschen = (tenths: number) => (tenths / 10).toFixed(1);

export class TradePanel {
  readonly el: HTMLDivElement;
  private shop: number | null = null;
  private note = "";

  private readonly shops: Shops;
  private readonly player: Inventory;
  private readonly items: ItemDb;
  /** an item's shown name from its localisation key */
  private readonly label: (key: string) => string | undefined;

  constructor(shops: Shops, player: Inventory, items: ItemDb, label: (key: string) => string | undefined) {
    this.shops = shops;
    this.player = player;
    this.items = items;
    this.label = label;
    this.el = document.createElement("div");
    this.el.className = "level-chest level-trade";
    this.el.hidden = true;
  }

  get isOpen(): boolean {
    return this.shop !== null;
  }

  open(shop: number): void {
    this.shop = shop;
    this.note = "";
    this.render();
  }

  close(): void {
    this.shop = null;
    this.el.hidden = true;
  }

  private name(item: string): string {
    const i = this.items.get(item);
    return (i?.uiName && this.label(i.uiName)) || i?.name || item.slice(0, 8);
  }

  private render(): void {
    const shop = this.shop;
    if (shop === null) return;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const row = (item: string, amount: number, price: number, verb: string, act: () => string | null) => {
      const li = el("li");
      const b = el("button", undefined, verb);
      b.type = "button";
      b.addEventListener("click", () => { this.note = act() ?? ""; this.render(); });
      li.append(`${this.name(item)} ×${amount} · ${groschen(price)} `, b);
      return li;
    };
    const stock = el("ul"), mine = el("ul");
    for (const o of this.shops.offers(shop)) stock.append(row(o.item, o.amount, o.price, "Buy", () => this.shops.buy(shop, o.item, 1, this.player)));
    for (const [item, n] of this.player.entries()) if (item !== this.items.money) mine.append(row(item, n, this.shops.sellPrice(shop, item), "Sell", () => this.shops.sell(shop, item, 1, this.player)));
    const close = el("button", undefined, "Close");
    close.type = "button";
    close.addEventListener("click", () => this.close());
    this.el.replaceChildren(
      el("h3", undefined, `Trade · your money ${groschen(this.player.count(this.items.money))} groschen · the shop's ${groschen(this.shops.money(shop))}`),
      el("p", "note", "The shop sells:"), stock.childElementCount ? stock : el("p", undefined, "Nothing."),
      el("p", "note", "You carry:"), mine.childElementCount ? mine : el("p", undefined, "Nothing."),
      el("p", "note", this.note ? `No deal: ${this.note}.` : "Prices in groschen. No haggling yet."), close,
    );
    this.el.hidden = false;
  }
}
