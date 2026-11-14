// NPC messaging (research notes, npc-messaging.md): mailboxes from the AI tables, routing of
// a message to the receiver's mailboxes, and the queues the reader nodes take messages from.
//
// A message goes to the mailboxes the receiver has right now: its brain's (brain2mailbox), plus
// those of the smart-area and smart-object behaviours it is running (sa_/so_behaviour_tag2mailbox).
// A mailbox accepts it when one of its filter types is the message's type or an ancestor of it
// (`garrison` catches `garrison:register`); a consuming mailbox ends the routing, a continuing one
// lets later mailboxes take it too. A full mailbox drops its oldest message (the engine default).

import type { Row } from "./tables.ts";
import type { Value } from "./btRuntime.ts";

export interface Mailbox {
  name: string;
  /** -1: unlimited */
  limit: number;
  /** on_accept 2 (the engine's default): the routing stops here; 1: later mailboxes get it too */
  consume: boolean;
  /** accepted types; "" (the root) accepts every message */
  types: string[];
}

export interface Message {
  type: string;
  fields: Record<string, Value>;
  sender: number;
  /** called once a ProcessMessage handler has finished with it, with its answerVar's value */
  processed?: (answer: Value | undefined) => void;
}

/** Whether `type` is `filter` or below it in the colon hierarchy ("" is the root). */
export function typeMatches(type: string, filter: string): boolean {
  if (filter === "") return true;
  const t = type.toLowerCase(), f = filter.toLowerCase();
  return t === f || t.startsWith(`${f}:`);
}

/** The mailbox tables: mailboxes by brain and by behaviour tag, each with its priority. */
export class MailDb {
  private boxes = new Map<string, Mailbox>();
  private byBrain = new Map<string, { box: Mailbox; priority: number }[]>();
  private byTag = new Map<string, { box: Mailbox; priority: number }[]>();

  /** `known`: whether a type name is declared (an unknown filter type falls back to the root). */
  constructor(t: { mailbox: Row[]; filter: Row[]; brain: Row[]; saTag: Row[]; soTag: Row[] }, known: (type: string) => boolean) {
    for (const r of t.mailbox) {
      this.boxes.set(r.mailbox_id, { name: r.mailbox_name, limit: Number(r.message_limit || -1), consume: r.on_accept !== "1", types: [] });
    }
    for (const r of t.filter) {
      const b = this.boxes.get(r.mailbox_id);
      if (!b) continue;
      const type = known(r.type) ? r.type : "";
      if (!b.types.includes(type)) b.types.push(type);
    }
    const add = (map: Map<string, { box: Mailbox; priority: number }[]>, key: string, r: Row) => {
      const box = this.boxes.get(r.mailbox_id);
      if (!box || !key) return;
      const list = map.get(key) ?? [];
      list.push({ box, priority: Number(r.priority || 0) });
      map.set(key, list);
    };
    for (const r of t.brain) add(this.byBrain, r.brain_id, r);
    for (const r of t.saTag) add(this.byTag, r.sa_behaviour_tag_id, r);
    for (const r of t.soTag) add(this.byTag, r.so_behaviour_tag_id, r);
  }

  /**
   * An entity's mailboxes now, in routing order. ASSUMPTION: a higher priority is offered first
   * (nearly every attachment row has priority 0; the note doesn't give the direction).
   */
  mailboxes(brain: string | undefined, tags: Iterable<string>): Mailbox[] {
    const list = [...(brain ? this.byBrain.get(brain) ?? [] : [])];
    for (const t of tags) list.push(...(this.byTag.get(t) ?? []));
    const seen = new Set<Mailbox>();
    return list.sort((a, b) => b.priority - a.priority).map((x) => x.box).filter((b) => !seen.has(b) && !!seen.add(b));
  }

  static TABLES = { mailbox: "ai/mailbox", filter: "ai/mailbox_filter", brain: "ai/brain2mailbox", saTag: "ai/sa_behaviour_tag2mailbox", soTag: "ai/so_behaviour_tag2mailbox" } as const;
}

/** The queued messages, per entity and mailbox name. */
export class PostOffice {
  private queues = new Map<number, Map<string, Message[]>>();
  delivered = 0;
  dropped = 0;

  /** Route a message into the receiver's mailboxes; false when none took it. */
  deliver(to: number, msg: Message, boxes: Mailbox[]): boolean {
    let taken = false;
    for (const b of boxes) {
      if (!b.types.some((f) => typeMatches(msg.type, f))) continue;
      const q = this.queue(to, b.name);
      q.push(msg);
      if (b.limit >= 0 && q.length > b.limit) q.shift();
      taken = true;
      if (b.consume) break;
    }
    if (taken) this.delivered++;
    else this.dropped++;
    return taken;
  }

  /** The oldest message in the mailbox that `accept` takes, removed from it. */
  take(at: number, box: string, accept: (m: Message) => boolean): Message | undefined {
    const q = this.queues.get(at)?.get(box);
    if (!q) return undefined;
    const i = q.findIndex(accept);
    return i < 0 ? undefined : q.splice(i, 1)[0];
  }

  /** ClearInbox: drop the mailbox's messages, or only those of one type. */
  clear(at: number, box: string, type = ""): void {
    const q = this.queues.get(at)?.get(box);
    if (!q) return;
    const keep = q.filter((m) => type !== "" && !typeMatches(m.type, type));
    q.splice(0, q.length, ...keep);
  }

  /** An entity left the simulation: its mail goes with it. */
  forget(at: number): void {
    this.queues.delete(at);
  }

  private queue(at: number, box: string): Message[] {
    let m = this.queues.get(at);
    if (!m) { m = new Map(); this.queues.set(at, m); }
    let q = m.get(box);
    if (!q) { q = []; m.set(box, q); }
    return q;
  }
}
