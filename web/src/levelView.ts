// World view: loads a level's compiled terrain and lets you walk it as Henry, or fly over it.
// Player: click to capture the mouse · WASD move · Shift sprint · X walk/run · Space jump ·
// V first / third person (mouse wheel: camera distance).
// F: free-fly (debug): mouse drag look · WASD / arrows move · Q/E or Space/C down/up · Shift fast ·
// T puts Henry under the fly camera.

import { heightAt, type Terrain } from "./terrain.ts";
import { FOV_Y, TerrainRenderer, type FlyCamera } from "./terrainRenderer.ts";
import type { PakSource } from "./paks.ts";
import type { LevelObjects } from "./levelObjects.ts";
import type { Cover } from "./cover.ts";
import { MergedMeshes } from "./mergedMeshes.ts";
import { Roads } from "./roads.ts";
import { Decals } from "./decals.ts";
import { FarTrees } from "./farTrees.ts";
import { setAssetPackage, setGpuBlockCompression } from "./model.ts";
import { ModelRenderer } from "./renderer.ts";
import { TexturePool } from "./texturePool.ts";
import { WaterRenderer } from "./waterRenderer.ts";
import { buildGrassScene, buildWorldScene, isUberLod, lodItems, newWorldCaches, sceneMatrices, selectLods, trimWorldCaches, type WorldScene } from "./world.ts";
import { Vfs } from "./vfs.ts";
import type { EntityInfo, NpcEntity } from "./levelEntities.ts";
import { Schedules } from "./schedule.ts";
import { NpcWorld, npcItems, animateNpcs, updateAi, type WorldNpc } from "./npcs.ts";
import { createAiWorld } from "./btWorld.ts";
import { NpcAi } from "./npcAi.ts";
import { AnimLibrary } from "./mannequin.ts";
import { LuaHost } from "./luaHost.ts";
// served by Vite with the app (never the package's CDN default)
import luaWasm from "wasmoon-lua5.1/dist/liblua5.1.wasm?url";
import { PlayerAvatar } from "./playerAvatar.ts";
import { PlayerSession } from "./playerSession.ts";
import { CollisionWorld } from "./collision.ts";
import { Doors, type Door } from "./doors.ts";
import { Chests, type Chest } from "./chests.ts";
import { Localization } from "./localization.ts";
import { DialogueHost } from "./dialogueView.ts";
import { DialogueCameraRig, SHOTS, type Shot } from "./dialogueCamera.ts";
import { Beds, sleepMinutes, WAKE_MINUTE, type Bed } from "./beds.ts";
import { depthClear, depthFormat, type PassSetup } from "./mat4.ts";
import type { TimeOfDay } from "./tod.ts";
import { SkyRenderer, skyAt, pickProfile, invert } from "./sky.ts";
import { PRESETS, savedPreset, savePreset, type PresetName } from "./quality.ts";
import { loadDetailLayers } from "./terrainDetail.ts";
import { levelData, levelVfs } from "./levelData.ts";
import { openSlim } from "./slimView.ts";
import { ShadowMap } from "./shadow.ts";
import { ShadowCasters } from "./shadowPass.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let stopActive: (() => void) | null = null;
// model caches per texture size (presets load textures at different sizes)
const worldCaches = new Map<number, ReturnType<typeof newWorldCaches>>();
const NPC_RADIUS = 120;
const SPEEDS: [string, number][] = [["paused", 0], ["×15 (game speed)", 15], ["×60", 60], ["×720 (1 h per 5 s)", 720]];
/** Where Henry starts: Rataje's market, under the town wall, facing south; `?at=x,y[,yaw°]` in the address moves it (debugging). */
const SPAWN_AT = (typeof location !== "undefined" ? new URLSearchParams(location.search).get("at") : null)?.split(",").map(Number).filter(Number.isFinite);
const SPAWN: [number, number, number] = SPAWN_AT && SPAWN_AT.length >= 2 ? [SPAWN_AT[0], SPAWN_AT[1], 0] : [2577.8, 574, 0];
const SPAWN_YAW = SPAWN_AT && SPAWN_AT.length >= 3 ? (SPAWN_AT[2] * Math.PI) / 180 : -Math.PI / 2;
/** Time between drawn frames while the world is loading (ms): about 15 fps. */
const LOADING_FRAME = 66;

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
  let ents: Map<number, EntityInfo>;
  let hiddenLayers: Set<number>;
  let tod: TimeOfDay | null;
  let surfaceTypes: Map<number, string>;
  let merged: MergedMeshes;
  let roads: Roads;
  let decals: Decals;
  let vfs: Vfs;
  let device: GPUDevice;
  try {
    ({ terrain, objects, cover, npcEntities, schedules, props, ents, hiddenLayers, tod, surfaceTypes, merged, roads, decals } = await levelData(paks, level, (m) => { status.textContent = m; }));
    vfs = await levelVfs(paks, level, (m) => { status.textContent = m; });
    if (!navigator.gpu) throw new Error("WebGPU is not available in this browser (chrome://flags/#enable-unsafe-webgpu).");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter.");
    device = await adapter.requestDevice({ requiredFeatures: (["texture-compression-bc", "indirect-first-instance"] as GPUFeatureName[]).filter((f) => adapter.features.has(f)) });
    setGpuBlockCompression(device.features.has("texture-compression-bc"));
  } catch (err) {
    host.replaceChildren(el("p", "error", (err as Error).message));
    return;
  }

  // WebGPU failures were silent (a black view): the first errors go to the console and the HUD
  let gpuProblem = "";
  let gpuErrors = 0;
  const gpuDevice = device;
  const onGpuError = (e: Event) => {
    const msg = (e as GPUUncapturedErrorEvent).error.message;
    if (gpuErrors++ < 5) console.error("WebGPU:", msg);
    if (!gpuProblem) gpuProblem = `GPU error: ${msg.split("\n")[0]}`;
  };
  gpuDevice.addEventListener("uncapturederror", onGpuError);
  void gpuDevice.lost.then((info) => {
    console.error("WebGPU device lost:", info.reason, info.message);
    gpuProblem = `GPU device lost (${info.reason}): ${info.message}`;
  });

  const presetName = savedPreset();
  const q = PRESETS[presetName];
  const STREAM_RADIUS = q.streamRadius; // metres of objects around the camera
  const STREAM_STEP = q.streamRadius * 0.3; // rebuild after moving this far
  const NPC_MAX = q.npcMax;
  let caches = worldCaches.get(q.maxTextureDim);
  if (!caches) worldCaches.set(q.maxTextureDim, (caches = newWorldCaches()));
  // the compact package, when one is built (docs/SLIM.md): the world's models from it, read and
  // decoded on the read workers; Potato prefers its own variant
  if (!caches.slim) caches.slim = (await openSlim(presetName === "potato" ? "potato" : "full", vfs.workers ?? undefined).catch((err) => { console.warn("compact package:", err); return null; })) ?? undefined;
  // (and every other model and texture load: characters, props, the far field, terrain detail)
  setAssetPackage(caches.slim ?? null);
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
  // quality preset (changing it rebuilds the view: MSAA is baked into the pipelines)
  const presetSel = el("select", "level-preset");
  for (const [k, v] of Object.entries(PRESETS)) presetSel.append(new Option(`Quality: ${v.label}`, k, k === presetName, k === presetName));
  presetSel.addEventListener("change", () => { savePreset(presetSel.value as PresetName); void showLevel(host, paks, level); });
  clockBar.append(presetSel);
  // debug: play a dialogue sequence by id with the NPCs around Henry (how conversations start
  // waits for a research note); 46319 is the tailor's gossip about the baths
  const dlgId = el("input", "level-dialogue-id");
  dlgId.type = "number";
  dlgId.value = "46319";
  dlgId.title = "Dialogue sequence id (debug)";
  const dlgBtn = el("button", undefined, "▶ Dialogue");
  dlgBtn.type = "button";
  // debug: the dialogue camera's shot while a dialogue plays (which shot a line uses waits for a
  // research note): the rig on Henry, framing the NPC who spoke last
  const shotSel = el("select", "level-dialogue-shot");
  shotSel.title = "Dialogue camera shot (debug)";
  for (const s of ["off", ...SHOTS]) shotSel.append(new Option(s === "off" ? "Camera: normal" : `Camera: ${s}`, s));
  clockBar.append(dlgId, dlgBtn, shotSel);
  let cameraRig: Promise<DialogueCameraRig | null> | null = null;
  let rig: DialogueCameraRig | null = null;
  /** Henry's view before the dialogue camera took over (it shows his head, so third person meanwhile) */
  let viewBeforeShot: "first" | "third" | null = null;
  shotSel.addEventListener("change", () => {
    cameraRig ??= DialogueCameraRig.load(vfs).catch((err) => { console.warn("dialogue camera:", err); return null; });
    void cameraRig.then((r) => { rig = r; });
    canvas.focus();
  });
  // an open chest's contents
  const chestPanel = el("div", "level-chest");
  chestPanel.hidden = true;
  const fade = el("div", "level-fade");
  // what E does at the door, chest or bed Henry faces
  const prompt = el("div", "level-prompt");
  prompt.hidden = true;
  let promptText = "";
  const dialogue = new DialogueHost(vfs, paks);
  let dialogueInfo = "";
  stage.append(canvas, fullBtn, marketBtn, clockBar, hud, chestPanel, prompt, dialogue.subtitle, fade);
  host.replaceChildren(
    el("p", "scene-title", `${level}: ${terrain.size} × ${terrain.size} m terrain, ${objects.brushName.length.toLocaleString()} brushes, ${objects.vegGroup.length.toLocaleString()} vegetation instances`),
    stage,
    el("p", "dim", "Click the view to walk as Henry: mouse look · WASD move · Shift sprint · X walk/run · Space jump · V first/third person (wheel zooms) · F free-fly (drag to look, Q/E down/up, T puts Henry there) · Esc releases the mouse"),
  );
  const setFull = (on: boolean) => {
    stage.classList.toggle("full", on);
    fullBtn.textContent = on ? "✕ Exit full window" : "⛶ Full window";
    canvas.focus();
  };
  fullBtn.addEventListener("click", () => setFull(!stage.classList.contains("full")));
  marketBtn.addEventListener("click", () => {
    // Rataje's market under the town wall, looking south at a guard by the stalls
    if (player && mode === "player") {
      player.controller.pos = [SPAWN[0], SPAWN[1], heightAt(terrain, SPAWN[0], SPAWN[1])];
      player.controller.vel = [0, 0, 0];
    } else {
      cam.pos = [2577.8, 574, 83.8];
      cam.yaw = -Math.PI / 2;
      cam.pitch = -0.21;
    }
    canvas.focus();
  });
  canvas.addEventListener("keydown", (e) => { if (e.code === "Escape") setFull(false); });
  const ctx = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });
  // reversed-Z: the first-person view needs a 1 cm near plane (Henry's own body) and the horizon
  const passSetup: PassSetup = { sampleCount: q.msaa, reversedZ: true };
  const renderer = new TerrainRenderer(device, format, terrain, cover, passSetup, undefined, { detailFade: q.detailFade });
  // sun shadows (none on Potato)
  const shadowMap = q.shadows.cascades ? new ShadowMap(device, q.shadows.size, q.shadows.cascades, q.shadows.splits) : null;
  const casters = new ShadowCasters();
  renderer.setShadow(shadowMap);
  // the ground's detail layers (grass, soil, cobbles…) decode in the background
  void loadDetailLayers(vfs, surfaceTypes, q.terrainDetail).then((d) => { if (!stopped) renderer.setDetail(d); }).catch((err) => console.warn("terrain detail:", err));
  // textures shared by the object, grass, NPC and player renderers, sharper for what is near
  const pool = new TexturePool(device, vfs, { budget: q.textures.budgetMiB * 2 ** 20, maxDim: q.textures.maxDim });
  // (instance indices: the scene's matrices go up once per streaming step, see ModelRenderer.indexed)
  const models = new ModelRenderer(device, format, passSetup.sampleCount, { ...passSetup, pool, instanceIndices: true });
  // grass and ground plants (merged-mesh sectors): a small scene of their own around the camera,
  // rebuilt every few metres, with sharper textures than other objects (thin blades in atlases)
  const grassR = new ModelRenderer(device, format, passSetup.sampleCount, { ...passSetup, pool });
  const grassCaches = newWorldCaches();
  let grass: { at: [number, number]; scene: WorldScene; out: Float32Array[]; counts: number[] } | null = null;
  let grassBusy = false;
  const streamGrass = async () => {
    if (grassBusy || !q.grass) return;
    grassBusy = true;
    const at: [number, number] = [cam.pos[0], cam.pos[1]];
    try {
      const next = await buildGrassScene(vfs, terrain, merged, at, q.grass, { caches: grassCaches, maxTextureDim: Math.min(1024, q.maxTextureDim * 4), normalMaps: q.normalMaps });
      if (stopped) return;
      const items = lodItems(next);
      grassR.setModels(items);
      grassR.setShadow(shadowMap);
      grass = { at, scene: next, out: items.map((it) => new Float32Array(it.capacity * 16)), counts: items.map(() => 0) };
      trimWorldCaches(grassCaches, 8);
    } catch (err) {
      console.warn("grass:", err);
    } finally {
      grassBusy = false;
    }
  };
  const water = new WaterRenderer(device, format, objects.water, passSetup);
  void water.loadMaterials(vfs, terrain.materials).catch((err) => console.warn("water:", err));
  const npcR = new ModelRenderer(device, format, passSetup.sampleCount, { ...passSetup, pool });
  const playerR = new ModelRenderer(device, format, passSetup.sampleCount, { ...passSetup, pool });
  // the far field: every town's uber-LOD (94 in Rataje), drawn beyond the streamed objects
  const farR = new ModelRenderer(device, format, passSetup.sampleCount, { ...passSetup, pool });
  let far: { scene: WorldScene; out: Float32Array[]; counts: number[] } | null = null;
  void buildWorldScene(vfs, terrain, objects, [terrain.size / 2, terrain.size / 2], terrain.size, {
    maxModels: 1000, maxTextureDim: q.maxTextureDim, caches: newWorldCaches(), hiddenLayers, normalMaps: false, onlyBrushes: isUberLod,
  }).then((scene) => {
    if (stopped) return;
    const items = lodItems(scene);
    farR.setModels(items);
    far = { scene, out: items.map((it) => new Float32Array(it.capacity * 16)), counts: items.map(() => 0) };
  }).catch((err) => console.warn("far field:", err));
  // every tree beyond the streamed ones, as cards (built in the background: a second or two)
  const farTrees = new FarTrees(device, format, passSetup);
  void farTrees.build(vfs, terrain, objects, { maxTextureDim: q.maxTextureDim }).catch((err) => console.warn("far trees:", err));
  const sky = new SkyRenderer(device, format, passSetup);
  const todProfile = tod ? pickProfile(tod) : null;
  // Henry: the player character (loaded in the background; free-fly until then)
  let player: PlayerSession | null = null;
  let mode: "player" | "fly" = "fly";
  let playerInfo = "Henry: loading…";
  // terrain plus the streamed objects' collision geometry (physics proxies first, collision.ts)
  const surroundings = new CollisionWorld((x, y) => heightAt(terrain, x, y), terrain.size);
  // doors open and close (E): their instances move in the scene, their leaves collide (doors.ts)
  const doors = new Doors(vfs, props);
  doors.preload();
  /** doors whose leaf is in the collision world (those near Henry) */
  const doorColliders = new Set<number>();
  const showDoor = (id: number) => { for (const { index, m } of doors.matrices(id)) models.setSceneMatrix(index, m); };
  /** what E would do now (HUD hint), refreshed each frame */
  let doorHint: { door: Door; act: ReturnType<Doors["action"]> } | null = null;
  // chests open (E) and show what they hold (chests.ts); item names in English for now
  const chests = new Chests(vfs, props);
  const text = new Localization();
  void text.load(paks, ["text_ui_items"]).catch(() => false);
  const showChest = (id: number) => { for (const { index, m } of chests.matrices(id)) models.setSceneMatrix(index, m); };
  let chestHint: { chest: Chest; act: ReturnType<Chests["action"]> } | null = null;
  // beds: E sleeps until morning (beds.ts)
  const beds = new Beds(vfs, props);
  let bedHint: { bed: Bed; taken: boolean } | null = null;
  let sleeping = false;
  const sleepIn = (bed: Bed) => {
    if (!player || sleeping) return;
    sleeping = true;
    const hours = Math.round(sleepMinutes(minute) / 60);
    fade.textContent = `Sleeping until ${String(WAKE_MINUTE / 60).padStart(2, "0")}:00 (${hours} h)…`;
    fade.classList.add("on");
    setTimeout(() => {
      // asleep: the night passes, the town moves on, and Henry gets up beside the bed
      minute = WAKE_MINUTE;
      clockRange.value = String(minute);
      npcCheckedAt = -Infinity;
      const nav = schedules.navMesh;
      const spot = beds.wakeSpot(bed, nav ? (p) => { const hit = nav.findPoly(p, 0.4); return hit?.point && Math.abs(hit.point[2] - p[2]) < 0.8 ? hit.point[2] : null; } : undefined);
      if (player) {
        player.controller.pos = [...spot.pos];
        player.controller.vel = [0, 0, 0];
        player.controller.yaw = spot.yaw;
      }
    }, 700);
    setTimeout(() => { fade.classList.remove("on"); sleeping = false; }, 1900);
  };
  /** the chest whose contents are shown */
  let openChest: Chest | null = null;
  const fillChestPanel = async (c: Chest) => {
    const items = await chests.contents(c, text);
    if (openChest !== c) return;
    chestPanel.replaceChildren(el("h3", undefined, "Chest"));
    const list = el("ul");
    for (const it of items.filter((x) => !x.maybe)) list.append(el("li", undefined, `${it.name} ×${it.amount}`));
    const maybe = items.filter((x) => x.maybe);
    if (maybe.length) {
      const li = el("li", "maybe", `and perhaps some of: ${maybe.slice(0, 12).map((x) => x.name).join(", ")}${maybe.length > 12 ? `, … (${maybe.length} kinds)` : ""}`);
      list.append(li);
    }
    chestPanel.append(items.length ? list : el("p", undefined, "Empty."), el("p", "note", "Taking items comes with the inventory."));
    chestPanel.hidden = false;
  };
  const closeChest = () => {
    if (openChest && chests.action(openChest) === "close") chests.use(openChest);
    openChest = null;
    chestPanel.hidden = true;
  };
  /** Henry stepping back out of a door's swing over STEP_ASIDE seconds (doors.ts clearSpot) */
  let stepAside: { from: number[]; to: number[]; t: number } | null = null;
  const STEP_ASIDE = 0.6;
  void PlayerAvatar.load(vfs, { maxTextureDim: Math.max(256, q.maxTextureDim) }).then((avatar) => {
    if (stopped) return;
    player = new PlayerSession(surroundings, avatar, SPAWN, SPAWN_YAW);
    playerR.setModels(avatar.renderItems());
    playerR.setShadow(shadowMap);
    mode = "player";
    playerInfo = "";
  }).catch((err) => { playerInfo = `Henry: ${(err as Error).message}`; });
  const npcWorld = new NpcWorld(vfs, npcEntities, schedules, (x, y) => heightAt(terrain, x, y));
  dlgBtn.addEventListener("click", () => {
    // the cast: NPCs within 30 m of Henry (or the camera), nearest first
    const at = player && mode === "player" ? player.controller.pos : cam.pos;
    const near = npcs
      .map((n) => { const p = (npcWorld.drawn(n.entity.id) ?? n.placement).pos; return { n, d: Math.hypot(p[0] - at[0], p[1] - at[1]) }; })
      .filter((x) => x.d < 30)
      .sort((a, b) => a.d - b.d);
    dialogueInfo = "Loading the dialogue tables…";
    void dialogue.play(Number(dlgId.value), near.map((x) => x.n.soul))
      .then((s) => { dialogueInfo = s; })
      .catch((err) => { dialogueInfo = `Dialogue: ${(err as Error).message}`; });
    canvas.focus();
  });
  // NPCs stand on the same surfaces as Henry: within 0.5 m up (steps) and 1.5 m down of their planned height,
  // else up to 1 m up (navmesh routes run up to 0.85 m under the ground in places)
  npcWorld.surface = (x, y, z) => (surroundings.ground(x, y, z + 0.5, z - 1.5) ?? surroundings.ground(x, y, z + 1, z - 1.5))?.z ?? null;
  // behaviour trees for NPCs at work (loaded in the background: ~1 s of tree parsing)
  let npcAi: NpcAi | null = null;
  void (async () => {
    // Lua 5.1 with the game's scripts (Scripts/main.lua) for the trees' Lua code
    const lua = await LuaHost.create(vfs, luaWasm);
    await lua.preload();
    await lua.preloadTables();
    const w = await createAiWorld(vfs, {
      ents, lua, realTime: () => npcAi?.now ?? 0, worldTime: () => (npcAi?.now ?? 0) * 15, act: (a) => npcAi?.act(a) ?? 1,
    });
    if (!lua.boot()) console.warn("Lua start-up:", lua.errors.slice(0, 3));
    return w;
  })().then((w) => {
    if (stopped) return;
    npcAi = new NpcAi(w, { male: new AnimLibrary(vfs, "male"), female: new AnimLibrary(vfs, "female") });
    npcAi.nav = schedules.navMesh;
    npcWorld.ai = npcAi;
    npcCheckedAt = -Infinity;
  }).catch((err) => console.warn("behaviour trees:", err));
  let npcs: WorldNpc[] = [];
  let npcKey = "";
  let npcBusy = false;
  let npcCheckedAt = -Infinity;
  // NPCs (loading them, their behaviour trees, crowd and animation) wait until the first streamed
  // scene is complete: running them meanwhile took about half the main thread while the market loaded
  let worldLoading = true;
  /** the first NPCs have been assembled (until then frames stay capped too, see LOADING_FRAME) */
  let npcsLoaded = false;
  let npcInfo = `NPCs: ${npcEntities.length} in level`;
  let minute = 10 * 60; // game time of day, minutes
  let simSeconds = 0; // simulation clock (real seconds at ×15)
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
      updateAi(npcs, npcWorld, m);
      if (key === npcKey || stopped) return;
      const next = await npcWorld.near(at, NPC_RADIUS, NPC_MAX, m, (s) => { npcInfo = s; });
      if (stopped) return;
      npcR.setModels(npcItems(next));
      npcR.setShadow(shadowMap);
      npcs = next;
      npcsLoaded = true;
      npcKey = key;
      npcInfo = `${next.length} NPCs within ${NPC_RADIUS} m`;
    } catch (err) {
      npcInfo = `NPCs: ${(err as Error).message}`;
      npcsLoaded = true;
    } finally {
      npcBusy = false;
    }
  };
  let depth: GPUTexture | null = null;
  // (one view for the texture's life: the water's bind group holds it)
  let depthView: GPUTextureView | null = null;
  let msaa: GPUTexture | null = null;
  let streamedAt: [number, number] | null = null;
  let streaming = false;
  let sceneInfo = "objects: loading…";
  let scene: WorldScene | null = null;
  let lodOut: (Float32Array | Uint32Array)[] = [];
  let lodCounts: number[] = [];
  let lodInfo = "";
  const stream = async () => {
    if (streaming) return;
    streaming = true;
    const at: [number, number] = [cam.pos[0], cam.pos[1]];
    try {
      // two passes: the nearest models first (shown quickly), then everything in range; the second
      // pass reuses the first one's loaded models from the cache (the old 1,500-model cap left
      // dense towns like Rattay missing floors and walls, with their props floating)
      // (at later positions the old scene stays up until the complete one is ready: replacing it
      // with the quick pass made every building beyond the nearest 800 models blink out)
      for (const maxModels of scene ? [20000] : [800, 20000]) {
        const next = await buildWorldScene(vfs, terrain, objects, at, STREAM_RADIUS, {
          maxModels, maxTextureDim: q.maxTextureDim, caches, props, hiddenLayers, normalMaps: q.normalMaps, ground: [roads, decals],
          onStatus: (s) => { sceneInfo = s; },
        });
        if (stopped) return;
        const items = lodItems(next);
        // new meshes' geometry goes up a few milliseconds a frame first; setModels then reuses it
        await models.prepare(items);
        if (stopped) return;
        models.setModels(items, models.indexed ? sceneMatrices(next) : undefined);
        models.setShadow(shadowMap);
        if (shadowMap) casters.setScene(next, items.map((it) => it.capacity), shadowMap.cascades, models.indexed);
        surroundings.setScene(next);
        for (const id of doors.attach(next)) showDoor(id);
        for (const id of chests.attach(next)) showChest(id);
        for (const id of doorColliders) surroundings.setDynamic(id, null);
        doorColliders.clear();
        lodOut = items.map((it) => (models.indexed ? new Uint32Array(it.capacity) : new Float32Array(it.capacity * 16)));
        lodCounts = items.map(() => 0);
        scene = next;
        streamedAt = at;
        // forget what the last two positions' scenes (two builds each) didn't use
        trimWorldCaches(caches!, 4);
        sceneInfo = `${next.models.length} models, ${next.instances.toLocaleString()} instances within ${STREAM_RADIUS} m${next.modelsSkipped ? ` (loading ${next.modelsSkipped} more…)` : ""}`;
        if (!next.modelsSkipped) { worldLoading = false; break; }
      }
    } catch (err) {
      sceneInfo = `objects: ${(err as Error).message}`;
    } finally {
      streaming = false;
    }
  };
  let stopped = false;
  // start above Henry's spawn in Rattay's market, looking the way he will: the first streamed
  // scene is the one he needs (starting 600 m away streamed a whole scene there first, about
  // 100 s from the game folder before the market was complete)
  const cam: FlyCamera = { pos: [SPAWN[0], SPAWN[1], heightAt(terrain, SPAWN[0], SPAWN[1]) + 30], yaw: SPAWN_YAW, pitch: -0.4 };

  const keys = new Set<string>();
  canvas.addEventListener("keydown", (e) => {
    if (!e.repeat) {
      if (e.code === "KeyF" && player) {
        mode = mode === "player" ? "fly" : "player";
        if (mode === "fly") document.exitPointerLock?.();
      }
      if ((e.code === "KeyX" || e.code === "CapsLock") && player) player.walk = !player.walk;
      if (e.code === "KeyV" && player && mode === "player") player.setView(player.viewMode === "first" ? "third" : "first");
      // E: the chest Henry faces, else the door
      if (e.code === "KeyE" && player && mode === "player" && chestHint) {
        if (chestHint.act === "close") closeChest();
        else if (chests.use(chestHint.chest)) { openChest = chestHint.chest; void fillChestPanel(openChest); }
      } else if (e.code === "KeyE" && player && mode === "player" && !doorHint && bedHint && !bedHint.taken) {
        sleepIn(bedHint.bed);
      } else if (e.code === "KeyE" && player && mode === "player" && doorHint && doors.use(doorHint.door, player.controller.pos)) {
        const to = doors.clearSpot(doorHint.door, player.controller.pos);
        if (to) stepAside = { from: [...player.controller.pos], to, t: 0 };
      }
      if (e.code === "KeyT" && player && mode === "fly") {
        player.controller.pos = [cam.pos[0], cam.pos[1], cam.pos[2]];
        player.controller.vel = [0, 0, 0];
        player.controller.grounded = false;
        player.controller.yaw = cam.yaw;
        mode = "player";
      }
    }
    keys.add(e.code);
    e.preventDefault();
  });
  canvas.addEventListener("keyup", (e) => keys.delete(e.code));
  canvas.addEventListener("blur", () => keys.clear());
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.focus();
    if (mode === "player") {
      if (document.pointerLockElement !== canvas) void canvas.requestPointerLock?.();
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("wheel", (e) => {
    if (mode !== "player" || player?.viewMode !== "third") return;
    player.zoom(Math.sign(e.deltaY));
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener("pointermove", (e) => {
    if (mode === "player" && player && document.pointerLockElement === canvas) {
      player.look(-e.movementX * 0.0025, -e.movementY * 0.0025);
      return;
    }
    if (!drag) return;
    cam.yaw -= (e.clientX - drag.x) * 0.004;
    cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - (e.clientY - drag.y) * 0.004));
    drag = { x: e.clientX, y: e.clientY };
  });

  const ro = new ResizeObserver(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * q.renderScale;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  });
  ro.observe(canvas);

  let raf = 0;
  let last = 0;
  let fpsAvg = 16.7; // smoothed frame time, ms
  let cpuAvg = 0; // smoothed main-thread time per frame, ms (fps well below 1000 / cpu: the GPU is the limit)
  const frame = (now: number) => {
    const t0 = performance.now();
    raf = requestAnimationFrame(frame);
    // while the world and then the first NPCs load, a frame every LOADING_FRAME ms at most:
    // drawing the growing scene at full speed took about half the main thread from loading
    if ((worldLoading || !npcsLoaded) && last && now - last < LOADING_FRAME) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    if (last) fpsAvg += ((now - last) - fpsAvg) * 0.05;
    last = now;
    const doorsMoved = doors.step(dt);
    for (const id of doorsMoved) showDoor(id);
    for (const id of chests.step(dt)) showChest(id);
    dialogue.update(dt);
    if (mode === "player" && player) {
      player.update(dt, player.input(keys));
      if (stepAside) {
        // eased; collision still applies on his next update
        stepAside.t = Math.min(STEP_ASIDE, stepAside.t + dt);
        const k = stepAside.t / STEP_ASIDE, e = k * k * (3 - 2 * k), s = stepAside;
        player.controller.pos[0] = s.from[0] + (s.to[0] - s.from[0]) * e;
        player.controller.pos[1] = s.from[1] + (s.to[1] - s.from[1]) * e;
        if (k >= 1) stepAside = null;
      }
      Object.assign(cam, player.camera(dt));
      // the dialogue camera (debug shot choice): the rig on Henry, aimed by the NPC who spoke last
      const shot = shotSel.value as Shot | "off";
      const talker = shot !== "off" && rig && dialogue.partner ? npcs.find((n) => n.soul === dialogue.partner) : undefined;
      if (talker && !viewBeforeShot) { viewBeforeShot = player.viewMode; player.setView("third"); }
      if (!talker && viewBeforeShot) { player.setView(viewBeforeShot); viewBeforeShot = null; }
      if (talker && rig && shot !== "off") {
        const s = rig.place(player.controller.pos, player.controller.yaw, (npcWorld.drawn(talker.entity.id) ?? talker.placement).pos)[shot];
        const d = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
        cam.pos = [...s.eye];
        cam.yaw = Math.atan2(d[1], d[0]);
        cam.pitch = Math.atan2(d[2], Math.hypot(d[0], d[1]));
      }
      // keep a chase camera above the terrain
      const g = heightAt(terrain, cam.pos[0], cam.pos[1]);
      if (player.viewMode === "third" && cam.pos[2] < g + 0.3) cam.pos[2] = g + 0.3;
      player.avatar.upload(playerR);
      // doors: the one Henry faces (HUD hint, E), the moving ones, and the leaves near him colliding
      const feet = player.controller.pos;
      const fwd: [number, number, number] = [Math.cos(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch)];
      const target = doors.target(feet, cam.pos, fwd);
      doorHint = target ? { door: target, act: doors.action(target) } : null;
      const bed = beds.target(feet, cam.pos, fwd);
      bedHint = bed ? { bed, taken: npcs.some((n) => n.placement.pose === "sleep" && n.placement.bed?.id === bed.entity.id) } : null;
      const chest = chests.target(feet, cam.pos, fwd);
      chestHint = chest ? { chest, act: chest === openChest ? "close" : chests.action(chest) } : null;
      // walking away from an open chest closes it
      if (openChest && Math.hypot(openChest.entity.pos[0] - feet[0], openChest.entity.pos[1] - feet[1]) > openChest.useDistance + 0.5) closeChest();
      const near = new Set(doors.near(feet, 12));
      for (const id of doorColliders) if (!near.has(id)) { surroundings.setDynamic(id, null); doorColliders.delete(id); }
      // (a swinging leaf doesn't shove Henry: it collides again where it stops)
      for (const id of near) {
        if (doors.isMoving(id)) { if (doorColliders.delete(id)) surroundings.setDynamic(id, null); continue; }
        if (!doorColliders.has(id)) { surroundings.setDynamic(id, doors.collider(id)); doorColliders.add(id); }
      }
    } else {
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
      const g = heightAt(terrain, cam.pos[0], cam.pos[1]);
      if (cam.pos[2] < g + 1.7) cam.pos[2] = g + 1.7;
    }
    const ground = heightAt(terrain, cam.pos[0], cam.pos[1]);
    if (!canvas.width) return;
    if (!streamedAt || Math.hypot(cam.pos[0] - streamedAt[0], cam.pos[1] - streamedAt[1]) > STREAM_STEP) void stream();
    if (!grass || Math.hypot(cam.pos[0] - grass.at[0], cam.pos[1] - grass.at[1]) > q.grass / 4) void streamGrass();
    minute = (minute + (dt * Number(speedSel.value)) / 60) % 1440;
    // one simulation clock for behaviour trees and NPC animation, scaled like the game clock
    // (×15 = real time): legs keep pace with movement at every speed, and pausing freezes both
    const simDt = (dt * Number(speedSel.value)) / 15;
    simSeconds += simDt;
    if (!worldLoading) npcAi?.tick(simDt);
    const hh = Math.floor(minute / 60), mm = Math.floor(minute % 60);
    clockLabel.textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    if (document.activeElement !== clockRange) clockRange.value = String(Math.floor(minute));
    if (streamedAt && !worldLoading && now - npcCheckedAt > 500) { npcCheckedAt = now; void updateNpcs(); }
    const target = ctx.getCurrentTexture();
    if (!depth || depth.width !== target.width || depth.height !== target.height) {
      depth?.destroy();
      msaa?.destroy();
      depth = device.createTexture({ size: [target.width, target.height], format: depthFormat(passSetup), sampleCount: passSetup.sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      depthView = depth.createView();
      msaa = passSetup.sampleCount > 1 ? device.createTexture({ size: [target.width, target.height], format, sampleCount: passSetup.sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : null;
    }
    const vp = TerrainRenderer.viewProj(cam, target.width / target.height, { reversed: true, near: mode === "player" && player?.viewMode === "first" ? 0.01 : 0.1 });
    // streamed textures that finished loading go in before anything is drawn
    pool.setViewport(target.height, FOV_Y);
    pool.beginFrame();
    // day and night from the level's time of day at the game clock
    const skyState = todProfile ? skyAt(todProfile, minute / 60) : null;
    if (far) {
      const f = far;
      selectLods(f.scene, cam.pos, vp, f.out, f.counts, { uberNear: STREAM_RADIUS * 0.9 });
      f.counts.forEach((n, k) => farR.setInstances(k, f.out[k], n));
    }
    if (skyState) {
      models.lighting = npcR.lighting = playerR.lighting = farR.lighting = grassR.lighting = skyState.lighting;
      sky.update(invert(vp), cam.pos, skyState);
    }
    renderer.prepare(cam, vp, { lighting: skyState?.lighting, lodDistance: q.terrainLod });
    models.setCamera(vp, cam.pos);
    water.time = now / 1000;
    water.setCamera(vp, cam.pos, [0.45, 0.25, 0.85], undefined, skyState?.lighting, skyState?.horizon);
    npcR.setCamera(vp, cam.pos);
    playerR.setCamera(vp, cam.pos);
    farR.setCamera(vp, cam.pos);
    grassR.setCamera(vp, cam.pos);
    farTrees.setCamera(vp, cam.pos, skyState?.lighting ?? models.lighting, { center: streamedAt ?? [cam.pos[0], cam.pos[1]], radius: scene ? STREAM_RADIUS : 0, distanceScale: q.distanceScale });
    if (grass) {
      const g = grass;
      selectLods(g.scene, cam.pos, vp, g.out, g.counts, { maxDistance: q.grass, fade: [q.grass * 0.67, q.grass] });
      g.counts.forEach((n, k) => grassR.setInstances(k, g.out[k], n));
    }
    if (!worldLoading) {
      npcWorld.stepCrowd(npcs, minute, simDt);
      animateNpcs(npcs, npcWorld, minute, simSeconds, npcR, cam.pos);
    }
    if (scene) {
      const st = selectLods(scene, cam.pos, vp, lodOut, lodCounts, { lodScale: q.lodScale, distanceScale: q.distanceScale, indices: models.indexed });
      lodCounts.forEach((n, k) => models.setInstances(k, lodOut[k], n));
      lodInfo = ` · drawing ${st.drawn.toLocaleString()} (LOD ${st.perLod.map((n) => n ?? 0).join("/")}), culled ${st.culledDistance.toLocaleString()} by distance, ${st.culledFrustum.toLocaleString()} off-screen`;
    }
    const enc = device.createCommandEncoder();
    if (shadowMap && skyState) {
      const f: [number, number, number] = [Math.cos(cam.pitch) * Math.cos(cam.yaw), Math.cos(cam.pitch) * Math.sin(cam.yaw), Math.sin(cam.pitch)];
      casters.render(enc, shadowMap, cam.pos, f, skyState.lighting.sunDir, models, player && mode === "player" ? [npcR, playerR] : [npcR], { lodScale: q.lodScale });
    }
    const colour = (msaa ?? target).createView();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: colour, clearValue: { r: 0.55, g: 0.62, b: 0.70, a: 1 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: depthView!, depthClearValue: depthClear(passSetup), depthLoadOp: "clear", depthStoreOp: "store" },
    });
    if (skyState) sky.draw(pass);
    renderer.draw(pass);
    // roads and decals blend onto the terrain before anything stands on it
    models.drawGround(pass);
    farR.draw(pass);
    models.draw(pass);
    grassR.draw(pass);
    farTrees.draw(pass);
    npcR.draw(pass);
    if (player && mode === "player") playerR.draw(pass);
    pass.end();
    // see-through materials (waterfalls, weirs, glass, water) over everything opaque, in a second
    // pass that holds the depth read-only: the water reads it (how deep it is under each pixel)
    const blend = enc.beginRenderPass({
      colorAttachments: [{ view: colour, resolveTarget: msaa ? target.createView() : undefined, loadOp: "load", storeOp: msaa ? "discard" : "store" }],
      depthStencilAttachment: { view: depthView!, depthReadOnly: true },
    });
    farR.drawBlended(blend);
    models.drawBlended(blend);
    // (eye shadow shells)
    npcR.drawBlended(blend);
    if (player && mode === "player") playerR.drawBlended(blend);
    water.setDepth(depthView, mode === "player" && player?.viewMode === "first" ? 0.01 : 0.1);
    water.draw(blend);
    blend.end();
    device.queue.submit([enc.finish()]);
    cpuAvg += (performance.now() - t0 - cpuAvg) * 0.05;
    const pc = player?.controller;
    // [key, action]: key "" for a message without one
    const hint: readonly [string, string] | null = mode !== "player" || sleeping ? null
      : chestHint ? ({ open: ["E", "Open the chest"], close: ["E", "Close the chest"], locked: ["", "The chest is locked"], busy: null } as const)[chestHint.act]
      : doorHint ? ({ open: ["E", "Open the door"], close: ["E", "Close the door"], locked: ["", "The door is locked"], busy: null } as const)[doorHint.act]
      : bedHint ? (bedHint.taken ? ["", "Someone is sleeping here"] : ["E", `Sleep until morning${bedHint.bed.legal ? "" : " (not your bed)"}`]) : null;
    const promptKey = hint ? hint.join("|") : "";
    if (promptKey !== promptText) {
      promptText = promptKey;
      prompt.hidden = !hint;
      if (hint) prompt.replaceChildren(...(hint[0] ? [el("kbd", undefined, hint[0])] : []), hint[1]);
    }
    const who = mode === "player" && pc ? `Henry (${player!.viewMode} person) ${pc.gait}${player!.walk ? " (walk)" : ""} ${pc.speed().toFixed(1)} m/s${pc.grounded ? "" : " (in the air)"} · ` : playerInfo ? `${playerInfo} · ` : "free-fly · ";
    hud.textContent = `${gpuProblem ? `⚠ ${gpuProblem} · ` : ""}${(1000 / fpsAvg).toFixed(0)} fps, cpu ${cpuAvg.toFixed(1)} ms (${q.label}, ${canvas.width}×${canvas.height}) · ${who}x ${cam.pos[0].toFixed(0)}  y ${cam.pos[1].toFixed(0)}  z ${cam.pos[2].toFixed(0)} m (ground ${ground.toFixed(1)}) · terrain ${(renderer.stats.triangles / 1e6).toFixed(2)}M + objects ${(models.stats.triangles / 1e6).toFixed(2)}M triangles · ${pool.summary()} · ${sceneInfo}${lodInfo} · ${worldLoading ? "NPCs start once the world has loaded" : npcInfo}${npcs.length ? ` (${npcs.filter((n) => n.placement.pose === "walk").length} walking, ${npcs.filter((n) => n.placement.pose === "sleep").length} asleep, ${npcAi?.ids().length ?? 0} run by behaviour trees)` : ""}${dialogueInfo ? ` · ${dialogueInfo}` : ""}`;
  };
  raf = requestAnimationFrame(frame);
  canvas.focus();

  stopActive = () => {
    stopped = true;
    dialogue.stop();
    gpuDevice.removeEventListener("uncapturederror", onGpuError);
    cancelAnimationFrame(raf);
    models.destroy();
    grassR.destroy();
    farTrees.destroy();
    npcR.destroy();
    playerR.destroy();
    farR.destroy();
    pool.destroy();
    sky.destroy();
    shadowMap?.destroy();
    water.destroy();
    depth?.destroy();
    msaa?.destroy();
    ro.disconnect();
    renderer.destroy();
    ctx.unconfigure();
    device.destroy();
  };
}
