// Node test for src/btWorld.ts on Rataje (read-only): starts the tailor's
// workplace behaviour from the game's own data (NPC → work area → area template
// behaviour → trees) and traces what the trees decide for two real-time minutes.
// usage: node scripts/test-btworld.ts [GAME_ROOT] [NPC_NAME] [BEHAVIOUR]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createAiWorld } from "../src/btWorld.ts";
import { LuaHost } from "../src/luaHost.ts";
import { createRequire } from "node:module";
import { parseEntityIndex, parseNpcEntities } from "../src/levelEntities.ts";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { readCentralDirectory, readEntry } from "../src/zip.ts";

const root = process.argv[2] ?? join(homedir(), "kcd1");
const npcName = process.argv[3] ?? "rat_tailor";
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
const mission = (await readCentralDirectory(level)).find((e) => e.name.toLowerCase() === "objects_mission0.xml")!;
const xml = new TextDecoder().decode(await readEntry(level, mission));
const ents = parseEntityIndex(xml);
const npc = parseNpcEntities(xml).find((n) => n.name === npcName)!;
const [workLink, area] = [...npc.links].find(([k]) => k.split(",").some((p) => p.startsWith("Work")))!;
const behaviour = process.argv[4] ?? /Work\['?([^'\]]+)'?\]/.exec(workLink)?.[1] ?? "work";
console.log(`${npcName}: work link "${workLink}" → ${ents.get(area)?.name} (template ${ents.get(area)?.saTemplate}); behaviour "${behaviour}"`);

const clock = { real: 0 };
const lines: string[] = [];
const unsupported = new Set<string>();
const world = await createAiWorld(vfs, {
  ents, lua,
  realTime: () => clock.real,
  worldTime: () => clock.real * 15,
  random: () => 0.5,
  trace: (m) => {
    if (m.startsWith("[unsupported]")) { unsupported.add(m.slice(14)); return; }
    const line = `${clock.real.toFixed(1).padStart(6)} s  ${m}`;
    if (lines.length < 60) lines.push(line);
  },
});
console.log(`Lua: main.lua ${lua.boot() ? "booted" : "failed"}; errors ${lua.errors.length} ${lua.errors.slice(0, 2).join(" | ")}`);
lua.calls.clear();
const task = world.startAreaBehaviour(npc.id, area, behaviour);
let status = "running";
for (let i = 0; task && i < 1200 && status === "running"; i++) { status = task.tick(); clock.real += 0.1; }
console.log(lines.join("\n"));
console.log(`status after ${clock.real.toFixed(0)} s: ${status}`);
console.log(`unsupported (${unsupported.size}): ${[...unsupported].join("; ")}`);
console.log(`engine API called from tree Lua: ${[...lua.calls].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}×${v}`).join(", ")}`);
console.log(`Lua errors (${lua.errors.length}): ${[...new Set(lua.errors)].slice(0, 5).join(" | ")}`);
const ok = !!task && lines.some((l) => l.includes("CallBehavior") && !l.includes("not found")) && lines.some((l) => l.includes("animation"));
console.log(ok ? "OK" : "FAIL");
if (!ok) process.exit(1);
