// What a user's directory keeps of their limits: their rules for all agents, the log of calls that change data, and the
// index of actions waiting for them across their chats (their feed's Needs you items for them expire by it). The
// actions themselves stay in the chat objects that made them, which run them.

import { checkRules, GuardrailError, type CallLogView, type CallOutcome, type GuardrailRule, type PendingActionView } from "../../../shared/limits.ts";
import type { Sql } from "../../members.ts";

/** How long the log keeps a call: longer than any day a callsPerDay rule counts, and enough to look back on a week. */
const LOG_DAYS = 30;
const MAX_LOG_ROWS = 5_000;
/** The log is pruned once every so many calls, not on each. */
const PRUNE_EVERY = 50;

type CallRow = {
  id: number;
  at: number;
  chat_id: string;
  actor: string;
  agent_id: string | null;
  server: string;
  tool: string;
  outcome: CallOutcome;
  detail: string | null;
};

/** The key-value storage the rules are kept in: a Durable Object's `ctx.storage.kv`, or a test's map. */
export interface Kv {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): unknown;
}

/** A call to log, as the chat that made it tells it; `agentId` when an agent made it (its name may change). */
export type CallEntry = Omit<CallLogView, "id" | "at"> & { agentId?: string };

export class LimitsDirectory {
  readonly #sql: Sql;
  readonly #kv: Kv;
  readonly #now: () => number;
  #logged = 0;

  constructor(sql: Sql, kv: Kv, now: () => number = Date.now) {
    this.#sql = sql;
    this.#kv = kv;
    this.#now = now;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, chat_id TEXT NOT NULL, actor TEXT NOT NULL, agent_id TEXT,
        server TEXT NOT NULL, tool TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls (server, tool, at);
      CREATE INDEX IF NOT EXISTS tool_calls_agent ON tool_calls (agent_id, id);
      CREATE TABLE IF NOT EXISTS waiting_actions (
        chat_id TEXT NOT NULL, id TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (chat_id, id)
      );
    `);
  }

  rules(): GuardrailRule[] {
    return this.#kv.get<GuardrailRule[]>("guardrails") ?? [];
  }

  setRules(input: unknown): GuardrailRule[] | { error: string } {
    try {
      const rules = checkRules(input);
      if (rules.length) this.#kv.put("guardrails", rules);
      else this.#kv.delete("guardrails");
      return rules;
    } catch (error) {
      if (error instanceof GuardrailError) return { error: error.message };
      throw error;
    }
  }

  log(entry: CallEntry): void {
    const now = this.#now();
    this.#sql.exec(
      "INSERT INTO tool_calls (at, chat_id, actor, agent_id, server, tool, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      now,
      entry.chatId,
      entry.actor.slice(0, 64),
      entry.agentId ?? null,
      entry.server,
      entry.tool,
      entry.outcome,
      entry.detail?.slice(0, 500) ?? null,
    );
    if (++this.#logged % PRUNE_EVERY === 1) this.#prune(now);
  }

  /** Calls older than LOG_DAYS, and past the newest MAX_LOG_ROWS, go (ids grow with time). */
  #prune(now: number): void {
    const old = this.#sql.exec("SELECT MAX(id) AS id FROM tool_calls WHERE at < ?", now - LOG_DAYS * 86_400_000).toArray()[0]?.id as number | null;
    const newest = this.#sql.exec("SELECT MAX(id) AS id FROM tool_calls").toArray()[0]?.id as number | null;
    const cut = Math.max(old ?? 0, (newest ?? 0) - MAX_LOG_ROWS);
    if (cut > 0) this.#sql.exec("DELETE FROM tool_calls WHERE id <= ?", cut);
  }

  /**
   * How many calls of server.tool ran since `since`, in all the user's chats: what a callsPerDay rule counts. "*" for
   * the server or the tool counts every one, as such a rule is on all of them.
   */
  callsSince(server: string, tool: string, since: number): number {
    return this.#sql
      .exec(
        "SELECT COUNT(*) AS n FROM tool_calls WHERE (? = '*' OR server = ?) AND (? = '*' OR tool = ?) AND at >= ? AND outcome IN ('ran', 'warned', 'failed')",
        server,
        server,
        tool,
        tool,
        since,
      )
      .toArray()[0].n as number;
  }

  /** The newest calls, of one agent (by id) when given. */
  calls(agentId?: string, limit = 50): CallLogView[] {
    const rows = (
      agentId === undefined
        ? this.#sql.exec("SELECT * FROM tool_calls ORDER BY id DESC LIMIT ?", limit)
        : this.#sql.exec("SELECT * FROM tool_calls WHERE agent_id = ? ORDER BY id DESC LIMIT ?", agentId, limit)
    ).toArray() as CallRow[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      chatId: row.chat_id,
      actor: row.actor,
      server: row.server,
      tool: row.tool,
      outcome: row.outcome,
      ...(row.detail !== null && { detail: row.detail }),
    }));
  }

  /**
   * An action waits for the user in their feed: kept until its chat says it ended, or its time is past (only which and
   * until when: the action itself is in the feed's item).
   */
  addNeedsYou(item: Pick<PendingActionView, "chatId" | "id" | "expiresAt">): void {
    this.#sql.exec("INSERT OR REPLACE INTO waiting_actions (chat_id, id, expires_at) VALUES (?, ?, ?)", item.chatId, item.id, item.expiresAt);
  }

  /** Ones whose chat never said they expired (its alarm or its word lost) go once their time is past: which went. */
  dropExpired(): { chatId: string; id: string }[] {
    return (this.#sql.exec("DELETE FROM waiting_actions WHERE expires_at < ? RETURNING chat_id, id", this.#now()).toArray() as { chat_id: string; id: string }[]).map(
      (row) => ({ chatId: row.chat_id, id: row.id }),
    );
  }

  /** Whether it was there. */
  removeNeedsYou(chatId: string, id: string): boolean {
    return this.#sql.exec("DELETE FROM waiting_actions WHERE chat_id = ? AND id = ?", chatId, id).rowsWritten > 0;
  }

  /** A chat that is deleted takes its waiting actions with it. */
  forgetChat(chatId: string): boolean {
    return this.#sql.exec("DELETE FROM waiting_actions WHERE chat_id = ?", chatId).rowsWritten > 0;
  }
}
