// Conversations the behaviour trees ask for (research notes, dialogue.md "Requests from behaviour
// trees"): a RequestDialog node files a request and gets its id; whoever plays conversations (the
// world view's dialogue, a test) takes the oldest waiting one, plays it and reports its end; the
// tree's DoDialog node runs meanwhile. Henry's mother asks for the opening quest's first
// conversation this way (final/dialogUtils.xml#dialogInitiator_instant).

import type { DialogRequest } from "./btWorld.ts";
import type { DialogueDb } from "./dialogue.ts";

export type DialogStatus = "waiting" | "playing" | "done" | "failed";

export interface FiledRequest extends DialogRequest {
  id: number;
  status: DialogStatus;
  /** the topic asked for (by id or label); 0 for a metarole request */
  topic: number;
}

export class DialogRequests {
  private nextId = 1;
  private filed = new Map<number, FiledRequest>();
  private readonly db: DialogueDb | null;

  /** `db` resolves topic labels; without it only topic ids are understood. */
  constructor(db: DialogueDb | null = null) {
    this.db = db;
  }

  /** WorldOptions.requestDialog: file a request. A label that names no topic is refused (0). */
  request(r: DialogRequest): number {
    const topic = r.topicId || (r.label && this.db ? this.db.topicByLabel(r.label) : 0);
    if (!topic && !r.metaroles) return 0;
    const id = this.nextId++;
    this.filed.set(id, { ...r, id, status: "waiting", topic });
    return id;
  }

  /** WorldOptions.dialogStatus. An unknown id reads as failed. */
  status(id: number): DialogStatus {
    return this.filed.get(id)?.status ?? "failed";
  }

  /** The oldest waiting request, if any (`withPlayer`: only ones the player takes part in). */
  next(withPlayer = false): FiledRequest | null {
    for (const r of this.filed.values()) if (r.status === "waiting" && (!withPlayer || r.souls.includes(-1) || r.initiator === -1)) return r;
    return null;
  }

  /** The conversation of request `id` began. */
  begin(id: number): void {
    const r = this.filed.get(id);
    if (r?.status === "waiting") r.status = "playing";
  }

  /** It ended (`played` false: it could not start), and is forgotten once its tree has read that. */
  end(id: number, played = true): void {
    const r = this.filed.get(id);
    if (r) r.status = played ? "done" : "failed";
    // keep the last few ended requests readable; older ones go
    const ended = [...this.filed.values()].filter((x) => x.status === "done" || x.status === "failed");
    for (const x of ended.slice(0, Math.max(0, ended.length - 32))) this.filed.delete(x.id);
  }

  /** Whether a requested conversation with the player is playing. */
  get playerTalking(): boolean {
    for (const r of this.filed.values()) if (r.status === "playing" && (r.souls.includes(-1) || r.initiator === -1)) return true;
    return false;
  }
}
