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
   - `CA_BONE` attachments pin props or weapons to a bone, using either an
     absolute `Position`/`Rotation` (w, x, y, z) or a bone-relative
     `RelPosition`/`RelRotation`. They are not drawn yet.

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
