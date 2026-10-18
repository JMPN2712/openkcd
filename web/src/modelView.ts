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

export interface ScenePart {
  model: LoadedModel;
  /** extra model-to-scene transform (bone attachments) */
  transform?: Float32Array;
  /** depth layer (character clothing: outer layers drawn in front) */
  layer?: number;
  label?: string;
}

export interface Scene {
  title?: string;
  parts: ScenePart[];
  notes: string[];
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
  const draw = () => {
    raf = 0;
    if (!canvas.width || !canvas.height) return;
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
  texCb.addEventListener("change", () => { renderer.setModels(items(texCb.checked)); redraw(); });

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
