// A fight in the world view: the rules (combat.ts) stepped each frame, and what they report
// played as the game's combat fragments on Henry and the NPC (CombatAttack by the attack row's
// tags, CombatBlockImpact, CombatBlockPerfect, CombatDodge, CombatHit, CombatDeath, CombatIdle
// between). A first cut: fists only, two fighters, the NPC stands where the fight began.
// OURS, not from the notes: the keys, the choice of reaction variants by overlapping tags, and
// playing the death fragment for a knock-out.

import type { Clip } from "./anim.ts";
import { Fight, P, type CombatDb, type FightEvent, type Fighter } from "./combat.ts";
import type { AnimLibrary, FragmentClip } from "./mannequin.ts";

/** How a fighter's clips reach the screen (Henry's overlay, an NPC's override). */
export interface Puppet {
  lib: AnimLibrary;
  /** what the fighter holds, as the fragments' state tags ("r_noweapon") */
  state: string[];
  play(clip: Clip | null, o: { loop: boolean; hold: boolean }): void;
}

export class FightView {
  readonly fight: Fight;
  private readonly puppets: [Puppet, Puppet];
  private readonly names: [string, string];
  /** the last thing that happened, for the HUD */
  last = "";
  /** seconds since each fighter's last action clip began, and its length (then back to the idle) */
  private busy: [number, number] = [0, 0];
  private idle: [FragmentClip | null, FragmentClip | null] = [null, null];
  private ended = false;

  constructor(db: CombatDb, henry: Fighter, foe: Fighter, puppets: [Puppet, Puppet], names: [string, string], random?: () => number) {
    this.fight = new Fight(db, henry, foe, { random });
    this.puppets = puppets;
    this.names = names;
    puppets.forEach((p, i) => void p.lib.tagged("CombatIdle", p.state, ["rightGuard", "sZ2", "oppMale"]).then((c) => { this.idle[i] = c; if (this.busy[i] <= 0) this.toIdle(i); }));
  }

  private toIdle(i: number): void {
    if (this.fight.a[i].out) return;
    const c = this.idle[i];
    this.puppets[i].play(c?.clip ?? null, { loop: true, hold: false });
  }

  private act(i: number, fragment: string, want: string[], hold = false): void {
    const p = this.puppets[i];
    this.busy[i] = 0.6;
    void p.lib.tagged(fragment, p.state, want).then((c) => {
      if (!c) return;
      this.busy[i] = hold ? Infinity : c.seconds;
      p.play(c.clip, { loop: false, hold });
    });
  }

  /** Henry's input. `zone`: 0 head, 1 upper left, 2 upper right, 3 lower left, 4 lower right, 5 centre. */
  attack(input: number, zone = 2): boolean {
    return this.fight.attack(0, input, zone);
  }

  /** Block held or released; pressing it is also the perfect-block press. */
  block(on: boolean): void {
    this.fight.block(0, on);
    if (on) this.fight.press(0, "perfectBlock");
  }

  dodge(): void {
    this.fight.press(0, "dodge");
  }

  get over(): boolean {
    return this.fight.over;
  }

  private show(e: FightEvent): void {
    const who = (i: number) => this.names[i];
    if (e.kind === "attack") {
      this.act(e.by, "CombatAttack", e.row.tags.split("+"));
      this.last = `${who(e.by)} attacks (${e.type})`;
    } else if (e.kind === "hit") {
      const d = 1 - e.by;
      const guard = ["rightGuard", "dZ0", "sZ0", "oppMale", "hitTypeNormal"];
      if (e.answer === "perfectBlock" || e.answer === "masterStrike") this.act(d, "CombatBlockPerfect", guard);
      else if (e.answer === "dodge") this.act(d, "CombatDodge", [...guard, "move_back"]);
      else if (e.block === "full" || e.block === "partial") this.act(d, "CombatBlockImpact", guard);
      else if (!this.fight.a[d].out) this.act(d, "CombatHit", guard);
      const what = e.answer === "perfectBlock" ? "a perfect block" : e.answer === "masterStrike" ? "a master strike" : e.answer === "dodge" ? "a dodge" : e.block === "full" ? "a block" : e.block === "partial" ? "a partial block" : e.block === "broken" ? "a broken block" : "a hit";
      this.last = `${who(d)}: ${what}${e.health > 0 ? `, −${e.health.toFixed(0)} health` : ""}`;
    } else if (e.kind === "counter") {
      this.act(1 - e.by, "CombatHit", ["rightGuard", "dZ0", "hitTypeNormal"]);
      this.last = `${who(e.by)} counters${e.health > 0 ? `, −${e.health.toFixed(0)} health` : ""}`;
    } else {
      this.act(e.who, "CombatDeath", ["death", "rightGuard", "dZ0"], true);
      this.last = `${who(e.who)} is ${e.how === "dead" ? "dead" : "knocked out"}`;
    }
  }

  /** Advance by `dt` play seconds; `inReach`: the two stand within striking distance. */
  update(dt: number, inReach: boolean): void {
    this.fight.inReach = inReach;
    if (this.fight.over) { this.ended = true; return; }
    for (const e of this.fight.step(dt)) this.show(e);
    for (let i = 0; i < 2; i++) {
      if (this.busy[i] <= 0) continue;
      this.busy[i] -= dt;
      if (this.busy[i] <= 0) this.toIdle(i);
    }
    if (this.fight.over && !this.ended) this.ended = true;
  }

  /** One line for the HUD: both fighters' health and stamina, and the last event. */
  summary(): string {
    const bar = (i: number) => { const s = this.fight.a[i]; return `${this.names[i]} health ${s.health.toFixed(0)} stamina ${s.stamina.toFixed(0)}${s.out ? ` (${s.out === "dead" ? "dead" : "knocked out"})` : ""}`; };
    return `Fight: ${bar(0)} · ${bar(1)}${this.last ? ` · ${this.last}` : ""}${this.fight.over ? " · over" : ""}`;
  }
}

/** Striking distance for fists and one-hand weapons (the attack rows' reach is about 1–1.7 m). */
export const REACH = 1.8;
export { P as COMBAT_PARAMS };
