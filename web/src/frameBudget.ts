// One budget per frame for background work (geometry uploads, model and character decoding):
// each piece of work calls `await workSlice()` before it starts, and that resolves at once while
// this frame's budget lasts, otherwise on a later frame. Before, each task kept to its own few
// milliseconds, and several of them ran in the same gap between two frames (80–130 ms frames
// while streaming).

/** Milliseconds of background work per frame, shared by every task. */
export let FRAME_WORK_MS = 4;

/** Set the budget (the world view raises it while loading, when frames are capped anyway). */
export function setFrameWorkMs(ms: number): void {
  FRAME_WORK_MS = ms;
}

let windowStart = performance.now();
let scheduled = false;
const waiting: (() => void)[] = [];

const now = () => performance.now();
const spent = () => now() - windowStart >= FRAME_WORK_MS;

// a new task at once: chained setTimeout(…, 0) calls are clamped to 4 ms each, which made a
// queue of hundreds of loads crawl
// (Node, for the headless scripts: setImmediate; an open MessageChannel would keep it running)
const immediate = (globalThis as { setImmediate?: (cb: () => void) => void }).setImmediate;
const channel = !immediate && typeof MessageChannel === "function" ? new MessageChannel() : null;
const posted: (() => void)[] = [];
if (channel) channel.port1.onmessage = () => posted.shift()?.();
function post(cb: () => void): void {
  if (immediate) { immediate(cb); return; }
  if (!channel) { setTimeout(cb, 0); return; }
  posted.push(cb);
  channel.port2.postMessage(0);
}

function nextFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(cb, 0));
  else setTimeout(cb, 0);
}

/** A new frame: the budget starts again. */
function tick(): void {
  windowStart = now();
  drain();
}

/**
 * Resume the oldest waiting piece of work, then (as a new task, after it has run up to its next
 * wait) the next one, until the budget is spent; then wait for the next frame. One at a time, so
 * hundreds of waiting loads cost nothing until their turn.
 */
function drain(): void {
  if (!waiting.length) { scheduled = false; return; }
  if (spent()) { nextFrame(tick); return; }
  waiting.shift()!();
  post(drain);
}

/**
 * Wait (if needed) until there is room in the current frame's budget for more background work.
 * The budget is wall time since the frame began, so it also counts work that ran in between
 * without asking.
 */
export function workSlice(): Promise<void> {
  if (!spent() && !waiting.length) return Promise.resolve();
  return new Promise((resolve) => {
    waiting.push(resolve);
    if (!scheduled) { scheduled = true; nextFrame(tick); }
  });
}
