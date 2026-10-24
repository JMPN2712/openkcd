// Read-only reader for GOG's Inno Setup installers (setup .exe plus .bin
// slices), so the game can be converted straight from the installer without
// installing it first. Written for setup data version 5.6.2 (unicode), which
// is what GOG's KCD 1.9.8b installers use; other versions are rejected. The
// layout is documented in docs/INSTALLER.md. All reads go through
// Blob.slice(), so the 4 GB slices are never loaded whole.

import { crc32 } from "./zip.ts";
import { lzmaDecode } from "./lzma.ts";

const LOADER_MAGIC = [0x72, 0x44, 0x6c, 0x50, 0x74, 0x53, 0xcd, 0xe6, 0xd7, 0x7b, 0x0b, 0x2a]; // "rDlPtS" + 6 bytes
const SLICE_MAGIC = "idska32\x1a";
const CHUNK_MAGIC = "zlb\x1a";
const SUPPORTED = "Inno Setup Setup Data (5.6.2) (u)";

async function bytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function ascii(b: Uint8Array): string {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

/**
 * Where the setup headers start inside the .exe, and where its file data
 * starts when the installer keeps it there (small DLC installers) instead of
 * in .bin slices (0).
 */
async function setupDataOffset(exe: Blob): Promise<{ headers: number; data: number }> {
  const head = await bytes(exe, 0, Math.min(exe.size, 4 << 20));
  outer: for (let i = 0; i + 44 <= head.length; i++) {
    for (let k = 0; k < LOADER_MAGIC.length; k++) if (head[i + k] !== LOADER_MAGIC[k]) continue outer;
    const v = new DataView(head.buffer, i);
    if (v.getUint32(12, true) !== 1) throw new Error(`unsupported loader table version ${v.getUint32(12, true)}`);
    if (crc32(head.subarray(i, i + 40)) !== v.getUint32(40, true)) throw new Error("loader table CRC mismatch");
    return { headers: v.getUint32(32, true), data: v.getUint32(36, true) };
  }
  throw new Error("not an Inno Setup installer (no loader table)");
}

/**
 * One compressed header block: a CRC'd 9-byte prefix (stored size,
 * compressed flag), then the stored bytes in 4 KB chunks, each after its own
 * CRC32. Returns the decompressed bytes and the offset after the block.
 */
async function readBlock(exe: Blob, at: number): Promise<{ data: Uint8Array; end: number }> {
  const head = await bytes(exe, at, at + 9);
  const hv = new DataView(head.buffer);
  if (crc32(head.subarray(4, 9)) !== hv.getUint32(0, true)) throw new Error(`header block CRC mismatch at ${at}`);
  const stored = hv.getUint32(4, true);
  const compressed = head[8] !== 0;
  const raw = await bytes(exe, at + 9, at + 9 + stored);
  const joined = new Uint8Array(stored);
  let n = 0;
  for (let o = 0; o < stored; ) {
    const len = Math.min(4096, stored - o - 4);
    const chunk = raw.subarray(o + 4, o + 4 + len);
    if (crc32(chunk) !== new DataView(raw.buffer, o).getUint32(0, true)) throw new Error(`header chunk CRC mismatch at ${at + 9 + o}`);
    joined.set(chunk, n);
    n += len;
    o += 4 + len;
  }
  const body = joined.subarray(0, n);
  const data = compressed ? lzmaDecode(body.subarray(0, 5), body.subarray(5)) : body;
  return { data, end: at + 9 + stored };
}

/** The decompressed setup headers: block 1 (setup header and entries) and block 2 (file locations). */
export async function readHeaderBlocks(exe: Blob): Promise<{ version: string; dataOffset: number; block1: Uint8Array; block2: Uint8Array }> {
  const { headers: at, data: dataOffset } = await setupDataOffset(exe);
  const id = await bytes(exe, at, at + 64);
  const version = ascii(id.subarray(0, id.indexOf(0) < 0 ? 64 : id.indexOf(0)));
  if (version !== SUPPORTED) throw new Error(`unsupported installer version "${version}" (expected "${SUPPORTED}")`);
  const b1 = await readBlock(exe, at + 64);
  const b2 = await readBlock(exe, b1.end);
  return { version, dataOffset, block1: b1.data, block2: b2.data };
}

/** A byte cursor over a decompressed header block. */
class Cursor {
  p = 0;
  private readonly v: DataView;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u32(): number {
    const x = this.v.getUint32(this.p, true);
    this.p += 4;
    return x;
  }
  /** Length-prefixed string; `wide` ones are UTF-16LE. */
  str(wide = true): string {
    const n = this.u32();
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return wide ? utf16.decode(s) : ascii(s);
  }
  skipStrings(count: number): void {
    for (let i = 0; i < count; i++) {
      const n = this.u32(); // not `this.p += this.u32()`: that reads p before the call moves it
      this.p += n;
    }
  }
  /** Skip `count` entries of `strings` strings and `fixed` bytes each. */
  skipEntries(count: number, strings: number, fixed: number): void {
    for (let i = 0; i < count; i++) {
      this.skipStrings(strings);
      this.p += fixed;
    }
  }
  fixed(n: number): DataView {
    const d = new DataView(this.b.buffer, this.b.byteOffset + this.p, n);
    this.p += n;
    return d;
  }
}

const utf16 = new TextDecoder("utf-16le");

// Entry layouts for 5.6.2 (unicode): [strings, fixed bytes]. Strings come
// first, then the fixed fields (see docs/INSTALLER.md). Only the lists up to
// the file entries are walked; the location records sit in block 2.
const HEADER_STRINGS = 34; // 30 UTF-16 strings, then 4 byte strings (license, info before/after, compiled script)
const HEADER_FIXED = 93;
const LANGUAGE: [number, number] = [10, 21];
const MESSAGE: [number, number] = [2, 4];
const PERMISSION: [number, number] = [1, 0];
const TYPE: [number, number] = [4, 30];
const COMPONENT: [number, number] = [5, 42];
const TASK: [number, number] = [6, 26];
const DIRECTORY: [number, number] = [7, 27];
const FILE_STRINGS = 10;
const FILE_FIXED = 43;
const LOCATION_SIZE = 74;

/** One stored piece of a file in the slices. */
export interface Part {
  /** slice index (0-based) and byte offset of the stored data, after the chunk marker */
  slice: number;
  offset: number;
  /** last slice the stored data reaches (a part can cross into the next slice) */
  lastSlice: number;
  stored: number; // bytes in the slices (zlib stream)
  size: number; // bytes once inflated
  md5: string; // of the inflated part
}

/** A game file, stored as zlib parts of 10 MiB each (GOG Galaxy style). */
export interface InstallerFile {
  path: string; // relative to the game root, '/'-separated, original case
  size: number;
  md5: string;
  parts: Part[];
}

export interface Installer {
  version: string;
  appName: string;
  appVersion: string;
  /** offset of the file data inside the .exe, or 0 when it's in .bin slices */
  dataOffset: number;
  sliceCount: number;
  files: InstallerFile[];
}

interface Location {
  firstSlice: number;
  lastSlice: number;
  startOffset: number;
  subOffset: number;
  size: number;
  chunkSize: number;
  flags: number;
}

function parseLocations(block2: Uint8Array, count: number): Location[] {
  if (block2.length !== count * LOCATION_SIZE) throw new Error(`file location block is ${block2.length} bytes, expected ${count} × ${LOCATION_SIZE}`);
  const v = new DataView(block2.buffer, block2.byteOffset, block2.byteLength);
  const out: Location[] = [];
  for (let o = 0; o < block2.length; o += LOCATION_SIZE) {
    out.push({
      firstSlice: v.getUint32(o, true),
      lastSlice: v.getUint32(o + 4, true),
      startOffset: v.getUint32(o + 8, true),
      subOffset: Number(v.getBigUint64(o + 12, true)),
      size: Number(v.getBigUint64(o + 20, true)),
      chunkSize: Number(v.getBigUint64(o + 28, true)),
      // 36: SHA-1 of the stored bytes, 56: file time, 64: file version
      flags: v.getUint16(o + 72, true),
    });
  }
  return out;
}

const LOC_CHUNK_COMPRESSED = 1 << 7;
const LOC_CHUNK_ENCRYPTED = 1 << 6;

// GOG's install script calls, kept in each file entry's condition strings.
const BEFORE_INSTALL = /^before_install\('([0-9a-f]{32})', '(.+)', (\d+)\)$/;
const AFTER_INSTALL = /^after_install\('([0-9a-f]{32})', (\d+), (\d+)\)$/;

/** Parse the installer's headers into the list of game files and where their parts are. */
export async function readInstaller(exe: Blob): Promise<Installer> {
  const { version, dataOffset, block1, block2 } = await readHeaderBlocks(exe);
  const c = new Cursor(block1);
  const appName = c.str();
  c.skipStrings(8);
  const appVersion = c.str();
  c.skipStrings(HEADER_STRINGS - 10);
  const [nLang, nMsg, nPerm, nType, nComp, nTask, nDir, nFile, nLoc] = Array.from({ length: 16 }, () => c.u32());
  const fixed = c.fixed(HEADER_FIXED);
  const slicesPerDisk = fixed.getUint32(65, true);
  if (slicesPerDisk !== 1) throw new Error(`${slicesPerDisk} slices per disk aren't supported`);
  c.skipEntries(nLang, ...LANGUAGE);
  c.skipEntries(nMsg, ...MESSAGE);
  c.skipEntries(nPerm, ...PERMISSION);
  c.skipEntries(nType, ...TYPE);
  c.skipEntries(nComp, ...COMPONENT);
  c.skipEntries(nTask, ...TASK);
  c.skipEntries(nDir, ...DIRECTORY);

  const locations = parseLocations(block2, nLoc);
  const files: InstallerFile[] = [];
  let current: InstallerFile | null = null;
  let expected = 0;
  let sliceCount = 0;
  for (let i = 0; i < nFile; i++) {
    c.skipStrings(8); // source, destination, font, assembly, components, tasks, languages, check
    const after = c.str();
    const before = c.str();
    const f = c.fixed(FILE_FIXED);
    const loc = f.getInt32(20, true);

    const head = BEFORE_INSTALL.exec(before);
    if (head) {
      if (current && current.parts.length !== expected) throw new Error(`${current.path}: ${current.parts.length} of ${expected} parts`);
      current = { path: head[2].replaceAll("\\", "/"), size: 0, md5: head[1], parts: [] };
      expected = Number(head[3]);
      files.push(current);
    }
    const part = AFTER_INSTALL.exec(after);
    if (!part) continue; // installer UI files and redistributables
    if (!current || current.parts.length >= expected) throw new Error(`file entry ${i}: part without a file`);
    const l = locations[loc];
    if (!l) throw new Error(`file entry ${i}: bad location ${loc}`);
    if (l.flags & (LOC_CHUNK_COMPRESSED | LOC_CHUNK_ENCRYPTED)) throw new Error(`${current.path}: compressed or encrypted chunk`);
    if (l.subOffset !== 0 || l.size !== Number(part[2])) throw new Error(`${current.path}: unexpected part layout`);
    current.parts.push({
      slice: l.firstSlice,
      offset: l.startOffset + CHUNK_MAGIC.length,
      lastSlice: l.lastSlice,
      stored: l.size,
      size: Number(part[3]),
      md5: part[1],
    });
    current.size += Number(part[3]);
    sliceCount = Math.max(sliceCount, l.lastSlice + 1);
  }
  if (current && current.parts.length !== expected) throw new Error(`${current.path}: ${current.parts.length} of ${expected} parts`);
  return { version, appName, appVersion, dataOffset, sliceCount: dataOffset ? 0 : sliceCount, files };
}

/** Slice file names: "setup_x.exe" keeps its data in "setup_x-1.bin", "setup_x-2.bin", … */
export function sliceName(exeName: string, index: number): string {
  return `${exeName.replace(/\.exe$/i, "")}-${index + 1}.bin`;
}

/**
 * The slice accessor for readFile: the .bin files by index, or for an
 * installer that keeps its data inside the .exe, that data as slice 0.
 */
export function sliceSource(inst: Installer, exe: Blob, bins: (index: number) => Promise<Blob>): (index: number) => Promise<Blob> {
  if (!inst.dataOffset) return bins;
  const data = exe.slice(inst.dataOffset);
  return async (i) => {
    if (i !== 0) throw new Error(`slice ${i + 1} requested from a single-file installer`);
    return data;
  };
}

/** Check a slice's header and that it's the size it claims. */
export async function checkSlice(slice: Blob, index: number): Promise<void> {
  const h = await bytes(slice, 0, 12);
  if (ascii(h.subarray(0, 8)) !== SLICE_MAGIC) throw new Error(`slice ${index + 1}: not an installer data file`);
  const size = new DataView(h.buffer).getUint32(8, true);
  if (size !== slice.size) throw new Error(`slice ${index + 1}: ${slice.size} bytes, expected ${size} (incomplete download?)`);
}

const SLICE_HEADER = 12;

/** A part's stored bytes as one Blob, joining slices if it crosses into the next. */
async function storedBlob(part: Part, slice: (index: number) => Promise<Blob>): Promise<Blob> {
  const pieces: Blob[] = [];
  let left = part.stored;
  let at = part.offset;
  for (let s = part.slice; left > 0; s++) {
    if (s > part.lastSlice) throw new Error(`part runs past slice ${part.lastSlice + 1}`);
    const b = await slice(s);
    const n = Math.min(left, b.size - at);
    pieces.push(b.slice(at, at + n));
    left -= n;
    at = SLICE_HEADER;
  }
  return pieces.length === 1 ? pieces[0] : new Blob(pieces);
}

/** One part's inflated bytes (checked against its size; the stream checks the Adler-32). */
export async function inflatePart(part: Part, slice: (index: number) => Promise<Blob>): Promise<Uint8Array> {
  const stored = await storedBlob(part, slice);
  const out = new Uint8Array(await new Response(stored.stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  if (out.byteLength !== part.size) throw new Error(`part inflated to ${out.byteLength} bytes, expected ${part.size}`);
  return out;
}

/**
 * Stream a file's bytes, part by part. Each part is a zlib stream; the
 * browser inflates it and checks its Adler-32. `slice(i)` hands out the
 * i-th .bin file.
 */
export async function* readFile(file: InstallerFile, slice: (index: number) => Promise<Blob>): AsyncGenerator<Uint8Array> {
  for (const part of file.parts) {
    const stored = await storedBlob(part, slice);
    const reader = stored.stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      yield value;
    }
    if (got !== part.size) throw new Error(`${file.path}: part inflated to ${got} bytes, expected ${part.size}`);
  }
}
