// Assembles CryEngine split textures from the VFS and decodes one mip.
//
// Layout (verified against the KCD install, see docs/RECON.md):
//   foo.dds        DDS header + the smallest mips (the "persistent" tail)
//   foo.dds.1..K   one mip each, numbered from the small end: .1 is mip K-1,
//                  .K is mip 0. K comes from the header (mipCount minus the
//                  tail mips in the header file), NOT from which parts exist:
//                  patches ship lower-res headers that leave .K+1… unused.
//   foo.dds.a      attached alpha/gloss texture header (no "DDS " magic) + tail
//   foo.dds.1a..Ka its split mips, same numbering
// The parts can come from different paks: the HD pack ships a new header plus
// only the new top mip, the lower mips stay in the base pak.

import { parseDdsHeader, mipBytes, mipDims, type DdsHeader, type Pixels } from "./dds.ts";
import type { Vfs, VfsHit } from "./vfs.ts";

export const TEXTURE_RE = /\.dds(\.\d+a?|\.a)?$/;

/** Map any texture-related file name to its header path ("…/foo.dds" or "…/foo.dds.a"). */
export function textureStem(name: string): string | null {
  const n = name.toLowerCase();
  let m = /^(.*\.dds)\.\d+a$/.exec(n);
  if (m) return m[1] + ".a";
  m = /^(.*\.dds)\.\d+$/.exec(n);
  if (m) return m[1];
  if (n.endsWith(".dds") || n.endsWith(".dds.a")) return n;
  return null;
}

function partName(stem: string, n: number): string {
  return stem.endsWith(".a") ? `${stem.slice(0, -2)}.${n}a` : `${stem}.${n}`;
}

export interface Texture {
  stem: string;
  header: DdsHeader;
  headerHit: VfsHit;
  headerBytes: Uint8Array;
  /** split part count K from the header (0 = not split) */
  splitParts: number;
  partHits: VfsHit[]; // index n-1 -> part n; shorter than K if parts are missing
  /** largest decodable mip level (0 unless parts are missing) */
  firstLevel: number;
  attached: string | null; // stem of the attached alpha texture, if present
  /** higher-priority header versions that were skipped because their mips are missing */
  skipped: string[];
  warnings: string[];
}

interface Candidate {
  hit: VfsHit;
  bytes: Uint8Array;
  header: DdsHeader;
  K: number;
  parts: VfsHit[];
  problem: string | null;
}

/** K = number of mips NOT stored in the header file: count tail mips from the
 *  smallest up while they fit (CryEngine may append a few trailer bytes). */
function splitCount(header: DdsHeader, bytes: Uint8Array): number {
  if (!header.format) return 0;
  const have = bytes.byteLength - header.headerSize;
  let used = 0;
  let K = header.mipCount;
  while (K > 0) {
    const next = used + mipBytes(header, K - 1) * header.faces * header.depth;
    if (next > have) break;
    used = next;
    K--;
  }
  return K;
}

async function candidate(vfs: Vfs, stem: string, hit: VfsHit): Promise<Candidate> {
  const bytes = await vfs.read(hit);
  const header = parseDdsHeader(bytes);
  const K = splitCount(header, bytes);
  const parts: VfsHit[] = [];
  let problem: string | null = null;
  for (let n = 1; n <= K; n++) {
    const want = mipBytes(header, K - n);
    // any version of the part with the right size will do
    const hits = vfs.lookupAll(partName(stem, n));
    const ok = hits.find((h) => h.entry.usize === want);
    if (!ok) {
      problem = hits.length
        ? `${partName(stem, n)} is ${hits[0].entry.usize} bytes, mip ${K - n} needs ${want}`
        : `missing ${partName(stem, n)}`;
      break;
    }
    parts.push(ok);
  }
  return { hit, bytes, header, K, parts, problem };
}

/**
 * Pick the highest-priority header version whose split mips are all present.
 * Needed because load order alone isn't enough: e.g. an HD fast-load pak
 * ships a 4096² header for a texture whose 4096² mip exists nowhere, while
 * the 1.9 patch has a complete 2048² set.
 */
export async function openTexture(vfs: Vfs, stem: string): Promise<Texture> {
  const hits = vfs.lookupAll(stem);
  if (!hits.length) throw new Error(`texture header ${stem} not found in any pak`);
  const skipped: string[] = [];
  let best: Candidate | null = null;
  for (const hit of hits) {
    const c = await candidate(vfs, stem, hit);
    if (!c.problem) { best = c; break; }
    skipped.push(`${hit.pak.path}: ${c.header.width}×${c.header.height}, ${c.problem}`);
    if (!best || c.parts.length - c.K > best.parts.length - best.K) best = c; // fewest missing mips
  }
  const c = best!;
  const warnings: string[] = [];
  if (c.problem) warnings.push(`no complete version; top ${c.K - c.parts.length} mip(s) unavailable (${c.problem})`);
  if (c.header.format && c.K === c.header.mipCount) warnings.push("header file holds no mip data");
  if (c.K && (c.header.faces > 1 || c.header.isVolume)) warnings.push("split cubemap/volume: layout not verified");

  const attachedStem = stem.endsWith(".a") ? null : stem + ".a";
  return {
    stem, header: c.header, headerHit: c.hit, headerBytes: c.bytes,
    splitParts: c.K, partHits: c.parts, firstLevel: c.K - c.parts.length,
    attached: attachedStem && vfs.lookup(attachedStem) ? attachedStem : null,
    skipped, warnings,
  };
}

/** Raw (still block-compressed) bytes of one face of one mip. */
export async function mipData(vfs: Vfs, t: Texture, level: number, face = 0): Promise<Uint8Array> {
  const h = t.header;
  if (level < t.splitParts) {
    const hit = t.partHits[t.splitParts - level - 1];
    if (!hit) throw new Error(`mip ${level} is not available (split part missing)`);
    return vfs.read(hit);
  }
  // tail mips live in the header file, face-major (all mips of face 0, then face 1, …)
  let off = h.headerSize;
  const faceTail = (() => {
    let s = 0;
    for (let l = t.splitParts; l < h.mipCount; l++) s += mipBytes(h, l) * h.depth;
    return s;
  })();
  off += face * faceTail;
  for (let l = t.splitParts; l < level; l++) off += mipBytes(h, l) * h.depth;
  const size = mipBytes(h, level);
  if (off + size > t.headerBytes.byteLength) throw new Error(`mip ${level} is outside the header file`);
  return t.headerBytes.subarray(off, off + size);
}

export async function decodeMip(vfs: Vfs, t: Texture, level: number, face = 0): Promise<{ w: number; h: number; pixels: Pixels }> {
  const f = t.header.format;
  if (!f) throw new Error(`unsupported pixel format: ${t.header.formatLabel}`);
  const [w, h] = mipDims(t.header, level);
  const raw = await mipData(vfs, t, level, face);
  return { w, h, pixels: f.decode(raw, w, h) };
}
