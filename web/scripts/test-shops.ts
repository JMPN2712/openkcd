// Node test for src/shops.ts and src/inventory.ts (research notes, economy.md): prices, buying
// and selling on a made-up shop, then the game's own tables: the collier's charcoal, the tailor's
// stock, diet mode's grants.
// usage: node scripts/test-shops.ts [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { gameSources } from "./lib.ts";
import { Vfs } from "../src/vfs.ts";
import { Inventory, ItemDb } from "../src/inventory.ts";
import { healthFactor, ShopDb, Shops } from "../src/shops.ts";
import { DIET } from "../src/dietConfig.ts";
import { readTable } from "../src/tables.ts";
import { defaultGameRoot } from "./paths.ts";

const args = process.argv.slice(2);
const root = args.includes("--root") ? args[args.indexOf("--root") + 1] : defaultGameRoot;
let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

// ---- made-up tables ----
{
  const items = ItemDb.from({
    items: [{ item_id: "m", item_name: "money", item_category_id: "6" }, { item_id: "bread", item_name: "Bread", item_category_id: "5" }, { item_id: "sword", item_name: "Sword", item_category_id: "1" }],
    pickable: [{ item_id: "bread", price: "20", weight: "0.5" }, { item_id: "sword", price: "5000", weight: "3" }],
  });
  const db = ShopDb.from({
    shops: [{ shop_id: "1", shop_name: "bakery", shop_type_id: "4", business_hours_begin: "6", business_hours_end: "21", price_buy_multiplier: "1.1", price_sell_multiplier: "0.8", amount_multiplier: "2" }],
    items: [{ shop_type_id: "4", item_id: "bread", amount: "5", default_on: "True" }, { shop_type_id: "4", item_id: "m", amount: "300", default_on: "False" }],
    keepers: [{ shop_id: "1", keeper_id: "baker" }],
  });
  const shops = new Shops(db, items);
  const bag = new Inventory();
  check(items.money === "m" && db.shopOf("baker") === 1, "the money item and the keeper's shop are found");
  check([1, 0.5, 0.25, 0].map((h) => healthFactor(h)).join() === "1,0.77,0.6,0.2", "the item-health price curve: 1, 0.77, 0.6, 0.2");
  check(shops.stockOf(1).get("bread") === 10 && shops.money(1) === 600, "stock is the type's amounts × the shop's amount multiplier (10 loaves, 60 groschen)");
  // value 2.0 groschen; r 0.5 → f 1.25; buy ×1.25, coefficient 0.875, shop ×1.1 → 2.40 → 24 tenths
  check(shops.buyPrice(1, "bread") === 24, `bread costs 2.4 groschen (${shops.buyPrice(1, "bread") / 10})`);
  // sell ×0.25, 0.875, shop ×0.8 → 0.35 → 3 tenths
  check(shops.sellPrice(1, "bread") === 3, `and sells for 0.3 (${shops.sellPrice(1, "bread") / 10})`);
  shops.relationship = () => 1;
  check(shops.buyPrice(1, "bread") === 19 && shops.sellPrice(1, "bread") === 7, "a friend (r = 1) buys for 1.9 and sells for 0.7");
  shops.relationship = () => 0.5;
  check(shops.isOpen(1, 12) && !shops.isOpen(1, 22) && !shops.isOpen(1, 5), "open 6 to 21");
  shops.open.add(1);
  check(shops.isOpen(1, 23), "or when a script opened it");
  check(shops.buy(1, "bread", 1, bag) === "not enough money", "no money, no bread");
  bag.add("m", 100);
  let changes = 0;
  bag.onChange = () => { changes++; };
  check(shops.buy(1, "bread", 4, bag) === null && bag.count("bread") === 4 && bag.count("m") === 4 && shops.money(1) === 696 && shops.stockOf(1).get("bread") === 6, "four loaves for 9.6: money moves to the shop, bread to Henry");
  check(changes === 2, "the inventory announced the changes");
  check(shops.buy(1, "bread", 7, bag) === "not in stock" && shops.buy(1, "sword", 1, bag) === "not in stock", "the shop can't sell what it hasn't got");
  check(shops.sell(1, "bread", 2, bag) === null && bag.count("bread") === 2 && bag.count("m") === 10, "two loaves sold back for 0.6");
  check(shops.sell(1, "sword", 1, bag) === "not carried", "Henry can't sell what he doesn't carry");
  bag.add("sword", 1);
  check(shops.sell(1, "sword", 1, bag) === "the shop has not enough money", "nor more than the shop's money buys");
  shops.grants = () => [{ item: "sword", amount: 1 }];
  check(shops.offers(1).some((o) => o.item === "sword" && o.amount === 1) && shops.offers(1).find((o) => o.item === "sword")!.amount === 1, "a grant is stocked once");
  const saved = shops.save();
  const again = new Shops(db, items);
  again.load(saved);
  again.grants = shops.grants;
  check(again.stockOf(1).get("bread") === 8 && again.stockOf(1).get("sword") === 1 && again.open.has(1), "stock, grants and open shops survive a save");
  const lua = shops.script((e) => (e === 7 ? "baker" : undefined));
  check(lua("GetShopDBIdByKeeper", 7) === 1 && lua("GetShopDBIdByKeeper", 8) === null && lua("IsShopOpened", 1) === true && (lua("CloseShop", 1), lua("IsShopOpened", 1)) === false && lua("GetShopMoney", 7) === shops.money(1), "the script functions: the keeper's shop, open and close, the shop's money");
}

// ---- the game's tables ----
const sources = await gameSources(root);
const vfs = await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => /^libs\/tables\/(item|shop|rpg)\/.*\.xml$/.test(n), includeHd: false });
const [items, db, souls] = await Promise.all([ItemDb.load(vfs), ShopDb.load(vfs), readTable(vfs, "rpg/soul")]);
const soul = (name: string) => souls.find((r) => r.soul_name === name)?.soul_id ?? "";
const shops = new Shops(db, items);
check(db.shops.size === 163, `${db.shops.size} shops (the note: 163)`);
check(items.get(items.money)?.name === "money", "money is an item");
const collier = db.shopOf(soul("ska_collierVarlet"));
const charcoal = items.byName("Charcoal")!;
check(collier === 17 && shops.offers(17).some((o) => o.item === charcoal.id && o.amount === 50), "Skalitz's collier (shop 17) stocks 50 charcoal");
check(shops.buyPrice(17, charcoal.id) === 6, `at 0.6 groschen each (${shops.buyPrice(17, charcoal.id) / 10})`);
const tailor = db.shopOf(soul("rat_tailor"));
const offers = tailor === undefined ? [] : shops.offers(tailor);
console.log(`  the tailor (shop ${tailor}): ${offers.length} kinds of goods, e.g. ${offers.slice(0, 4).map((o) => `${items.get(o.item)?.name} ×${o.amount} ${o.price / 10}`).join(", ")}; money ${shops.money(tailor ?? -1) / 10}`);
check(offers.length > 10 && offers.every((o) => o.price >= 1 && o.amount >= 1), "Rataje's tailor has stock, every item with a price");
const unpriced = [...db.shops.values()].flatMap((s) => db.listed(s.type)).filter((r) => r.item !== items.money && !(items.get(r.item)?.price ?? 0)).length;
console.log(`  stock rows whose item has no price in pickable_item: ${unpriced}`);
// diet mode's grants land in their shops
shops.grants = (shop) => DIET.grants.filter((g) => g.shop === shop);
for (const g of DIET.grants) check(db.shops.get(g.shop)?.name === g.shopName && shops.offers(g.shop).some((o) => o.item === g.item), `diet grant: ${g.itemName} is on sale at ${g.shopName}`);

console.log(fails ? `${fails} FAILED` : "OK");
process.exit(fails ? 1 : 0);
