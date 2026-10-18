// Node test for src/terrain.ts on a real level (read-only): parses terrain.dat,
// checks that the node tree ends where the object octree starts, measures
// seams between leaves, and writes a hillshade PNG for a visual check.
// usage: node scripts/test-terrain.ts OUT.png [GAME_ROOT] [LEVEL]

import { openAsBlob } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { parseTerrain, HEIGHT_UNIT } from "../src/terrain.ts";

const [out, rootArg, levelArg] = process.argv.slice(2);
if (!out) throw new Error("usage: test-terrain.ts OUT.png [GAME_ROOT] [LEVEL]");
const root = rootArg ?? join(homedir(), "kcd1");
const level = levelArg ?? "rataje";

const blob = await openAsBlob(join(root, `Data/Levels/${level}/level.pak`));
const entry = (await readCentralDirectory(blob)).find((e) => e.name.toLowerCase() === "terrain/terrain.dat");
if (!entry) throw new Error("terrain/terrain.dat not found");
const t0 = performance.now();
const t = parseTerrain(await readEntry(blob, entry));
console.log(`terrain ${t.size}x${t.size} m, ${t.leaves} leaves (${[...t.leafResolutions].map(([n, c]) => `${n}²:${c}`).join(" ")}), heights ${t.minHeight.toFixed(1)}..${t.maxHeight.toFixed(1)} m, ${Math.round(performance.now() - t0)} ms`);
console.log(`${t.vegetation.length} vegetation groups, ${t.brushNames.length} brush names, ${t.materials.length} materials; object octree at byte ${t.objectsOffset}`);

// seam check: second differences across 64 m sector borders vs. inside sectors
const side = t.size + 1;
const h = (x: number, y: number) => t.heights[y * side + x] * HEIGHT_UNIT;
let seam = 0, seamN = 0, inner = 0, innerN = 0;
for (let y = 1; y < side - 1; y += 7) {
  for (let x = 1; x < side - 1; x++) {
    const d2 = Math.abs(h(x - 1, y) - 2 * h(x, y) + h(x + 1, y));
    if (x % 64 === 0) { seam += d2; seamN++; } else { inner += d2; innerN++; }
  }
}
console.log(`mean |2nd difference|: at sector borders ${(seam / seamN).toFixed(4)} m, inside sectors ${(inner / innerN).toFixed(4)} m`);

// hillshade, 1 px per 4 m
const S = 4, W = Math.floor(t.size / S);
const rgba = new Uint8Array(W * W * 4);
for (let py = 0; py < W; py++) {
  for (let px = 0; px < W; px++) {
    const x = Math.min(side - 2, px * S), y = Math.min(side - 2, py * S);
    const dx = (h(x + 1, y) - h(Math.max(0, x - 1), y)) / 2, dy = (h(x, y + 1) - h(x, Math.max(0, y - 1))) / 2;
    const shade = Math.max(0, Math.min(1, 0.6 + (-dx * 0.7 - dy * 0.7) * 0.6));
    const e = (h(x, y) - t.minHeight) / (t.maxHeight - t.minHeight);
    const i = ((W - 1 - py) * W + px) * 4; // north (+y) up
    rgba[i] = 255 * shade * (0.45 + 0.5 * e);
    rgba[i + 1] = 255 * shade * (0.55 + 0.35 * e);
    rgba[i + 2] = 255 * shade * (0.4 + 0.3 * e);
    rgba[i + 3] = 255;
  }
}
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc((W * 4 + 1) * W);
for (let y = 0; y < W; y++) Buffer.from(rgba.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
await writeFile(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
console.log(`wrote ${out} (${W}x${W}, 1 px = ${S} m, north up)`);
