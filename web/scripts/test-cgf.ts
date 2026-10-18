// Node test for src/cgf.ts against every geometry file in a real install (read-only).
// usage: node scripts/test-cgf.ts [GAME_ROOT] [--ext cgf,cga,skin,chr]

import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readCentralDirectory, readEntry } from "../src/zip.ts";
import { parseCgf, CHUNK } from "../src/cgf.ts";

const args = process.argv.slice(2);
const root = args[0] && !args[0].startsWith("--") ? args[0] : join(homedir(), "kcd1");
const exts = (args.includes("--ext") ? args[args.indexOf("--ext") + 1] : "cgf,cga,skin,chr").split(",");

async function findPaks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await findPaks(p)));
    else if (d.name.toLowerCase().endsWith(".pak")) out.push(p);
  }
  return out;
}

const streamSizes = new Map<string, number>();
const failures = new Map<string, string[]>();
const fail = (kind: string, msg: string) => {
  if (!failures.has(kind)) failures.set(kind, []);
  failures.get(kind)!.push(msg);
};
let files = 0, meshes = 0, tris = 0, noMesh = 0, noNormals = 0, noUvs = 0, withMtl = 0;
let agree = 0, disagree = 0;
const perFileAgreement: number[] = [];
const t0 = performance.now();

for (const pakPath of (await findPaks(root)).sort()) {
  const blob = await openAsBlob(pakPath);
  const entries = (await readCentralDirectory(blob)).filter((e) => exts.includes(e.name.toLowerCase().split(".").pop()!));
  for (const e of entries) {
    const where = `${relative(root, pakPath)}:${e.name}`;
    files++;
    let cgf;
    try {
      cgf = parseCgf(await readEntry(blob, e));
    } catch (err) {
      fail("parse error: " + (err as Error).message.replace(/\d+/g, "N"), where);
      continue;
    }
    // stream element sizes, for the record
    for (const c of cgf.chunks) {
      if (c.type === CHUNK.DataStream) streamSizes.set(`v${c.version.toString(16)}`, (streamSizes.get(`v${c.version.toString(16)}`) ?? 0) + 1);
    }
    if (!cgf.meshes.length) { noMesh++; continue; }
    if (cgf.material) withMtl++;
    let fa = 0, fd = 0;
    for (const m of cgf.meshes) {
      meshes++;
      const nv = m.positions.length / 3;
      tris += m.indices.length / 3;
      if (!m.normals) noNormals++;
      if (!m.uvs) noUvs++;
      let maxIdx = 0;
      for (const i of m.indices) if (i > maxIdx) maxIdx = i;
      if (maxIdx >= nv) fail("index out of range", where);
      for (const s of m.subsets) {
        if (s.firstIndex + s.numIndices > m.indices.length || s.firstVert + s.numVerts > nv) { fail("subset out of range", where); break; }
      }
      // positions inside the declared bbox (with tolerance for half-float rounding)
      const ext = Math.max(...[0, 1, 2].map((c) => m.bboxMax[c] - m.bboxMin[c]), 1e-3);
      const tol = ext * 0.01 + 1e-3;
      let outside = 0;
      for (let i = 0; i < nv; i++) {
        for (let c = 0; c < 3; c++) {
          const v = m.positions[i * 3 + c];
          if (!(v >= m.bboxMin[c] - tol && v <= m.bboxMax[c] + tol)) { outside++; break; }
        }
      }
      if (outside) fail(`positions outside bbox`, `${where} (${outside}/${nv})`);
      // vertex normals vs geometric face normals (counter-clockwise winding assumed)
      if (m.normals) {
        const P = m.positions, N = m.normals, I = m.indices;
        for (let t = 0; t + 2 < I.length; t += 3) {
          const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
          const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
          const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
          const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
          if (Math.hypot(fx, fy, fz) < 1e-12) continue;
          const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
          if (fx * nx + fy * ny + fz * nz > 0) fa++; else fd++;
        }
      }
    }
    agree += fa; disagree += fd;
    if (fa + fd > 0) perFileAgreement.push(fa / (fa + fd));
  }
}

const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`${files} files (${exts.join(",")}), ${meshes} meshes, ${(tris / 1e6).toFixed(1)}M triangles, ${secs}s`);
console.log(`no renderable mesh: ${noMesh}, with material: ${withMtl}, meshes without normals: ${noNormals}, without UVs: ${noUvs}`);
console.log(`stream chunk versions: ${[...streamSizes].map(([k, v]) => `${k}=${v}`).join(" ")}`);
const ratio = agree / Math.max(1, agree + disagree);
const lowFiles = perFileAgreement.filter((r) => r < 0.5).length;
console.log(`normals agree with CCW face normals on ${(ratio * 100).toFixed(2)}% of triangles; files with < 50% agreement: ${lowFiles}/${perFileAgreement.length}`);
for (const [k, v] of failures) console.log(`FAIL ${k}: ${v.length}  e.g. ${v.slice(0, 3).join(" | ")}`);
process.exit(failures.size ? 1 : 0);
