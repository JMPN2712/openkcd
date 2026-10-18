# Animation

Skeletal animation as decoded by the pak browser (`web/src/anim.ts`,
`pose.ts`, `clips.ts`). Verified with `web/scripts/test-anim.ts` and headless
renders (`render-model.ts --anim … --frames …`).

## Files

| File | Contents |
|---|---|
| `*.caf` (8,233) | One clip. A Controller chunk (0x100d v0x829) per animated bone, plus MotionParameters (0x3002 v0x925) |
| `*.dba` | Animation databases: many clips in one Controller chunk (0x100d **v0x905**). This is where gameplay locomotion and idles live (`male_general.dba`, `male_combat.dba`). **Not decoded yet.** |
| `Animations.img` | 141,177 GlobalAnimationHeaderCAF chunks (0x3007 v0x971), one per clip |
| `DirectionalBlends.img` | AIM pose headers (0x3008 v0x970) |
| `*.chrparams` | Per-skeleton animation list: `#filepath` folders whose `.caf` files apply, `$TracksDatabase` `.dba` files, `$Include`, IK setup |

The loose male `.caf` clips are mostly cinematics (about 4,100), plus combat,
look and aim poses. Gameplay animation is in the `.dba` files.

## Controller 0x829 layout

- **Header.** 16 bytes: 14 used plus 2 padding.
  - `u32 controllerId`, `u16 numRotKeys`, `u16 numPosKeys`.
  - Then one byte each: rotation format, rotation time format, position
    format, position keys info, position time format, tracks aligned.
- **Blocks, in order:** rotation keys, rotation times, position keys,
  position times.
  - Position times are present only when `positionKeysInfo == 1`; otherwise
    positions share the rotation times.
  - Each block is padded to 4 bytes **except the last** (the chunk ends
    unpadded).
- **Formats seen in KCD.**
  - Rotations: 5 = SmallTree48Bit, 8 = SmallTree64BitExt (0 when there are
    no rotation keys).
  - Positions: 2 = float3.
  - Key times: 0 = f32, 1 = u16, 2 = u8, in **frames**. All clips are
    30 fps (from MotionParameters: ticks per frame × seconds per tick).
- **"Smallest three" quaternions.**
  - The top 2 bits index the dropped largest component.
  - The remaining components are stored LSB-first into slots x, y, z, w in
    ascending order, skipping the dropped index. Each maps
    [0, 2^bits − 1] → ±1/√2.
  - Widths: 15/15/15 (48-bit format) and 21/21/20 (64-bit format).
  - How the layout was chosen, out of the plausible variants: the 14-byte
    header guess produced impossible keys (|xyz| > 1). With 16 bytes, the
    smoothest decoding of consecutive keys (1.1M keys) wins. Format 5 has
    0.08% of steps above about 11° (mean |dot| 0.99997). Format 8 has 0.19%;
    its tracks are key-reduced (u8 times).
- **Component order check.** Over the tracks of a standing cinematic, frame-0
  rotations sit a median 18.5° from the bind pose using x, y, z, w order,
  against 171° for w, x, y, z.
- **Coverage.** All 8,233 clips parse exactly (blocks sum to the chunk size):
  886,062 tracks and 2.16 billion keys. Key times always increase. Human
  clip tracks match `male.chr` bone controller IDs 100%.

## Pose and skinning

- **Local tracks.** Tracks are parent-relative rotation plus translation.
  Bones without a track keep their bind-pose local transform,
  inverse(parent bind) × bind.
- **Bone order.** CompiledBones lists parents before children (checked for
  `male.chr`, `female.chr` and `s1_body.skin`), so one forward pass chains
  model-space matrices.
- **Skin weights.** Skins carry their own bone list and a bone-mapping stream
  (type 9, 12 bytes: 4× u16 ids and 4× u8 weights out of 255). The skinning
  palette is world(bone by name) × inverse(skin bone bind pose). With no clip
  this is the identity to about 3e-7, and renders are pixel-identical to the
  static path.
- **Cinematics** place characters in scene space (the hips track of
  `cin_19591_bandits_interrupt_henry` starts at x = −3.08), so the viewer
  camera follows the hips. The hips are taken to be the root's child with
  the largest bone subtree.
- **Bone attachments** (props, weapons) follow
  world(bone) × inverse(bind(bone)) × their bind-pose transform.

## Not yet

- `.dba` databases (controller v0x905): gameplay idles and locomotion.
- Blend spaces (`.bspace`, `.comb`), Mannequin (`.adb`) and animation events.
- Facial animation, IK, and cloth or pendulum attachment simulation.
