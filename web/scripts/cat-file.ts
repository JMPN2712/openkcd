// Print one file from the game's paks (by its path inside them), or list paths matching a regex.
// usage: node scripts/cat-file.ts [--root GAME_ROOT] PATH | --grep REGEX
import { homedir } from "node:os";
import { join } from "node:path";
import { gameSources } from "./lib.ts";
import { Vfs } from "../src/vfs.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const grep = opt("--grep", "");
const want = (args[0] ?? "").toLowerCase();
const re = grep ? new RegExp(grep, "i") : null;
const names: string[] = [];
const sources = await gameSources(root);
const vfs = await Vfs.build(sources.filter((s) => !s.path.toLowerCase().startsWith("data/levels/")), { filter: (n) => { if (re?.test(n)) names.push(n); return n === want; }, includeHd: false });
if (re) console.log([...new Set(names)].sort().join("\n"));
else {
  const f = vfs.lookup(want);
  if (!f) { console.error(`not found: ${want}`); process.exit(1); }
  process.stdout.write(new TextDecoder().decode(await vfs.read(f)));
}
