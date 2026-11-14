// Node test for NPC messaging (src/mail.ts, btWorld.ts; research notes npc-messaging.md) on
// Rattay (read-only), with the game's own trees:
//  1. a garrison: its brain hands out its posts; guards register and run the post's job;
//  2. a shop: the merchant serves a customer who walks in (shoppe:request / shoppe:response).
// Moves and animations take their default durations (no navmesh or clips).
// usage: node scripts/test-messaging.ts [GAME_ROOT] (DEBUG=1: every trace line)

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { createAiWorld } from "../src/btWorld.ts";
import { NpcAi } from "../src/npcAi.ts";
import type { AnimLibrary } from "../src/mannequin.ts";
import type { Task } from "../src/btRuntime.ts";
import { LuaHost } from "../src/luaHost.ts";
import { parseEntityIndex, parseNpcEntities } from "../src/levelEntities.ts";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";

const root = process.argv[2] ?? join(homedir(), "kcd1");
async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak") && !p.toLowerCase().includes("/levels/")) out.push(p);
  }
  return out;
}
const sources: PakSource[] = [];
for (const p of await findPaks(join(root, "Data"))) {
  const b = await openAsBlob(p);
  sources.push({ path: relative(root, p), size: b.size, open: async () => b });
}
const vfs = await Vfs.build(sources, { filter: (n) => /^libs\/(ai|tables\/ai)\/.*\.xml$/.test(n) || n === "libs/smartobjects.xml" || n.endsWith(".lua") || n.startsWith("libs/luaxml/") || /^libs\/tables\/.*\.xml$/.test(n), includeHd: false });
const lua = await LuaHost.create(vfs, createRequire(import.meta.url).resolve("wasmoon-lua5.1/dist/liblua5.1.wasm"));
await lua.preload();
await lua.preloadTables();
const level = await openAsBlob(join(root, "Data/Levels/rataje/level.pak"));
const xml = new TextDecoder().decode(await readEntry(level, (await readCentralDirectory(level)).find((e) => e.name.toLowerCase() === "objects_mission0.xml")!));
const ents = parseEntityIndex(xml);
const npcs = parseNpcEntities(xml);
const id = (name: string) => [...ents.values()].find((e) => e.name === name)?.id ?? npcs.find((n) => n.name === name)!.id;

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const clock = { real: 0 };
let ai: NpcAi | null = null;
const lines: string[] = [];
const debug = !!process.env.DEBUG;
const world = await createAiWorld(vfs, {
  ents, lua,
  realTime: () => ai?.now ?? clock.real,
  worldTime: () => (ai?.now ?? clock.real) * 15,
  act: (a) => ai?.act(a) ?? undefined,
  random: () => 0.5,
  trace: (m) => { lines.push(m); if (debug) console.log(`${clock.real.toFixed(1).padStart(6)} s  ${m}`); },
});
lua.boot();

/** Run the tasks (NPC behaviours and area brains) for `seconds`, ten ticks a second. */
function run(tasks: Task[], seconds: number) {
  for (let i = 0; i < seconds * 10; i++) {
    for (const t of tasks) t.tick();
    clock.real += 0.1;
  }
}

// ---- 1. the garrison by the Špalíček: one post, two guards ----
{
  const garrison = id("sa_rat_garrison_spalicek");
  const guards = ["rat_guard26", "rat_guard27"].map(id);
  const brain = world.startAreaBrain(garrison);
  check(!!brain, "the garrison's brain runs (sa_garrison.xml#onUpdate)");
  const tasks: Task[] = [brain!];
  for (const g of guards) { world.beginActivity(g); tasks.push(world.startAreaBehaviour(g, garrison, "Guard")!); }
  lines.length = 0;
  run(tasks, 60);
  const registers = lines.filter((l) => l.includes("message garrison:register"));
  const posted = registers.filter((l) => !l.includes('"workplaceIndex":-1'));
  console.log(`  ${registers.length} register messages, ${posted.length} with a post:\n    ${registers.slice(0, 4).join("\n    ")}`);
  check(posted.length >= 1, "the garrison hands its post to a guard (garrison:register with a post)");
  check(lines.some((l) => l.includes('CallBehavior "Guard_job"')), "a guard runs the post's job (Guard_job)");
  check(lines.some((l) => l.includes('CallBehavior "guardIdle"')), "a guard without a post idles (guardIdle)");
  if (debug) {
    const vars = (world as unknown as { brains: Map<number, { vars: Map<string, unknown> }> }).brains.get(garrison)?.vars;
    for (const [k, v] of vars ?? []) if (k.startsWith("t_garrison") || k.startsWith("t_avail")) console.log(`  ${k} = ${JSON.stringify(v)}`);
  }
  for (const t of tasks) t.abort();
}

// ---- 2. a shop (sa_rat_shop2): its merchant, and a customer who walks in ----
{
  // walks follow straight lines; animations take 4 s (no clips)
  const noClips = { ready: new Map(), fragment: async () => null } as unknown as AnimLibrary;
  ai = new NpcAi(world, { male: noClips, female: noClips });
  const shop = id("sa_rat_shop2");
  const people = ["rat_merchant_shop2", "rat_vekosPruda"].map((n) => npcs.find((x) => x.name === n)!);
  lines.length = 0;
  ai.start(people[0], shop, "merchant", [...people[0].pos], [...people[0].rot]);
  ai.start(people[1], shop, "customer", [...people[1].pos], [...people[1].rot]);
  world.runner.debug = debug;
  for (let i = 0; i < 180 * 30; i++) ai.tick(1 / 30);
  if (debug) for (const p of people) console.log(`  ${p.name} waits in: ${(world.stuckAt.get(p.id) ?? []).slice(-10).join(" > ")}`);
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  check(has(/area sa_rat_shop2: brain/), "the shop's brain runs");
  check(has(/AddLink sa_rat_shop2 -merchant-> rat_merchant_shop2/), "the shop links its merchant when he starts (onRequest)");
  check(has(/AddLink sa_rat_shop2 -customer-> rat_vekosPruda/), "the customer who walks in is linked (onEnter)");
  check(has(/message shoppe:request to rat_merchant_shop2/), "the customer asks the merchant (shoppe:request)");
  check(has(/npc 20053: monologue MERCHANT_VYVOLAVANI/), "the merchant cries her wares (dialog:monologRequest served by the switch's monologue tree)");
  // serving: she walks to her point nearest the customer, faces him and asks for a conversation;
  // the conversation between two NPCs (RequestDialog and the dialog:status replies) needs a
  // research note, so she waits there and shoppe:response isn't sent yet
  check(world.unsupported.has("unsupported node RequestDialog") && [...world.unsupported.get("unsupported node RequestDialog")!].includes(id("rat_merchant_shop2")), "the merchant serves the customer up to the conversation (RequestDialog: research note needed)");
  console.log(`  ${lines.filter((l) => /shoppe|-customer->|-merchant->|monologue/.test(l)).slice(0, 6).join("\n  ")}`);
  console.log(`  mail: ${world.post.delivered} delivered, ${world.post.dropped} dropped`);
}

console.log(`Lua errors: ${[...new Set(lua.errors)].slice(0, 4).join(" | ") || "none"}`);
console.log(`unsupported: ${[...world.unsupported.keys()].join("; ") || "none"}`);
console.log(fails ? `${fails} FAILED` : "OK");
process.exit(fails ? 1 : 0);
