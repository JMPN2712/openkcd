// End-to-end install test in headless Chrome: builds the app, serves it, starts Chrome,
// hands the page an installer folder through its folder input, clicks
// Install, waits, then checks the copy in OPFS: each installed file's size,
// and a SHA-256 of its first 64 MiB against the same file in GAME_ROOT.
// Paks the install repacked (repacked.json) are checked for their recorded
// sizes instead; scripts/test-repack.ts checks their contents.
// Driven over the DevTools protocol (Node's built-in WebSocket); no npm deps.
// With --compact=full|potato it installs the compact package instead (compactInstall.ts) and
// checks that only the package and its store are left, and that the page opens them.
// usage: node scripts/test-install-browser.ts INSTALLER_DIR [--root=GAME_ROOT] [--keep] [--compact=full|potato]
//   INSTALLER_DIR must hold real files: Chrome's folder upload skips symlinks.
//   --keep keeps the browser profile (and its OPFS copy) for a later run.
//   CHROME=… picks the browser binary, PROFILE_DIR=… where the profile goes
//   (it holds the installed copy: tens of GB).

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { open, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "");
const root = process.argv.find((a) => a.startsWith("--root="))?.slice(7) ?? join(homedir(), "kcd1");
const keep = process.argv.includes("--keep");
const compact = process.argv.find((a) => a.startsWith("--compact="))?.slice(10);
const chrome = process.env.CHROME ?? "google-chrome";
// a throwaway profile on disk (not tmpdir(): /tmp is often a small tmpfs); with --keep it stays for a later run
const profile = join(process.env.PROFILE_DIR ?? join(homedir(), ".cache"), "openkcd-test-profile");
const PORT = 5199;
const DEBUG = 9339;

const children: ChildProcess[] = [];
const stop = () => children.forEach((c) => c.kill());
process.on("exit", stop);

let onTimeout: () => Promise<string> = async () => "";
async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}. ${await onTimeout().catch(() => "")}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// a production build, not the dev server: an edit during a long run would reload the page and stall it
const dist = join(tmpdir(), "openkcd-test-dist");
const build = spawn("node_modules/.bin/vite", ["build", "--outDir", dist, "--emptyOutDir"], { stdio: "ignore" });
if ((await new Promise((r) => build.once("exit", r))) !== 0) throw new Error("vite build failed");
children.push(spawn("node_modules/.bin/vite", ["preview", "--outDir", dist, "--port", String(PORT), "--strictPort"], { stdio: "ignore" }));
await waitFor("Vite", async () => ((await fetch(`http://localhost:${PORT}/`)).ok ? true : undefined));
children.push(
  // Chrome on Linux has no WebGPU adapter without Vulkan
  spawn(chrome, ["--headless=new", "--enable-features=Vulkan", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" }),
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
  if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) console.log(`page ${msg.params.type}:`, msg.params.args.map((a: any) => a.value ?? a.description).join(" "));
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
await page("Runtime.enable");
await page("Page.navigate", { url: `http://localhost:${PORT}/` }); // after Runtime.enable, so load errors are reported
onTimeout = () => evaluate<string>(`"Page: " + document.getElementById("status").textContent + " | " + document.getElementById("preview").textContent.slice(0, 400)`);
async function evaluate<T>(expression: string): Promise<T> {
  const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value as T;
}
// module scripts have run once the document is complete
await waitFor("the page", () => evaluate<boolean>(`document.readyState === "complete" && !!document.getElementById("install-input")`).then((v) => v || undefined));

// hand the folder to the input, as picking it would
const { root: doc } = await page("DOM.getDocument");
const { nodeId } = await page("DOM.querySelector", { nodeId: doc.nodeId, selector: "#install-input" });
await page("DOM.setFileInputFiles", { nodeId, files: [dir] });
// Chrome fills the input asynchronously and fires "change" itself; Chromium fired none, so
// fire one only if the page hasn't reacted. Folder uploads skip symlinks.
const picked = await waitFor("the picked files", () => evaluate<number>(`document.getElementById("install-input").files.length`).then((n) => n || undefined));
await new Promise((r) => setTimeout(r, 1000));
await evaluate(`document.getElementById("preview").textContent.trim() || document.getElementById("install-input").dispatchEvent(new Event("change"))`);
console.log(`picked ${picked} files from ${dir}`);

const listed = await waitFor("the installer list", () =>
  evaluate<string | null>(`(() => { const b = document.querySelector(".install-go"); const e = document.querySelector(".preview-body .error"); return e ? "ERROR " + e.textContent : b ? [...document.querySelectorAll(".install-list li")].map((li) => li.textContent).join("\\n") : null; })()`).then((v) => v ?? undefined),
);
console.log(listed);
if (listed.startsWith("ERROR")) process.exit(1);

if (compact) {
  await evaluate(`(() => { const m = document.querySelector(".install-mode"); m.value = ${JSON.stringify(compact)}; m.dispatchEvent(new Event("change")); })()`);
  await new Promise((r) => setTimeout(r, 500));
  console.log(await evaluate<string>(`[...document.querySelectorAll(".preview-body .note")].map((n) => n.textContent).find((t) => /storage/.test(t)) ?? ""`));
}
const t0 = Date.now();
await evaluate(`document.querySelector(".install-go").click()`);
let lastLine = "";
const outcome = await waitFor(
  "the install",
  async () => {
    const s = await evaluate<{ line: string; result: string; cls: string; busy: boolean }>(
      `(() => { const r = document.querySelector(".install-line ~ .note, .install-line ~ .error"); const b = document.querySelector(".install-go"); return { line: document.querySelector(".install-line")?.textContent ?? "", result: r?.textContent ?? "", cls: r?.className ?? "", busy: b.disabled }; })()`,
    );
    if (s.line && s.line !== lastLine && Date.now() % 15000 < 600) console.log("  " + s.line);
    lastLine = s.line;
    return s.busy ? undefined : s;
  },
  4 * 3600 * 1000,
);
console.log(`${outcome.result} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
if (!outcome.cls.includes("ok")) process.exit(1);
const quit = async (code: number) => {
  ws.close();
  // Chrome keeps writing its profile until it has exited
  await Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r(null) : (c.once("exit", r), c.kill())))));
  if (!keep) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  process.exit(code);
};
if (compact && outcome.cls.includes("part-next")) {
  // part by part: stopped for the next slice; what was copied so far is staged
  const staged = await evaluate<string[]>(`(async () => {
    const out = [];
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("compact-staging");
    async function walk(d, prefix) { for await (const [n, h] of d.entries()) h.kind === "directory" ? await walk(h, prefix + n + "/") : out.push(prefix + n + " " + (await h.getFile()).size); }
    await walk(d, "");
    return out;
  })()`);
  console.log(`staged: ${staged.join(", ")}`);
  await quit(staged.length ? 0 : 1);
}

if (compact) {
  // only the package and its store are left in OPFS, and the page opens them
  const left = await evaluate<{ name: string; bytes: number }[]>(`(async () => {
    const out = [];
    async function size(d) { let n = 0; for await (const [, h] of d.entries()) n += h.kind === "directory" ? await size(h) : (await h.getFile()).size; return n; }
    for await (const [name, h] of (await navigator.storage.getDirectory()).entries()) out.push({ name, bytes: h.kind === "directory" ? await size(h) : (await h.getFile()).size });
    return out;
  })()`);
  console.log(`OPFS: ${left.map((l) => `${l.name} ${(l.bytes / 2 ** 30).toFixed(2)} GiB`).join(", ")}`);
  let bad = left.some((l) => l.name !== `slim-${compact}`) ? 1 : 0;
  if (bad) console.log("FAIL something besides the package is left in OPFS");
  const opened = await evaluate<string>(`(async () => {
    for (let i = 0; i < 100 && document.getElementById("package").hidden; i++) await new Promise((r) => setTimeout(r, 100));
    document.getElementById("package").click();
    for (let i = 0; i < 300 && !/archives/.test(document.getElementById("status").textContent); i++) await new Promise((r) => setTimeout(r, 100));
    return document.getElementById("status").textContent;
  })()`);
  console.log(`status: ${opened}`);
  if (!/Compact package.*archives/.test(opened)) bad++;
  await quit(bad ? 1 : 0);
}

// check the OPFS copy against GAME_ROOT
const installed = await evaluate<{ path: string; size: number; sha: string }[]>(`(async () => {
  const out = [];
  const game = await (await navigator.storage.getDirectory()).getDirectoryHandle("game");
  async function walk(d, prefix) {
    for await (const [n, h] of d.entries()) {
      if (h.kind === "directory") await walk(h, prefix + n + "/");
      else {
        const f = await h.getFile();
        const head = await f.slice(0, 64 << 20).arrayBuffer();
        const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", head))].map((b) => b.toString(16).padStart(2, "0")).join("");
        out.push({ path: prefix + n, size: f.size, sha });
      }
    }
  }
  await walk(game, "");
  return out;
})()`);
let failures = 0;
let compared = 0;
let repacked = 0;
const manifest = installed.find((f) => f.path === "repacked.json");
const sizes: Record<string, { from: number; to: number }> = manifest
  ? await evaluate(`(async () => {
      const game = await (await navigator.storage.getDirectory()).getDirectoryHandle("game");
      return JSON.parse(await (await (await game.getFileHandle("repacked.json")).getFile()).text());
    })()`)
  : {};
for (const f of installed) {
  if (f === manifest) continue;
  const r = sizes[f.path.toLowerCase()];
  if (r && f.size === r.to) {
    const st = await stat(join(root, f.path)).catch(() => null);
    if (st && st.size !== r.from) {
      failures++;
      console.log(`FAIL ${f.path}: repacked from ${r.from} bytes, the original has ${st.size}`);
    }
    repacked++;
    continue;
  }
  const fh = await open(join(root, f.path)).catch(() => null);
  if (!fh) continue; // not installed in GAME_ROOT (e.g. the HD voice packs)
  const size = (await fh.stat()).size;
  const head = Buffer.alloc(Math.min(size, 64 << 20));
  await fh.read(head, 0, head.length, 0);
  await fh.close();
  const sha = createHash("sha256").update(head).digest("hex");
  compared++;
  if (size !== f.size || sha !== f.sha) {
    failures++;
    console.log(`FAIL ${f.path}: ${f.size} bytes ${f.sha.slice(0, 12)}, expected ${size} bytes ${sha.slice(0, 12)}`);
  }
}
console.log(`${installed.length} files in OPFS, ${compared} compared with ${root}, ${repacked} repacked, ${failures} failures`);

// the page offers the installed copy and opens it
const opened = await evaluate<string>(`(async () => {
  document.getElementById("installed").click();
  for (let i = 0; i < 100 && !/archives/.test(document.getElementById("status").textContent); i++) await new Promise((r) => setTimeout(r, 100));
  return document.getElementById("status").textContent;
})()`);
console.log(`status: ${opened}`);
if (!/archives/.test(opened)) failures++;

ws.close();
// Chrome keeps writing its profile until it has exited
await Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r(null) : (c.once("exit", r), c.kill())))));
if (!keep) await rm(profile, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
