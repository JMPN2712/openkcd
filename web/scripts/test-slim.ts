// Node test for src/slim.ts: the entry codec round-trips typed arrays and Maps, and a built
// package (scripts/build-slim.ts) gives the same models and textures as the paks, for a sample.
// usage: node scripts/test-slim.ts PACKAGE_DIR [--root GAME_ROOT] [--sample N]

import { homedir } from "node:os";
import { join } from "node:path";
import { decodeEntry, encodeEntry, SlimPackage, textureKeys } from "../src/slim.ts";
import { loadMipChain, loadModelParts, setGpuBlockCompression } from "../src/model.ts";
import { nodeSlimFiles, openRataje } from "./lib.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args.splice(args.indexOf(k), 2)[1] : d);
const root = opt("--root", join(homedir(), "kcd1"));
const sample = Number(opt("--sample", "300"));
const dir = args[0];
if (!dir) throw new Error("usage: test-slim.ts PACKAGE_DIR [--root GAME_ROOT] [--sample N]");

let failures = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } };
const same = (a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined) => {
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
  return true;
};

// the codec
{
  const v = { a: new Float32Array([1.5, -2, 3]), b: [new Uint16Array([1, 2, 3, 4, 5]), new Uint8Array([7])], m: new Map([["x", "y"]]), s: "text", n: null };
  const back = decodeEntry<typeof v>(encodeEntry(v));
  check(same(back.a, v.a) && back.a instanceof Float32Array, "codec: Float32Array");
  check(same(back.b[0], v.b[0]) && same(back.b[1], v.b[1]), "codec: arrays in arrays");
  check(back.m instanceof Map && back.m.get("x") === "y", "codec: Map");
  check(back.s === "text" && back.n === null, "codec: plain values");
  const copied = decodeEntry<typeof v>(encodeEntry(v), true);
  check(same(copied.a, v.a) && copied.a.byteOffset === 0, "codec: copy");
}

// the package against the paks
setGpuBlockCompression(true);
const lvl = await openRataje(root);
const pkg = await SlimPackage.open(nodeSlimFiles(dir));
const paths = Object.keys(pkg.index.models);
const step = Math.max(1, Math.floor(paths.length / sample));
let models = 0, textures = 0;
for (let i = 0; i < paths.length; i += step) {
  const p = paths[i];
  const [a, b] = await Promise.all([pkg.modelParts(p), loadModelParts(lvl.vfs, p)]);
  models++;
  check(a.cgf.meshes.length === b.cgf.meshes.length, `${p}: mesh count`);
  a.cgf.meshes.forEach((m, k) => {
    const n = b.cgf.meshes[k];
    if (!n) return;
    check(same(m.positions, n.positions) && same(m.indices, n.indices) && same(m.normals, n.normals) && same(m.uvs, n.uvs) && same(m.tangents, n.tangents) && same(m.colors, n.colors), `${p} mesh ${k}: streams`);
    check(JSON.stringify(m.subsets) === JSON.stringify(n.subsets) && same(m.transform, n.transform), `${p} mesh ${k}: subsets / transform`);
  });
  check(a.cgf.physics.length === b.cgf.physics.length, `${p}: physics proxies`);
  check(a.mtlPath === b.mtlPath && a.materials.length === b.materials.length, `${p}: materials`);
  // one of its textures, at a size the pool would load
  const key = textureKeys(a.materials)[0];
  if (key && pkg.index.textures[key]) {
    const [stem, n] = key.split("|");
    const cap = pkg.index.textureCap || Infinity;
    const [x, y] = await Promise.all([pkg.textures(stem, Math.min(512, cap), n === "n"), loadMipChain(lvl.vfs, stem, Math.min(512, cap), { normalMap: n === "n" })]);
    textures++;
    check(x.levels.length === y.levels.length && x.levels.every((l, k) => l.w === y.levels[k].w && same(l.data, y.levels[k].data)), `${key}: levels`);
    check(x.bc?.format === y.bc?.format && x.full === y.full, `${key}: format`);
  }
}
console.log(`${pkg.index.variant} package: ${paths.length} models, ${Object.keys(pkg.index.textures).length} textures; compared ${models} models and ${textures} textures with the paks: ${failures} failures`);
process.exit(failures ? 1 : 0);
