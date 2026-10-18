// Node test for src/bt.ts (read-only): parses every behaviour tree in Libs/AI,
// parses every quoted property as an expression and resolves IncludeTree targets.
// usage: node scripts/test-bt.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";
import { parseTreeFile, parseExpr, quoted, isTextProp, type BtNode, type BtTree } from "../src/bt.ts";

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
const vfs = await Vfs.build(sources, { filter: (n) => /^libs\/ai\/.*\.xml$/.test(n), includeHd: false });
let t0 = performance.now();
const trees = new Map<string, BtTree>();
let files = 0;
for (const path of vfs.paths()) {
  const xml = new TextDecoder().decode(await vfs.read(vfs.lookup(path)!));
  if (!xml.includes("<BehaviorTree")) continue;
  files++;
  const rel = path.slice("libs/ai/".length);
  for (const t of parseTreeFile(xml, rel)) trees.set(`${rel}#${t.name.toLowerCase()}`, t);
}
console.log(`${files} files, ${trees.size} trees parsed in ${Math.round(performance.now() - t0)} ms`);

// expressions: every quoted property, by property name
t0 = performance.now();
let total = 0, failed = 0;
const failsByProp = new Map<string, { n: number; ex: string; err: string }>();
let includes = 0, unresolved = 0, dynamic = 0;
const missing = new Map<string, number>();
const visit = (n: BtNode) => {
  for (const [k, v] of Object.entries(n.props)) {
    const q = quoted(v);
    if (q === null || isTextProp(k, q)) continue;
    total++;
    try {
      parseExpr(q);
    } catch (e) {
      failed++;
      const key = `${n.tag}.${k}`;
      const f = failsByProp.get(key) ?? { n: 0, ex: q.slice(0, 90), err: (e as Error).message };
      f.n++;
      failsByProp.set(key, f);
    }
  }
  if (n.tag === "IncludeTree") {
    includes++;
    const file = quoted(n.props.File)?.toLowerCase().replaceAll("\\", "/"), name = quoted(n.props.Name)?.toLowerCase();
    if (file?.startsWith("$") || name?.startsWith("$")) dynamic++;
    else if (!file || !name || !trees.has(`${file}#${name}`)) {
      unresolved++;
      const k = `${file}#${name}`;
      missing.set(k, (missing.get(k) ?? 0) + 1);
    }
  }
  n.children.forEach(visit);
};
for (const t of trees.values()) if (t.root) visit(t.root);
console.log(`quoted properties: ${total}, parsed as expressions: ${total - failed} (${((100 * (total - failed)) / total).toFixed(2)}%) in ${Math.round(performance.now() - t0)} ms`);
console.log("not parsing (by node.property):", [...failsByProp].sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, f]) => `\n  ${k} ×${f.n}: ${JSON.stringify(f.ex)} — ${f.err}`).join(""));
console.log(`IncludeTree: ${includes} (${dynamic} with run-time targets), unresolved ${unresolved}`, [...missing].sort((a, b) => b[1] - a[1]).slice(0, 5));
const ok = trees.size > 4800 && (total - failed) / total >= 0.999 && unresolved === 0;
console.log(ok ? "OK" : "FAIL");
if (!ok) process.exit(1);
