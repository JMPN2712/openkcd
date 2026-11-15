// The trade window of the world view: a shop's goods with prices on one side, what Henry carries
// on the other, bought and sold one at a time (shops.ts, inventory.ts). It frees the pointer when
// it opens (the view captures it for mouse look) and closes with Esc, E, Backspace or its button.
// A plain list for now; the game's inventory screen, haggling and repairs come later.

import type { Inventory, ItemDb } from "./inventory.ts";
import type { Shops } from "./shops.ts";

const groschen = (tenths: number) => (tenths / 10).toFixed(1);

export class TradePanel {
  readonly el: HTMLDivElement;
  private shop: number | null = null;
  private note = "";
  /** called after the window closed (the view takes the keyboard and pointer back) */
  onClose: (() => void) | null = null;

  private readonly shops: Shops;
  private readonly player: Inventory;
  private readonly items: ItemDb;
  /** an item's shown name from its localisation key */
  private readonly label: (key: string) => string | undefined;
  private readonly onKey = (e: KeyboardEvent) => {
    if (this.shop === null || (e.code !== "Escape" && e.code !== "KeyE" && e.code !== "Backspace")) return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  constructor(shops: Shops, player: Inventory, items: ItemDb, label: (key: string) => string | undefined) {
    this.shops = shops;
    this.player = player;
    this.items = items;
    this.label = label;
    this.el = document.createElement("div");
    this.el.className = "level-chest level-trade";
    this.el.hidden = true;
    this.el.tabIndex = -1;
  }

  get isOpen(): boolean {
    return this.shop !== null;
  }

  open(shop: number): void {
    const was = this.shop !== null;
    this.shop = shop;
    this.note = "";
    this.render();
    if (was) return;
    // the mouse must be free to press Buy and Sell
    if (document.pointerLockElement) document.exitPointerLock?.();
    document.addEventListener("keydown", this.onKey, true);
    this.el.focus({ preventScroll: true });
  }

  close(): void {
    if (this.shop === null) return;
    this.shop = null;
    this.el.hidden = true;
    document.removeEventListener("keydown", this.onKey, true);
    this.onClose?.();
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
      li.append(el("span", undefined, `${this.name(item)} ×${amount}`), el("span", "price", groschen(price)), b);
      return li;
    };
    const column = (title: string, list: HTMLUListElement) => {
      const c = el("div", "col");
      c.append(el("strong", undefined, title), list.childElementCount ? list : el("p", "note", "Nothing."));
      return c;
    };
    // (the lists keep their scroll position over a purchase)
    const scroll = [...this.el.querySelectorAll("ul")].map((u) => u.scrollTop);
    const stock = el("ul"), mine = el("ul");
    for (const o of this.shops.offers(shop)) stock.append(row(o.item, o.amount, o.price, "Buy", () => this.shops.buy(shop, o.item, 1, this.player)));
    for (const [item, n] of this.player.entries()) if (item !== this.items.money) mine.append(row(item, n, this.shops.sellPrice(shop, item), "Sell", () => this.shops.sell(shop, item, 1, this.player)));
    const head = el("header");
    const close = el("button", undefined, "Close (Esc)");
    close.type = "button";
    close.addEventListener("click", () => this.close());
    head.append(el("h3", undefined, `Trade · you have ${groschen(this.player.count(this.items.money))} groschen · the shop ${groschen(this.shops.money(shop))}`), close);
    const cols = el("div", "cols");
    cols.append(column("The shop sells", stock), column("You carry", mine));
    this.el.replaceChildren(head, cols, el("footer", undefined, this.note ? `No deal: ${this.note}.` : "Prices in groschen, each. No haggling yet."));
    [stock, mine].forEach((u, i) => { u.scrollTop = scroll[i] ?? 0; });
    this.el.hidden = false;
  }
}
