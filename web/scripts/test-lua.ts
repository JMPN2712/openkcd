// Node test for src/luaHost.ts: Lua 5.1 semantics, the data round trip used by
// behaviour trees, and booting the game's Scripts/main.lua against the asset VFS.
// usage: node scripts/test-lua.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { LuaHost } from "../src/luaHost.ts";
import { TypeDefs } from "../src/typeDefs.ts";

const wasm = createRequire(import.meta.url).resolve("wasmoon-lua5.1/dist/liblua5.1.wasm");
const root = process.argv[2] ?? join(homedir(), "kcd1");
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); if (!ok) fails++; };

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
const vfs = await Vfs.build(sources, { filter: (n) => n.endsWith(".lua") || n.startsWith("libs/luaxml/") || n === "libs/ai/typedefinitions.xml", includeHd: false });
const host = await LuaHost.create(vfs, wasm);

check("Lua 5.1 semantics", host.lua.doStringSync(`return _VERSION .. "|" .. tostring(10/2) .. "|" .. table.getn({1,2,3})`) === "Lua 5.1|5|3");
// the behaviour-tree data round trip: the workplace snippet from final/sa_templates.xml (commonWorkplace)
const changed = host.run(
  `local saEntity = XGenAIModule.GetEntityByWUID(data.__area.id)
   local chance = tonumber(GetEntityScriptProperty(saEntity, 'workBreakChance')) or 0.25
   if chance then data.t_workplace_params.breakChance = chance end
   data.t_list[3] = 'c'
   entity.soul:AddMetaRoleByName('MERCHANT', false)`,
  { __area: { id: 649 }, t_workplace_params: { breakChance: 1, useCategories: "tailor_measuring" }, t_list: ["a", "b"], untouched: 5 },
  { id: 22547, name: "rat_tailor" },
);
const want = { t_workplace_params: { breakChance: 0.25, useCategories: "tailor_measuring" }, t_list: ["a", "b", "c"] };
const sorted = (o: object) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
check("tree Lua writes data back (only changed variables)", sorted(changed) === sorted(want), JSON.stringify(changed));
check("engine calls are stubbed and counted", host.calls.get("entity.soul.AddMetaRoleByName") === 1 && host.calls.get("XGenAIModule.GetEntityByWUID") === 1, JSON.stringify([...host.calls]));

const t0 = performance.now();
const n = await host.preload();
host.calls.clear();
const defs = new TypeDefs(new TextDecoder().decode(await vfs.read(vfs.lookup("libs/ai/typedefinitions.xml")!)));
host.defineEnums(defs.luaEnums());
console.log(`TypeDefinitions: ${defs.types.size} types, ${defs.enums.size} enums; cutsceneData default: ${JSON.stringify(defs.defaultOf("cutsceneData")).slice(0, 160)}`);
const ok = host.boot();
console.log(`main.lua: ${ok ? "ran" : "failed"} (${n} scripts preloaded, ${Math.round(performance.now() - t0)} ms); errors ${host.errors.length}: ${host.errors.slice(0, 5).join(" | ")}`);
console.log(`engine API touched while booting: ${[...host.calls].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`).join(", ")}`);
const defined = host.lua.doStringSync(`local t = {} for k, v in pairs(_G) do if type(k) == "string" and (type(v) == "function" or (type(v) == "table" and not getmetatable(v))) then t[#t + 1] = k end end table.sort(t) return #t .. ": " .. table.concat(t, " ", 1, math.min(#t, 60))`);
console.log(`globals defined by the game's scripts after boot (plain tables and functions) ${defined}`);
// remaining errors are engine APIs not implemented yet (e.g. Database.GetTableInfo in Events.lua)
check("main.lua and OnInit run to the end", ok, host.errors.length ? `known gaps: ${host.errors.slice(0, 3).join(" | ")}` : "no errors");
console.log(fails ? `FAIL (${fails})` : "OK");
if (fails) process.exit(1);
