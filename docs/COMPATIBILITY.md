# Compatibility

What OpenKCD has been tried on, and how it went. Reports from other machines
are welcome (the bug report form asks for browser, GPU and driver).

**Needs:** a Chromium-based browser with WebGPU and BC texture compression.
See [PLAYING.md](PLAYING.md) for the requirements and Linux flags. The hosted
player is at <https://openkcd.jmpn.workers.dev/>.

## Tested

| Machine | OS | Browser | GPU (driver) | What was tried | Result |
|---|---|---|---|---|---|
| Development machine: Ryzen 9 9900X, 64 GB | Kubuntu 26.04 (KDE Plasma, Wayland), Linux 7.0 | Google Chrome 156, `--enable-features=Vulkan --ozone-platform=x11` | NVIDIA RTX 5070 Ti (595.99) | Walking the map; install from the GOG installer (archives, compact Full and Potato, part by part); compact package play | **Works.** High in Rattay's market at a locked 70 fps with other heavy programs running (about 130 fps otherwise, 2026-10-23). Interiors and furniture correct. All install modes complete. |
| Same machine | same | Google Chrome 156, headless (automated tests) | RTX 5070 Ti | `test-install-browser.ts`: every install mode, interrupt and resume, opening the package | **Works.** |
| Same machine | same | none: Node with Dawn (`webgpu` npm), headless benchmark | RTX 5070 Ti | `bench-presets.ts`, market and fields | Potato 325 fps, Low 198, Medium 111, High 75 in the market ([PERFORMANCE.md](PERFORMANCE.md)) |
| Same machine | same | none: Node with Dawn, headless benchmark | AMD Radeon integrated graphics (Ryzen 9 9900X, 2 RDNA2 CUs) | `bench-presets.ts`, market and fields | Potato 84 fps, Low 52 in the market. A pessimistic stand-in for the Vega 7 (2 compute units against 7). |
| MacBook Pro, Apple M3 Pro, 24 GB (the development machine since 2026-10-30) | macOS | Google Chrome 143 (headless, automated tests), no flags | Apple M3 Pro (Metal) | The in-app benchmark (`profile-browser.ts --bench`); the headless test suite | **Works.** Potato 297 fps, Low 196, Medium 80, High 57 (benchmark average, 1920×1080; [PERFORMANCE.md](PERFORMANCE.md)). Not yet played by hand in a visible window. |
| Low-end target: AMD Vega 7 laptop, 16 GB (shared with graphics); a friend's | | Chrome (version to follow) | AMD Radeon Vega 7 (integrated) | The hosted player, in Rataje after loading (2026-10-26) | **Playable on Potato and Low.** Potato a locked 60 fps; Low 40–60 fps; Medium about 10 fps, at most 20. The HUD's CPU time was about 9 ms per frame, so the GPU is the limit. The in-app benchmark (⏱ Benchmark) will give per-pass GPU times, the driver and the render size. |

## Not working

| Browser | Why |
|---|---|
| Firefox | Not supported yet: WebGPU isn't available on every platform, and the install flow relies on Chromium's file and storage APIs. |
| Safari | Not supported yet (untested). |
| Chrome on Linux without the Vulkan flag | No WebGPU adapter; only the CPU fallback with `--enable-unsafe-webgpu`, far too slow. |

## Untested

- **Windows** (10, 11): Chrome and Edge.
- **macOS:** Chrome on Intel Macs, and Apple silicon other than the M3 Pro.
- **ChromeOS**, **Android**.
- **Other Chromium browsers:** Edge, Brave, Opera, Vivaldi, Chromium itself.
- **GPUs:** AMD discrete (RDNA, GCN), Intel integrated and Arc, older
  NVIDIA (Turing, Pascal), Apple silicon other than the M3 Pro.
- **Linux on X11** sessions (only Wayland with the x11 flag so far), and
  Mesa drivers in Chrome (Mesa was used headless only).
- **Low memory:** machines with 8 GB of RAM.
