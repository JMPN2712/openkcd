// 3D preview panel: renders a scene of one or more models with WebGPU — a
// single .cgf/.cga/.skin/.chr, or a character assembled from a .cdf or the
// game database. Drag to orbit, right-drag / shift-drag to pan, wheel to zoom,
// double-click to reset.

import { loadModel, type LoadedModel } from "./model.ts";
import { textureFile } from "./mtl.ts";
import { ModelRenderer, type Camera } from "./renderer.ts";
import type { TextureContext } from "./textureView.ts";
import type { Vfs } from "./vfs.ts";
import { formatCount } from "./format.ts";
import type { Clip } from "./anim.ts";
import type { Skeleton } from "./skeleton.ts";
import { Animator, invertRigid } from "./pose.ts";
import { multiply } from "./mat4.ts";

export interface ScenePart {
  model: LoadedModel;
  /** extra model-to-scene transform (bone attachments) */
  transform?: Float32Array;
  /** depth layer (character clothing: outer layers drawn in front) */
  layer?: number;
  label?: string;
}

export interface SceneAnimation {
  skeleton: Skeleton;
  /** .caf paths usable with the skeleton */
  clips: string[];
  /** animation databases (.dba), each holding many clips */
  databases: string[];
  loadClip(path: string): Promise<Clip>;
  /** names of the animations inside a database */
  listDatabase(path: string): Promise<string[]>;
  loadDatabaseClip(path: string, name: string): Promise<Clip>;
  /** per scene part: the bones its mesh is weighted to (null = rigid) */
  partSkeletons: (Skeleton | null)[];
  /** per scene part: a bone attachment (skeleton bone index + bind-pose transform) */
  attachments: ({ bone: number; base: Float32Array } | null)[];
}

export interface Scene {
  title?: string;
  parts: ScenePart[];
  notes: string[];
  animation?: SceneAnimation;
}

export type SceneLoader = (vfs: Vfs, onStatus: (s: string) => void) => Promise<Scene>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let devicePromise: Promise<GPUDevice> | null = null;

function getDevice(): Promise<GPUDevice> {
  if (!devicePromise) {
    devicePromise = (async () => {
      if (!navigator.gpu) {
        throw new Error("WebGPU is not available in this browser. In Chrome on Linux, enable it at chrome://flags/#enable-unsafe-webgpu (and #enable-vulkan), then restart.");
      }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("WebGPU is present but no GPU adapter was returned (check chrome://gpu).");
      const device = await adapter.requestDevice();
      device.lost.then(() => { devicePromise = null; });
      return device;
    })();
    devicePromise.catch(() => { devicePromise = null; });
  }
  return devicePromise;
}

let generation = 0;
let active: { stop: () => void } | null = null;

/** Show a single model file. */
export function showModel(host: HTMLElement, ctx: TextureContext, path: string, openTexture: (stem: string) => void): Promise<void> {
  return showScene(host, ctx, async (vfs, onStatus) => {
    const model = await loadModel(vfs, path, { onStatus });
    return { parts: [{ model }], notes: model.notes };
  }, openTexture);
}

function materialList(model: LoadedModel, openTexture: (stem: string) => void): HTMLElement {
  const dl = el("dl", "meta tex-meta");
  const used = new Set(model.cgf.meshes.flatMap((m) => m.subsets.map((s) => s.matId)));
  model.materials.forEach((m, i) => {
    if (!used.has(i)) return;
    const dd = el("dd");
    dd.append(`${m.name || "(unnamed)"} · ${m.shader}${m.nodraw ? " (hidden)" : ""}${m.genMask.includes("%COLORIZING") ? " · colorized" : ""}`);
    for (const slot of ["Diffuse", "Bumpmap", "Specular"]) {
      const f = m.textures.get(slot);
      if (!f) continue;
      const b = el("button", "link", ` ${slot}`);
      b.type = "button";
      b.title = f;
      b.addEventListener("click", () => openTexture(textureFile(f)));
      dd.append(" ·", b);
    }
    dl.append(el("dt", undefined, `Mat ${i}`), dd);
  });
  return dl;
}

export async function showScene(host: HTMLElement, ctx: TextureContext, load: SceneLoader, openTexture: (stem: string) => void): Promise<void> {
  const gen = ++generation;
  active?.stop();
  active = null;
  const status = el("p", "note", "Indexing assets across all archives…");
  host.replaceChildren(status);
  const onStatus = (s: string) => { if (gen === generation) status.textContent = s; };

  let scene: Scene;
  let device: GPUDevice;
  try {
    const vfs = await ctx.vfs(ctx.includeHd, (d, t) => onStatus(`Indexing assets across all archives… ${d}/${t}`));
    if (gen !== generation) return;
    onStatus("Loading…");
    scene = await load(vfs, onStatus);
    if (gen !== generation) return;
    if (!scene.parts.length) throw new Error(`nothing to draw${scene.notes.length ? `: ${scene.notes.join("; ")}` : ""}`);
    device = await getDevice();
  } catch (err) {
    if (gen === generation) host.replaceChildren(el("p", "error", (err as Error).message));
    return;
  }
  if (gen !== generation) return;

  // ---- layout
  host.replaceChildren();
  if (scene.title) host.append(el("p", "scene-title", scene.title));
  const stage = el("div", "model-stage");
  const canvas = el("canvas", "model-canvas");
  stage.append(canvas);
  const controls = el("div", "tex-controls");
  const flatCb = el("input");
  flatCb.type = "checkbox";
  const flatLabel = el("label", "ctl check");
  flatLabel.append(flatCb, el("span", undefined, "Flat shading"));
  const texCb = el("input");
  texCb.type = "checkbox";
  texCb.checked = true;
  const texLabel = el("label", "ctl check");
  texLabel.append(texCb, el("span", undefined, "Textures"));
  const reset = el("button", "link", "Reset view");
  reset.type = "button";
  controls.append(flatLabel, texLabel, reset, el("span", "dim", "Drag: orbit · right-drag: pan · wheel: zoom"));
  const info = el("dl", "meta tex-meta");
  host.append(stage, controls, info);

  // ---- renderer
  const context = canvas.getContext("webgpu");
  if (!context) {
    host.replaceChildren(el("p", "error", "Could not create a WebGPU canvas context."));
    return;
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const renderer = new ModelRenderer(device, format, 4);
  let gpuError: string | null = null;
  const onGpuError = (e: Event) => { gpuError = (e as GPUUncapturedErrorEvent).error.message; };
  device.addEventListener("uncapturederror", onGpuError);
  const items = (textured: boolean) =>
    scene.parts.map(({ model, layer, transform }) => ({
      transform,
      model: textured ? model : { ...model, diffuse: model.diffuse.map(() => null), specular: model.specular.map(() => null) },
      layer,
    }));
  renderer.setModels(items(true));
  let cam: Camera = renderer.defaultCamera();

  let raf = 0;
  let onFrame: ((now: number) => void) | null = null;
  const draw = (now: number) => {
    raf = 0;
    if (!canvas.width || !canvas.height) return;
    onFrame?.(now);
    cam.flat = flatCb.checked;
    renderer.render(context.getCurrentTexture(), cam);
    if (gpuError) status.textContent = `GPU error: ${gpuError}`;
  };
  const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };

  const ro = new ResizeObserver(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    redraw();
  });
  ro.observe(canvas);

  // ---- interaction
  let drag: { x: number; y: number; pan: boolean } | null = null;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
  });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.pan) {
      const s = cam.distance * 0.0015;
      const right = [-Math.sin(cam.yaw), Math.cos(cam.yaw), 0];
      cam.target = [
        cam.target[0] - right[0] * dx * s,
        cam.target[1] - right[1] * dx * s,
        cam.target[2] + dy * s,
      ];
    } else {
      cam.yaw -= dx * 0.008;
      cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch + dy * 0.008));
    }
    redraw();
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    cam.distance *= Math.exp(e.deltaY * 0.001);
    redraw();
  }, { passive: false });
  const resetView = () => { cam = renderer.defaultCamera(); redraw(); };
  canvas.addEventListener("dblclick", resetView);
  reset.addEventListener("click", resetView);
  flatCb.addEventListener("change", redraw);
  texCb.addEventListener("change", () => { renderer.setModels(items(texCb.checked)); applyPose(); redraw(); });

  // ---- animation
  let applyPose = () => {};
  if (scene.animation) {
    const anim = scene.animation;
    const animator = new Animator(anim.skeleton);
    let clip: Clip | null = null;
    let frame = 0;
    // camera target relative to the hips in the bind pose, kept while following
    animator.evaluate(null, 0);
    const bindCenter = animator.center();
    const followOffset = () => [0, 1, 2].map((k) => renderer.defaultCamera().target[k] - bindCenter[k]);
    let playing = false;
    let last = 0;
    applyPose = () => {
      animator.evaluate(clip, frame);
      anim.partSkeletons.forEach((sk, i) => { if (sk && renderer.paletteSize(i)) renderer.setPalette(i, animator.palette(sk)); });
      anim.attachments.forEach((a, i) => {
        if (a) renderer.setItemTransform(i, multiply(multiply(animator.world[a.bone], invertRigid(anim.skeleton.bones[a.bone].bindPose)), a.base));
      });
      if (clip && followCb.checked) {
        const c = animator.center();
        const off = followOffset();
        cam.target = [c[0] + off[0], c[1] + off[1], c[2] + off[2]];
      }
    };
    const row = el("div", "tex-controls anim-controls");
    const filter = el("input", "char-search");
    filter.type = "search";
    filter.placeholder = `Filter ${formatCount(anim.databases.length)} databases, ${formatCount(anim.clips.length)} clips…`;
    const pick = el("select", "clip-select");
    const dbPick = el("select", "clip-select");
    dbPick.hidden = true;
    let dbAnims: string[] = [];
    const playBtn = el("button", "link", "▶ Play");
    playBtn.type = "button";
    const scrub = el("input");
    scrub.type = "range";
    scrub.min = "0"; scrub.max = "0"; scrub.step = "0.1"; scrub.value = "0";
    const speed = el("select");
    for (const v of ["0.25", "0.5", "1", "2"]) {
      const o = el("option", undefined, `${v}×`);
      o.value = v;
      if (v === "1") o.selected = true;
      speed.append(o);
    }
    const followCb = el("input");
    followCb.type = "checkbox";
    followCb.checked = true;
    const followLabel = el("label", "ctl check");
    followLabel.append(followCb, el("span", undefined, "Follow"));
    const frameLabel = el("span", "dim", "bind pose");
    const short = (c: string) => c.replace(/^animations\//, "");
    // gameplay databases first, the many per-line facial ones last
    const databases = [...anim.databases].sort((a, b) => Number(a.includes("/facials/")) - Number(b.includes("/facials/")) || a.localeCompare(b));
    const fillPick = () => {
      const q = filter.value.trim().toLowerCase();
      const keep = pick.value;
      const dbs = (q ? databases.filter((c) => c.includes(q)) : databases).slice(0, 300);
      const cafs = (q ? anim.clips.filter((c) => c.includes(q)) : anim.clips).slice(0, 500);
      pick.replaceChildren(el("option", undefined, "— bind pose —"));
      (pick.firstChild as HTMLOptionElement).value = "";
      for (const [label, list, kind] of [["Animation databases", dbs, "dba"], ["Clips", cafs, "caf"]] as const) {
        if (!list.length) continue;
        const g = el("optgroup");
        g.label = `${label} (${list.length})`;
        for (const c of list) {
          const o = el("option", undefined, short(c));
          o.value = `${kind}:${c}`;
          g.append(o);
        }
        pick.append(g);
      }
      if ([...pick.options].some((o) => o.value === keep)) pick.value = keep;
    };
    const fillDbPick = () => {
      const q = filter.value.trim().toLowerCase();
      const hits = (q && !pick.value.includes(q) ? dbAnims.filter((a) => a.includes(q)) : dbAnims).slice(0, 1000);
      dbPick.replaceChildren(el("option", undefined, `— ${hits.length} of ${dbAnims.length} animations —`));
      (dbPick.firstChild as HTMLOptionElement).value = "";
      for (const a of hits) {
        const o = el("option", undefined, short(a));
        o.value = a;
        dbPick.append(o);
      }
    };
    let ft = 0;
    filter.addEventListener("input", () => { clearTimeout(ft); ft = window.setTimeout(() => { fillPick(); if (!dbPick.hidden) fillDbPick(); }, 150); });
    fillPick();
    const setPlaying = (p: boolean) => {
      playing = p && !!clip;
      playBtn.textContent = playing ? "❚❚ Pause" : "▶ Play";
      last = 0;
      redraw();
    };
    const useClip = async (load: (() => Promise<Clip>) | null, label: string) => {
      setPlaying(false);
      if (!load) {
        clip = null;
        frameLabel.textContent = "bind pose";
      } else {
        status.textContent = `Loading ${label}…`;
        try {
          clip = await load();
          status.textContent = `${label}: ${clip.tracks.size} bone tracks, frames ${clip.start}–${clip.end} at ${clip.fps} fps`;
        } catch (err) {
          clip = null;
          status.textContent = (err as Error).message;
        }
      }
      frame = clip?.start ?? 0;
      scrub.min = String(clip?.start ?? 0);
      scrub.max = String(clip?.end ?? 0);
      scrub.value = String(frame);
      applyPose();
      setPlaying(!!clip);
    };
    pick.addEventListener("change", async () => {
      const [kind, path] = [pick.value.slice(0, 3), pick.value.slice(4)];
      if (kind === "dba") {
        status.textContent = `Reading ${short(path)}…`;
        try {
          dbAnims = await anim.listDatabase(path);
          dbPick.hidden = false;
          fillDbPick();
          status.textContent = `${short(path)}: ${formatCount(dbAnims.length)} animations`;
        } catch (err) {
          status.textContent = (err as Error).message;
        }
        return;
      }
      dbPick.hidden = true;
      await useClip(kind === "caf" ? () => anim.loadClip(path) : null, short(path));
    });
    dbPick.addEventListener("change", async () => {
      const path = pick.value.slice(4);
      const name = dbPick.value;
      await useClip(name ? () => anim.loadDatabaseClip(path, name) : null, short(name));
    });
    playBtn.addEventListener("click", () => setPlaying(!playing));
    scrub.addEventListener("input", () => {
      frame = Number(scrub.value);
      setPlaying(false);
      applyPose();
      redraw();
    });
    followCb.addEventListener("change", () => { applyPose(); redraw(); });
    onFrame = (now) => {
      if (!playing || !clip) return;
      if (last) {
        frame += ((now - last) / 1000) * clip.fps * Number(speed.value);
        if (frame > clip.end) frame = clip.start + ((frame - clip.start) % Math.max(1, clip.end - clip.start));
      }
      last = now;
      scrub.value = String(frame);
      frameLabel.textContent = `frame ${frame.toFixed(0)} / ${clip.end}`;
      applyPose();
      redraw(); // keep the loop going while playing
    };
    row.append(filter, pick, dbPick, playBtn, scrub, speed, followLabel, frameLabel);
    host.insertBefore(row, info);
    applyPose();
  }

  // ---- info
  const st = renderer.stats;
  const size = renderer.bboxMax.map((v, i) => (v - renderer.bboxMin[i]).toFixed(2)).join(" × ");
  const rows: [string, string][] = [
    ["Geometry", `${st.meshes} mesh${st.meshes === 1 ? "" : "es"} · ${formatCount(st.triangles)} triangles · ${formatCount(st.vertices)} vertices · ${st.draws} draws`],
    ["Size", `${size} m`],
  ];
  if (scene.parts.length === 1) {
    const m = scene.parts[0].model;
    rows.push(["Source", m.hit.pak.path], ["Material", m.mtlPath ?? "none"]);
    if (m.cgf.skippedNodes.length) rows.push(["Hidden nodes", m.cgf.skippedNodes.join(", ")]);
  }
  for (const [k, v] of rows) info.append(el("dt", undefined, k), el("dd", undefined, v));
  if (scene.parts.length === 1) {
    host.append(materialList(scene.parts[0].model, openTexture));
  } else {
    for (const p of scene.parts) {
      const d = el("details", "part");
      const sum = el("summary");
      sum.append(el("span", undefined, p.label ?? p.model.path), el("span", "dim", ` ${p.model.path.slice(p.model.path.lastIndexOf("/") + 1)}`));
      d.append(sum, el("p", "dim", `${p.model.hit.pak.path} · ${p.model.mtlPath ?? "no material"}`), materialList(p.model, openTexture));
      host.append(d);
    }
  }
  host.append(status);
  status.textContent = scene.notes.join(" · ");

  active = {
    stop: () => {
      ro.disconnect();
      device.removeEventListener("uncapturederror", onGpuError);
      if (raf) cancelAnimationFrame(raf);
      renderer.destroy();
      context.unconfigure();
    },
  };
}
