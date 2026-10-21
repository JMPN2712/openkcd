// Read-only ZIP reader for CryEngine .pak archives.
//
// Only the central directory is trusted: in KCD's original paks the local
// headers spell paths with '\' and some patch paks use data descriptors, so
// local headers are used just to find where file data starts. All reads go
// through Blob.slice(), so multi-GB paks are never loaded into memory.

export interface PakEntry {
  name: string; // '/'-separated, original case
  method: number; // 0 = stored, 8 = deflate
  flags: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number; // local header offset
  record: number; // central directory record: offset in the archive
  recordLen: number; // and length
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CDH = 0x02014b50;
const SIG_LFH = 0x04034b50;

const utf8 = new TextDecoder("utf-8");
const latin1 = new TextDecoder("windows-1252"); // cp437 isn't available; names are ASCII anyway

async function bytes(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

function u64(v: DataView, o: number): number {
  return Number(v.getBigUint64(o, true));
}

export async function readCentralDirectory(blob: Blob): Promise<PakEntry[]> {
  return (await readZip(blob)).entries;
}

/** The entries plus where the central directory starts (the end of the file data). */
export async function readZip(blob: Blob): Promise<{ entries: PakEntry[]; cdOffset: number }> {
  const size = blob.size;
  const tailStart = Math.max(0, size - (65535 + 22));
  const tail = await bytes(blob, tailStart, size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");

  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.getUint32(loc, true) === SIG_EOCD64_LOC) {
      const e64 = await bytes(blob, u64(tail, loc + 8), u64(tail, loc + 8) + 56);
      count = u64(e64, 32);
      cdSize = u64(e64, 40);
      cdOffset = u64(e64, 48);
    }
  }

  const cd = await bytes(blob, cdOffset, cdOffset + cdSize);
  const raw = new Uint8Array(cd.buffer);
  const entries: PakEntry[] = [];
  let o = 0;
  // KCD paks with >65535 entries store the count mod 65536 and no ZIP64
  // record, so walk the directory until its bytes run out instead.
  void count;
  for (let n = 0; o + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(o, true) !== SIG_CDH) throw new Error(`bad central directory entry #${n} at +${o}`);
    const flags = cd.getUint16(o + 8, true);
    const method = cd.getUint16(o + 10, true);
    const crc = cd.getUint32(o + 16, true);
    let csize = cd.getUint32(o + 20, true);
    let usize = cd.getUint32(o + 24, true);
    const nameLen = cd.getUint16(o + 28, true);
    const extraLen = cd.getUint16(o + 30, true);
    const commentLen = cd.getUint16(o + 32, true);
    let offset = cd.getUint32(o + 42, true);
    const nameBytes = raw.subarray(o + 46, o + 46 + nameLen);
    const name = (flags & 0x800 ? utf8 : latin1).decode(nameBytes).replaceAll("\\", "/");

    // ZIP64 extra field (unused by KCD, but cheap to support)
    let x = o + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let p = x + 4;
        if (usize === 0xffffffff) { usize = u64(cd, p); p += 8; }
        if (csize === 0xffffffff) { csize = u64(cd, p); p += 8; }
        if (offset === 0xffffffff) { offset = u64(cd, p); }
      }
      x += 4 + len;
    }
    const record = cdOffset + o;
    o = xEnd + commentLen;
    if (!name.endsWith("/")) entries.push({ name, method, flags, crc, csize, usize, offset, record, recordLen: cdOffset + o - record });
  }
  return { entries, cdOffset };
}

async function dataStart(blob: Blob, e: PakEntry): Promise<number> {
  const lh = await bytes(blob, e.offset, e.offset + 30);
  if (lh.byteLength < 30 || lh.getUint32(0, true) !== SIG_LFH) {
    throw new Error(`bad local header for ${e.name}`);
  }
  return e.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
}

/**
 * Read an entry's uncompressed bytes. With `limit`, stops after that many
 * output bytes (for previews) and skips the CRC check; `verify = false` skips
 * it too (bulk asset reads at run time, where it cost ~15% of loading).
 */
export async function readEntry(blob: Blob, e: PakEntry, limit?: number, verify = true): Promise<Uint8Array> {
  if (e.flags & 1) throw new Error("encrypted entries are not supported");
  const start = await dataStart(blob, e);
  const want = limit === undefined ? e.usize : Math.min(limit, e.usize);

  if (e.method === 0) {
    const out = new Uint8Array(await blob.slice(start, start + want).arrayBuffer());
    if (limit === undefined && verify) checkCrc(out, e);
    return out;
  }
  if (e.method !== 8) throw new Error(`unsupported compression method ${e.method}`);

  const stream = blob.slice(start, start + e.csize).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const out = new Uint8Array(want);
  let got = 0;
  while (got < want) {
    const { done, value } = await reader.read();
    if (done) break;
    const n = Math.min(value.byteLength, want - got);
    out.set(value.subarray(0, n), got);
    got += n;
  }
  // only a partial read (limit) leaves the stream open
  if (got < e.usize) await reader.cancel().catch(() => {});
  if (got < want) throw new Error(`truncated data in ${e.name}: ${got}/${want} bytes`);
  if (limit === undefined && verify) checkCrc(out, e);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function checkCrc(data: Uint8Array, e: PakEntry): void {
  const c = crc32(data);
  if (c !== e.crc) {
    throw new Error(`CRC mismatch in ${e.name}: got ${c.toString(16)}, expected ${e.crc.toString(16)}`);
  }
}
