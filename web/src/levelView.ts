// World view: loads a level's compiled terrain and lets you fly over it.
// Mouse drag: look · WASD / arrows: move · Q/E or Space/C: down/up · Shift: fast.

import { readCentralDirectory, readEntry } from "./zip.ts";
import { parseTerrain, heightAt, type Terrain } from "./terrain.ts";
import { TerrainRenderer, type FlyCamera } from "./terrainRenderer.ts";
import type { PakSource } from "./paks.ts";
import { parseLevelObjects, type LevelObjects } from "./levelObjects.ts";
import { parseCover, type Cover } from "./cover.ts";
import { ModelRenderer } from "./renderer.ts";
import { WaterRenderer } from "./waterRenderer.ts";
import { buildWorldScene, lodItems, newWorldCaches, selectLods, type WorldScene } from "./world.ts";
import { Vfs } from "./vfs.ts";
import { parseNpcEntities, parseEntityIndex, propEntities, type EntityInfo, type NpcEntity } from "./levelEntities.ts";
import { Schedules } from "./schedule.ts";
import { NpcWorld, npcItems, animateNpcs, type WorldNpc } from "./npcs.ts";
import { ASSET_RE } from "./assets.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let stopActive: (() => void) | null = null;
const terrainCache = new Map<string, Promise<{ terrain: Terrain; objects: LevelObjects; cover?: Cover; npcEntities: NpcEntity[]; schedules: Schedules; props: EntityInfo[] }>>();
const vfsCache = new Map<string, Promise<Vfs>>();
const worldCaches = newWorldCaches();
const STREAM_RADIUS = 500; // metres of objects around the camera
const STREAM_STEP = 150; // rebuild after moving this far
const NPC_RADIUS = 120, NPC_MAX = 40;
const SPEEDS: [string, number][] = [["paused", 0], ["×15 (game speed)", 15], ["×60", 60], ["×720 (1 h per 5 s)", 720]];

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
  let cover: Cover | undefined;
  let npcEntities: NpcEntity[];
  let schedules: Schedules;
  let props: EntityInfo[];
  let vfs: Vfs;
  let device: GPUDevice;
  try {
    let p = terrainCache.get(pakPath);
    if (!p) {
      p = (async () => {
        const blob = await pak.open();
        const entries = await readCentralDirectory(blob);
        const entry = entries.find((e) => e.name.toLowerCase() === "terrain/terrain.dat");
        const ctc = entries.find((e) => e.name.toLowerCase() === "terrain/cover.ctc");
        if (!entry) throw new Error("terrain/terrain.dat not found in the level pak");
        status.textContent = `Reading terrain (${Math.round(entry.usize / 2 ** 20)} MiB)…`;
        const bytes = await readEntry(blob, entry);
        status.textContent = "Decoding heightmap and object octree…";
        await new Promise((r) => setTimeout(r, 0));
        const terrain = parseTerrain(bytes);
        const objects = parseLevelObjects(bytes, terrain.objectsOffset);
        status.textContent = "Reading terrain colour…";
        const cover = ctc ? parseCover(await readEntry(blob, ctc), terrain.size) : undefined;
        const mission = entries.find((e) => e.name.toLowerCase() === "objects_mission0.xml");
        status.textContent = "Reading entities (NPCs, furniture)…";
        const xml = mission ? new TextDecoder().decode(await readEntry(blob, mission)) : "";
        const npcEntities = parseNpcEntities(xml);
        const ents = parseEntityIndex(xml);
        const schedules = new Schedules(npcEntities, ents);
        return { terrain, objects, cover, npcEntities, schedules, props: propEntities(ents) };
      })();
      p.catch(() => terrainCache.delete(pakPath));
      terrainCache.set(pakPath, p);
    }
    ({ terrain, objects, cover, npcEntities, schedules, props } = await p);
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
    device = await adapter.requestDevice({ requiredFeatures: adapter.features.has("texture-compression-bc") ? ["texture-compression-bc"] : [] });
  } catch (err) {
    host.replaceChildren(el("p", "error", (err as Error).message));
    return;
  }

  const canvas = el("canvas", "model-canvas level-canvas");
  canvas.tabIndex = 0;
  const hud = el("p", "note level-hud");
  const stage = el("div", "level-stage");
  const fullBtn = el("button", "level-full-btn", "⛶ Full window");
  fullBtn.type = "button";
  const marketBtn = el("button", "level-full-btn level-goto-btn", "Go to Rataje market");
  marketBtn.type = "button";
  // game clock: time of day drives where NPCs are (their schedules)
  const clockBar = el("div", "level-clock");
  const clockLabel = el("span", "level-clock-time");
  const clockRange = el("input");
  clockRange.type = "range";
  clockRange.min = "0";
  clockRange.max = "1439";
  clockRange.step = "1";
  const speedSel = el("select");
  for (const [label, v] of SPEEDS) speedSel.append(new Option(label, String(v), v === 15, v === 15));
  clockBar.append(el("span", "dim", "Time"), clockLabel, clockRange, speedSel);
  stage.append(canvas, fullBtn, marketBtn, clockBar, hud);
  host.replaceChildren(
    el("p", "scene-title", `${level}: ${terrain.size} × ${terrain.size} m terrain, ${objects.brushName.length.toLocaleString()} brushes, ${objects.vegGroup.length.toLocaleString()} vegetation instances`),
    stage,
    el("p", "dim", "Click the view, then: drag to look · WASD/arrows move · Q/E or Space/C down/up · Shift = fast · Esc leaves full window"),
  );
  const setFull = (on: boolean) => {
    stage.classList.toggle("full", on);
    fullBtn.textContent = on ? "✕ Exit full window" : "⛶ Full window";
    canvas.focus();
  };
  fullBtn.addEventListener("click", () => setFull(!stage.classList.contains("full")));
  marketBtn.addEventListener("click", () => {
    // Rataje's market under the town wall, looking south at a guard by the stalls
    cam.pos = [2577.8, 574, 83.8];
    cam.yaw = -Math.PI / 2;
    cam.pitch = -0.21;
    canvas.focus();
  });
  canvas.addEventListener("keydown", (e) => { if (e.code === "Escape") setFull(false); });
  const ctx = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });
  const renderer = new TerrainRenderer(device, format, terrain, cover);
  const models = new ModelRenderer(device, format, 4);
  const water = new WaterRenderer(device, format, objects.water);
  const npcR = new ModelRenderer(device, format, 4);
  const npcWorld = new NpcWorld(vfs, npcEntities, schedules, (x, y) => heightAt(terrain, x, y));
  let npcs: WorldNpc[] = [];
  let npcKey = "";
  let npcBusy = false;
  let npcCheckedAt = -Infinity;
  let npcInfo = `NPCs: ${npcEntities.length} in level`;
  let minute = 10 * 60; // game time of day, minutes
  clockRange.value = String(minute);
  clockRange.addEventListener("input", () => { minute = Number(clockRange.value); npcCheckedAt = -Infinity; });
  // re-place NPCs when the set around the camera (or where they are) changes
  const updateNpcs = async () => {
    if (npcBusy) return;
    npcBusy = true;
    const at: [number, number, number] = [...cam.pos];
    const m = Math.floor(minute);
    try {
      const key = NpcWorld.key(await npcWorld.select(at, NPC_RADIUS, NPC_MAX, m));
      if (key === npcKey || stopped) return;
      const next = await npcWorld.near(at, NPC_RADIUS, NPC_MAX, m, (s) => { npcInfo = s; });
      if (stopped) return;
      npcR.setModels(npcItems(next));
      npcs = next;
      npcKey = key;
      npcInfo = `${next.length} NPCs within ${NPC_RADIUS} m`;
    } catch (err) {
      npcInfo = `NPCs: ${(err as Error).message}`;
    } finally {
      npcBusy = false;
    }
  };
  let depth: GPUTexture | null = null;
  let msaa: GPUTexture | null = null;
  let streamedAt: [number, number] | null = null;
  let streaming = false;
  let sceneInfo = "objects: loading…";
  let scene: WorldScene | null = null;
  let lodOut: Float32Array[] = [];
  let lodCounts: number[] = [];
  let lodInfo = "";
  const stream = async () => {
    if (streaming) return;
    streaming = true;
    const at: [number, number] = [cam.pos[0], cam.pos[1]];
    try {
      const next = await buildWorldScene(vfs, terrain, objects, at, STREAM_RADIUS, {
        maxModels: 1500, maxTextureDim: 256, caches: worldCaches, props,
        onStatus: (s) => { sceneInfo = s; },
      });
      if (stopped) return;
      const items = lodItems(next);
      models.setModels(items);
      lodOut = items.map((it) => new Float32Array(it.capacity * 16));
      lodCounts = items.map(() => 0);
      scene = next;
      streamedAt = at;
      sceneInfo = `${next.models.length} models, ${next.instances.toLocaleString()} instances within ${STREAM_RADIUS} m${next.modelsSkipped ? ` (${next.modelsSkipped} more models over the cap)` : ""}`;
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
    minute = (minute + (dt * Number(speedSel.value)) / 60) % 1440;
    const hh = Math.floor(minute / 60), mm = Math.floor(minute % 60);
    clockLabel.textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    if (document.activeElement !== clockRange) clockRange.value = String(Math.floor(minute));
    if (streamedAt && now - npcCheckedAt > 500) { npcCheckedAt = now; void updateNpcs(); }
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
    water.setCamera(vp, cam.pos, [0.45, 0.25, 0.85]);
    npcR.setCamera(vp, cam.pos, [0.45, 0.25, 0.85]);
    animateNpcs(npcs, npcWorld, minute, now / 1000, npcR);
    if (scene) {
      const st = selectLods(scene, cam.pos, vp, lodOut, lodCounts);
      lodCounts.forEach((n, k) => models.setInstances(k, lodOut[k], n));
      lodInfo = ` · drawing ${st.drawn.toLocaleString()} (LOD ${st.perLod.map((n) => n ?? 0).join("/")}), culled ${st.culledDistance.toLocaleString()} by distance, ${st.culledFrustum.toLocaleString()} off-screen`;
    }
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: msaa!.createView(), resolveTarget: target.createView(), clearValue: { r: 0.55, g: 0.62, b: 0.70, a: 1 }, loadOp: "clear", storeOp: "discard" }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    });
    renderer.draw(pass);
    models.draw(pass);
    npcR.draw(pass);
    water.draw(pass);
    pass.end();
    device.queue.submit([enc.finish()]);
    hud.textContent = `x ${cam.pos[0].toFixed(0)}  y ${cam.pos[1].toFixed(0)}  z ${cam.pos[2].toFixed(0)} m (ground ${ground.toFixed(1)}) · terrain ${(renderer.stats.triangles / 1e6).toFixed(2)}M + objects ${(models.stats.triangles / 1e6).toFixed(2)}M triangles · ${sceneInfo}${lodInfo} · ${npcInfo}${npcs.length ? ` (${npcs.filter((n) => n.placement.pose === "walk").length} walking, ${npcs.filter((n) => n.placement.pose === "sleep").length} asleep)` : ""}`;
  };
  raf = requestAnimationFrame(frame);
  canvas.focus();

  stopActive = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    models.destroy();
    npcR.destroy();
    water.destroy();
    depth?.destroy();
    msaa?.destroy();
    ro.disconnect();
    renderer.destroy();
    ctx.unconfigure();
    device.destroy();
  };
}
