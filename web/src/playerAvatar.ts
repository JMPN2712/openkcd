// Henry's body in the world: the player soul ("dude": Henry's head, hair and starting clothes)
// assembled like an NPC, skinned by an Animator and placed at the controller's feet.

import { CharacterDb, loadCharacter, type LoadedCharacter } from "./character.ts";
import { parseSkeleton } from "./skeleton.ts";
import { Animator } from "./pose.ts";
import { Dba } from "./dba.ts";
import type { Clip } from "./anim.ts";
import type { LoadedModel } from "./model.ts";
import type { Vfs } from "./vfs.ts";
import { multiply } from "./mat4.ts";
import type { NpcRendererOps } from "./npcs.ts";
import { loadLocomotion, type LoadedLocomotion } from "./locomotion.ts";

/** The player's soul in rpg/soul. */
export const PLAYER_SOUL = "dude";

/** Gameplay locomotion for the male skeleton (docs/ANIMATION.md). */
export const MALE_GENERAL = "animations/humans/male/male_general.dba";

export class PlayerAvatar {
  readonly character: LoadedCharacter;
  readonly animator: Animator;
  /** clips of male_general.dba by base name ("relaxed_walk_medium_player") */
  readonly clips: Map<string, () => Clip>;
  /** entity world matrix: feet position, facing */
  world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  /** renderer item index of each part (setItems) */
  items: number[] = [];
  /** parts not drawn (first person hides the head) */
  hidden = new Set<number>();
  /** the player's locomotion blend spaces and Mannequin fragments */
  readonly locomotion: LoadedLocomotion;

  private constructor(character: LoadedCharacter, animator: Animator, clips: Map<string, () => Clip>, locomotion: LoadedLocomotion) {
    this.character = character;
    this.animator = animator;
    this.clips = clips;
    this.locomotion = locomotion;
  }

  static async load(vfs: Vfs, opts: { maxTextureDim?: number } = {}): Promise<PlayerAvatar> {
    const db = await CharacterDb.load(vfs);
    const soul = db.souls.find((s) => s.name === PLAYER_SOUL);
    if (!soul) throw new Error(`player soul "${PLAYER_SOUL}" not in rpg/soul`);
    const spec = db.soul(soul.id);
    const character = await loadCharacter(vfs, spec, { maxTextureDim: opts.maxTextureDim ?? 512 });
    const sk = vfs.lookup(spec.skeleton);
    const skeleton = sk ? parseSkeleton(await vfs.read(sk)) : null;
    if (!skeleton) throw new Error(`no skeleton ${spec.skeleton}`);
    const dh = vfs.lookup(MALE_GENERAL);
    if (!dh) throw new Error(`${MALE_GENERAL} not found`);
    const dba = new Dba(await vfs.read(dh));
    const clips = new Map<string, () => Clip>();
    for (const a of dba.anims) {
      const base = a.name.slice(a.name.lastIndexOf("/") + 1).replace(/\.caf$/, "");
      if (clips.has(base)) continue;
      let c: Clip | null = null;
      clips.set(base, () => (c ??= dba.clip(a.name)));
    }
    const clipOf = (n: string) => clips.get(n.toLowerCase())?.() ?? null;
    const locomotion = await loadLocomotion(vfs, clipOf, skeleton.bones[0].controllerId);
    return new PlayerAvatar(character, new Animator(skeleton), clips, locomotion);
  }

  clip(name: string): Clip | null {
    return this.clips.get(name)?.() ?? null;
  }

  /** Renderer items for the parts (bind pose, identity placement until place()). */
  renderItems(base = 0): { model: LoadedModel; transform: Float32Array; layer: number }[] {
    this.items = this.character.parts.map((_, k) => base + k);
    return this.character.parts.map(({ model, part, transform }) => ({ model, transform: transform ? multiply(this.world, transform) : this.world, layer: part.layer }));
  }

  /** Feet at `pos`, facing `yaw` (radians, 0 = +X). Characters face +Y in model space. */
  place(pos: [number, number, number], yaw: number): void {
    const a = yaw - Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
    this.world = new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, pos[0], pos[1], pos[2], 1]);
  }

  /** Upload placement and skinning (after animator.evaluate…) to the renderer. */
  upload(r: NpcRendererOps): void {
    // hidden parts stay in the shadow passes when the renderer can do that; otherwise they are
    // collapsed to a point (no renderer rebuild)
    const zero = new Float32Array(16);
    this.character.parts.forEach(({ model, transform }, k) => {
      const item = this.items[k];
      const hide = this.hidden.has(k);
      const viaRenderer = r.setItemHidden?.(item, hide) ?? false;
      r.setItemTransform(item, hide && !viaRenderer ? zero : transform ? multiply(this.world, transform) : this.world);
      if (model.skeleton && r.paletteSize(item)) r.setPalette(item, this.animator.palette(model.skeleton));
    });
  }

  /** Model-space matrix of a bone after the last evaluate (null if the skeleton lacks it). */
  bone(name: string): Float32Array | null {
    const i = this.animator.skeleton.byName.get(name.toLowerCase());
    return i === undefined ? null : this.animator.world[i];
  }

  /** World-space position of a bone. */
  bonePos(name: string): [number, number, number] | null {
    const m = this.bone(name);
    if (!m) return null;
    const w = this.world;
    return [0, 1, 2].map((r) => w[r] * m[12] + w[4 + r] * m[13] + w[8 + r] * m[14] + w[12 + r]) as [number, number, number];
  }
}
