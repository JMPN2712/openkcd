// Node test for src/btRuntime.ts: node semantics on small hand-written trees,
// then a real tree from the game (the tailor workplace's settings) run against
// a stub host.
// usage: node scripts/test-btrun.ts [GAME_ROOT]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parseTreeFile, type BtTree } from "../src/bt.ts";
import { Runner, type Host, type Status, type Value } from "../src/btRuntime.ts";
import type { PakSource } from "../src/paks.ts";
import { Vfs } from "../src/vfs.ts";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) fails++;
};

// hand-written trees use the game's syntax (quoted expression properties)
const q = (s: string) => `&quot;${s.replace(/'/g, "&apos;")}&quot;`;
function trees(xml: string): Map<string, BtTree> {
  const m = new Map<string, BtTree>();
  for (const t of parseTreeFile(`<BehaviorTrees>${xml}</BehaviorTrees>`, "test.xml")) m.set(t.name.toLowerCase(), t);
  return m;
}
function host(lib: Map<string, BtTree>, clock: { t: number }, rnd = 0.25): Host {
  return {
    worldTime: () => clock.t * 15, realTime: () => clock.t, random: () => rnd,
    tree: (file, name) => (file === "test.xml" ? lib.get(name) : undefined),
  };
}
function run(lib: Map<string, BtTree>, name: string, opts: { ticks?: number; dt?: number; rnd?: number } = {}) {
  const clock = { t: 0 };
  const r = new Runner(host(lib, clock, opts.rnd));
  const { task, scope } = r.instantiate(lib.get(name)!);
  let s: Status = "running";
  let ticks = 0;
  for (; ticks < (opts.ticks ?? 100) && s === "running"; ticks++) { s = task.tick(); clock.t += opts.dt ?? 1; }
  return { s, ticks, scope, problems: r.problems, get: (v: string) => scope.get(v) as Value };
}
const tree = (name: string, vars: string, body: string, init = "") =>
  `<BehaviorTree name="${name}"><Variables>${vars}</Variables><Root>${init ? `<OnInit>${init}</OnInit>` : ""}<Behavior>${body}</Behavior></Root></BehaviorTree>`;
const v = (name: string, type: string, values = "", form = "single") => `<Variable name="${name}" type="${type}" values="${values}" form="${form}" />`;
const expr = (s: string) => `<Expression expressions="${q(s)}" />`;

{
  const lib = trees(tree("t", v("a", "_int", "0") + v("b", "_bool", "false"),
    `<Sequence>${expr("$a = 1")}<Selector><Fail />${expr("$b = true")}</Selector>${expr("$a += 2")}</Sequence>`,
    expr("$a = 10")));
  const r = run(lib, "t");
  check("OnInit then Sequence/Selector/Expression", r.s === "success" && r.get("a") === 3 && r.get("b") === true, `${r.s} a=${r.get("a")} b=${r.get("b")}`);
}
{
  const lib = trees(tree("t", v("n", "_int", "0"),
    `<While condition="${q("$n < 5")}" doFail="${q("false")}" propagateChildFail="${q("false")}"><Sequence>${expr("$n += 1")}<Wait duration="${q("2s")}" timeType="${q("GameTime")}" /></Sequence></While>`));
  const r = run(lib, "t");
  check("While + Wait 2s (game time)", r.s === "success" && r.get("n") === 5 && r.ticks >= 10, `${r.s} n=${r.get("n")} after ${r.ticks} ticks`);
}
{
  const lib = trees(tree("t", v("xs", "_int", "", "array") + v("x", "_int", "0") + v("sum", "_int", "0") + v("stop", "_bool", "false"),
    `<Sequence>${expr("$xs = 0")}<VarOperation varName="${q("xs")}" targetVarName="${q("")}" operation="${q("Reinit")}" argument="${q("")}" />` +
    [3, 4, 5, 6].map((k) => `<VarOperation varName="${q("xs")}" targetVarName="${q("")}" operation="${q("PushBack")}" argument="${q(String(k))}" />`).join("") +
    `<ForEach startIndex="${q("1")}" step="${q("1")}" array="${q("xs")}" iterator="${q("")}" value="${q("x")}" break="${q("stop")}"><Sequence>${expr("$sum += $x")}<IfCondition failOnCondition="${q("false")}" condition="${q("$x == 5")}">${expr("$stop = true")}</IfCondition></Sequence></ForEach></Sequence>`));
  const r = run(lib, "t");
  check("VarOperation Reinit/PushBack + ForEach from index 1 with break", r.s === "success" && r.get("sum") === 9, `${r.s} xs=${JSON.stringify(r.get("xs"))} sum=${r.get("sum")}`);
}
{
  const lib = trees(tree("t", v("done", "_int", "0"),
    `<Parallel successMode="${q("Any")}" failureMode="${q("Any")}"><Wait duration="${q("-1")}" timeType="${q("GameTime")}" /><Sequence><Wait duration="${q("3s")}" timeType="${q("GameTime")}" />${expr("$done = 1")}</Sequence></Parallel>`));
  const r = run(lib, "t");
  check("Parallel Any ends when one child succeeds (other waits forever)", r.s === "success" && r.get("done") === 1, `${r.s} after ${r.ticks} ticks`);
}
{
  const lib = trees(
    tree("outer", v("p", "params"), `<Sequence><IncludeTree File="${q("test.xml")}" Name="${q("inner")}" />${expr("$p.total = $p.a + $p.b")}</Sequence>`) +
    `<BehaviorTree name="inner"><Variables /><Root><Behavior>${expr("$p.a = 2, $p.b = 1.5h")}</Behavior></Root><EditorData><ForwardDeclarations>${v("p", "params")}</ForwardDeclarations></EditorData></BehaviorTree>`);
  const r = run(lib, "outer");
  const p = r.get("p") as Record<string, number>;
  check("IncludeTree shares the caller's variables (forward declarations)", r.s === "success" && p?.total === 5402, `${r.s} p=${JSON.stringify(p)}`);
}
{
  const lib = trees(tree("t", v("p", "params"), `<Sequence>${expr("$p.d = '1m 30s'")}<Wait duration="${q("$p.d")}" timeType="${q("GameTime")}" /></Sequence>`));
  const r = run(lib, "t", { ticks: 200, dt: 1 });
  check("Wait reads a duration string from a variable ('1m 30s')", r.s === "success" && r.ticks >= 90 && r.ticks <= 92, `${r.s} after ${r.ticks} ticks`);
}
{
  const lib = trees(tree("t", v("r", "_string", ""), `<RandomGate opensWithChance="${q("0.5")}"><Then>${expr("$r = 'then'")}</Then><Else>${expr("$r = 'else'")}</Else></RandomGate>`));
  check("RandomGate opens below the chance", run(lib, "t", { rnd: 0.25 }).get("r") === "then" && run(lib, "t", { rnd: 0.75 }).get("r") === "else");
}

// a real tree: final/sa_tailory.xml "tailor_setParams" (sets the workplace parameters)
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
const game = new Map<string, BtTree>();
for (const path of vfs.paths()) {
  const xml = new TextDecoder().decode(await vfs.read(vfs.lookup(path)!));
  if (!xml.includes("<BehaviorTree")) continue;
  for (const t of parseTreeFile(xml, path.slice(8))) game.set(`${path.slice(8)}#${t.name.toLowerCase()}`, t);
}
{
  const clock = { t: 0 };
  const r = new Runner({ worldTime: () => clock.t * 15, realTime: () => clock.t, random: () => 0.5, tree: (f, n) => game.get(`${f}#${n}`) });
  const tailor = game.get("final/sa_tailory.xml#tailor")!;
  // run only its OnInit (the parameters); its Behavior is the shared workplace loop
  const { scope } = r.instantiate(tailor);
  const init = r.make(tailor.root!.children.find((c) => c.tag === "OnInit")!, scope);
  const s = init.tick();
  const p = scope.get("t_workplace_params") as Record<string, Value>;
  // the game stores durations as strings ('10s'); numeric uses read them as seconds
  check("game tree sa_tailory.xml#tailor OnInit → tailor_setParams", s === "success" && p?.useCategories === "tailor_measuring" && p?.breakChance === 1 && p?.breakDuration === "10s" && p?.breakVariation === "30s", `${s} ${JSON.stringify(p)}`);
  // and the whole tree for a few game minutes, to list what the world side must provide
  const full = r.instantiate(tailor).task;
  let st: Status = "running";
  for (let i = 0; i < 600 && st === "running"; i++) { st = full.tick(); clock.t += 1; }
  console.log(`whole tailor tree after 10 game minutes: ${st}; host features needed: ${r.problems.join("; ")}`);
}
console.log(fails ? `FAIL (${fails})` : "OK");
if (fails) process.exit(1);
