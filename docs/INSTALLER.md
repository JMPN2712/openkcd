# GOG installer format

Milestone 2 converts the game straight from GOG's offline installer, without
installing it. This note describes what `web/src/inno.ts` reads. The
installers are standard Inno Setup installers (an open-source installer
builder); GOG adds its own file-part scheme on top. The layout below was
worked out from the installer files themselves, with the open-source
`innoextract` tool as a cross-check. No game code is involved.

- **Version:** every KCD 1.9.8b installer (base game and all 10 DLC
  installers) uses setup data version `5.6.2 (u)` (Unicode). The reader
  rejects any other version instead of guessing.
- **Test:** `node scripts/test-inno.ts` (all installers in
  `~/Downloads/kingdom_come_deliverance`, sampled files) or `--full` (every
  file). Each file is compared byte for byte with `~/kcd1` where that has it,
  and always checked against the installer's MD5s.

## Files

| Installer | Files | Size | Data |
|---|---:|---:|---|
| Base game | 129 | 59.8 GiB | 15 `.bin` slices (4 GiB each) |
| A Woman's Lot, HD Texture Pack | 17, 14 | 6.5 GiB each | 2 slices |
| HD Voice Packs (EN/FR/DE) | 9–11 | 3.9 GiB each | 1 slice |
| Band of Bastards, Hans Capon, HD Sound Pack | 3–8 | 0.35–0.46 GiB | inside the `.exe` |
| From the Ashes, Treasures of the Past | 2 | < 1 MiB | inside the `.exe` |

## Layout

**Loader table (in the `.exe`).** Found by its 12-byte magic (`rDlPtS` and 6
fixed bytes). It is a version (1) followed by 32-bit fields; the CRC32 of the
first 40 bytes ends it. Two fields matter:

- the offset of the setup headers;
- the offset of the file data inside the `.exe`, or 0 when the data is in
  `.bin` slices.

**Setup headers.** A 64-byte version string (`Inno Setup Setup Data (5.6.2)
(u)`), then two compressed blocks. Each block is:

- CRC32, then the stored size (32-bit) and a compressed flag (1 byte); the
  CRC covers those 5 bytes;
- the stored bytes, in chunks of up to 4096 bytes, each after its own CRC32;
- once joined, the data is raw LZMA: 5 property bytes, then the stream, with
  no end marker (`web/src/lzma.ts`).

Block 1 is about 3 MB for the base game; block 2 is about 0.5 MB.

**Block 1: setup header and entry lists.** Strings are a 32-bit byte length
followed by the bytes (UTF-16LE for the text strings). The block holds, in
order:

1. The setup header:
   - 30 UTF-16 strings (app name, version, …), then 4 byte strings (licence
     and info texts, the compiled install script);
   - 16 entry counts: languages, custom messages, permissions, types,
     components, tasks, directories, files, file locations, icons, INI,
     registry, install deletes, uninstall deletes, run, uninstall run;
   - 93 fixed bytes. Slices per disk is the 32-bit value at +65; it is 1 in
     every KCD installer.
2. Entry lists. Each entry is its strings followed by its fixed bytes:

   | List | Strings | Fixed bytes |
   |---|---:|---:|
   | Languages | 10 | 21 |
   | Custom messages | 2 | 4 |
   | Permissions | 1 | 0 |
   | Types | 4 | 30 |
   | Components | 5 | 42 |
   | Tasks | 6 | 26 |
   | Directories | 7 | 27 |
   | **Files** | 10 | 43 |

   The reader stops after the file entries. A file entry's strings are:
   source, destination, font name, assembly name, components, tasks,
   languages, check, after-install and before-install. Its location index
   (signed 32-bit, −1 for none) is at fixed byte +20.

**Block 2: file locations.** 74-byte records, one per stored chunk:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | First slice (0-based) |
| 4 | 4 | Last slice |
| 8 | 4 | Chunk start offset in the first slice |
| 12 | 8 | Offset of the file in the chunk (always 0 here) |
| 20 | 8 | Size |
| 28 | 8 | Chunk stored size |
| 36 | 20 | SHA-1 |
| 56 | 8 | File time |
| 64 | 8 | File version |
| 72 | 2 | Flags (bit 6 encrypted chunk, bit 7 compressed chunk) |

**Slices.** File `setup_x-N.bin` holds slice N−1 and starts with a 12-byte
header: `idska32\x1a`, then its own size (32-bit). This also catches truncated
downloads. Each chunk starts with the marker `zlb\x1a`, and a chunk can run
on into the next slice, after that slice's header. When the data is inside
the `.exe`, it acts as slice 0 starting at the loader table's data offset,
with no header.

## GOG's file parts

The game files are not ordinary Inno entries.

- **Parts.** GOG splits each file into parts of 10 MiB (the last part is
  shorter) and compresses every part with zlib itself.
- **Storage.** Inno stores the parts uncompressed (flags bits 6 and 7 clear),
  under hashed temporary names (`{tmp}/64/bc\64bc…`).
- **Reassembly.** The install script puts them back together. The calls are
  kept in each entry's condition strings:
  - `before_install('<md5 of the whole file>', 'Data\Buildings.pak', 183)` on
    the first part gives the real path and the number of parts;
  - `after_install('<md5 of the inflated part>', <stored size>, <inflated
    size>)` on every part;
  - the parts of a file are consecutive file entries;
  - `check_if_install('en-US#','32#64#','')` is the same for every game file
    in the KCD installers.

So a file is the inflated parts concatenated. The browser's
`DecompressionStream("deflate")` inflates each part and checks its Adler-32.
Incompressible parts still go through zlib (stored blocks), so they come out
about 3 KB bigger than the raw data.

**Not read:**
- entries without `after_install`: installer UI images, EULAs, the GOG
  uninstaller, `webcache.zip`;
- the DirectX and Visual C++ redistributables (`*_dependency` calls).

None of these are needed by the engine.

## Speed

Node reads, inflates, MD5-checks and compares at about 300–350 MiB/s on the
Ryzen 9 9900X (one thread). The base game's 60 GiB would take about 3
minutes at that rate, before any conversion work.
