// The quests' own behaviour trees (research notes, quest-system.md "The quest's tree"). A quest
// with a smart object has an entity of its name in the level (class QuestObject), whose brain's
// always-active subbrain runs the quest's tree from Libs/AI/quests. The quest state announces
// every change to that entity's QuestMailbox, and the tree answers with SetQuestObjective, messages
// to NPCs and daily-cycle patches.
//
// A new game sends questModule:onNewGame to every quest; q_master_main's tree takes it from there
// (it starts its objective named after the first story quest, which activates that quest).

import type { AiWorld } from "./btWorld.ts";
import type { Task } from "./btRuntime.ts";
import type { QuestEvent, QuestSystem } from "./quests.ts";

// message states as the trees compare them: enum values are "<enum>.<value>" (typeDefs.ts)
const QUEST_STATE = ["Started", "Completed", "Canceled", "Failed", "Reset", "Active"].map((v) => `QuestState.${v}`);
const OBJECTIVE_STATE = ["Started", "Completed", "Canceled", "Expired"].map((v) => `ObjectiveState.${v}`);

export class QuestBrains {
  private tasks = new Map<number, Task>();
  /** quest (canonical name) → its entity */
  readonly entities = new Map<string, number>();

  private readonly world: AiWorld;
  private readonly quests: QuestSystem;

  /**
   * `runs`: whether a quest's tree runs (diet mode: a cut quest's doesn't, so what only its tree
   * spawns stays unspawned); `only`: run just these quests (tests).
   */
  constructor(world: AiWorld, quests: QuestSystem, o: { runs?: (quest: string) => boolean; only?: string[] } = {}) {
    this.world = world;
    this.quests = quests;
    const only = o.only ? new Set(o.only.map((q) => quests.db.canonical(q))) : null;
    for (const e of world.o.ents.values()) {
      if (e.cls !== "QuestObject") continue;
      const q = quests.db.canonical(e.name);
      if (!q || this.entities.has(q) || (only && !only.has(q)) || (o.runs && !o.runs(q))) continue;
      this.entities.set(q, e.id);
    }
    quests.on((e) => this.announce(e));
  }

  /** Start the trees (each quest's subbrain is always active). Returns how many run. */
  start(): number {
    for (const [, id] of this.entities) {
      if (this.tasks.has(id)) continue;
      const task = this.world.startObjectBrain(id);
      if (task) this.tasks.set(id, task);
    }
    return this.tasks.size;
  }

  /** A new game: every quest hears of it; `runStory` false is a game without the story (a test level). */
  newGame(runStory = true): void {
    for (const id of this.tasks.keys()) this.world.send(id, { type: "questModule:onNewGame", fields: { runStory }, sender: id });
  }

  /** The quest state's announcements, as messages to the quest's entity. */
  private announce(e: QuestEvent): void {
    const id = this.entities.get(e.quest);
    if (id === undefined || !this.tasks.has(id)) return;
    if (e.kind === "quest") {
      // a visible quest's start is announced twice (the banner, then the message): one message
      if (e.state === 0 && e.banner) return;
      this.world.send(id, { type: "questModule:onQuest", fields: { State: QUEST_STATE[e.state] }, sender: id });
    } else if (e.kind === "objective") {
      this.world.send(id, { type: "questModule:onObjective", fields: { State: OBJECTIVE_STATE[e.state], ObjectiveId: e.objective, ObjectiveName: this.quests.db.objective(e.quest, e.objective)?.name ?? "" }, sender: id });
    }
  }

  /** Tick every quest's tree once. A tree that ends is not restarted. */
  tick(): void {
    for (const [id, task] of this.tasks) {
      if (task.tick() !== "running") { this.tasks.delete(id); this.ended.push(id); }
    }
  }

  /** Tick one quest's tree (debugging). */
  tickOne(id: number): void {
    this.tasks.get(id)?.tick();
  }

  /** entities whose tree ended (most trees loop forever; an ended one is worth a look) */
  readonly ended: number[] = [];
}
