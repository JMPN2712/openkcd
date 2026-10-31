// Mannequin fragments → animation clips. Behaviour trees ask for fragments by
// ID ("TailorIn", "Tailor", "TailorOut"); the gender's animation database
// (Animations/Mannequin/ADB/kcd_<gender>_database.adb) lists, per fragment ID,
// variants by tag set, each with layers of animation names:
//
//   <AnimDB FragDef=… TagDef=…><FragmentList><Tailor>
//     <Fragment BlendOutDuration= Tags=""><AnimLayer><Blend …/><Animation name="tailor_idle" flags="Loop"/></AnimLayer>
//     <ProcLayer>…procedural clips (collider mode, alignment, variations)…</ProcLayer></Fragment>
//
// Animation names are aliases from the skeleton's .chrparams: for humans
// `name="*" path="*\*.caf"` under Animations\humans\<gender>, i.e. a .caf's base
// name anywhere below that folder. The tracks live in the gender's DBAs.

import { parseXml, type XmlNode } from "./xml.ts";
import { Dba } from "./dba.ts";
import type { Clip } from "./anim.ts";
import type { Vfs } from "./vfs.ts";
import { workSlice } from "./frameBudget.ts";

export interface FragmentVariant {
  tags: string;
  /** animations of the first AnimLayer, in sequence */
  anims: { name: string; loop: boolean }[];
}

export function parseAdb(xml: string): Map<string, FragmentVariant[]> {
  const out = new Map<string, FragmentVariant[]>();
  const db = parseXml(xml).children.find((c) => c.tag === "AnimDB");
  const list = db?.children.find((c) => c.tag === "FragmentList");
  for (const frag of list?.children ?? []) {
    const variants: FragmentVariant[] = [];
    for (const f of frag.children.filter((c: XmlNode) => c.tag === "Fragment")) {
      const layer = f.children.find((c) => c.tag === "AnimLayer");
      const anims = (layer?.children ?? []).filter((c) => c.tag === "Animation" && c.attrs.name).map((a) => ({ name: a.attrs.name.toLowerCase(), loop: /\bLoop\b/.test(a.attrs.flags ?? "") }));
      variants.push({ tags: f.attrs.Tags ?? "", anims });
    }
    out.set(frag.tag.toLowerCase(), variants);
  }
  return out;
}

export interface FragmentClip {
  clip: Clip;
  loop: boolean;
  /** clip length in seconds */
  seconds: number;
  name: string;
}

/** Animation databases an AnimLibrary keeps decoded (most recently used). */
const KEPT_DBAS = 8;

/** Fragment and alias resolution for one gender ("male" / "female"). */
export class AnimLibrary {
  private vfs: Vfs;
  private gender: string;
  private adb: Promise<Map<string, FragmentVariant[]>> | null = null;
  private aliases: Promise<Map<string, { dba: string; anim: string }>> | null = null;
  private dbas = new Map<string, Promise<Dba>>();
  private clips = new Map<string, Promise<FragmentClip | null>>();
  /** fragments already resolved (synchronous access) */
  readonly ready = new Map<string, FragmentClip | null>();

  constructor(vfs: Vfs, gender: "male" | "female") {
    this.vfs = vfs;
    this.gender = gender;
  }

  private aliasClips = new Map<string, Promise<Clip | null>>();

  private loadDba(path: string): Promise<Dba> {
    // (decoded in the frame's shared work budget)
    return this.vfs.read(this.vfs.lookup(path)!).then(async (b) => { await workSlice(); return new Dba(b); });
  }

  /**
   * A database, from the last few used: a clip is decoded into arrays of its own, so a database
   * isn't needed once its clips are out (keeping every one held 713 MiB after a flight).
   */
  private dba(path: string): Promise<Dba> {
    let d = this.dbas.get(path);
    if (d) this.dbas.delete(path);
    else d = this.loadDba(path);
    this.dbas.set(path, d);
    while (this.dbas.size > KEPT_DBAS) this.dbas.delete(this.dbas.keys().next().value!);
    return d;
  }

  private aliasIndex(): Promise<Map<string, { dba: string; anim: string }>> {
    this.aliases ??= (async () => {
      const idx = new Map<string, { dba: string; anim: string }>();
      const dir = `animations/humans/${this.gender}/`;
      // (each database read for its names only, not kept)
      for (const p of [...this.vfs.paths()].filter((x) => x.startsWith(dir) && x.endsWith(".dba"))) {
        for (const a of (await this.loadDba(p)).anims) {
          const base = a.name.slice(a.name.lastIndexOf("/") + 1).replace(/\.caf$/, "");
          if (!idx.has(base)) idx.set(base, { dba: p, anim: a.name });
        }
      }
      return idx;
    })();
    return this.aliases;
  }

  /** The clip for animation alias `name` (e.g. "tailor_idle"). */
  alias(name: string): Promise<Clip | null> {
    const key = name.toLowerCase();
    let p = this.aliasClips.get(key);
    if (!p) {
      p = (async () => {
        const hit = (await this.aliasIndex()).get(key);
        return hit ? (await this.dba(hit.dba)).clip(hit.anim) : null;
      })();
      this.aliasClips.set(key, p);
    }
    return p;
  }

  /** The clip of fragment `id` (untagged variant preferred, its first animation). */
  fragment(id: string): Promise<FragmentClip | null> {
    const key = id.toLowerCase();
    let p = this.clips.get(key);
    if (!p) {
      p = (async () => {
        this.adb ??= this.vfs.read(this.vfs.lookup(`animations/mannequin/adb/kcd_${this.gender}_database.adb`)!).then((b) => parseAdb(new TextDecoder().decode(b)));
        const variants = (await this.adb).get(key) ?? [];
        const v = variants.find((x) => x.tags === "" && x.anims.length) ?? variants.find((x) => x.anims.length);
        const a = v?.anims[0];
        const clip = a ? await this.alias(a.name) : null;
        return clip ? { clip, loop: a!.loop, seconds: (clip.end - clip.start) / clip.fps, name: a!.name } : null;
      })().catch(() => null);
      void p.then((c) => this.ready.set(key, c));
      this.clips.set(key, p);
    }
    return p;
  }
}
