// World view: loads a level's compiled terrain and lets you fly over it.
// Mouse drag: look · WASD / arrows: move · Q/E or Space/C: down/up · Shift: fast.

import { readCentralDirectory, readEntry } from "./zip.ts";
import { parseTerrain, heightAt, type Terrain } from "./terrain.ts";
import { TerrainRenderer, type FlyCamera } from "./terrainRenderer.ts";
import type { PakSource } from "./paks.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let stopActive: (() => void) | null = null;
const terrainCache = new Map<string, Promise<Terrain>>();

export async function showLevel(host: HTMLElement, paks: PakSource[], level: string): Promise<void> {
  stopActive?.();
  stopActive = null;
  const status = el("p", "note", `Loading ${level}…`);
  host.replaceChildren(status);
  const pakPath = `data/levels/${level}/level.pak`;
  const pak = paks.find((p) => p.path.toLowerCase() === pakPath);
  if (!pak) {
    host.replaceChildren(el("p", "error", `${pakPath} not found`));
    return;
  }
  let terrain: Terrain;
  let device: GPUDevice;
  try {
    let p = terrainCache.get(pakPath);
    if (!p) {
      p = (async () => {
        const blob = await pak.open();
        const entry = (await readCentralDirectory(blob)).find((e) => e.name.toLowerCase() === "terrain/terrain.dat");
        if (!entry) throw new Error("terrain/terrain.dat not found in the level pak");
        status.textContent = `Reading terrain (${Math.round(entry.usize / 2 ** 20)} MiB)…`;
        const bytes = await readEntry(blob, entry);
        status.textContent = "Decoding heightmap…";
        await new Promise((r) => setTimeout(r, 0));
        return parseTerrain(bytes);
      })();
      p.catch(() => terrainCache.delete(pakPath));
      terrainCache.set(pakPath, p);
    }
    terrain = await p;
    if (!navigator.gpu) throw new Error("WebGPU is not available in this browser (chrome://flags/#enable-unsafe-webgpu).");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter.");
    device = await adapter.requestDevice();
  } catch (err) {
    host.replaceChildren(el("p", "error", (err as Error).message));
    return;
  }

  const canvas = el("canvas", "model-canvas level-canvas");
  canvas.tabIndex = 0;
  const hud = el("p", "note");
  host.replaceChildren(
    el("p", "scene-title", `${level}: ${terrain.size} × ${terrain.size} m terrain, heights ${terrain.minHeight.toFixed(0)}–${terrain.maxHeight.toFixed(0)} m`),
    canvas,
    el("p", "dim", "Click the view, then: drag to look · WASD/arrows move · Q/E or Space/C down/up · Shift = fast"),
    hud,
  );
  const ctx = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });
  const renderer = new TerrainRenderer(device, format, terrain);
  const cx = terrain.size / 2, cy = terrain.size / 2;
  const cam: FlyCamera = { pos: [cx, cy - 900, heightAt(terrain, cx, cy) + 450], yaw: Math.PI / 2, pitch: -0.45 };

  const keys = new Set<string>();
  canvas.addEventListener("keydown", (e) => { keys.add(e.code); e.preventDefault(); });
  canvas.addEventListener("keyup", (e) => keys.delete(e.code));
  canvas.addEventListener("blur", () => keys.clear());
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => { canvas.focus(); canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    cam.yaw -= (e.clientX - drag.x) * 0.004;
    cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - (e.clientY - drag.y) * 0.004));
    drag = { x: e.clientX, y: e.clientY };
  });

  const ro = new ResizeObserver(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  });
  ro.observe(canvas);

  let raf = 0;
  let last = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    const speed = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 400 : 60) * dt;
    const fx = Math.cos(cam.yaw), fy = Math.sin(cam.yaw);
    const mv = (f: number, s: number, u: number) => {
      cam.pos = [cam.pos[0] + (fx * f - fy * s) * speed, cam.pos[1] + (fy * f + fx * s) * speed, cam.pos[2] + u * speed];
    };
    if (keys.has("KeyW") || keys.has("ArrowUp")) mv(1, 0, 0);
    if (keys.has("KeyS") || keys.has("ArrowDown")) mv(-1, 0, 0);
    if (keys.has("KeyA") || keys.has("ArrowLeft")) mv(0, 1, 0);
    if (keys.has("KeyD") || keys.has("ArrowRight")) mv(0, -1, 0);
    if (keys.has("KeyE") || keys.has("Space")) mv(0, 0, 1);
    if (keys.has("KeyQ") || keys.has("KeyC")) mv(0, 0, -1);
    const ground = heightAt(terrain, cam.pos[0], cam.pos[1]);
    if (cam.pos[2] < ground + 1.7) cam.pos[2] = ground + 1.7;
    if (!canvas.width) return;
    renderer.render(ctx.getCurrentTexture(), cam);
    hud.textContent = `x ${cam.pos[0].toFixed(0)}  y ${cam.pos[1].toFixed(0)}  z ${cam.pos[2].toFixed(0)} m (ground ${ground.toFixed(1)}) · ${(renderer.stats.triangles / 1e6).toFixed(2)}M triangles`;
  };
  raf = requestAnimationFrame(frame);
  canvas.focus();

  stopActive = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    renderer.destroy();
    ctx.unconfigure();
    device.destroy();
  };
}
