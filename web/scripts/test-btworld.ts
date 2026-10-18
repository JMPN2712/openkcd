// Node test for src/btWorld.ts on Rataje (read-only): starts the tailor's
// workplace behaviour from the game's own data (NPC → work area → area template
// behaviour → trees) and traces what the trees decide for two real-time minutes.
// usage: node scripts/test-btworld.ts [GAME_ROOT] [NPC_NAME] [BEHAVIOUR]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parseTreeFile, type BtTree } from "../src/bt.ts";
import { AiDb, AiWorld, parseSmartObjectHelpers } from "../src/btWorld.ts";
import { parseEntityIndex, parseNpcEntities } from "../src/levelEntities.ts";
import type { PakSource } from "../src/paks.ts";
import { readTable } from "../src/tables.ts";
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
const vfs = await Vfs.build(sources, { filter: (n) => /^libs\/(ai|tables\/ai)\/.*\.xml$/.test(n) || n === "libs/smartobjects.xml", includeHd: false });
const trees = new Map<string, BtTree>();
for (const path of vfs.paths()) {
  if (!path.startsWith("libs/ai/")) continue;
  const xml = new TextDecoder().decode(await vfs.read(vfs.lookup(path)!));
  if (!xml.includes("<BehaviorTree")) continue;
  const rel = path.slice("libs/ai/".length);
  for (const t of parseTreeFile(xml, rel)) trees.set(`${rel}#${t.name.toLowerCase()}`, t);
}
const T = AiDb.TABLES;
const ai = new AiDb({ soTag: await readTable(vfs, T.soTag), so2tag: await readTable(vfs, T.so2tag), saTag: await readTable(vfs, T.saTag), sa2tag: await readTable(vfs, T.sa2tag) });

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
const helpers = parseSmartObjectHelpers(new TextDecoder().decode(await vfs.read(vfs.lookup("libs/smartobjects.xml")!)));
const world = new AiWorld({
  ents, ai, helpers,
  trees: (f, n) => trees.get(`${f}#${n}`),
  realTime: () => clock.real,
  gameTime: () => clock.real * 15,
  random: () => 0.5,
  trace: (m) => {
    if (m.startsWith("[unsupported]")) { unsupported.add(m.slice(14)); return; }
    const line = `${clock.real.toFixed(1).padStart(6)} s  ${m}`;
    if (lines.length < 60) lines.push(line);
  },
});
const task = world.startAreaBehaviour(npc.id, area, behaviour);
let status = "running";
for (let i = 0; task && i < 1200 && status === "running"; i++) { status = task.tick(); clock.real += 0.1; }
console.log(lines.join("\n"));
console.log(`status after ${clock.real.toFixed(0)} s: ${status}`);
console.log(`unsupported (${unsupported.size}): ${[...unsupported].join("; ")}`);
const ok = !!task && lines.some((l) => l.includes("CallBehavior") && !l.includes("not found")) && lines.some((l) => l.includes("animation"));
console.log(ok ? "OK" : "FAIL");
if (!ok) process.exit(1);
