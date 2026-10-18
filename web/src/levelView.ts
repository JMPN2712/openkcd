// World view: loads a level's compiled terrain and lets you fly over it.
// Mouse drag: look · WASD / arrows: move · Q/E or Space/C: down/up · Shift: fast.

import { readCentralDirectory, readEntry } from "./zip.ts";
import { parseTerrain, heightAt, type Terrain } from "./terrain.ts";
import { TerrainRenderer, type FlyCamera } from "./terrainRenderer.ts";
import type { PakSource } from "./paks.ts";
import { parseLevelObjects, type LevelObjects } from "./levelObjects.ts";
import { ModelRenderer } from "./renderer.ts";
import { buildWorldScene } from "./world.ts";
import { Vfs } from "./vfs.ts";
import { ASSET_RE } from "./assets.ts";
import type { LoadedModel } from "./model.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let stopActive: (() => void) | null = null;
const terrainCache = new Map<string, Promise<{ terrain: Terrain; objects: LevelObjects }>>();
const vfsCache = new Map<string, Promise<Vfs>>();
const modelCache = new Map<string, Promise<LoadedModel | null>>();
const STREAM_RADIUS = 250; // metres of objects around the camera
const STREAM_STEP = 120; // rebuild after moving this far

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
  let objects: LevelObjects;
  let vfs: Vfs;
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
        status.textContent = "Decoding heightmap and object octree…";
        await new Promise((r) => setTimeout(r, 0));
        const terrain = parseTerrain(bytes);
        return { terrain, objects: parseLevelObjects(bytes, terrain.objectsOffset) };
      })();
      p.catch(() => terrainCache.delete(pakPath));
      terrainCache.set(pakPath, p);
    }
    ({ terrain, objects } = await p);
    let v = vfsCache.get(pakPath);
    if (!v) {
      // assets from every non-level pak, with this level's own files (brush/*.cgf, …) on top
      v = Vfs.build(paks.filter((x) => !x.path.toLowerCase().startsWith("data/levels/")), {
        filter: (n) => ASSET_RE.test(n),
        includeHd: true,
        onProgress: (d, t) => { status.textContent = `Indexing assets… ${d}/${t}`; },
      }).then((base) => base.extend(pak, (n) => ASSET_RE.test(n)));
      v.catch(() => vfsCache.delete(pakPath));
      vfsCache.set(pakPath, v);
    }
    vfs = await v;
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
    el("p", "scene-title", `${level}: ${terrain.size} × ${terrain.size} m terrain, ${objects.brushName.length.toLocaleString()} brushes, ${objects.vegGroup.length.toLocaleString()} vegetation instances`),
    canvas,
    el("p", "dim", "Click the view, then: drag to look · WASD/arrows move · Q/E or Space/C down/up · Shift = fast"),
    hud,
  );
  const ctx = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });
  const renderer = new TerrainRenderer(device, format, terrain);
  const models = new ModelRenderer(device, format, 4);
  let depth: GPUTexture | null = null;
  let msaa: GPUTexture | null = null;
  let streamedAt: [number, number] | null = null;
  let streaming = false;
  let sceneInfo = "objects: loading…";
  const stream = async () => {
    if (streaming) return;
    streaming = true;
    const at: [number, number] = [cam.pos[0], cam.pos[1]];
    try {
      const scene = await buildWorldScene(vfs, terrain, objects, at, STREAM_RADIUS, {
        maxModels: 400, maxTextureDim: 256, cache: modelCache,
        onStatus: (s) => { sceneInfo = s; },
      });
      if (stopped) return;
      models.setModels(scene.items);
      streamedAt = at;
      sceneInfo = `objects within ${STREAM_RADIUS} m: ${scene.modelsLoaded} models, ${scene.instances.toLocaleString()} instances${scene.modelsSkipped ? ` (${scene.modelsSkipped} more models over the cap)` : ""}`;
    } catch (err) {
      sceneInfo = `objects: ${(err as Error).message}`;
    } finally {
      streaming = false;
    }
  };
  let stopped = false;
  // start just south of Rataje town (centre of its brushes is around 2190, 1300), looking north
  const cx = 2192, cy = 1050;
  const cam: FlyCamera = { pos: [cx, cy, heightAt(terrain, cx, cy) + 60], yaw: Math.PI / 2, pitch: -0.25 };

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
    if (!streamedAt || Math.hypot(cam.pos[0] - streamedAt[0], cam.pos[1] - streamedAt[1]) > STREAM_STEP) void stream();
    const target = ctx.getCurrentTexture();
    if (!depth || depth.width !== target.width || depth.height !== target.height) {
      depth?.destroy();
      msaa?.destroy();
      depth = device.createTexture({ size: [target.width, target.height], format: "depth24plus", sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      msaa = device.createTexture({ size: [target.width, target.height], format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    const vp = TerrainRenderer.viewProj(cam, target.width / target.height);
    renderer.prepare(cam, vp);
    models.setCamera(vp, cam.pos, [0.45, 0.25, 0.85]);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: msaa!.createView(), resolveTarget: target.createView(), clearValue: { r: 0.55, g: 0.62, b: 0.70, a: 1 }, loadOp: "clear", storeOp: "discard" }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    });
    renderer.draw(pass);
    models.draw(pass);
    pass.end();
    device.queue.submit([enc.finish()]);
    hud.textContent = `x ${cam.pos[0].toFixed(0)}  y ${cam.pos[1].toFixed(0)}  z ${cam.pos[2].toFixed(0)} m (ground ${ground.toFixed(1)}) · terrain ${(renderer.stats.triangles / 1e6).toFixed(2)}M + objects ${(models.stats.triangles / 1e6).toFixed(1)}M triangles · ${sceneInfo}`;
  };
  raf = requestAnimationFrame(frame);
  canvas.focus();

  stopActive = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    models.destroy();
    depth?.destroy();
    msaa?.destroy();
    ro.disconnect();
    renderer.destroy();
    ctx.unconfigure();
    device.destroy();
  };
}
