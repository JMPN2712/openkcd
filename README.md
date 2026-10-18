# kcd-web

Private, long-term experiment: running Kingdom Come: Deliverance (PC, GOG) in the
browser via WebAssembly + WebGPU. Requires your own legally owned copy of the game.

This repository contains **only original code and documentation**. No game files,
extracted assets or derived data are ever committed.

## Layout

- `docs/RECON.md`: Phase 1 survey of the install (binaries, middleware, pak format quirks).
- `docs/CHARACTERS.md`: how NPCs are assembled from the database, .cdf files and clothing materials.
- `docs/ANIMATION.md`: animation clip format, quaternion decoding, skinning.
- `docs/LEVELS.md`: level files and the compiled terrain heightmap.
- `tools/`: read-only Python recon scripts (`pe_info.py`, `pak_survey.py`, `pak_report.py`, `pakread.py`).
- `web/`: browser pak reader (Vite + TypeScript, no backend, no runtime dependencies).

## Pak browser

Requires Chrome/Chromium (File System Access API). Game files are read locally
through `Blob.slice()`; nothing is uploaded or copied.

```sh
cd web
npm install
npm run dev        # then open http://localhost:5173/ in Chrome
npm run test:pak   # Node smoke test against ~/kcd1 (or pass a game root)
node scripts/test-textures.ts /tmp/tex && python3 -I scripts/compare_pillow.py /tmp/tex   # texture layout + decoder check
node scripts/test-cgf.ts                         # parse every model, check indices/bounds/normals
node scripts/test-characters.ts                  # resolve every NPC soul/preset from the database, load a sample
node scripts/test-anim.ts                        # parse all 8,233 .caf clips (~2 min)
node scripts/test-dba.ts                         # decode all 5,155 .dba animation databases (~1.5 min)
node scripts/test-terrain.ts /tmp/rataje.png      # decode the Rataje heightmap, check seams, write a hillshade
node scripts/render-terrain.ts /tmp/t "1500,1800,0,30,-8"   # headless 3D terrain views (x,y,z|0=ground,yaw,pitch)
node scripts/test-level-objects.ts               # parse Rataje's object octree (brushes, vegetation), check against terrain
node scripts/render-model.ts /tmp/r soul:henry --anim <clip.caf | db.dba#anim.caf> --frames 0,20,40   # animated headless renders
node scripts/render-model.ts /tmp/renders objects/vehicles/cart/cart_01.cga   # headless WebGPU render to PNG (Dawn)
```

Click **Open KCD folder** and pick the game root (the folder containing `Data` and `bin`).
Click a `.dds*` file for the texture viewer, a `.cgf/.cga/.skin` for the WebGPU model viewer, a `.cdf`
for a character, **Characters (game database)** to browse every NPC soul and clothing preset, or
**World: Rataje** to fly over the level's terrain.
