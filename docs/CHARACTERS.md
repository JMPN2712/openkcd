# Characters

How KCD assembles people and animals, as used by the pak browser's character
viewer (`web/src/character.ts`, `characterView.ts`). Verified with
`web/scripts/test-characters.ts` and headless renders.

## Sources

1. **Game database (`Libs/Tables/*.xml`, in `Data/Tables.pak`).** Every NPC is
   a *soul*, and its look is resolved through these tables:

   ```
   rpg/soul ─┬─ character_body/head/hair/beard_id ─> character_* (model, material names)
             └─ initial_clothing_preset_id ─> item/armor2clothing_preset ─> item/armor (item_id)
                  ├─ clothing_id, clothing2_id ─> item/clothing (model, material, armor_archetype_id)
                  │     armor_archetype_id ─> item/armor_archetype2body_subpart ─> item/body_layer.layer_order
                  └─ item/armor2clothing_attachment ─> item/clothing_attachment (model, material)
   ```

   - **Paths.** Names resolve to `Objects/characters/<root>/<kind>/<name>.skin`
     and `.mtl`. The root is `humans`, or `animals/horse` for race 1 (names
     starting `sh`).
   - **Clothing presets** (`item/clothing_preset`) can be shown on the default
     body and head for their gender.
   - **Coverage:** 5,025 souls and 1,400 presets resolve to 66,491 parts.
   - **Gaps in the data itself:** 16 body skins, 5 attachments and 1 hair are
     referenced but not shipped, and 22 clothing IDs are dangling.
   - The binary `.tbl` files are twins of the XML tables; the XML is easier to
     read.
2. **Character definitions (`.cdf`, XML, about 270 files, mostly animals and
   a few story characters).**
   - `<Model File=…chr>` names the skeleton.
   - `CA_SKIN` attachments give a `Binding` (`.skin`) and a `Material`
     override.
   - `CA_BONE` attachments pin props or weapons (`.cgf`) to a bone, using
     either an absolute model-space `Position`/`Rotation` or a bone-relative
     `RelPosition`/`RelRotation` (world = bone bind pose × relative).
     Quaternions are **w, x, y, z**.
   - Checked on 401 absolute attachments: 371 sit exactly on their bone's
     parsed bind position, and 368 rotations match the w, x, y, z order
     (105 would match the conjugate). That validates the skeleton parser.
   - Only 32 bone attachments carry geometry. Nested `.cdf` bindings (2) are
     not supported.
   - Some test `.cdf`s (`male_halberd`, `male_sword_shield`) reference files
     that aren't shipped.

## Geometry

- `.skin` meshes are stored **in the bind pose in model space**, so the parts
  of a character can simply be drawn together with no skinning needed for a
  static view.
- Skeletons are a CompiledBones chunk (0x2000 v0x800): a 32-byte header,
  then 584-byte records. Each `.skin` carries a copy of the bones it is
  weighted to (`web/src/skeleton.ts`).
- Clothing layers sit on top of the body with near-coincident surfaces. The
  viewer nudges outer layers towards the camera by their body-layer order to
  avoid z-fighting.

## Materials

- **Colorizing (`%COLORIZING`, 1,313 materials;
  `%COLORIZING_WITH_MASK`, 1,060 of them).**
  - With a mask, the `Specular` texture slot is **not** specular. It is an RGB
    region mask: R, G and B select mask 1, 2 and 3.
  - Each region is recoloured by `MaskHue/Saturation/BrightnessN`, then the
    whole material by `ColorizingHue/Saturation/Brightness`.
  - Hue is in degrees (−180…180); saturation and brightness are multipliers
    (0…6). About 10–25% of the materials use non-neutral values.
  - The viewer applies these in gamma space using an HSV shift. The exact
    engine formula is not verified.
- **Eyes.** `Shader="Eye"` with `%EYE_AO_OVERLAY` is a blended shadow shell
  over the eyeballs. Drawn opaque it hides the eyes, so the viewer skips it
  until there is a blended pass.
- **Also unused for now:** dirt, blood and scratch layers (`%DIRT_SYSTEM`,
  `Decal`/`Custom` slots, `ZoneBloodN`), detail maps, normal maps, and the
  `Humanskin` subsurface shading.

## Two-state garments

`item/armor` rows can name a second clothing piece (`clothing2_id`). In all
26 such rows it's another state of the same garment: 24 hoods up and down
(`hood_001` / `hood_001_down`, `hood_004_up` / `hood_004_down`), a tabard
variant and a test item. Only one is drawn: the `…down` hood (towns by day),
else the first. Drawing both put a raised hood on everyone wearing one and
made the two shapes clip through each other.

## Attached entities

5,039 entities in Rataje's mission file have a `ParentId`; their `Pos` and
`Rotate` are relative to the parent (`HoeOnSlot` at `-0.0001, 0.05, 1.07`).
`parseEntityIndex` composes them into world space (parents first). None of
them is a drawn prop yet: they're pickable items, whose models come from the
item database.
