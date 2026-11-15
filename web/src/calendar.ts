// The calendar the scripts read and set (research notes, quest-system.md "Timeout suffixes"): world
// time runs at 15× real time and stops while paused; game (play) time runs at 1×. Scripts move
// the world clock (forwardTime in Scripts/Utils/TimeUtils.lua sets the hour for a quest's scene)
// and pause it (the prologue holds the morning still).

import { WORLD_TIME_RATE } from "./duration.ts";

export class Calendar {
  /** world time in seconds since the start of day 0 */
  world = 0;
  /** play time in seconds */
  game = 0;
  paused = false;
  /** called when a script sets the world time (the view moves its clock) */
  onSet: ((worldSeconds: number) => void) | null = null;

  /** `dt` seconds of play time pass. */
  advance(dt: number): void {
    this.game += dt;
    if (!this.paused) this.world += dt * WORLD_TIME_RATE;
  }

  get hourOfDay(): number {
    return (this.world % 86400) / 3600;
  }

  /** The Calendar script functions (luaHost.ts `calendar`). */
  script(): (fn: string, a?: number | boolean) => number | boolean | null {
    return (fn, a) => {
      switch (fn) {
        case "GetWorldTime": return this.world;
        case "SetWorldTime": if (typeof a === "number" && Number.isFinite(a)) { this.world = a; this.onSet?.(a); } return null;
        case "GetWorldHourOfDay": return this.hourOfDay;
        case "GetWorldDay": return Math.floor(this.world / 86400);
        case "GetGameTime": return this.game;
        case "IsWorldTimePaused": return this.paused;
        case "SetWorldTimePaused": this.paused = a === true || a === 1; return null;
        case "GetWorldTimeRatio": return WORLD_TIME_RATE;
      }
      return null;
    };
  }
}
