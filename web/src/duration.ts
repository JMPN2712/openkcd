// Duration strings and the clocks they run on, from the research notes (bt-rules.md "The Wait
// node", quest-system.md "Timeout suffixes", dialogue.md "Availability and timeout"):
// - units ms, s, m, h, d, summed ("1m 30s"); parsing stops at '#' (the clock suffix);
// - "infinite", "-1" and "oo" mean forever;
// - "#WT" runs on the world clock (15× real time), "#GT" or no suffix on the play clock (1× real
//   time, stopped while the game is paused). Behaviour-tree Waits pick their clock with timeType
//   instead (GameTime: play clock, WorldTime: world clock); dialogue cooldowns are play time.

/** The world clock's rate against real (play) time. */
export const WORLD_TIME_RATE = 15;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Milliseconds of a duration (`'10s'`, `'1m 30s'`, `'500ms'`, `'2h #WT'`); Infinity for the forever
 * forms; null when the text is not a duration. A number without a unit is milliseconds, the
 * parser's base unit (ASSUMPTION: the notes list the units only; trees write "500" beside "500ms").
 */
export function durationMs(v: string | number): number | null {
  if (typeof v === "number") return v < 0 ? Infinity : v;
  let s = v.trim().toLowerCase();
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash).trim();
  if (s === "infinite" || s === "oo" || s === "-1") return Infinity;
  if (s === "") return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)(?![a-z])/g)];
  if (!parts.length || parts.map((m) => m[0]).join("").replace(/\s/g, "") !== s.replace(/\s/g, "")) return null;
  // (the game sums whole milliseconds per term)
  return parts.reduce((t, m) => t + Math.trunc(Number(m[1]) * UNIT_MS[m[2]]), 0);
}

/** The clock a timer string runs on: "#WT" the world clock, "#GT" or none the play clock. */
export function timerClock(v: string): "world" | "play" {
  const hash = v.indexOf("#");
  return hash >= 0 && v.slice(hash + 1).trim().toUpperCase().startsWith("WT") ? "world" : "play";
}
