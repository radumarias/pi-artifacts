// A watched read shared by everyone who watches it: one Source object per call (server, tool, input), polling once per
// interval for all its subscribers and telling them only when the value moved. Only for servers whose results every
// viewer shares and that do not sign in each user (RunnerHost.sharedWatch): one person's read is anyone's there.

import { callIdentity, canonicalJson } from "../../../shared/canonical.ts";
import type { Value } from "../../../shared/conditions.ts";
import type { LookStep } from "../../../shared/agents.ts";
import { errorMessage, sha256Hex } from "../../../shared/util.ts";
import type { Sql } from "../../members.ts";

/** Who watches through a Source: an agent, in its owner's home conversation. */
export interface Subscriber {
  uid: string;
  chatId: string;
  agentId: string;
}

/** The Source object's name for a read: a hash of its call identity. */
export function sourceName(step: Pick<LookStep, "server" | "tool" | "input">): Promise<string> {
  return sha256Hex(callIdentity(step.server, step.tool, step.input));
}

/** What a Source needs around it: the read, the subscribers' objects, an alarm and a clock. Tests pass fakes. */
export interface SourceHost {
  read(step: Pick<LookStep, "server" | "tool" | "input">): Promise<Value>;
  /** Tell a subscriber the value; `source` is this Source's name, so it can tell a read it no longer watches. */
  notify(subscriber: Subscriber, value: Value, source: string): Promise<void>;
  setAlarm(at: number): void;
  now(): number;
}

type SubscriberRow = { uid: string; chat_id: string; agent_id: string; every_minutes: number; fresh: number };

/**
 * A Source's state and rules, in its SQLite: the read it makes, who subscribes and how often each wants it, and the last
 * value it saw. It polls at the shortest interval any subscriber asked for; a value that did not move tells nobody.
 */
export class SourceCore {
  readonly #sql: Sql;
  readonly #host: SourceHost;
  /** Its name (sourceName of its call), worked out once. */
  #name: Promise<string> | undefined;

  constructor(sql: Sql, host: SourceHost) {
    this.#sql = sql;
    this.#host = host;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS source_call (id INTEGER PRIMARY KEY CHECK (id = 1), step TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_subscribers (
        uid TEXT NOT NULL, chat_id TEXT NOT NULL, agent_id TEXT NOT NULL, every_minutes INTEGER NOT NULL,
        -- 1 until the subscriber is told a value: the next poll tells it even when the value did not move.
        fresh INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (uid, agent_id)
      );
      CREATE TABLE IF NOT EXISTS source_last (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }

  #subscribers(): SubscriberRow[] {
    return this.#sql.exec("SELECT * FROM source_subscribers").toArray() as SubscriberRow[];
  }

  #interval(): number | null {
    const row = (this.#sql.exec("SELECT MIN(every_minutes) AS every FROM source_subscribers").toArray()[0] as { every: number | null });
    return row.every === null ? null : row.every * 60_000;
  }

  #anyone(): boolean {
    return this.#sql.exec("SELECT 1 FROM source_subscribers LIMIT 1").toArray().length > 0;
  }

  subscribe(step: Pick<LookStep, "server" | "tool" | "input">, subscriber: Subscriber, everyMinutes: number): void {
    this.#sql.exec("INSERT OR REPLACE INTO source_call (id, step) VALUES (1, ?)", canonicalJson({ server: step.server, tool: step.tool, input: step.input }));
    this.#sql.exec(
      "INSERT OR REPLACE INTO source_subscribers (uid, chat_id, agent_id, every_minutes, fresh) VALUES (?, ?, ?, ?, 1)",
      subscriber.uid,
      subscriber.chatId,
      subscriber.agentId,
      everyMinutes,
    );
    // A new subscriber is told the value as it is now, as a watch of its own is at its first check: one read, now. The
    // others hear of it only when it moved, and their next poll is an interval from this one.
    this.#host.setAlarm(this.#host.now());
  }

  /** Whether anyone still subscribes. */
  unsubscribe(subscriber: Pick<Subscriber, "uid" | "agentId">): boolean {
    this.#sql.exec("DELETE FROM source_subscribers WHERE uid = ? AND agent_id = ?", subscriber.uid, subscriber.agentId);
    return this.#anyone();
  }

  /** Read once for every subscriber; tell them when the value moved, and new subscribers in any case. Sets the next poll. */
  async poll(): Promise<{ moved: boolean; told: number }> {
    const subscribers = this.#subscribers();
    const call = this.#sql.exec("SELECT step FROM source_call").toArray()[0] as { step: string } | undefined;
    if (!subscribers.length || !call) return { moved: false, told: 0 };
    this.#host.setAlarm(this.#host.now() + this.#interval()!);
    const value = await this.#host.read(JSON.parse(call.step) as LookStep);
    const json = canonicalJson(value);
    const last = this.#sql.exec("SELECT value FROM source_last").toArray()[0] as { value: string } | undefined;
    const moved = last?.value !== json;
    if (moved) this.#sql.exec("INSERT OR REPLACE INTO source_last (id, value, at) VALUES (1, ?, ?)", json, this.#host.now());
    const telling = moved ? subscribers : subscribers.filter((row) => row.fresh === 1);
    const source = await (this.#name ??= sourceName(JSON.parse(call.step) as LookStep));
    const told = await Promise.allSettled(
      telling.map((row) => this.#host.notify({ uid: row.uid, chatId: row.chat_id, agentId: row.agent_id }, value, source)),
    );
    told.forEach((result, index) => {
      const row = telling[index];
      if (result.status === "rejected") console.error("source notify:", errorMessage(result.reason));
      // A subscriber not told (the new value is saved already) is told at the next poll, as a new one is.
      const fresh = result.status === "rejected" ? 1 : 0;
      if (row.fresh !== fresh) this.#sql.exec("UPDATE source_subscribers SET fresh = ? WHERE uid = ? AND agent_id = ?", fresh, row.uid, row.agent_id);
    });
    return { moved, told: told.filter((result) => result.status === "fulfilled").length };
  }
}
