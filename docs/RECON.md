# KCD1 install reconnaissance

Survey of the GOG release of *Kingdom Come: Deliverance* (Phase 1). Everything here
was gathered with the read-only scripts in `tools/` against the extracted install;
no game data is stored in this repo.

- **Source:** GOG offline installer `setup_kingdom_come_deliverance_1.9.8b_(89871)`
  plus DLC installers, extracted with `innoextract 1.9 --gog`.
- **Game root:** `~/kcd1` (contains `bin/` — lowercase — and `Data/`).
- **DLC extracted:** A Woman's Lot, Band of Bastards, From the Ashes, The Amorous
  Adventures of Bold Sir Hans Capon, Treasures of the Past, HD Texture Pack.
  **Not extracted:** HD Sound Pack, HD Voice Packs (EN/FR/DE).
- **Build IDs:** `bin/Win64/version` = `ver_01_09_598307_667_master`;
  PE FileVersion `1.9.7.0` (GOG label 1.9.8b); built with MSVC 2017.

Regenerate the tables with:

```sh
python3 -I tools/pak_survey.py ~/kcd1 --json /tmp/paks.json
python3 -I tools/pak_report.py /tmp/paks.json
python3 -I tools/pe_info.py ~/kcd1/bin/Win64/* ~/kcd1/bin/Win64Shared/*.dll
```

## 1. Folder layout

| Folder | Size | Contents |
|---|---:|---|
| `Data/` | 56 GB | Game content paks (37 GB top level + `patch/` 16 GB + `Levels/` 2.3 GB + `_fastload/` 55 MB) |
| `Localization/` | 18 GB | Per-language voice-over (`.ogg`) and text (`*_xml.pak`) paks, plus `patch/` |
| `localization/` | 472 MB | **Lowercase duplicate dir** created by the Hans Capon DLC installer (DLC2 language paks). On Windows this merges with `Localization/`; on Linux it doesn't |
| `Engine/` | 247 MB | Engine assets, shaders, shader caches |
| `__redist/` | 124 MB | DirectX / MSVC 2015 redistributables, GOG ISI script interpreter |
| `tmp/` | 109 MB | Installer UI images (InnoSetup temp files) |
| `bin/` | 88 MB | `Win64/` (game) and `Win64Shared/` (middleware) |
| `app/`, `commonappdata/` | ~2 MB | GOG installer support files |
| root | small | `system.cfg`, `PatchVersion.txt`, `whdlversions.txt`, `goggame-*.info/.hashdb` |

`goggame-*.info` product IDs: 1719198803 base game; 1201995925 From the Ashes;
1300320746 Treasures of the Past; 1336069439 Hans Capon; 1460218995 A Woman's Lot;
1597510471 HD Texture Pack; 1957357825 Band of Bastards.

## 2. Binaries

KCD is a **monolithic build**: there are no stock `Cry*.dll` modules. CryEngine
(system, 3D engine, renderer, physics, animation, AI, action, network, entity,
script, sound, movie, font, input) and the Warhorse game code are all statically
linked into one `WHGame.dll`.

### `bin/Win64/`

| File | Size | Role |
|---|---:|---|
| `KingdomCome.exe` | 1.3 MB | Thin launcher (22 KB of code, rest is icon resources). Loads `WHGame.dll`. Exports `NvOptimusEnablement` / `AmdPowerXpressRequestHighPerformance` (discrete-GPU hints) |
| `WHGame.dll` | 45 MB | **Everything**: CryEngine + game logic. 33 MB `.text`. |
| `version` | 29 B | Build tag `ver_01_09_598307_667_master` |

The game-specific logic and stock CryEngine are **not separable at the DLL
level**.

### `bin/Win64Shared/` (middleware)

| File | Size | Vendor / version | Role |
|---|---:|---|---|
| `fmod64.dll` | 1.7 MB | Firelight FMOD 1.10.7 (build 95892) | Low-level audio |
| `fmodstudio64.dll` | 1.4 MB | FMOD Studio 1.10.7 | Event-based audio (`.bank` files) |
| `d3dcompiler_46.dll` / `_47.dll` | 3.7 / 4.0 MB | Microsoft | Runtime HLSL compiler |
| `amd_ags_x64.dll` | 107 KB | AMD AGS (2016) | AMD driver extensions (DX11 multi-draw-indirect, depth bounds) |
| `AnselSDK64.dll` | 651 KB | NVIDIA Ansel 1.5 | Photo mode |
| `GfeSDK.dll` | 4.0 MB | NVIDIA GeForce Experience SDK 1.1 | ShadowPlay highlights |
| `Galaxy64.dll` | 6.9 MB | GOG Galaxy SDK 1.114.4 | Achievements, cloud, ownership |
| `StovePCSDK.dll`, `sgup_api64.dll` | 3.4 MB / 25 KB | Smilegate Stove 2.1.0 | Korean Stove store integration |
| `pros.sdk.x64.dll` | 11 MB | "hydra5.sdk" 5.18.86 (2025) | Publisher online services (telemetry, crash upload, accounts, economy); exports `hydra5_*` |
| `solstice.dll` | 2.1 MB | unknown vendor (2020) | Store/purchase SDK (`solsticePurchase`, `solsticeListAddOnsBySku`) |
| `Tobii.GameIntegration.dll` | 1.9 MB | Tobii 0.1.0.135 | Eye tracking (`tobii_*` cvars) |
| `LightFX*.dll` | 22 KB each | Alienware LightFX 3.5 | RGB lighting |

### Statically linked into `WHGame.dll`

| Library | Evidence | Notes |
|---|---|---|
| **Scaleform GFx 3.3.94** | `Using Scaleform GFx 3.3.94` (version string) | Entire UI is Flash (`.gfx` files, magic `CFX` = zlib-compressed SWF). **Proprietary and discontinued.** |
| **CRI Movie (Sofdec) 3.50a** | `CRI Movie/PCx64 Ver.3.50a`, ADX/M2V/MPV decoders | All video is `.usm` (CRID magic). **Proprietary.** |
| **Lua 5.1** | `Lua 5.1` | CryEngine script system; game scripts ship as plain `.lua` source |
| OpenSSL 1.0.2f, libcurl 7.43.0 | version strings | Networking / online |
| zlib, LZ4 | log strings | Pak + streaming decompression |
| CryPhysics | engine strings | No PhysX or Havok present |
| Oculus SDK paths | Oculus SDK strings | Stock CryEngine VR code, unused |
| NVAPI | `nvapi64.dll` dynamic load | Vendor GPU hooks |

## 3. CryEngine version

There's no single "CryEngine x.y" banner. The evidence points to **CryEngine
3.8.x** (circa 2015), heavily modified by Warhorse:

- A cvar help string reads `Legacy auto exposure for backwards compatibility (CE 3.6 to 3.8.1)`.
  That text was added in 3.8.x, so the base is at least 3.8.1.
- `CryRenderD3D11` and `CryRenderOpenGL` driver names, and HLSLcc command lines
  (`PCGL/V010/HLSLcc.exe -lang=es310 / -lang=440`), match the 3.8 renderer.
  The GL / GLES 3.1 cross-compile path exists in code, though the shipped
  build only uses D3D11.
- Mannequin, the flow graph, `crysoundsystem` with an FMOD implementation (the
  ATL audio layer), and the `CrChF` chunk-file version 0x746 for
  `.cgf/.chr/.skin/.caf/.dba` are all CE 3.x.
- The bare strings `3.5.1` and `3.5.7` also appear. They're probably
  asset/version compat constants rather than the engine version.

## 4. Pak archives

**141 `.pak` files, 73.6 GiB on disk, 1,250,598 files, 106 GiB uncompressed.** (Plus 77 directory entries; `ipl_patch_010300.pak` writes those with `\` even in the central directory, so normalise `\` to `/` before checking for a trailing slash.)

They're standard ZIP archives, with these quirks:

| Property | Finding |
|---|---|
| Compression | Only method **0 (stored)** (756k entries) and **8 (deflate)** (494k). No LZ4, zstd or Oodle at the pak level |
| Encryption | **None.** No general-purpose flag bit 0, no CryEngine custom-encryption EOCD comment (all comments empty), no methods 11–13 |
| **Entry count overflow** | 5 paks have more than 65,535 entries (`rataje/level.pak` 148,697; `English.pak`, `French.pak`, `German.pak`, `Japanese-part0.pak`) but **no ZIP64 record**. The EOCD's 16-bit entry count holds the true count mod 65,536 (e.g. 17,625 for `level.pak`). **Ignore the count and walk the central directory until `cd_size` bytes are used up** |
| ZIP64 | **Not used.** Paks are split into `-partN` files at about 1.86 GiB to stay under 2 GiB. Largest single entry is 1.29 GiB (`cin_9017_navsteva_racka.usm`) |
| Flags | `0x0008` (data descriptor) on 40,972 entries, all in the 1.8/1.9 patch paks; `0x0002` (max deflate) on 15. Harmless if you read sizes from the central directory |
| Extra fields | Only `0x000a` (NTFS timestamps) |
| **Path separator quirk** | In **81 of 141 paks** (most base content paks such as `Scripts.pak` and `Objects.pak`, plus most DLC and HD paks), **central directory names use `/` but local headers use `\`**. The other 60 (all `Data/patch/`, `Engine/`, `*_xml.pak`, `GameData.pak`, `rataje_dlc4/level.pak`) use `/` in both. Strict ZIP readers, including Python `zipfile`, refuse those entries. **Read the central directory only, and skip the local header's name and extra field by their lengths** |
| **Case quirks** | Mixed case in pak and dir names (`videos-part0.pak` next to `Videos-part1.pak`; `Localization/` and `localization/`). CryEngine treats paths case-insensitively, so lookups must too |
| Data integrity | CRC32 verified on a sample of deflate entries across 15 paks with a raw-inflate reader (`tools/pakread.py`); all OK |

### Patch layering

`Data/patch/` holds 21 cumulative patch paks (`patch_010300` → `patch_010900`
and `ipl_patch_010300` → `ipl_patch_010903`, 15 GiB). `Localization/patch/`
holds per-language patches. Files in later patches override files with the same
path in base paks, so any browser or VFS has to apply a version-ordered overlay.

### Base vs. DLC

| Owner | Paks | On disk (GiB) | Entries | How identified |
|---|---:|---:|---:|---|
| Base game | 81 | 44.70 | 1,031,397 | — |
| Base patches | 21 | 15.03 | 87,188 | `Data/patch/` |
| DLC2 Hans Capon | 6 | 0.46 | 17,289 | `*_DLC2` (installer log) |
| DLC3 Band of Bastards | 6 | 0.35 | 11,568 | `*_DLC3` (installer log) |
| DLC4 A Woman's Lot | 15 | 6.51 | 70,212 | `*_DLC4`, `Levels/rataje_dlc4/` |
| HD Texture Pack | 12 | 6.58 | 33,021 | `*_HD*` |

- **From the Ashes** and **Treasures of the Past** installers added *no paks*, only
  `goggame-*.info/.hashdb` license files. Their content presumably ships inside
  the base `IPL_*` / `ipl_patch_*` paks and is unlocked by ownership (the
  `game/whgame/dlc/dlcmanager` code). That's an inference, not verified.
- The DLC paks are additive, with no base files replaced, so a reader can
  treat every DLC as optional.

### Contents by type (all paks)

| Ext | Files | Uncompressed | What it is |
|---|---:|---:|---|
| `.dds.N` | 135,566 | 37.7 GiB | CryEngine **split mip chains** (`foo.dds` holds the header and smallest mips; `.dds.1…N` hold the larger mips, headerless) |
| `.dds` | 88,573 | 0.8 GiB | DDS headers + low mips (`DDS ` magic) |
| `.dds.a` | 18,399 | small | Attached alpha/gloss surface, split DDS without the `DDS ` magic |
| `.ogg` | 747,555 | 17.7 GiB | Voice-over (`Dialog/`) per language, stored uncompressed in the ZIP |
| `.caf` / `.dba` / `.img` | 8,233 / 5,155 / 22 | 16.8 / 6.3 / 0.6 GiB | CryEngine animations (`CrChF`), animation DB, animation image |
| `.usm` | 49 | 15.0 GiB | CRI Sofdec video (cutscenes, intro) |
| `.cgf` / `.skin` / `.chr` / `.cga` | 49,953 / 1,976 / 98 / 220 | 3.6 / 1.7 GiB / small | CryEngine geometry: static, skinned, skeleton, animated (`CrChF` v0x746) |
| `.dat` | 171,644 | 1.9 GiB | Level terrain / merged-mesh sectors (`0xCAFEBABE` magic), SVO data, sky (`STAR`) |
| `.bank` | 299 | 1.7 GiB | FMOD Studio banks (`RIFF … FEV FMT`) |
| `.xml` | 5,405 | 0.7 GiB | **Plain-text XML**, no CryXmlB binary XML found; 26 files have a UTF-8 BOM |
| `.mtl` | 11,444 | 60 MiB | Materials (XML) |
| `.sqcb` / `.widsh` | 157 / 11 | 0.45 GiB | Warhorse "SQC MUSIC ENGINE" (custom adaptive-music format, UTF-16 header) |
| `.fxcb` / `.cfxb` / `.cfib` | 649 / 184 / 92 | 0.2 GiB | Compiled shader cache / binary shader descriptions |
| `.tbl` | 391 | 59 MiB | Warhorse **binary database tables**; header starts with `03 00 00 00` |
| `.gfx` | 97 | 53 MiB | Scaleform UI (compressed SWF, `CFX`) |
| `.nav` / recast paks | 371 | 0.1 GiB | AI navmesh |
| `.lua` | 498 | 2 MiB | **Plain Lua 5.1 source** (not bytecode) |
| `.adb`, `.animevents`, `.bspace`, `.cdf`, `.chrparams`, `.ent`, `.cfg`, `.json` | ~2.9k | small | Text (XML / ini-like) |

By top-level dir inside the paks: `objects` 38.6 GiB, `animations` 23.5 GiB,
`dialog` 17.7 GiB, `videos` 15.0 GiB, `textures` 4.0 GiB, `terrain` 2.2 GiB,
`sounds` 1.6 GiB, `libs` 1.0 GiB, `scripts` 7 MiB.

The single game level is `Data/Levels/rataje/`: `level.pak` has 148,697 entries,
plus `svo.pak` (voxel GI) and `recast.pak` (navmesh). DLC4 adds an overlay level,
`rataje_dlc4`.

## 5. Textures (verified while building the texture preview)

Checked against all 42,542 texture headers in the install by `web/scripts/test-textures.ts`.
Decoders verified against Pillow 12 by `web/scripts/compare_pillow.py`: 25 samples
per format, exact match for BC1/BC3/BC4/BC5/BC7/DXT1/3/5/ATI2/L8/RGB(A), and
BC6H within 1/255.

- **Split layout.**
  - `foo.dds` holds the DDS header (with a DX10 extension for most) plus the
    smallest mips (the tail; usually 16², 8² and 4²).
  - `foo.dds.1 … foo.dds.K` hold one mip each, **numbered from the small end**:
    `.1` is mip K−1 and `.K` is mip 0.
  - **K must be derived from the header** (mip count minus the tail mips that
    fit in the header file), not from which parts exist. The 1.3–1.7 patches
    re-ship lower-resolution header-only versions (e.g. 1024² where the base
    pak has a 2048² header and parts up to `.7`), which leaves the top parts
    unused.
- **Attached alpha.** `foo.dds.a` is a second texture, usually a BC4 gloss
  channel for `_ddna` normal maps. Its header has **no `DDS ` magic**, and its
  parts are named `foo.dds.1a … .Ka`.
- **CryEngine header fields.** `dwReserved1` carries CryEngine data (flags,
  average brightness, min/max colour as floats), and `dwReserved2` holds the
  `CRYF` marker. 13 engine cubemaps append an 8-byte trailer.
- **Cubemaps are never split.** 26,383 of them are complete in their header
  file, mostly BC6H HDR environment probes. Faces are stored face-major.
- **Mips span paks.**
  - The HD Texture Pack ships a new header plus only the new top mip; the
    lower mips stay in the base pak.
  - A working load order is base < DLC < patches (by version) < HD <
    HD patches. Patches can't outrank HD, because they re-ship 1024² headers
    for textures whose 2048² HD header has no HD patch.
  - Rank alone isn't sufficient. `_fastload/startup_characters_hd.pak` has
    stale 4096² headers (e.g. `johanka_body_diff`) whose top mip exists in no
    pak, while the 1.9 patch has a complete 2048² set.
  - **Resolution rule:** pick the highest-ranked header version whose parts
    all exist at the right sizes. 55 textures need this fallback.
  - 39 textures (rain puddles, some defaults) have no complete version at all
    and ship without their top mip.
- **Format mix (unique headers):**
  - 23,973 BC6H cubemaps.
  - Block-compressed: BC1 sRGB 5,097; BC4 4,717; BC5 4,454; BC3 sRGB 2,184;
    DXT5 1,064; BC7 270.
  - Plus a long tail of legacy DX9 formats (DXT1/3, ATI2, L8, A8, RGB
    24/32-bit, G16R16F, A16B16G16R16F) and DXGI A8 / R16G16.

## 6. Models (verified while building the model viewer)

Checked by `web/scripts/test-cgf.ts` over all 52,247 `.cgf/.cga/.skin/.chr`
files (86.7M triangles), and visually via headless WebGPU renders from
`web/scripts/render-model.ts`, which uses Dawn through the `webgpu` npm package.

- **Container.** `CrCh` signature, version 0x746, with 16-byte chunk table
  entries {u16 type, u16 version, u32 id, u32 size, u32 offset}. Chunks carry
  no inline header.
- **Chunk types used:**

  | Type | Chunk | Version |
  |---|---|---|
  | 0x1000 | Mesh | 0x801 |
  | 0x1001 | Helper | 0x744 |
  | 0x100b | Node | 0x824 |
  | 0x100e | Timing | 0x918 |
  | 0x1013 | SourceInfo | |
  | 0x1014 | MtlName | 0x802 |
  | 0x1015 | ExportFlags | |
  | 0x1016 | DataStream | 0x800 |
  | 0x1017 | MeshSubsets | 0x800 |
  | 0x1018 | MeshPhysicsData | 0x800 |
  | 0x3009 | BspTreeData | |
  | 0x1003, 0x1005 | | rare |

  31 character files use older variants (a `CryTek` 0x744/0x745 header, or
  another node version) and are not supported yet.
- **Streams.** `{flags, type, count, elemSize, reserved[2]}` followed by data:
  - Positions: half-float ×4 (w = 1.0), **absolute** model-space metres.
  - UVs: float32 ×2.
  - Indices: u16 or u32, absolute (not relative to the subset's first vertex).
  - Tangents: `SPipTangents`, int16×4 tangent + int16×4 bitangent; the
    normal is (t × b) · sign(t.w).
  - Shape-deformation streams (type 8) appear on characters.
- **Subsets.** A 16-byte header, then 36 bytes per subset. Flag 0x4 appends
  one float (texel density) per subset.
- **Node transform.**
  - Stored as an affine 4×4 with **the 4th column zeroed** (`tm[15] == 0`),
    so it must be fixed up before use.
  - Its **translation is in centimetres** while vertices are in metres (the
    `cart_01.cga` wheels sit at 62.3/71.2 for a 0.69 m radius).
  - Nodes named `$physics_proxy…` are collision meshes.
- **Fast-load stubs.** `_fastload/startup_*.pak` hold about 20,000 stub
  copies of models: real chunk tables and bounding boxes but empty mesh
  chunks. Rank them lowest and take the highest-priority version that has
  geometry.
- **Winding and normals.**
  - Counter-clockwise front faces: decoded normals agree with face winding
    on 98.7% of triangles. The rest are foliage with hand-authored normals.
  - Many meshes contain layered duplicate triangles; the windmill roof has
    1,946 identical and 214 reversed. Some, like that windmill's floors, also
    have authored non-geometric normals.
  - A renderer should disable culling and flip normals toward the viewer.
    Flipping by `front_facing` makes the duplicates z-fight.
- **Materials (`.mtl`, plain XML).**
  - `SubMaterials` are indexed by the subset material ID; `Shader="Nodraw"`
    marks proxies.
  - Texture paths use `.tif` and map to `.dds` in the paks.
  - The material name is relative to the model's folder when bare, or to the
    game root when it contains `/`.
  - PBR conventions: metals have near-black diffuse. When a `Specular` map is
    present, the `Specular` attribute is a multiplier, typically 1,1,1.
  - Characters get their materials from `.cdf` files; their skins reference a
    placeholder `wh_geometry.mtl` that doesn't exist.
- **Known viewer limitations.**
  - Clothing and armour use a zone-mask/palette shader (the "diffuse" is a
    mask), so they render garish.
  - Billboard LODs (`_lod3` trees) need an impostor shader.
  - No normal maps, detail maps, blend layers, second UV set or skinning yet.

## 7. Full pak table

| Pak | Size (MiB) | Files | Uncompressed (MiB) | Methods | ZIP64 | Owner |
|---|---:|---:|---:|---|---|---|
| `Data/Animations-part0.pak` | 1,854.1 | 5,888 | 6,040.7 | 8:5888 |  | Base |
| `Data/Animations-part1.pak` | 334.9 | 329 | 794.0 | 8:329 |  | Base |
| `Data/Buildings.pak` | 1,838.9 | 30,242 | 2,917.1 | 8:30242 |  | Base |
| `Data/Buildings_HD-part0.pak` | 1,854.7 | 6,054 | 2,506.8 | 8:6054 |  | HD Texture Pack |
| `Data/Buildings_HD-part1.pak` | 717.0 | 1,264 | 1,103.0 | 8:1264 |  | HD Texture Pack |
| `Data/Characters.pak` | 1,693.4 | 12,730 | 3,605.0 | 8:12730 |  | Base |
| `Data/Characters_HD.pak` | 6.6 | 8 | 10.1 | 8:8 |  | HD Texture Pack |
| `Data/Cinematics.pak` | 1,043.8 | 1,808 | 3,832.7 | 8:1808 |  | Base |
| `Data/Cinematics_DLC4.pak` | 167.0 | 216 | 687.6 | 8:216 |  | DLC4 A Woman's Lot |
| `Data/Cloth-part0.pak` | 1,854.7 | 6,635 | 3,234.1 | 8:6635 |  | Base |
| `Data/Cloth-part1.pak` | 1,852.7 | 6,300 | 3,446.0 | 8:6300 |  | Base |
| `Data/Cloth-part2.pak` | 984.7 | 3,371 | 1,529.1 | 8:3371 |  | Base |
| `Data/GameData.pak` | 313.4 | 4,228 | 590.4 | 8:4228 |  | Base |
| `Data/GeomCaches.pak` | 3.6 | 10 | 3.6 | 0:10 |  | Base |
| `Data/Heads.pak` | 1,185.6 | 3,450 | 1,739.9 | 8:3450 |  | Base |
| `Data/IPL_Cinematics.pak` | 93.3 | 192 | 368.9 | 8:192 |  | Base |
| `Data/IPL_Heads.pak` | 896.4 | 2,410 | 1,350.6 | 8:2410 |  | Base |
| `Data/Levels/rataje/level.pak` | 698.6 | 148,697 | 887.9 | 0:4, 8:148693 |  | Base |
| `Data/Levels/rataje/recast.pak` | 111.6 | 736 | 111.5 | 0:736 |  | Base |
| `Data/Levels/rataje/svo.pak` | 893.0 | 257 | 893.0 | 0:257 |  | Base |
| `Data/Levels/rataje_dlc4/level.pak` | 238.1 | 29,735 | 267.7 | 0:3, 8:29732 |  | DLC4 A Woman's Lot |
| `Data/Levels/rataje_dlc4/recast.pak` | 11.2 | 15 | 11.2 | 0:15 |  | DLC4 A Woman's Lot |
| `Data/Levels/rataje_dlc4/svo.pak` | 385.7 | 257 | 385.7 | 0:257 |  | DLC4 A Woman's Lot |
| `Data/Objects.pak` | 1,614.2 | 46,838 | 2,502.3 | 8:46838 |  | Base |
| `Data/Objects_HD-part0.pak` | 1,853.5 | 6,760 | 2,555.5 | 8:6760 |  | HD Texture Pack |
| `Data/Objects_HD-part1.pak` | 373.5 | 1,365 | 525.8 | 8:1365 |  | HD Texture Pack |
| `Data/Scripts.pak` | 6.7 | 1,447 | 66.0 | 8:1447 |  | Base |
| `Data/Scripts_DLC2.pak` | 0.1 | 3 | 1.7 | 8:3 |  | DLC2 Hans Capon |
| `Data/Scripts_DLC3.pak` | 0.1 | 9 | 1.4 | 8:9 |  | DLC3 Band of Bastards |
| `Data/Scripts_DLC4.pak` | 0.3 | 23 | 3.5 | 8:23 |  | DLC4 A Woman's Lot |
| `Data/Sounds.pak` | 273.1 | 80 | 273.1 | 0:80 |  | Base |
| `Data/Tables.pak` | 37.8 | 800 | 268.9 | 8:800 |  | Base |
| `Data/Textures.pak` | 570.4 | 30,143 | 713.1 | 8:30143 |  | Base |
| `Data/Textures_DLC4.pak` | 9.8 | 1,836 | 12.8 | 8:1836 |  | DLC4 A Woman's Lot |
| `Data/Textures_HD.pak` | 1,132.5 | 2,365 | 1,400.4 | 8:2365 |  | HD Texture Pack |
| `Data/Videos-part1.pak` | 1,363.5 | 3 | 1,363.5 | 0:3 |  | Base |
| `Data/Videos_DLC4-part0.pak` | 1,351.3 | 2 | 1,351.3 | 0:2 |  | DLC4 A Woman's Lot |
| `Data/Videos_DLC4-part1.pak` | 1,865.1 | 5 | 1,865.1 | 0:5 |  | DLC4 A Woman's Lot |
| `Data/Videos_DLC4-part2.pak` | 1,543.9 | 3 | 1,543.9 | 0:3 |  | DLC4 A Woman's Lot |
| `Data/_fastload/startup_Animations.pak` | 0.9 | 771 | 8.3 | 8:771 |  | Base |
| `Data/_fastload/startup_Characters.pak` | 4.4 | 6,123 | 10.4 | 8:6123 |  | Base |
| `Data/_fastload/startup_Graphics.pak` | 42.6 | 35,589 | 103.2 | 8:35589 |  | Base |
| `Data/_fastload/startup_HD.pak` | 1.9 | 3,664 | 1.4 | 8:3664 |  | HD Texture Pack |
| `Data/_fastload/startup_characters_hd.pak` | 0.0 | 24 | 0.0 | 8:24 |  | HD Texture Pack |
| `Data/_fastload/startup_graphics_hd.pak` | 4.5 | 8,917 | 3.6 | 8:8917 |  | HD Texture Pack |
| `Data/ipl_videos.pak` | 483.8 | 2 | 483.8 | 0:2 |  | Base |
| `Data/ipl_videosb.pak` | 623.7 | 1 | 623.7 | 0:1 |  | Base |
| `Data/music.pak` | 349.2 | 140 | 349.2 | 0:140 |  | Base |
| `Data/patch/ipl_patch_010300.pak` | 690.7 | 5,414 | 1,124.8 | 0:77, 8:5337 |  | Base (patch) |
| `Data/patch/ipl_patch_010400.pak` | 1,219.6 | 14,817 | 1,932.5 | 0:1378, 8:13439 |  | Base (patch) |
| `Data/patch/ipl_patch_010403.pak` | 654.8 | 4,598 | 1,198.7 | 0:380, 8:4218 |  | Base (patch) |
| `Data/patch/ipl_patch_010500.pak` | 1,488.2 | 8,098 | 2,430.1 | 0:888, 8:7210 |  | Base (patch) |
| `Data/patch/ipl_patch_010500_hd.pak` | 127.2 | 93 | 184.0 | 0:1, 8:92 |  | HD Texture Pack |
| `Data/patch/ipl_patch_010600.pak` | 1,222.2 | 8,438 | 2,222.8 | 0:742, 8:7696 |  | Base (patch) |
| `Data/patch/ipl_patch_010600_hd.pak` | 652.8 | 2,467 | 803.7 | 0:1, 8:2466 |  | HD Texture Pack |
| `Data/patch/ipl_patch_010602.pak` | 1,165.2 | 7,175 | 2,125.2 | 0:561, 8:6614 |  | Base (patch) |
| `Data/patch/ipl_patch_010700.pak` | 1,787.5 | 11,514 | 2,537.3 | 0:1127, 8:10387 |  | Base (patch) |
| `Data/patch/ipl_patch_010700_hd.pak` | 10.9 | 40 | 14.9 | 8:40 |  | HD Texture Pack |
| `Data/patch/ipl_patch_010700b.pak` | 411.6 | 628 | 1,135.1 | 8:628 |  | Base (patch) |
| `Data/patch/ipl_patch_010701.pak` | 1,668.8 | 10,908 | 2,359.8 | 0:1049, 8:9859 |  | Base (patch) |
| `Data/patch/ipl_patch_010701b.pak` | 418.7 | 632 | 1,147.5 | 8:632 |  | Base (patch) |
| `Data/patch/ipl_patch_010800.pak` | 1,273.9 | 3,859 | 2,049.7 | 0:94, 8:3765 |  | Base (patch) |
| `Data/patch/ipl_patch_010900.pak` | 1,705.6 | 7,033 | 3,024.9 | 0:100, 8:6933 |  | Base (patch) |
| `Data/patch/ipl_patch_010902.pak` | 143.9 | 925 | 200.9 | 0:7, 8:918 |  | Base (patch) |
| `Data/patch/ipl_patch_010903.pak` | 0.3 | 16 | 0.3 | 0:3, 8:13 |  | Base (patch) |
| `Data/patch/patch_010300.pak` | 11.6 | 164 | 21.0 | 8:164 |  | Base (patch) |
| `Data/patch/patch_010500.pak` | 54.8 | 189 | 56.0 | 0:27, 8:162 |  | Base (patch) |
| `Data/patch/patch_010600.pak` | 54.8 | 189 | 56.0 | 0:27, 8:162 |  | Base (patch) |
| `Data/patch/patch_010700.pak` | 33.4 | 111 | 42.2 | 0:9, 8:102 |  | Base (patch) |
| `Data/patch/patch_010701.pak` | 18.1 | 63 | 18.7 | 0:9, 8:54 |  | Base (patch) |
| `Data/patch/patch_010800.pak` | 1,061.5 | 1,905 | 3,896.8 | 8:1905 |  | Base (patch) |
| `Data/patch/patch_010900.pak` | 303.1 | 512 | 906.9 | 8:512 |  | Base (patch) |
| `Data/videos-part0.pak` | 1,645.1 | 8 | 1,645.1 | 0:8 |  | Base |
| `Data/videos-part2.pak` | 1,653.8 | 17 | 1,653.8 | 0:17 |  | Base |
| `Data/videos-part3.pak` | 1,418.6 | 2 | 1,418.6 | 0:2 |  | Base |
| `Data/videos-part4.pak` | 1,262.3 | 2 | 1,262.3 | 0:2 |  | Base |
| `Data/videosb-part0.pak` | 842.5 | 3 | 842.5 | 0:3 |  | Base |
| `Data/videosb-part1.pak` | 1,321.9 | 1 | 1,321.9 | 0:1 |  | Base |
| `Engine/engine.pak` | 24.0 | 366 | 44.4 | 8:366 |  | Base |
| `Engine/shadercache.pak` | 215.9 | 698 | 215.8 | 0:698 |  | Base |
| `Engine/shadercachestartup.pak` | 1.5 | 75 | 1.5 | 0:75 |  | Base |
| `Engine/shaders.pak` | 0.5 | 148 | 1.9 | 8:148 |  | Base |
| `Engine/shadersbin.pak` | 4.7 | 113 | 4.7 | 0:113 |  | Base |
| `Localization/Chineses_xml.pak` | 4.7 | 11 | 14.4 | 8:11 |  | Base |
| `Localization/Czech-part0.pak` | 1,904.3 | 57,848 | 1,894.2 | 0:57848 |  | Base |
| `Localization/Czech-part1.pak` | 791.0 | 21,979 | 787.1 | 0:21979 |  | Base |
| `Localization/Czech_DLC3.pak` | 96.3 | 2,313 | 95.9 | 0:2313 |  | DLC3 Band of Bastards |
| `Localization/Czech_DLC4.pak` | 295.8 | 7,601 | 294.4 | 0:7601 |  | DLC4 A Woman's Lot |
| `Localization/Czech_xml.pak` | 3.5 | 11 | 15.9 | 8:11 |  | Base |
| `Localization/English.pak` | 1,733.2 | 75,521 | 1,720.0 | 0:75521 |  | Base |
| `Localization/English_DLC3.pak` | 62.7 | 2,313 | 62.3 | 0:2313 |  | DLC3 Band of Bastards |
| `Localization/English_DLC4.pak` | 191.4 | 7,596 | 190.1 | 0:7596 |  | DLC4 A Woman's Lot |
| `Localization/English_xml.pak` | 3.2 | 11 | 15.6 | 8:11 |  | Base |
| `Localization/French.pak` | 1,731.7 | 73,800 | 1,718.8 | 0:73800 |  | Base |
| `Localization/French_DLC3.pak` | 63.9 | 2,313 | 63.5 | 0:2313 |  | DLC3 Band of Bastards |
| `Localization/French_DLC4.pak` | 194.7 | 7,488 | 193.4 | 0:7488 |  | DLC4 A Woman's Lot |
| `Localization/French_xml.pak` | 4.7 | 11 | 15.8 | 8:11 |  | Base |
| `Localization/German.pak` | 1,779.0 | 73,885 | 1,766.1 | 0:73885 |  | Base |
| `Localization/German_DLC3.pak` | 63.3 | 2,313 | 62.9 | 0:2313 |  | DLC3 Band of Bastards |
| `Localization/German_DLC4.pak` | 186.7 | 7,488 | 185.4 | 0:7488 |  | DLC4 A Woman's Lot |
| `Localization/German_xml.pak` | 4.7 | 11 | 15.5 | 8:11 |  | Base |
| `Localization/IPL_Czech.pak` | 1,539.3 | 54,712 | 1,529.7 | 0:54712 |  | Base |
| `Localization/IPL_English.pak` | 1,014.2 | 54,282 | 1,004.7 | 0:54282 |  | Base |
| `Localization/IPL_English_DLC4.pak` | 9.7 | 345 | 9.6 | 0:345 |  | DLC4 A Woman's Lot |
| `Localization/IPL_French.pak` | 1,018.1 | 53,783 | 1,008.7 | 0:53783 |  | Base |
| `Localization/IPL_German.pak` | 1,037.1 | 53,941 | 1,027.7 | 0:53941 |  | Base |
| `Localization/IPL_Japanese.pak` | 1,153.8 | 54,534 | 1,144.3 | 0:54534 |  | Base |
| `Localization/Italian_xml.pak` | 4.5 | 11 | 15.3 | 8:11 |  | Base |
| `Localization/Japanese-part0.pak` | 1,904.3 | 75,729 | 1,891.1 | 0:75729 |  | Base |
| `Localization/Japanese-part1.pak` | 107.4 | 3,837 | 106.7 | 0:3837 |  | Base |
| `Localization/Japanese_DLC3.pak` | 70.5 | 2,307 | 70.1 | 0:2307 |  | DLC3 Band of Bastards |
| `Localization/Japanese_DLC4.pak` | 217.0 | 7,602 | 215.6 | 0:7602 |  | DLC4 A Woman's Lot |
| `Localization/Japanese_xml.pak` | 4.9 | 11 | 16.5 | 8:11 |  | Base |
| `Localization/Korean_xml.pak` | 4.9 | 11 | 16.2 | 8:11 |  | Base |
| `Localization/Polish_xml.pak` | 4.7 | 11 | 15.2 | 8:11 |  | Base |
| `Localization/Portuguese_xml.pak` | 4.5 | 11 | 15.3 | 8:11 |  | Base |
| `Localization/Russian_xml.pak` | 5.0 | 11 | 17.6 | 8:11 |  | Base |
| `Localization/Spanish_xml.pak` | 4.5 | 11 | 15.4 | 8:11 |  | Base |
| `Localization/Turkish_xml.pak` | 4.3 | 11 | 15.3 | 8:11 |  | Base |
| `Localization/Ukrainian_xml.pak` | 4.8 | 11 | 16.8 | 8:11 |  | Base |
| `Localization/common.pak` | 0.0 | 1 | 0.0 | 8:1 |  | Base |
| `Localization/patch/english_patch_010800.pak` | 20.5 | 1,171 | 20.3 | 0:1171 |  | Base |
| `Localization/patch/english_patch_010900.pak` | 92.0 | 4,502 | 91.1 | 0:4502 |  | Base |
| `Localization/patch/english_patch_010902.pak` | 0.0 | 2 | 0.0 | 0:2 |  | Base |
| `Localization/patch/french_patch_010800.pak` | 22.2 | 1,198 | 22.0 | 0:1198 |  | Base |
| `Localization/patch/french_patch_010900.pak` | 81.6 | 3,626 | 80.9 | 0:3626 |  | Base |
| `Localization/patch/french_patch_010902.pak` | 23.7 | 1,234 | 23.5 | 0:1234 |  | Base |
| `Localization/patch/german_patch_010800.pak` | 20.5 | 1,175 | 20.3 | 0:1175 |  | Base |
| `Localization/patch/german_patch_010900.pak` | 80.9 | 3,631 | 80.2 | 0:3631 |  | Base |
| `Localization/patch/german_patch_010902.pak` | 18.1 | 924 | 17.9 | 0:924 |  | Base |
| `Localization/patch/ipl_english_patch_010900.pak` | 72.8 | 2,970 | 72.2 | 0:2970 |  | Base |
| `Localization/patch/ipl_english_patch_010902.pak` | 0.0 | 3 | 0.0 | 0:3 |  | Base |
| `Localization/patch/ipl_french_patch_010900.pak` | 54.7 | 2,087 | 54.3 | 0:2087 |  | Base |
| `Localization/patch/ipl_french_patch_010902.pak` | 22.2 | 1,145 | 22.0 | 0:1145 |  | Base |
| `Localization/patch/ipl_german_patch_010900.pak` | 54.0 | 2,087 | 53.7 | 0:2087 |  | Base |
| `Localization/patch/ipl_german_patch_010902.pak` | 17.8 | 983 | 17.6 | 0:983 |  | Base |
| `localization/Czech_DLC2.pak` | 126.8 | 3,460 | 126.2 | 0:3460 |  | DLC2 Hans Capon |
| `localization/English_DLC2.pak` | 84.8 | 3,460 | 84.1 | 0:3460 |  | DLC2 Hans Capon |
| `localization/French_DLC2.pak` | 85.3 | 3,460 | 84.7 | 0:3460 |  | DLC2 Hans Capon |
| `localization/German_DLC2.pak` | 84.1 | 3,459 | 83.4 | 0:3459 |  | DLC2 Hans Capon |
| `localization/Japanese_DLC2.pak` | 90.6 | 3,447 | 90.0 | 0:3447 |  | DLC2 Hans Capon |

