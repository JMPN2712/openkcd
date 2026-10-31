// The world view in real (headless) Chrome: builds the app, serves it, opens GAME_ROOT through the
// page's folder input, starts Rataje at a quality preset (Henry at the market spawn), waits for
// the streaming to settle, reads the HUD's fps and main-thread ms, and records a CPU profile of
// the page. Headless Dawn (bench-presets.ts) times WebGPU differently from Chrome, where every
// call crosses into the GPU process: this measures what a player gets.
// Driven over the DevTools protocol (Node's built-in WebSocket); no npm deps.
// usage: node scripts/profile-browser.ts [--root=GAME_ROOT] [--preset=high] [--settle=30]
//          [--seconds=8] [--windowed] [--dialogue=SEQUENCE_ID [--shot=close_up] [--screenshot=PREFIX]] [--talk=NPC_NAME [--pick=1,2]] [--at=x,y[,yaw°]] [--fly=SECONDS [--spikes]] [--build-slim=full|potato] [--package] (settle: seconds after the models have loaded) [--out=FILE.cpuprofile] [--size=1920x1080] [--bench[=this]] [--query=gpu-mem] [--heap]
//   CHROME=… picks the browser binary, CHROME_FLAGS=… adds flags, PROFILE_DIR=… keeps the profile; --probe stops after naming the
//   WebGPU adapter; --fly then flies north-west across the map (free-fly, 60 m/s: a streaming
//   step every few seconds) printing the HUD every 10 s, then profiles there; with --spikes it
//   lists the frames over 25 ms during the flight and what ran in them; --trace also records a Chrome trace over the same seconds and prints how busy
//   each thread was (the renderer's main thread, the GPU process's main thread, …). Prints the HUD and the hottest functions (self and total).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromeBinary, chromeGpuFlags } from "./chrome.ts";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const root = arg("root", join(homedir(), "kcd1"));
const preset = arg("preset", "high");
const settle = Number(arg("settle", "15"));
const seconds = Number(arg("seconds", "8"));
const out = arg("out", "");
const [W, H] = arg("size", "1920x1080").split("x").map(Number);
// PORT=… and DEBUG_PORT=…: other ports, so two runs (two checkouts) don't collide
const PORT = Number(process.env.PORT ?? 5198);
const DEBUG = Number(process.env.DEBUG_PORT ?? 9338);

const children: ChildProcess[] = [];
process.on("exit", () => children.forEach((c) => c.kill()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, ms = 60000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

// (not minified: the profile names real functions)
const dist = join(tmpdir(), `openkcd-profile-dist-${PORT}`);
const build = spawn("node_modules/.bin/vite", ["build", "--outDir", dist, "--emptyOutDir", "--minify", "false"], { stdio: "ignore" });
if ((await new Promise((r) => build.once("exit", r))) !== 0) throw new Error("vite build failed");
children.push(spawn("node_modules/.bin/vite", ["preview", "--outDir", dist, "--port", String(PORT), "--strictPort"], { stdio: "ignore" }));
await waitFor("Vite", async () => ((await fetch(`http://localhost:${PORT}/`)).ok ? true : undefined));
// PROFILE_DIR=…: a browser profile kept between runs (its OPFS holds a compact package built by an
// earlier run with --build-slim); otherwise a throwaway one
const keepProfile = !!process.env.PROFILE_DIR;
const profile = process.env.PROFILE_DIR ?? await mkdtemp(join(tmpdir(), "openkcd-profile-"));
children.push(
  // the hardware adapter (Vulkan on Linux, chrome.ts) with the GPU blocklist off; frames unthrottled
  spawn(chromeBinary, ["--headless=new", ...chromeGpuFlags, "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--disable-gpu-vsync", "--disable-frame-rate-limit",
    ...(process.env.CHROME_FLAGS ?? "").split(" ").filter(Boolean), `--window-size=${W},${H}`, `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" }),
);
const version = await waitFor("Chrome", async () => (await fetch(`http://127.0.0.1:${DEBUG}/json/version`)).json() as Promise<{ webSocketDebuggerUrl: string }>);

// --- a minimal DevTools protocol client ---
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
const traceEvents: any[] = [];
let traceDone: (() => void) | null = null;
let snapshotChunk: ((c: string) => void) | null = null;
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.method === "HeapProfiler.addHeapSnapshotChunk") snapshotChunk?.(msg.params.chunk);
  if (msg.method === "Tracing.dataCollected") traceEvents.push(...msg.params.value);
  if (msg.method === "Tracing.tracingComplete") traceDone?.();
  if (msg.method === "Runtime.exceptionThrown") console.log("page exception:", msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") console.log("page error:", msg.params.args.map((a: any) => a.value ?? a.description).join(" "));
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.err(new Error(msg.error.message));
  else p.ok(msg.result);
});
function send(method: string, params: object = {}, sessionId?: string): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((ok, err) => pending.set(id, { ok, err }));
}
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const page = (method: string, params: object = {}) => send(method, params, sessionId);
async function evaluate<T>(expression: string): Promise<T> {
  const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value as T;
}
await page("Runtime.enable");
await page("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
// --at=x,y[,yaw°]: Henry starts there (the page's ?at= option)
const at = arg("at", "");
// --query=gpu-mem&…: more of the address's debugging switches
const query = [at ? `at=${at}` : "", arg("query", "")].filter(Boolean).join("&");
// --heap: a sampled JS heap profile from the start, its live allocations by function printed with the benchmark
const heap = process.argv.includes("--heap");
if (heap) { await page("HeapProfiler.enable"); await page("HeapProfiler.startSampling", { samplingInterval: 256 * 1024 }); }
await page("Page.navigate", { url: `http://localhost:${PORT}/${query ? `?${query}` : ""}` });
await waitFor("the page", () => evaluate<boolean>(`document.readyState === "complete" && !!document.getElementById("open-input")`).then((v) => v || undefined));
await evaluate(`localStorage.setItem("openkcd.quality", ${JSON.stringify(preset)})`);
const adapter = await evaluate<string>(`navigator.gpu ? navigator.gpu.requestAdapter().then((a) => a ? a.info.vendor + " " + a.info.architecture + " " + a.info.description : "no adapter") : "no WebGPU"`);
console.log(`WebGPU adapter: ${adapter}`);
if (process.argv.includes("--probe")) {
  // what the browser can inflate natively (the compact package's codec choice)
  const formats = await evaluate<string[]>(`["gzip", "deflate", "deflate-raw", "brotli", "zstd"].filter((f) => { try { new DecompressionStream(f); return true; } catch { return false; } })`);
  console.log(`DecompressionStream: ${formats.join(", ")}`);
  process.exit(0);
}

if (process.argv.includes("--package")) {
  // --package: the compact package and its file store in this profile's OPFS (built by an earlier
  // run with --build-slim, PROFILE_DIR kept): no game files at all
  await waitFor("the package button", () => evaluate<boolean>(`!document.getElementById("package").hidden`).then((v) => v || undefined), 30000);
  await evaluate(`document.getElementById("package").click()`);
} else {
  // hand the game folder to the input, as picking it would (Chrome fires "change" itself)
  const { root: doc } = await page("DOM.getDocument");
  const { nodeId } = await page("DOM.querySelector", { nodeId: doc.nodeId, selector: "#open-input" });
  await page("DOM.setFileInputFiles", { nodeId, files: [root] });
}
const status = await waitFor("the game folder", () => evaluate<string>(`document.getElementById("status").textContent`).then((s) => (/archives|failed|no Data/.test(s) ? s : undefined)), 120000);
console.log(status);
// --load-profile: a CPU profile of the loading, from the click until the market is complete
const loadProfile = process.argv.includes("--load-profile");
if (loadProfile) {
  await page("Profiler.enable");
  await page("Profiler.setSamplingInterval", { interval: 1000 });
  await page("Profiler.start");
}
// --build-slim=full|potato: build the compact package into this profile's OPFS first, through the
// page's builder (timed); the world view then loads from it
const buildSlim = arg("build-slim", "");
if (buildSlim) {
  const tb = Date.now();
  await evaluate(`document.getElementById("slim").click()`);
  await waitFor("the builder", () => evaluate<boolean>(`!!document.querySelector(".slim-${buildSlim}")`).then((v) => v || undefined));
  await evaluate(`document.querySelector(".slim-${buildSlim}").click()`);
  let shown = "";
  const result = await waitFor("the build", async () => {
    const s = await evaluate<{ text: string; cls: string }>(`(() => { const l = document.querySelector(".slim-line"); return { text: l.textContent, cls: l.className }; })()`);
    if (s.text !== shown && Date.now() % 20000 < 600) console.log(`  ${s.text}`);
    shown = s.text;
    return /ok|error/.test(s.cls) ? s : undefined;
  }, 3600 * 1000);
  console.log(`build: ${result.text} (${((Date.now() - tb) / 1000).toFixed(0)} s in the page)`);
  if (/error/.test(result.cls)) process.exit(1);
}
const t0 = Date.now();
await evaluate(`document.getElementById("world").click()`);
const hud = () => evaluate<string>(`document.querySelector(".level-hud")?.textContent ?? ""`);
await waitFor("Henry", () => hud().then((s) => (/Henry \(/.test(s) ? s : undefined)), 180000);
// the view fills the window, as a player has it (--windowed: the page's own small canvas)
if (!process.argv.includes("--windowed")) await evaluate(`[...document.querySelectorAll("button")].find((b) => /Full window/.test(b.textContent))?.click()`);
// until the models within the streaming radius have loaded, then `settle` more seconds (textures)
// (ten quiet seconds in a row: the scene complete and the NPCs assembled; they start once it is)
let quiet = 0, worldAt = 0;
await waitFor("the models", () => hud().then((s) => {
  if (!worldAt && /instances within/.test(s) && !/oading|start once/.test(s)) worldAt = Date.now();
  quiet = /instances within/.test(s) && !/oading|Assembling|start once/.test(s) ? quiet + 1 : 0;
  return quiet >= 20 ? true : undefined;
}), 900000);
// (from the click: the NPCs are complete when ten quiet seconds began)
console.log(`world complete ${((worldAt - t0) / 1000).toFixed(0)} s after opening the view, NPCs ${((Date.now() - 10000 - t0) / 1000).toFixed(0)} s; settling ${settle} s…`);
if (loadProfile) {
  const { profile: lp } = await page("Profiler.stop");
  type N = { id: number; callFrame: { functionName: string; url: string }; children?: number[] };
  const nodes = new Map<number, N>((lp.nodes as N[]).map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of nodes.values()) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map<string, number>(), incl = new Map<string, number>();
  let all = 0, idle = 0;
  (lp.samples as number[]).forEach((id, i) => {
    const dt = lp.timeDeltas[i] as number;
    all += dt;
    const n = nodes.get(id)!;
    if (n.callFrame.functionName === "(idle)") { idle += dt; return; }
    const k = n.callFrame.functionName || "(anonymous)";
    self.set(k, (self.get(k) ?? 0) + dt);
    const seen = new Set<string>();
    for (let j: number | undefined = id; j !== undefined; j = parent.get(j)) {
      const m = nodes.get(j)!;
      if (!m.callFrame.url.includes("index")) continue;
      const kk = m.callFrame.functionName || "(anonymous)";
      if (!seen.has(kk)) { seen.add(kk); incl.set(kk, (incl.get(kk) ?? 0) + dt); }
    }
  });
  const s = (v: number) => `${(v / 1e6).toFixed(1)} s`;
  console.log(`loading, main thread: ${s(all)} sampled, idle ${s(idle)}`);
  console.log(`  self: ${[...self].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => `${k} ${s(v)}`).join(", ")}`);
  console.log(`  total: ${[...incl].sort((a, b) => b[1] - a[1]).slice(0, 22).map(([k, v]) => `${k} ${s(v)}`).join(", ")}`);
}
await sleep(settle * 1000);
const readings: string[] = [];
for (let k = 0; k < 3; k++) { readings.push((await hud()).replace(/ · .*?x /, " · x ").replace(/ · (terrain|textures)[^·]*/g, "").slice(0, 300)); await sleep(1000); }
console.log(readings.join("\n"));

// --memory: is the JS heap real? The page's figure, then after a forced collection, V8's own
// breakdown, measureUserAgentSpecificMemory (cross-origin isolated pages only), and what the
// operating system charges each of this profile's Chrome processes
async function memoryReport(): Promise<void> {
  const mib = (b: number) => `${(b / 2 ** 20).toFixed(0)} MiB`;
  const pageHeap = () => evaluate<number>(`performance.memory?.usedJSHeapSize ?? 0`);
  console.log(`page heap (performance.memory): ${mib(await pageHeap())}`);
  await page("HeapProfiler.enable");
  await page("HeapProfiler.collectGarbage");
  await sleep(1000);
  console.log(`page heap after a forced collection: ${mib(await pageHeap())}`);
  const u = await page("Runtime.getHeapUsage");
  console.log(`V8: used ${mib(u.usedSize)} of ${mib(u.totalSize)}${u.embedderHeapUsedSize !== undefined ? `, embedder ${mib(u.embedderHeapUsedSize)}` : ""}${u.backingStorageSize !== undefined ? `, array buffer backing stores ${mib(u.backingStorageSize)}` : ""}`);
  const ua = await evaluate<string>(`self.crossOriginIsolated && performance.measureUserAgentSpecificMemory ? performance.measureUserAgentSpecificMemory().then((m) => JSON.stringify({ bytes: m.bytes, breakdown: m.breakdown.filter((b) => b.bytes > 1 << 20).map((b) => [b.types.join("+"), b.bytes]) })) : "not available (" + (self.crossOriginIsolated ? "no API" : "not cross-origin isolated") + ")"`).catch((e) => String(e));
  console.log(`measureUserAgentSpecificMemory: ${ua}`);
  // --snapshot=FILE: a heap snapshot for scripts/heap-buffers.ts (what retains the array buffers)
  const snapFile = arg("snapshot", "");
  if (snapFile) {
    const { createWriteStream } = await import("node:fs");
    const out = createWriteStream(snapFile);
    snapshotChunk = (c) => out.write(c);
    await page("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    snapshotChunk = null;
    await new Promise((r) => out.end(r));
    console.log(`heap snapshot: ${snapFile}`);
  }
  const { execFileSync } = await import("node:child_process");
  const ps = execFileSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  const mine = ps.split("\n").filter((l) => l.includes(profile)).map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)!;
    const type = /--type=([a-z-]+)/.exec(m[3])?.[1] ?? "browser";
    let footprint = "";
    if (process.platform === "darwin") {
      try { footprint = /phys_footprint:\s*([\d.]+ [KMG]B)/.exec(execFileSync("footprint", ["-p", m[1]], { encoding: "utf8" }))?.[1] ?? ""; } catch { /* (not allowed) */ }
    }
    return { pid: m[1], rss: Number(m[2]) * 1024, type, footprint };
  });
  for (const p of mine.sort((a, b) => b.rss - a.rss)) console.log(`  ${p.type.padEnd(10)} pid ${p.pid}: resident ${mib(p.rss)}${p.footprint ? `, footprint ${p.footprint}` : ""}`);
}
if (process.argv.includes("--memory") && !process.argv.some((a) => a.startsWith("--bench"))) { await memoryReport(); process.exit(0); }

// --bench[=this]: the in-app benchmark (every preset, or this one), printing its report
const benchArg = process.argv.find((a) => a === "--bench" || a.startsWith("--bench="));
if (benchArg) {
  await evaluate(`[...document.querySelectorAll("button")].find((b) => /Benchmark/.test(b.textContent)).dispatchEvent(new MouseEvent("click", { shiftKey: ${benchArg === "--bench=this"} }))`);
  let lastHud = "";
  const text = await waitFor("the benchmark", async () => {
    const h = (await hud()).match(/⏱ [^·]*/)?.[0] ?? "";
    // (the preset and phase as they change, not every second)
    const key = h.replace(/\d+\/\d+ s/, "");
    if (h && key !== lastHud) { console.log(h); lastHud = key; }
    return evaluate<string>(`(() => { const p = document.querySelector(".level-bench"); return p && !p.hidden ? p.querySelector("pre").textContent : undefined; })()`);
  }, 3600_000);
  console.log(text);
  if (heap) {
    // live bytes by allocating function (self), and by the app's functions on the stack (total)
    type H = { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children: H[] };
    const { profile: hp } = await page("HeapProfiler.getSamplingProfile");
    const self = new Map<string, number>(), incl = new Map<string, number>();
    const name = (n: H) => `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`;
    const walk = (n: H, stack: string[]) => {
      const k = name(n);
      const s2 = n.callFrame.url.includes("localhost") && !stack.includes(k) ? [...stack, k] : stack;
      if (n.selfSize) { self.set(k, (self.get(k) ?? 0) + n.selfSize); for (const f of s2) incl.set(f, (incl.get(f) ?? 0) + n.selfSize); }
      for (const c of n.children) walk(c, s2);
    };
    walk(hp.head as H, []);
    const m = (v: number) => `${(v / 2 ** 20).toFixed(0)} MiB`;
    console.log(`JS heap (sampled, live): ${m([...self.values()].reduce((a, b) => a + b, 0))}`);
    console.log(`  self: ${[...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${m(v)}`).join("\n        ")}`);
    console.log(`  total: ${[...incl].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k} ${m(v)}`).join("\n         ")}`);
  }
  // --memory with --bench: the same report after the run (is the end-of-run heap real?)
  if (process.argv.includes("--memory")) await memoryReport();
  process.exit(0);
}

// --dialogue=ID: play a dialogue sequence with the NPCs near Henry (the debug control) and print
// its subtitles as they appear, and how many of its lines decoded to audio
const dialogueId = arg("dialogue", "");
if (dialogueId) {
  // --shot=close_up …: the dialogue camera's debug shot; --screenshot=PREFIX saves a PNG at each new subtitle
  const shot = arg("shot", "");
  const shots = arg("screenshot", "");
  if (shot) {
    await evaluate(`(() => { const s = document.querySelector(".level-dialogue-shot"); s.value = ${JSON.stringify(shot)}; s.dispatchEvent(new Event("change")); })()`);
    await sleep(1500);
  }
  let shotNo = 0;
  await evaluate(`(() => { const i = document.querySelector(".level-dialogue-id"); i.value = ${JSON.stringify(dialogueId)}; [...document.querySelectorAll("button")].find((b) => /Dialogue/.test(b.textContent)).click(); })()`);
  const td = Date.now();
  const started = await waitFor("the dialogue", () => hud().then((s) => /Dialogue \d+:|Dialogue: |No dialogue/.test(s) ? s.slice(s.lastIndexOf(" · ") + 3) : undefined), 120000);
  console.log(`${started} (${((Date.now() - td) / 1000).toFixed(1)} s to load and start)`);
  let last = "", quietFor = 0;
  while (quietFor < 6) {
    const sub = await evaluate<string>(`(() => { const s = document.querySelector(".level-subtitle"); return s && !s.hidden ? s.textContent : ""; })()`);
    if (sub && sub !== last) {
      console.log(`  ${((Date.now() - td) / 1000).toFixed(1).padStart(5)} s  ${sub}`);
      if (shots) {
        await sleep(400); // the camera follows the new speaker from the next frame
        const { data } = await page("Page.captureScreenshot", { format: "png" });
        await writeFile(`${shots}${shotNo++}.png`, Buffer.from(data, "base64"));
      }
    }
    quietFor = sub ? 0 : quietFor + 1;
    last = sub;
    await sleep(500);
  }
}

// --talk=NPC_NAME: a conversation with that NPC (the debug control takes a name), printing the
// subtitles and each menu; --pick=2,1 presses those option numbers at the menus in turn (default 1)
const talkTo = arg("talk", "");
if (talkTo) {
  const picks = arg("pick", "1").split(",");
  const press = async (code: string, key: string) => {
    for (const type of ["keyDown", "keyUp"] as const) await page("Input.dispatchKeyEvent", { type, code, key, windowsVirtualKeyCode: key.charCodeAt(0) });
  };
  await evaluate(`(() => { const i = document.querySelector(".level-dialogue-id"); i.value = ${JSON.stringify(talkTo)}; [...document.querySelectorAll("button")].find((b) => /Dialogue/.test(b.textContent)).click(); })()`);
  const td = Date.now();
  let lastSub = "", lastMenu = "", quietFor = 0, k = 0;
  while (quietFor < 10 && Date.now() - td < 180000) {
    const [sub, menu, info] = await evaluate<[string, string, string]>(`(() => {
      const s = document.querySelector(".level-subtitle"), m = document.querySelector(".level-dialogue-menu"), h = document.querySelector(".level-hud")?.textContent ?? "";
      return [s && !s.hidden ? s.textContent : "", m && !m.hidden ? [...m.querySelectorAll("li")].map((li) => li.textContent).join(" | ") || m.textContent : "", h.slice(h.lastIndexOf(" · ") + 3)];
    })()`);
    const t = ((Date.now() - td) / 1000).toFixed(1).padStart(5);
    if (sub && sub !== lastSub) console.log(`  ${t} s  ${sub}`);
    if (menu && menu !== lastMenu) {
      console.log(`  ${t} s  menu: ${menu}`);
      await sleep(700);
      const n = picks[Math.min(k++, picks.length - 1)];
      console.log(`  ${t} s  presses ${n}`);
      await evaluate(`document.querySelector(".level-canvas").focus()`);
      await press(/^\d$/.test(n) ? `Digit${n}` : n, /^\d$/.test(n) ? n : "\r");
    }
    quietFor = sub || menu ? 0 : quietFor + 1;
    lastSub = sub; lastMenu = menu;
    if (/Conversation /.test(info)) { console.log(`  ${t} s  ${info}`); break; }
    await sleep(500);
  }
}

const fly = Number(arg("fly", "0"));
if (fly) {
  // F: free-fly; drag to turn from south to north-west and level the view; hold W
  const key = async (code: string, type: "keyDown" | "keyUp") => page("Input.dispatchKeyEvent", { type, code, key: code.replace(/^Key/, "").toLowerCase(), windowsVirtualKeyCode: code === "KeyF" ? 70 : code === "KeyW" ? 87 : 0 });
  await evaluate(`document.querySelector(".level-canvas").focus()`);
  await key("KeyF", "keyDown"); await key("KeyF", "keyUp");
  await page("Input.dispatchMouseEvent", { type: "mousePressed", x: 400, y: 500, button: "left", clickCount: 1 });
  for (let k = 1; k <= 10; k++) await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400 + 59 * k, y: 500 - 10 * k, button: "left" });
  await page("Input.dispatchMouseEvent", { type: "mouseReleased", x: 990, y: 400, button: "left", clickCount: 1 });
  // --spikes: frame timestamps in the page, a CPU profile alongside (aligned by its start)
  const spikes = process.argv.includes("--spikes");
  let pageT0 = 0;
  if (spikes) {
    await page("Profiler.enable");
    await page("Profiler.setSamplingInterval", { interval: 500 });
    await page("Profiler.start");
    pageT0 = await evaluate<number>(`(() => { const f = (globalThis.__frames = []); const loop = (t) => { f.push(t); requestAnimationFrame(loop); }; requestAnimationFrame(loop); return performance.now(); })()`);
  }
  await key("KeyW", "keyDown");
  for (let t = 0; t < fly; t += 10) {
    await sleep(10000);
    // (keys repeat as held keys do, so the view never sees them released)
    await key("KeyW", "keyDown");
    console.log(`  ${t + 10} s: ${(await hud()).replace(/ · (terrain|textures|Henry|free-fly)[^·]*/g, "").slice(0, 200)}`);
  }
  await key("KeyW", "keyUp");
  if (spikes) {
    const { profile: p } = await page("Profiler.stop");
    const frames = await evaluate<number[]>(`globalThis.__frames`);
    type N = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
    const nodes = new Map<number, N>((p.nodes as N[]).map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of nodes.values()) for (const c of n.children ?? []) parent.set(c, n.id);
    const nm = (n: N) => `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
    // sample times in the page's clock
    const times: number[] = [];
    let at = 0;
    for (const d of p.timeDeltas as number[]) { at += d; times.push(pageT0 + at / 1000); }
    const gaps = frames.slice(1).map((t, i) => [frames[i], t] as [number, number]).filter(([a, b]) => b - a > 25);
    const all = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
    console.log(`\n${frames.length} frames in ${((frames[frames.length - 1] - frames[0]) / 1000).toFixed(0)} s: median ${all[all.length >> 1].toFixed(1)} ms, p99 ${all[Math.floor(all.length * 0.99)].toFixed(1)} ms, ${gaps.length} over 25 ms, worst ${all[all.length - 1].toFixed(0)} ms`);
    // per long frame: the functions sampled in it (each counted once per sample, innermost three of our own)
    const total = new Map<string, number>(), totalSelf = new Map<string, number>();
    for (const [a, b] of gaps.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, 12)) {
      const here = new Map<string, number>();
      (p.samples as number[]).forEach((id, i) => {
        if (times[i] < a || times[i] > b) return;
        // the stage: what `frame` called, or the outermost function of a task outside the frame;
        // and the innermost of our functions (self)
        const chain: N[] = [];
        for (let j: number | undefined = id; j !== undefined; j = parent.get(j)) chain.push(nodes.get(j)!);
        const ours = chain.filter((n) => n.callFrame.url.includes("index"));
        const fi = ours.findIndex((n) => n.callFrame.functionName === "frame");
        const stage = fi > 0 ? `frame>${ours[fi - 1].callFrame.functionName || "(anonymous)"}` : fi === 0 ? "frame" : ours.length ? `task ${ours[ours.length - 1].callFrame.functionName || "(anonymous)"}` : chain[0] ? `native ${chain[0].callFrame.functionName}` : "?";
        const self = ours[0] ? ` / ${ours[0].callFrame.functionName || "(anonymous)"}` : "";
        const k = stage + self;
        here.set(k, (here.get(k) ?? 0) + 0.5);
        total.set(stage, (total.get(stage) ?? 0) + 0.5);
        const sk = ours[0] ? ours[0].callFrame.functionName || "(anonymous)" : `native ${chain[0]?.callFrame.functionName ?? "?"}`;
        totalSelf.set(sk, (totalSelf.get(sk) ?? 0) + 0.5);
      });
      console.log(`  ${(b - a).toFixed(0)} ms: ${[...here].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(", ")}`);
    }
    console.log(`in all long frames, innermost: ${[...totalSelf].sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(", ")}`);
    console.log(`in all long frames: ${[...total].sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(", ")}`);
  }
  await sleep(3000);
}
// (no screenshots: headless Chrome captures the WebGPU canvas blank; GPU errors show in the HUD
// readings and as "page error" lines)

const trace = process.argv.includes("--trace");
if (trace) await send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["toplevel", "gpu", "gpu.dawn", "disabled-by-default-gpu.dawn", "disabled-by-default-devtools.timeline"] } });
await page("Profiler.enable");
await page("Profiler.setSamplingInterval", { interval: 200 });
await page("Profiler.start");
await sleep(seconds * 1000);
const { profile: cpu } = await page("Profiler.stop");
if (trace) {
  const done = new Promise<void>((r) => (traceDone = r));
  await send("Tracing.end");
  await done;
  // busy time per thread: its top-level tasks (nested events are inside them)
  const names = new Map<string, string>();
  for (const e of traceEvents) if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args.name);
  for (const e of traceEvents) if (e.ph === "M" && e.name === "process_name") names.set(`${e.pid}`, e.args.name);
  // (top-level tasks can nest: the union of their intervals)
  const spans = new Map<string, [number, number][]>();
  let t0 = Infinity, t1 = -Infinity;
  for (const e of traceEvents) {
    if (e.ph !== "X" || !e.cat?.includes("toplevel") || !e.dur) continue;
    const k = `${e.pid}:${e.tid}`;
    (spans.get(k) ?? spans.set(k, []).get(k)!).push([e.ts, e.ts + e.dur]);
    t0 = Math.min(t0, e.ts); t1 = Math.max(t1, e.ts + e.dur);
  }
  const busy = new Map<string, number>();
  for (const [k, l] of spans) {
    l.sort((a, b) => a[0] - b[0]);
    let sum = 0, end = -Infinity;
    for (const [a, b] of l) { if (b > end) { sum += b - Math.max(a, end); end = b; } }
    busy.set(k, sum);
  }
  // the GPU process's main thread: event names by total time (nested ones included)
  const gpuMain = [...names].find(([k, v]) => v === "CrGpuMain" && names.get(k.split(":")[0]) === "GPU Process")?.[0];
  const byName = new Map<string, number>();
  for (const e of traceEvents) if (e.ph === "X" && e.dur && `${e.pid}:${e.tid}` === gpuMain) byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur);
  console.log("\nGPU process main thread, by event (ms per second):");
  for (const [k, v] of [...byName].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${(v / ((t1 - t0) / 1000)).toFixed(0).padStart(5)}  ${k}`);
  console.log("\nthreads by busy time over the trace:");
  for (const [k, v] of [...busy].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${((v / (t1 - t0)) * 100).toFixed(0).padStart(4)}%  ${names.get(k.split(":")[0]) ?? "?"} / ${names.get(k) ?? k}`);
}
console.log((await hud()).slice(0, 120));
if (out) await writeFile(out, JSON.stringify(cpu));

// the hottest functions: self time, and total time (callers included once per sample)
type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
const nodes = new Map<number, Node>((cpu.nodes as Node[]).map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of nodes.values()) for (const c of n.children ?? []) parent.set(c, n.id);
const name = (n: Node) => `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()?.replace(/-[\w-]{8}\.js$/, ".js")}:${n.callFrame.lineNumber + 1}`;
const self = new Map<string, number>(), total = new Map<string, number>();
let all = 0, idle = 0;
(cpu.samples as number[]).forEach((id, i) => {
  const dt = cpu.timeDeltas[i] as number;
  all += dt;
  const n = nodes.get(id)!;
  if (n.callFrame.functionName === "(idle)") { idle += dt; return; }
  self.set(name(n), (self.get(name(n)) ?? 0) + dt);
  const seen = new Set<string>();
  for (let j: number | undefined = id; j !== undefined; j = parent.get(j)) {
    const k = name(nodes.get(j)!);
    if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + dt); }
  }
});
const pct = (v: number) => `${((v / all) * 100).toFixed(1).padStart(5)}%`;
console.log(`\nprofile ${(all / 1e6).toFixed(1)} s, idle ${pct(idle)}\nself:`);
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${pct(v)}  ${k}`);
console.log("total:");
for (const [k, v] of [...total].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${pct(v)}  ${k}`);

ws.close();
await Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r(null) : (c.once("exit", r), c.kill())))));
if (!keepProfile) await rm(profile, { recursive: true, force: true });
process.exit(0);
