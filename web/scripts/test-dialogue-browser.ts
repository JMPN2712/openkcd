// Conversations in the world view, in real (headless) Chrome: Henry talks to Rataje's tailor (the
// debug control's talk by name, which steps Henry up to the NPC). Checks that the dialogue camera takes over and frames whoever
// speaks (the HUD names the shot and the one framed), that Henry turns to face the tailor, that
// Backspace at the menu ends the conversation (its "end topic", then the farewell) and so does a
// choice that ends it (trade, flag 1), and that afterwards the normal camera is back and S walks
// Henry again. --screenshot=PREFIX saves the view at each new shot (game content: never commit).
// Builds the app and drives Chrome as profile-browser.ts does.
// Then the bailiff (--henry-npc=NAME), whose first topic has Henry speak: Henry's lines frame Henry.
// usage: node scripts/test-dialogue-browser.ts [--root=GAME_ROOT] [--preset=potato] [--at=x,y] [--henry-npc=NAME] [--screenshot=PREFIX] [--headed]

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromeBinary, chromeGpuFlags } from "./chrome.ts";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const root = arg("root", join(homedir(), "kcd1"));
const preset = arg("preset", "potato");
const [W, H] = arg("size", "1920x1080").split("x").map(Number);
// PORT=… and DEBUG_PORT=…: other ports, so two runs (two checkouts) don't collide
const PORT = Number(process.env.PORT ?? 5199);
const DEBUG = Number(process.env.DEBUG_PORT ?? 9339);

const headed = process.argv.includes("--headed");
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
  // (--headed: a visible window with vsync, as a player has it; frames wait for the display)
  spawn(chromeBinary, [...(headed ? [] : ["--headless=new", "--disable-gpu-vsync", "--disable-frame-rate-limit"]), ...chromeGpuFlags, "--ignore-gpu-blocklist", "--enable-unsafe-webgpu",
    ...(process.env.CHROME_FLAGS ?? "").split(" ").filter(Boolean), `--window-size=${W},${H}`, `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" }),
);
const version = await waitFor("Chrome", async () => (await fetch(`http://127.0.0.1:${DEBUG}/json/version`)).json() as Promise<{ webSocketDebuggerUrl: string }>);

// --- a minimal DevTools protocol client ---
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(String(m.data));
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
// beside the tailor in his shop (he works at his table)
const at = arg("at", "2519.5,542");
await page("Page.navigate", { url: `http://localhost:${PORT}/?at=${at}` });
await waitFor("the page", () => evaluate<boolean>(`document.readyState === "complete" && !!document.getElementById("open-input")`).then((v) => v || undefined));
await evaluate(`localStorage.setItem("openkcd.quality", ${JSON.stringify(preset)})`);
const adapter = await evaluate<string>(`navigator.gpu ? navigator.gpu.requestAdapter().then((a) => a ? a.info.vendor + " " + a.info.architecture + " " + a.info.description : "no adapter") : "no WebGPU"`);
console.log(`WebGPU adapter: ${adapter}`);
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
await evaluate(`document.getElementById("world").click()`);
const hud = () => evaluate<string>(`document.querySelector(".level-hud")?.textContent ?? ""`);
await waitFor("Henry", () => hud().then((s) => (/Henry \(/.test(s) ? s : undefined)), 180000);
await evaluate(`[...document.querySelectorAll("button")].find((b) => /Full window/.test(b.textContent))?.click()`);
let quiet = 0;
await waitFor("the world", () => hud().then((s) => {
  quiet = /instances within/.test(s) && !/oading|Assembling|start once/.test(s) ? quiet + 1 : 0;
  return quiet >= 10 ? true : undefined;
}), 900000);

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const shots = arg("screenshot", "");
let shotNo = 0;
const press = async (code: string, key: string, type?: "keyDown" | "keyUp") => {
  await evaluate(`document.querySelector(".level-canvas").focus()`);
  for (const t of type ? [type] : ["keyDown", "keyUp"] as const) await page("Input.dispatchKeyEvent", { type: t, code, key, windowsVirtualKeyCode: code === "Backspace" ? 8 : key.toUpperCase().charCodeAt(0) });
};
const cameraOf = (h: string) => /camera (\S+) on ([^·(]+?)(?: \((\w+)\))?(?: ·|$)/.exec(h);
const speed = (h: string) => Number(/Henry \([^)]*\)[^·]*?([\d.]+) m\/s/.exec(h)?.[1] ?? NaN);

/**
 * One conversation with `npc`: `atMenu` gives the key pressed at each menu in turn (the last one
 * repeats). Returns what was seen.
 */
async function converse(npc: string, atMenu: [string, string][]): Promise<{ lines: { who: string; camera: string }[]; menus: string[]; end: string }> {
  await evaluate(`(() => { const i = document.querySelector(".level-dialogue-id"); i.value = ${JSON.stringify(npc)}; [...document.querySelectorAll("button")].find((b) => /Dialogue/.test(b.textContent)).click(); })()`);
  const lines: { who: string; camera: string }[] = [], menus: string[] = [];
  let lastSub = "", lastCam = "", lastMenu = "", end = "";
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const [sub, menu, h] = await evaluate<[string, string, string]>(`(() => {
      const s = document.querySelector(".level-subtitle"), m = document.querySelector(".level-dialogue-menu");
      return [s && !s.hidden ? s.textContent : "", m && !m.hidden ? [...m.querySelectorAll("li")].map((li) => li.textContent).join(" | ") : "", document.querySelector(".level-hud")?.textContent ?? ""];
    })()`);
    const cam = cameraOf(h)?.slice(1, 3).join(" on ") ?? "";
    if (cam && cam !== lastCam && shots) {
      await sleep(400);
      const { data } = await page("Page.captureScreenshot", { format: "png" });
      await writeFile(`${shots}${shotNo++}.png`, Buffer.from(data, "base64"));
    }
    if (sub && sub !== lastSub) { lines.push({ who: sub.slice(0, sub.indexOf(":")), camera: cam }); console.log(`  ${sub}  [${cam || "no dialogue camera"}]`); }
    if (menu && menu !== lastMenu) {
      const key = atMenu[Math.min(menus.length, atMenu.length - 1)];
      menus.push(cam);
      console.log(`  menu: ${menu}  [${cam || "no dialogue camera"}]; presses ${key[0]}`);
      await sleep(600);
      await press(...key);
    }
    lastSub = sub; lastMenu = menu; lastCam = cam;
    const info = /Conversation [^·]*|Dialogue: [^·]*/.exec(h)?.[0];
    if (info) { end = info.trim(); console.log(`  ${end}`); break; }
    await sleep(250);
  }
  return { lines, menus, end };
}

// 1. leave at the menu (Backspace: its "end topic")
const before = await hud();
check(!cameraOf(before), "before talking: the normal camera");
const framesSpeaker = (lines: { who: string; camera: string }[], npc: string) => lines.every((l) => !!l.camera && l.camera.endsWith(`on ${l.who === "Henry" ? "Henry" : npc}`));
const one = await converse("rat_tailor", [["Backspace", "Backspace"]]);
check(one.lines.length >= 2, `lines were said (${one.lines.length})`);
check(framesSpeaker(one.lines, "rat_tailor"), `the camera frames whoever speaks (${one.lines.map((l) => `${l.who}: ${l.camera}`).join("; ")})`);
check(one.menus.length === 1 && /on rat_tailor/.test(one.menus[0]), `at the menu the camera frames the tailor (${one.menus.join("; ")})`);
check(/said goodbye/.test(one.end), `Backspace at the menu ends it with the farewell (${one.end || "never ended"})`);
await sleep(500);
const after = await hud();
check(!cameraOf(after), "afterwards the normal camera is back");
// 2. control is back: S walks him (back, away from the tailor he faces)
await press("KeyS", "s", "keyDown");
await sleep(1500);
const walking = speed(await hud());
await press("KeyS", "s", "keyUp");
check(walking > 0.5, `S walks Henry again (${walking} m/s)`);
await sleep(1500);
// 3. a choice that ends the conversation: trade (flag 1), picked with its number
const two = await converse("rat_tailor", [["Digit1", "1"]]);
check(/said goodbye/.test(two.end) && two.menus.length === 1, `trade ends the conversation: no menu after it (${two.end || "never ended"}, ${two.menus.length} menus)`);
await sleep(1500);
// 4. Henry speaks too: the bailiff's first topic; its follow-up menu has no way out but its
// choices (as in the game), so "I can't help you now", then Backspace at the menu
const three = await converse(arg("henry-npc", "rat_bailiff"), [["Digit1", "1"], ["Digit2", "2"], ["Backspace", "Backspace"]]);
const henry = three.lines.filter((l) => l.who === "Henry");
check(henry.length > 0 && framesSpeaker(three.lines, arg("henry-npc", "rat_bailiff")), `Henry's lines frame Henry, the bailiff's the bailiff (${three.lines.map((l) => `${l.who}: ${l.camera}`).join("; ")})`);
check(/said goodbye|over/.test(three.end), `it ends at the menu (${three.end || "never ended"})`);

console.log(fails ? `${fails} FAILED` : "OK");
if (!keepProfile) await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(fails ? 1 : 0);
