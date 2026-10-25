// Voice-over files: Localization/<Language>*.pak hold Dialog/<folder>/<voice>_<line>.ogg (Ogg
// Vorbis, mono, 48 kHz). One language's paks are layered like the game's: the base and DLC paks,
// then its patches in order (english_patch_010800 < …_010900 < …_010902), then the HD packs.

import { pakKind } from "./install.ts";
import type { PakSource } from "./paks.ts";
import { readCentralDirectory, readEntry, type PakEntry } from "./zip.ts";

export class VoiceBank {
  private files = new Map<string, { pak: PakSource; entry: PakEntry }>();
  private blobs = new Map<PakSource, Promise<Blob>>();

  readonly language: string;

  private constructor(language: string) {
    this.language = language;
  }

  /** Index `language`'s voice paks among `paks`; an empty bank when it has none. */
  static async open(paks: PakSource[], language = "english"): Promise<VoiceBank> {
    const bank = new VoiceBank(language);
    const rank = (p: PakSource) => {
      const k = pakKind(p.path);
      return (k.kind === "hd-voice" ? 2 : 0) + (/_patch_/i.test(p.path) ? 1 : 0);
    };
    const mine = paks
      .filter((p) => { const k = pakKind(p.path); return (k.kind === "voice" || k.kind === "hd-voice") && k.language === language; })
      .sort((a, b) => rank(a) - rank(b) || a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
    for (const pak of mine) {
      const blob = pak.open();
      bank.blobs.set(pak, blob);
      for (const entry of await readCentralDirectory(await blob)) {
        const n = entry.name.toLowerCase().replace(/\\/g, "/");
        if (n.startsWith("dialog/")) bank.files.set(n, { pak, entry });
      }
    }
    return bank;
  }

  get size(): number {
    return this.files.size;
  }

  has(path: string): boolean {
    return this.files.has(path.toLowerCase());
  }

  /** The .ogg bytes of a voice path ("dialog/000323/mcra_….ogg"), or null. */
  async read(path: string): Promise<Uint8Array | null> {
    const hit = this.files.get(path.toLowerCase());
    if (!hit) return null;
    return readEntry(await this.blobs.get(hit.pak)!, hit.entry);
  }
}

/** Sample rate, channels and length (s) of an Ogg Vorbis file, from its first and last pages. */
export function oggInfo(b: Uint8Array): { rate: number; channels: number; seconds: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const isPage = (o: number) => b[o] === 0x4f && b[o + 1] === 0x67 && b[o + 2] === 0x67 && b[o + 3] === 0x53;
  if (b.length < 58 || !isPage(0)) return null;
  // first page: one packet, the identification header "\x01vorbis", version, channels, rate
  const body = 27 + b[26];
  if (b[body] !== 1 || String.fromCharCode(...b.subarray(body + 1, body + 7)) !== "vorbis") return null;
  const channels = b[body + 11];
  const rate = dv.getUint32(body + 12, true);
  // last page: its granule position is the stream's length in samples
  for (let o = b.length - 27; o >= 0; o--) {
    if (!isPage(o)) continue;
    const granule = dv.getUint32(o + 6, true) + dv.getUint32(o + 10, true) * 2 ** 32;
    return { rate, channels, seconds: rate ? granule / rate : 0 };
  }
  return null;
}
