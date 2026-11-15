// What ties the player's inventory to the quests: tracked items are counted in the inventory, a
// change to it re-checks the quests, and money and item rewards are paid into it (quests.ts,
// inventory.ts; research notes, quest-system.md "Complete objective" and "Automatic completion").
// Experience and perk rewards wait for the RPG layer: they are kept in `pending`.

import type { Inventory, ItemDb } from "./inventory.ts";
import type { QuestSystem, Reward } from "./quests.ts";

/** Tenths of a groschen per groschen: money is counted in tenths (economy.md, "Money units"). */
export const TENTHS = 10;

export function attachInventory(quests: QuestSystem, inventory: Inventory, items: ItemDb): { pending: Reward[] } {
  const pending: Reward[] = [];
  quests.world.itemCount = (item) => inventory.count(item);
  // (a re-check that pays a reward changes the inventory again: one re-check at a time)
  let checking = false, again = false;
  inventory.onChange = () => {
    if (checking) { again = true; return; }
    checking = true;
    try { do { again = false; quests.recheck(); } while (again); } finally { checking = false; }
  };
  quests.on((e) => {
    if (e.kind !== "reward") return;
    const r = e.reward;
    // ASSUMPTION: money_change amounts are groschen (the table's steps are 1, 2, 3, 5, 8, 10, …)
    if (r.kind === "money") { if (items.money && r.groschen > 0) inventory.add(items.money, Math.round(r.groschen * TENTHS)); }
    else if (r.kind === "item") inventory.add(r.item, r.count);
    else pending.push(r);
  });
  return { pending };
}
