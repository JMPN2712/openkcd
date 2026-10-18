# kcd-web

Private, long-term experiment: running Kingdom Come: Deliverance (PC, GOG) in the
browser via WebAssembly + WebGPU. Requires your own legally owned copy of the game.

This repository contains **only original code and documentation**. No game files,
extracted assets or derived data are ever committed.

## Layout

- `docs/RECON.md`: Phase 1 survey of the install (binaries, middleware, pak format quirks).
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
```

Click **Open KCD folder** and pick the game root (the folder containing `Data` and `bin`).
