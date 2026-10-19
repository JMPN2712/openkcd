# Contributing to OpenKCD

Thanks for helping. OpenKCD can only exist as an open-source project if it
stays strictly clean, so the rules below are not negotiable.

## Never commit game data

- No game files, in any form. That covers:
  - archives: `.pak`;
  - textures and models: `.dds`, `.cgf`, `.cga`, `.chr`, `.skin`, `.cdf`;
  - animation: `.caf`, `.dba`;
  - audio and video: `.wem`, `.bnk`, `.fsb`, `.bik`;
  - and anything else from the game: scripts, XML, tables, localisation.
- No extracted or converted assets, and no screenshots or renders used as
  test fixtures.
- No excerpts of the game's scripts or data in code or docs beyond what is
  needed to name a format or field.
- No large binaries.

The code reads the player's own copy at runtime. Tests run against a local
install (by default `~/kcd1`) and are never shipped with data.

Enable the commit guard once after cloning:

```sh
git config core.hooksPath .githooks
```

It refuses game file types, files over 1 MB, binaries over 100 KB and
decompiler output. Never bypass it with `--no-verify`. If it blocks something
legitimate, raise it in an issue.

## Clean-room rules

- **No decompiled code.** Never commit decompiler output, or code
  translated line by line from it. That includes Ghidra/IDA names such as
  `FUN_1801234567`, addresses and `undefined8`, in code, comments or docs.
- **Behaviour notes.**
  - Reverse-engineering findings are written up as plain-language behaviour
    notes (what the game does, constants, formats) in a separate private
    research repository.
  - Public code is written from those notes, from the game's own data files,
    and from observation.
- **No CryEngine source.** Do not copy code from Crytek's CryEngine source
  release (any version). It may be consulted as a reference for file
  formats only; write your own implementation.
- **Open-source libraries** with compatible licenses (e.g. Recast/Detour,
  RVO2) may be used or ported, with attribution.
- **No Warhorse or PLAION branding:** no logos, artwork, fonts or official
  imagery.

## Code

- TypeScript in `web/src`, no backend.
- Match the surrounding style and comment density.
- Before sending a change:
  - run `cd web && npx tsc --noEmit`;
  - run the relevant `web/scripts/test-*.ts` against your install.
- Every feature needs a low-end path (the "Potato" preset), so that it runs
  on integrated GPUs such as AMD Vega 7.

## Reporting bugs

Open an issue using the **Bug report** template. Include:

- browser and version;
- GPU and driver;
- OS;
- the quality preset;
- the location in the world (coordinates from the HUD, or a nearby town);
- steps to reproduce;
- console errors.

Screenshots of the problem are welcome in issues. Never attach game files.
