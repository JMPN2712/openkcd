// What retains a page's array buffers: reads a V8 heap snapshot (profile-browser.ts --memory
// --snapshot=FILE), finds each ArrayBuffer's backing store and its shortest retaining path from
// the root (weak edges left out), and sums the bytes by path, a few steps deep and in full.
// The arrays are parsed as a stream of numbers: a large snapshot is more than one JS string holds.
// usage: node scripts/heap-buffers.ts SNAPSHOT [--depth=6] [--top=40]

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: heap-buffers.ts SNAPSHOT [--depth=6] [--top=40]");
const opt = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d);
const depth = opt("depth", 6), top = opt("top", 40);
const buf = readFileSync(file);

const find = (s: string, from = 0) => { const i = buf.indexOf(s, from); if (i < 0) throw new Error(`${s} not in the snapshot`); return i; };
const nodesAt = find('"nodes":[');
const header = JSON.parse(buf.subarray(0, buf.lastIndexOf(",", nodesAt)).toString() + "}").snapshot;
const meta = header.meta;
const NF = meta.node_fields.length, EF = meta.edge_fields.length;
const nodeTypes: string[] = meta.node_types[0], edgeTypes: string[] = meta.edge_types[0];
const fN = (k: string) => meta.node_fields.indexOf(k), fE = (k: string) => meta.edge_fields.indexOf(k);

/** The numbers of a JSON array starting at `at` (just after its '['). */
function numbers(at: number, count: number): Float64Array {
  const out = new Float64Array(count);
  let k = 0, v = 0, inNum = false, neg = false;
  for (let i = at; k < count; i++) {
    const c = buf[i];
    if (c >= 48 && c <= 57) { v = v * 10 + (c - 48); inNum = true; }
    else if (c === 45) neg = true;
    else if (inNum || c === 93) { if (inNum) out[k++] = neg ? -v : v; v = 0; inNum = false; neg = false; if (c === 93) break; }
  }
  return out;
}
const nodes = numbers(nodesAt + 9, header.node_count * NF);
const edgesAt = find('"edges":[', nodesAt);
const edges = numbers(edgesAt + 9, header.edge_count * EF);
// strings: one JSON string after another
const strings: string[] = [];
{
  let i = find('"strings":[', edgesAt) + 11;
  while (buf[i] !== 93) {
    if (buf[i] !== 34) { i++; continue; }
    let j = i + 1;
    while (buf[j] !== 34) j += buf[j] === 92 ? 2 : 1;
    strings.push(JSON.parse(buf.subarray(i, j + 1).toString()));
    i = j + 1;
  }
}

const N = header.node_count;
const TYPE = fN("type"), NAME = fN("name"), SIZE = fN("self_size"), ECOUNT = fN("edge_count");
const ETYPE = fE("type"), ENAME = fE("name_or_index"), ETO = fE("to_node");
const firstEdge = new Uint32Array(N + 1);
for (let n = 0; n < N; n++) firstEdge[n + 1] = firstEdge[n] + nodes[n * NF + ECOUNT];
const nodeName = (n: number) => strings[nodes[n * NF + NAME]];
const nodeType = (n: number) => nodeTypes[nodes[n * NF + TYPE]];
const edgeLabel = (e: number) => {
  const t = edgeTypes[edges[e * EF + ETYPE]], v = edges[e * EF + ENAME];
  return t === "element" || t === "hidden" ? "[]" : strings[v] ?? String(v);
};

// shortest retaining paths: breadth first from the root over strong edges
const parentEdge = new Int32Array(N).fill(-1), parentNode = new Int32Array(N).fill(-1);
const seen = new Uint8Array(N);
let queue = new Int32Array(N), head = 0, tail = 0;
queue[tail++] = 0; seen[0] = 1;
const weak = edgeTypes.indexOf("weak");
while (head < tail) {
  const n = queue[head++];
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e++) {
    if (edges[e * EF + ETYPE] === weak) continue;
    const to = edges[e * EF + ETO] / NF;
    if (seen[to]) continue;
    seen[to] = 1; parentEdge[to] = e; parentNode[to] = n; queue[tail++] = to;
  }
}

// backing stores: the targets of ArrayBuffers' "backing_store" edges
const byPath = new Map<string, number>(), byShort = new Map<string, number>();
let total = 0, unreachable = 0;
for (let n = 0; n < N; n++) {
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e++) {
    if (edgeLabel(e) !== "backing_store") continue;
    const to = edges[e * EF + ETO] / NF, size = nodes[to * NF + SIZE];
    if (size < 4096) continue;
    total += size;
    if (!seen[n]) { unreachable += size; continue; }
    const steps: string[] = [];
    for (let m = n; parentNode[m] >= 0; m = parentNode[m]) {
      const p = parentNode[m];
      const t = nodeType(p), name = nodeName(p);
      // (a closure's context names the captured variable on its edge)
      const owner = name === "system / Context" ? "ctx" : t === "object" || t === "closure" ? name.split(" ")[0] : t === "synthetic" ? "" : t;
      steps.push(`${owner}.${edgeLabel(parentEdge[m])}`);
    }
    steps.reverse();
    // from the window object down; Maps' and arrays' internals folded
    const start = steps.findIndex((s) => /^Window\./.test(s));
    const path = steps.slice(start >= 0 ? start : 0).filter((s) => !/^(system|array|hidden|native)\.|\.\[\]$|\.table$|\.context$/.test(s));
    const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + size);
    // the holder: the last steps (where the data hangs), and the way there in full
    add(byShort, path.slice(-depth).join(" → "));
    add(byPath, path.join(" → "));
  }
}
const mib = (b: number) => `${(b / 2 ** 20).toFixed(1)} MiB`;
console.log(`array buffers of 4 KiB or more: ${mib(total)} (unreachable from the root: ${mib(unreachable)})`);
console.log(`\nby the last ${depth} steps:`);
for (const [k, v] of [...byShort].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${mib(v).padStart(11)}  ${k}`);
console.log(`\nby full path:`);
for (const [k, v] of [...byPath].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${mib(v).padStart(11)}  ${k.length > 400 ? "…" + k.slice(-400) : k}`);
