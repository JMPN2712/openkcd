// Warhorse database tables (Libs/Tables/**.xml): <database><table><rows><row col="v" …/>.
// The binary .tbl twins carry the same data; the XML is simpler to read.

import type { Vfs } from "./vfs.ts";

export type Row = Record<string, string>;

const ROW_RE = /<row\s([^>]*?)\/>/g;
const ATTR_RE = /([\w.:-]+)="([^"]*)"/g;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function parseTable(text: string): Row[] {
  const out: Row[] = [];
  for (const m of text.matchAll(ROW_RE)) {
    const row: Row = {};
    for (const a of m[1].matchAll(ATTR_RE)) row[a[1]] = a[2].includes("&") ? a[2].replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]) : a[2];
    out.push(row);
  }
  return out;
}

/** Read Libs/Tables/<name>.xml (e.g. "item/armor"). Throws if the table is missing. */
export async function readTable(vfs: Vfs, name: string): Promise<Row[]> {
  const path = `libs/tables/${name}.xml`;
  const hit = vfs.lookup(path);
  if (!hit) throw new Error(`table ${path} not found`);
  return parseTable(new TextDecoder("latin1").decode(await vfs.read(hit)));
}

export function indexBy(rows: Row[], key: string): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const r of rows) if (r[key]) m.set(r[key], r);
  return m;
}

export function groupBy(rows: Row[], key: string): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r[key];
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}
