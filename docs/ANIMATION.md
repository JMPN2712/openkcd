# Animation, skeletons and character controllers

How KCD stores skeletal animation, skeletons, blend spaces, Mannequin
fragments and the player's character controller.

- **Already implemented:** clip and database decoding, posing and skinning
  (`web/src/anim.ts`, `dba.ts`, `clips.ts`, `pose.ts`, `skeleton.ts`,
  `mannequin.ts`). Verified with `web/scripts/test-anim.ts`, `test-dba.ts`
  and headless renders (`render-model.ts --anim … --frames …`).
- **Researched for milestone 1** (the walking simulator), from the game's
  data files only:
  - the skeleton's special bones;
  - motion parameters;
  - blend spaces;
  - Mannequin;
  - the player's physics and camera.

## Files

| File | Contents |
|---|---|
| `*.chr` (75) | Skeleton: CompiledBones (0x2000 v0x800), physical bones and proxies (0x2001, 0x2003) |
| `*.cdf` (266) | Character definition: skeleton, skin and bone attachments, procedural modifiers (DrivenTwist, …) |
| `*.chrparams` (64) | Per-skeleton animation list (`#filepath` folders, `$TracksDatabase` `.dba` files, `$AnimEventDatabase`, `$Include`), plus the IK, look-IK and aim-IK setup |
| `*.caf` (8,233) | One clip. A Controller chunk (0x100d v0x829) per animated bone, plus MotionParameters (0x3002 v0x925) |
| `*.dba` (5,155) | Animation databases: many clips sharing one pool of tracks in a single Controller chunk (0x100d **v0x905**). This is where gameplay locomotion, idles and combat live (`male_general.dba` alone has 1,715 animations). See below |
| `Animations.img` | 141,177 GlobalAnimationHeaderCAF chunks (0x3007 v0x971), one per clip |
| `DirectionalBlends.img` | AIM pose headers (0x3008 v0x970) |
| `*.bspace` (533), `*.comb` (24) | Blend spaces (XML): parametric locomotion, turns, stairs, jumps |
| `*.animevents` (26) | Animation events (footsteps, sounds, effects) per skeleton |
| `Animations/Mannequin/ADB/*` | Mannequin: controller definitions (scopes, fragment IDs), tags, and fragment databases (`.adb`, 28) |
| `Scripts/Entities/actor/*.lua`, `Parameters/*.xml` | Actor and player script classes: physics (`Living`), stances, speed multipliers, camera limits |
| `Libs/Tables/ai/DeltaMovementParamsDatabase.xml` | AI movement smoothing per entity class (turn rates, throttle) |

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

## Animation databases (controller 0x905)

Implemented in `web/src/dba.ts`. Checked by `web/scripts/test-dba.ts`: all
5,155 databases decode, giving 460,632 animations and 29.2M tracks. Key times
always increase, every quaternion is unit length, and human tracks match the
male/female controller IDs 100%. Layout:

- **Header.** `u32 numPos, numRot, numTime, numAnims`, then the length and
  format-count tables:
  - `u16 timeLen[numTime]`, `u32 timeFormatCounts[7]`;
  - `u16 posLen[numPos]`, `u32 posFormatCounts[9]`;
  - `u16 rotLen[numRot]`, `u32 rotFormatCounts[9]`.
- **Format order.** Within each kind, tracks are ordered by format: the first
  `count[0]` tracks use format 0, the next `count[1]` use format 1, and so on.
- **Offsets.** `i32 offsets[numTime + numPos + numRot + 1]` give track starts
  **relative to the end of the chunk**. Tracks are laid out backwards, each
  padded to 4 bytes. The extra entry is the start of the whole track region.
  Verified exactly against the lengths × format sizes in 122 databases.
- **Animation headers.** After the offsets come a `u32`, zero padding, then
  the headers back to back: `u16 nameLen`, the name (a `.caf` path),
  MotionParams905 (132 bytes, **unaligned**), `u16` (0), `u16 numControllers`
  and `u32 recordsOffset`. That offset is measured from the first header; for
  example, `cow.dba` offsets 2,522, 3,642 and 4,642 step by 56×20 and 50×20.
- **Controller records** (20 bytes): `u32 controllerId`,
  `i32 posTimeTrack, posTrack, rotTimeTrack, rotTrack` (−1 = none). All
  809,665 records checked time a track of matching key count.
- **Bitset key times (format 6):** `u16 start, end, keyCount`, then one bit
  per frame from `start`, LSB first. The track "length" counts u16 words,
  which is 3 + ceil((end − start + 1) / 16). All 317,442 checked tracks have
  a popcount equal to `keyCount`.
- **Formats seen.**
  - Rotations: 1 (float32 x, y, z, w), 5 and 8.
  - Positions: 2 (float3).
  - Key times: 1 (u16), 2 (u8), 6 (bitset).
- **Smoothness check.** In `male_general.dba`, 0.9% of one-frame steps
  exceed 11°. Almost all are 11–30° (fast moves). The few above 135° are
  weapon-slot bones snapping between rest and active in draw/holster clips,
  which is in the data.
- **In the viewer.** A skeleton's `.chrparams` lists its databases with
  `$TracksDatabase`, wildcards allowed. The male skeleton gets 2,723
  databases, mostly per-line facial animation. The viewer lists them and
  decodes only the chosen animation's tracks.

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

## The human skeleton (`male.chr`)

259 bones, listed parents first.

- **`Human_Male` (bone 0): the locomotion locator.** Every bone hangs off it.
  - Its track is the clip's **root motion**. In `relaxed_walk_medium_player`
    it moves 3.03 m along +Y over the 65-frame cycle, which matches the
    motion parameters below.
  - Characters face **+Y**, and Z is up.
- **`Hips`** sits at 0.90 m.
- **Head chain:** `Spine`…`Spine4` → `Neck` → `Neck1` → `Head`.
- **Bones under `Head`:**

  | Bone | Bind position | Notes |
  |---|---|---|
  | `Look` | (0, 0.101, 1.624) | Look-IK parameter joint |
  | `camera` | (0, 0.123, 1.624) | Its axes are rotated so that one points forward. Locomotion clips don't animate it, so it follows the head |
  | `eye_left_bone`, `eye_right_bone` | ±0.029, 0.101, 1.624 | |

  The `camera` bone matches the stance `viewOffset` (0, 0.10, 1.625) in
  `BasicActor.lua`, so it is the natural first-person eye point.
- **Helper bones:**
  - alignment: `Align`, `Align_Secondary`;
  - ground alignment: `GroundAlignLeft`/`Right`, and `LeftHeel`/`RightHeel`
    under the feet;
  - weapon and item slots: `RightHandSlot`, `LeftWeaponSheath`,
    `BackSlot_*`, `CS_Slot1`–`6`;
  - IK targets and blend weights: `*_IKTarget`, `*_IKBlend`;
  - about 95 facial blend-weight bones under the root
    (`*_blendWeightVertex`);
  - cloth and skirt helpers (`ring*`, `v_*`).
- **`male.cdf` (the player model):**
  - `male.chr`, with `animbody.skin` and head `s1_head_v001.skin`;
  - bone attachments: `eye_*`, `hand_*`, `entity_*`, `weapon_*`,
    `scabbard_left`, and `dialog_cameras` (on `Align`);
  - DrivenTwist modifiers for knees and other twist bones.

## IK and procedural setup (`male.chrparams`)

- **Limb IK:**
  - arms use 2-bone IK (`LftArm01`/`RgtArm01`, root `*Arm`, end `*Hand`);
  - legs use 3-bone leg IK (`LftLeg01`/`RgtLeg01`, `*UpLeg` → `*ToeBase`);
  - ground alignment uses CCD5 chains (`*UpLeg`, `*Leg`, `*Foot`, `*Heel`,
    `*ToeBase`);
  - the spine uses `Spine_IK` (MRDX, `Spine` → `Spine4`).
- **Animation-driven IK targets:**
  - `Spine_IK` / `LftArm01` / `LftArm02` / `RgtArm01` are driven by the
    `*_IKTarget` bones;
  - the weights come from the `*_IKBlend` bones.
- **Feet lock** on the two leg handles.
- **Look IK:**
  - eye attachments;
  - directional blends of the `lookposes` token on joint `Look`;
  - an additive rotation list from `Hips` to `Look`, with arms and legs as
    secondary;
  - procedural adjustment on `Neck`, `Neck1`, `Head` and `Look`.
- **Aim IK:** the same structure, with `aimposes`.

## Motion parameters

Each clip carries MotionParams905: in `.caf` files in the 0x3002 chunk; in
databases, inside each animation header. The 132 bytes are:

| Bytes | Fields |
|---|---|
| 0–23 | `u32 assetFlags`, `u32 compression`, `i32 ticksPerFrame`, `f32 secsPerTick`, `i32 start`, `i32 end` |
| 24–43 | `f32 moveSpeed`, `turnSpeed`, `assetTurn`, `distance`, `slope` |
| 44–71 | Start location (quaternion x, y, z, w; position) |
| 72–99 | End location (quaternion x, y, z, w; position) |
| 100–131 | Foot plants: left/right heel and toe start/end. All −10000 (unset) in the locomotion clips checked |

The **end location** is the locator's offset over one cycle. **moveSpeed**
is distance ÷ duration.

**Player locomotion clips** (`male_general.dba`, `*_player.caf`):

| Clip | Cycle | Speed (m/s) | Distance per cycle |
|---|---|---|---|
| `relaxed_walk_slow_player` | 3.83 s | 0.56 | 2.16 m |
| `relaxed_walk_medium_player` | 2.17 s | 1.40 | 3.03 m |
| `relaxed_walk_fast_player` | 1.83 s | 1.93 | 3.54 m |
| `relaxed_run_slow_player` | 1.63 s | 2.08 | 3.40 m |
| `relaxed_run_slow_bwd_player` | 1.20 s | 2.64 | 3.17 m |
| `relaxed_run_medium_player` | 0.73 s | 3.57 | 2.62 m |
| `relaxed_run_fast_player` | 1.27 s | 4.45 | 5.64 m |
| `relaxed_sprint_fast_player` | 1.03 s | 6.27 | 6.48 m |

- **Variants.** Each speed has `_left`, `_right`, `_bwd`, `_left_bwd` and
  `_right_bwd` strafes, plus `_turn_left`/`_turn_right` versions that rotate
  the locator 90° per cycle.
- **`turnSpeed` is unreliable:** the stored value is 0 for left turns.
  Derive the turn from the start and end quaternions instead.
- The NPC clips (no `_player` suffix) have the same speeds.

## Blend spaces (`.bspace`, `.comb`)

Parametric blending, in plain XML.

- **`.bspace` (`<ParaGroup>`):**
  - `<Dimensions>`: one or two `<Param name min max cells [scale]>`, named
    `MoveSpeed`, `TravelAngle`, `TurnSpeed`, `TravelSlope`, …;
  - `<ExampleList>`: examples, each naming an **animation by its clip name**
    (the `.caf` basename, found in the skeleton's databases);
  - `<Blendable>`: quads (`<Face p0 p1 p2 p3>`) over the example indices.
  - Each example's parameter values are not in the XML. They come from the
    clip's motion parameters: speed, travel direction from the end
    location, and turn.
- **`.comb` (`<CombinedBlendSpace>`):**
  - joins 2D blend spaces into a 3D one: `MoveSpeed` × `TravelAngle` ×
    `TurnSpeed`, with a `ParaScale` per dimension;
  - each `<BlendSpace AName>` covers a subset of the dimensions.
- **The player's main locomotion:**

  | Blend space | Dimensions and examples |
  |---|---|
  | `3d_relaxed_walk_turn_strafe_player.comb` | `2d_relaxed_walk_strafe_spd_fwd_ext_player` (MoveSpeed 0.6–2.12 × TravelAngle ±π, 9 examples) + `2d_relaxed_walk_turn_spd_fwd_ext_player` (MoveSpeed 0.55–2.0 × TurnSpeed ±1.7) |
  | `3d_relaxed_run_turn_strafe_player.comb` | run strafe (MoveSpeed 2.0–4.2 × TravelAngle ±π) + run turn |
  | `2d_sprint_turn_player.bspace` | MoveSpeed 4.4–6.2 × TurnSpeed ±1.3: run fast, and sprint with 90° turns |

- **Start and stop transitions:**
  - starting: `2d_relaxed_idle_to_walk`, `…_to_run` and `…_to_sprint` combs,
    split into left-foot and right-foot blend spaces;
  - stopping: `2d_relaxed_walk_to_idle` and `…_run_to_idle`;
  - big turns on the spot: `1d_relaxed_idle_bigturns_nw`;
  - stairs: `1d_stairs_walk`/`run`;
  - jumps: `1d_jump_*`, `2d_jump_height`.

### How OpenKCD plays them (`web/src/locomotion.ts`)

- **Example parameters.** MoveSpeed is the root travel ÷ duration × PlaybackScale;
  TravelAngle is atan2(−x, y) of the travel (left positive); TurnSpeed and
  TurnAngle come from the turn; `SetParaN` overrides dimension N. The
  MotionParams start/end locations are in the exporter's Y-up frame; the end
  is taken relative to the start (`readMotion` in `anim.ts`).
- **Weights.** Inverse bilinear interpolation in the authored quads, with
  each dimension normalised by its range; outside every quad, the nearest
  one, clamped.
- **Phase.** Loop clips hold different numbers of gait cycles:
  `relaxed_walk_*_player` and `relaxed_run_slow_*` hold two (four steps),
  `relaxed_run_medium_*` one. Blending them by clip time put opposite feet
  together (47% foot slide when strafing). Each loop example's cycle count
  and left-foot-down phase are measured from its pose (the lower toe), and
  examples are synced on the gait cycle.
- **Combined spaces.** The strafe and turn spaces of the 3D combs are mixed
  by how much the body turns while moving straight. This is an
  approximation of the engine's combination.
- **Start and stop.** Start and stop combs choose their left- or right-foot
  space by the TurnAngle range (`ChooseBlendSpace`). For a straight stop,
  both fit, so OpenKCD picks the foot whose stop pose best matches the
  current feet. This is a placeholder until a note settles the game's rule.
- **Code-driven movement.** Transition clips advance by the distance
  actually travelled along their root motion. A stop is entered where the
  clip's remaining root travel equals the controller's stopping distance
  (speed ÷ inertia 11).

## Mannequin (`Animations/Mannequin/ADB`)

The player's script names its controller and database:

- `ActionController = kcd_male_controllerdefs.xml`;
- `AnimDatabase3P = kcd_male_database.adb`.

There is no 1P database (`AnimDatabase1P` is commented out): first person
uses the same full-body animation.

- **Controller definitions:**
  - Tags and fragment-ID files.
  - `<FragmentDefs>`: per fragment ID, the scopes it plays in, and tag
    overrides.
  - `<ScopeDefs>`: scope → animation layer range:
    - FullBody: layers 0–2;
    - HoldItemLeft: 3; HoldItemRight: 4–5;
    - UpperBody: 6–7;
    - TorsoDetail: 8; FacialExpression: 9;
    - AlignOffset: 10; GameLogic: 11; CombatCamera: 13;
    - AimPose: 14; LookPose: 15.
  - The `Char3P` scope context is shared by the player and the NPCs.
- **Database (`.adb`, XML):**
  - `<FragmentList>` → one element per fragment ID → `<Fragment Tags="a+b">`
    variants.
  - Each variant has an `<AnimLayer>`: a `<Blend>` and an
    `<Animation name flags="Loop">`, where the name may be a blend space.
    It may also have `<ProcLayer>`s: procedural clips such as
    `AnimationOverride`, `CameraNear`, `MovementControlMethod`,
    `DisableMoveTransitions`.
  - `<FragmentBlendList>` holds the transitions between fragment IDs.
  - The best tag match wins. `mannequin.ts` already resolves this for NPC
    behaviours.
- **Fragments a walking player needs (tag `player`):**

  | Fragment ID | Tags | Animation |
  |---|---|---|
  | `MotionIdle` | `player` | `relaxed_idle_both` |
  | `MotionMovement` | `walk+player` | `3d_relaxed_walk_turn_strafe_player` |
  | `MotionMovement` | `run+player` | `3d_relaxed_run_turn_strafe_player` |
  | `MotionMovement` | `sprint+player` | `2d_sprint_turn_player` |
  | `MotionMovement` | `stealth+walk/run(+backward)+player` | `2d_stealth_*_player` |
  | `MotionTurn` | `""` | `1d_relaxed_idle_bigturns_nw` |
  | `IdleToMove` | `walk` / `run` | `2d_relaxed_idle_to_walk` / `…_to_run` |
  | `MotionJump` | `""` | `1d_jump_start`, then `2d_jump_height` |
  | `MotionLand` | `walk` / `run` / `""` | `1d_jump_land_*`, `relaxed_jump_land_idle` |

## Character controller (player)

From `Scripts/Entities/actor/BasicActor.lua` (`BasicActorParams`),
`player.lua` and `Parameters/Player_Params.xml`.

- **Physics (`physicsParams.Living`):**

  | Parameter | Value |
  |---|---|
  | mass | 80 kg |
  | gravity | 13 m/s² |
  | inertia, inertiaAccel | 11 (higher = faster speed change) |
  | air control | 0.1 |
  | max ground speed | 16 m/s |
  | slide from | 49° |
  | max climb | 50° |
  | fall from | 90° |
  | max jump angle | 40° |
  | impulse recovery | 1 s |
  | collider material | `mat_player_collider` |

- **Stances** (`gameParams.stance`, all `useCapsule = 1`):

  | Stance | Collider height | Size (x, z) | View offset |
  |---|---|---|---|
  | normal | 1.05 | 0.3, 0.4 | (0, 0.10, 1.625) |
  | combat | 1.05 | 0.3, 0.4 | (0, 0.10, 1.625) |
  | crouch | 0.8 | 0.35, 0.1 | (0, 0, 1.1) |
  | carryCorpse | 0.90 | 0.4, 0.15 | (0, 0.10, 1.625) |

  The player's own `Properties.stance.normal.size` is (0.35, 0, 0.4).
  - **Reading these as CryEngine living-entity sizes** (an interpretation,
    still to be checked in game): x is the capsule radius and z the
    half-height of the cylinder part, centred at `heightCollider` above the
    feet.
  - That gives a 0.3–0.35 m radius capsule from about 0.35 m to 1.75 m. The
    gap under it lets the living entity step over small obstacles.
- **Movement multipliers:**

  | Multiplier | Value |
  |---|---|
  | sprint | 1.5 |
  | strafe | 0.75 |
  | backward | 0.7 |
  | carrying the maximum load | 0.5 |

  Other movement settings:
  - jump height: 1 m;
  - slope slowdown: 3;
  - lean: 0.35 m and 15°.

  The base speeds are not in these scripts. The blend-space ranges (walk
  0.6–2.1, run 2–4.2, sprint 4.4–6.2 m/s) bound them. The RPG table adds
  costs (`SprintCost` 3.5, `JumpCostBase` 6 stamina).
- **Camera:**
  - Pitch limits (`PlayerRotation`): −70° to +80° normally, −35° to +45°
    while sprinting.
  - Landing bob: up to 0.5 over 0.6 s, for falls up to 3 m.
- **First person is full body.** The local player is drawn (`DrawSlot`)
  with `firstPersonBody`; a comment in `player.lua` says the head and its
  attachments are hidden by the game code on revive. So the view is Henry's
  real body, animated by the same 3P locomotion, with the eye at the
  `camera` bone and the head hidden. The `CameraNear` procedural clip sets
  a 1 cm near plane in some fragments.
- **AI smoothing (NPCs, not the player):** `DeltaMovementParamsDatabase.xml`
  gives turn-rate limits per logical speed (for example 0.8–4 rad/s at
  run).

## Collision geometry

- Models carry physics proxies as `$physics_proxy…` nodes, each with a
  MeshPhysicsData chunk (0x1018: serialised physics geometry, not decoded
  yet).
- In a sample of 25 building models:
  - 6 have proxies (1 to 121);
  - the rest have **no** physics chunk, for example `rataje_bakery`, which
    is presumably physicalised from its render mesh by material.
- **Terrain** collision is the heightmap.
- **Vegetation** uses its own physics.

## Open questions

- **Player speeds.** The base walk, run and sprint speeds, and how
  stamina, encumbrance and skills change them. These are game code; a
  behaviour note is needed. OpenKCD uses the player clips' own speeds for
  now: walk 1.40 (`relaxed_walk_medium_player`), run 3.57
  (`relaxed_run_medium_player`) and sprint = run × 1.5 = 5.35 m/s.
- **Physics proxies.** The MeshPhysicsData format, and which render
  subsets are physicalised when a model has no proxy (the material's
  physicalise type).
- **Capsule geometry.** Whether the `size`/`heightCollider` reading above
  matches the game.
- **Root motion or code-driven movement.** Whether the player moves by
  root motion or by code-driven velocity, with the blend space following
  (the usual CryEngine setup for players). OpenKCD is code-driven for now
  (`player.ts`, `locomotion.ts`); root motion stays an option.
- **Look IK in first person.** OpenKCD pivots the eye about the neck by the
  look pitch (`playerSession.ts`) instead of solving the chrparams look IK.
- **Start, stop and turn transitions.** How they choose a foot
  (`_lleg`/`_rleg`). Starts: the TurnAngle ranges decide (a straight start
  falls in the right-foot space). Stops: OpenKCD matches the current pose.
- **Not done yet:**
  - facial animation. The data: one database per voice folder and voice,
    `animations/humans/facials/<folder>_<voice>.dba` (2,661), holding a
    clip per recorded line named like its voice file
    (`<folder>/<voice>_<line>.caf`, 30 fps, as long as the line). Each
    clip animates the 60 `*_blendWeightVertex` bones (rotations; 4 also
    move). Head skins are skinned to `Head`/`Neck`, not to those bones,
    and carry morph targets (CompiledMorphTargets, about 0.9 MB in
    `bernard.skin`), so the bones drive morph weights. How a bone's value
    becomes a weight, and the morph format, wait for a research note;
  - cloth and pendulum attachments;
  - animation events (footstep sounds come later, with audio).

## Object animations (.anm, chest lids)

Decoded by `web/src/anm.ts`; used by `web/src/chests.ts`.

- **Format:** CryTek's older chunk file (`"CryTek\0\0"`, file type, version,
  chunk-table offset; table entries of type, version, offset, id, size).
  Each chunk starts with a 16-byte copy of its table entry.
- **Node chunk** (`0xCCCC000B`): name[64], object/parent ids, children,
  material id, 4 bytes, tm f32[16], pos, rot, scale, then the position,
  rotation and scale controller ids (−1 none).
- **Controller chunk** (`0xCCCC000D`, v0x826): type, key count, flags, id,
  then keys. Type 10 (TCB rotation): 40-byte keys of i32 time (3ds Max
  ticks, 4,800 a second), axis xyz and angle (radians), then tension,
  continuity, bias and eases.
- **Keys are relative,** as Max exports TCB rotations, and turn by Max's
  left-hand rule (with it, the lids rise; as right-handed angles they sank
  into the chests).
- **Chests:** five models (`chest01`–`chest05`) with `<model>_open.anm`,
  ~990 chest entities in Rataje. Each lid turns about its node's x axis, on
  the chest's back (+Y) edge, by 10–20° over 0.83–1 s. Some open files go up
  and back down (`chest02`): "open" plays to the widest key, and closing
  plays it back.
