// Model preview panel: loads a .cgf/.cga/.skin/.chr with its materials and
// renders it with WebGPU. Drag to orbit, right-drag / shift-drag to pan,
// wheel to zoom, double-click to reset.

import { loadModel, type LoadedModel } from "./model.ts";
import { textureFile } from "./mtl.ts";
import { ModelRenderer, type Camera } from "./renderer.ts";
import type { TextureContext } from "./textureView.ts";
import { formatCount } from "./format.ts";

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
let active: { renderer: ModelRenderer; stop: () => void } | null = null;

export async function showModel(
  host: HTMLElement,
  ctx: TextureContext,
  path: string,
  openTexture: (stem: string) => void,
): Promise<void> {
  const gen = ++generation;
  active?.stop();
  active = null;
  const status = el("p", "note", "Indexing assets across all archives…");
  host.replaceChildren(status);

  let model: LoadedModel;
  let device: GPUDevice;
  try {
    const vfs = await ctx.vfs(ctx.includeHd, (d, t) => { if (gen === generation) status.textContent = `Indexing assets across all archives… ${d}/${t}`; });
    if (gen !== generation) return;
    status.textContent = "Loading model…";
    model = await loadModel(vfs, path, { onStatus: (s) => { if (gen === generation) status.textContent = s; } });
    if (gen !== generation) return;
    device = await getDevice();
  } catch (err) {
    if (gen === generation) host.replaceChildren(el("p", "error", (err as Error).message));
    return;
  }
  if (gen !== generation) return;

  // ---- layout
  host.replaceChildren();
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
  const untextured = { ...model, diffuse: model.diffuse.map(() => null), specular: model.specular.map(() => null) };
  renderer.setModel(model);
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
  texCb.addEventListener("change", () => { renderer.setModel(texCb.checked ? model : untextured); redraw(); });

  // ---- info
  const st = renderer.stats;
  const rows: [string, string | HTMLElement][] = [
    ["Geometry", `${st.meshes} mesh${st.meshes === 1 ? "" : "es"} · ${formatCount(st.triangles)} triangles · ${formatCount(st.vertices)} vertices · ${st.draws} draws`],
    ["Source", model.hit.pak.path],
    ["Material", model.mtlPath ?? "none"],
  ];
  const size = renderer.bboxMax.map((v, i) => (v - renderer.bboxMin[i]).toFixed(2)).join(" × ");
  rows.push(["Size", `${size} m`]);
  if (model.cgf.skippedNodes.length) rows.push(["Hidden nodes", model.cgf.skippedNodes.join(", ")]);
  for (const [k, v] of rows) info.append(el("dt", undefined, k), typeof v === "string" ? el("dd", undefined, v) : v);
  const used = new Set(model.cgf.meshes.flatMap((m) => m.subsets.map((s) => s.matId)));
  model.materials.forEach((m, i) => {
    if (!used.has(i)) return;
    const dd = el("dd");
    dd.append(`${m.name || "(unnamed)"} · ${m.shader}${m.nodraw ? " (hidden)" : ""}`);
    for (const slot of ["Diffuse", "Bumpmap", "Specular"]) {
      const f = m.textures.get(slot);
      if (!f) continue;
      const b = el("button", "link", ` ${slot}`);
      b.type = "button";
      b.title = f;
      b.addEventListener("click", () => openTexture(textureFile(f)));
      dd.append(" ·", b);
    }
    info.append(el("dt", undefined, `Mat ${i}`), dd);
  });
  host.append(status);
  status.textContent = model.notes.join(" · ");

  active = {
    renderer,
    stop: () => {
      ro.disconnect();
      device.removeEventListener("uncapturederror", onGpuError);
      if (raf) cancelAnimationFrame(raf);
      renderer.destroy();
      context.unconfigure();
    },
  };
}
