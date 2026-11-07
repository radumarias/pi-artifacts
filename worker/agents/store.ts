import {
  AGENT_ID_PATTERN,
  AgentError,
  checkAgent,
  copyName,
  defaultAvatar,
  defaultColor,
  MAX_AGENT_PROPOSALS,
  MAX_AGENTS,
  type AgentChanges,
  type AgentDefinition,
  type AgentInput,
  type AgentOrigin,
  type AgentResult,
} from "../../shared/agents.ts";
import type { ExportedAgent } from "../../shared/data-export.ts";
import { isObject, randomHex } from "../../shared/util.ts";
import type { Sql } from "../members.ts";

type AgentRow = {
  id: string;
  name: string;
  definition: string;
  origin: AgentOrigin;
  enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
  copied_from: string | null;
};

function definitionOf(row: AgentRow): AgentDefinition {
  const input = JSON.parse(row.definition) as AgentInput;
  return {
    ...input,
    id: row.id,
    name: row.name,
    avatar: input.avatar ?? defaultAvatar(row.name),
    color: input.color ?? defaultColor(row.name),
    autonomy: input.autonomy ?? 1,
    origin: row.origin,
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.copied_from && { copiedFrom: JSON.parse(row.copied_from) as NonNullable<AgentDefinition["copiedFrom"]> }),
  };
}

/** What saving an agent may say besides its fields: which one it replaces, and the version the writer read. */
export interface AgentSave {
  /** The agent to change; a new one when absent. */
  id?: string;
  /** The version the writer read: a save over a newer one is refused, so two editors never undo each other. */
  version?: number;
  copiedFrom?: AgentDefinition["copiedFrom"];
}

/**
 * One user's agent definitions, in their UserDirectory's SQLite, shaped like their skills: the model may propose one,
 * saved off until its owner turns it on. Each change counts the agent's version up, so two editors never undo each
 * other. Names are unique per user, so "@name" means one agent of theirs.
 */
export class AgentStore {
  readonly #sql: Sql;
  readonly #now: () => number;

  constructor(sql: Sql, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, definition TEXT NOT NULL, origin TEXT NOT NULL, enabled INTEGER NOT NULL,
        version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, copied_from TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_chats (
        agent_id TEXT NOT NULL, chat_id TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agent_id, chat_id)
      );
    `);
  }

  list(): AgentDefinition[] {
    return (this.#sql.exec("SELECT * FROM agents ORDER BY name").toArray() as AgentRow[]).map(definitionOf);
  }

  get(id: string): AgentDefinition | null {
    const row = this.#sql.exec("SELECT * FROM agents WHERE id = ?", id).toArray()[0] as AgentRow | undefined;
    return row ? definitionOf(row) : null;
  }

  byName(name: string): AgentDefinition | null {
    const row = this.#sql.exec("SELECT * FROM agents WHERE name = ?", name.toLowerCase()).toArray()[0] as AgentRow | undefined;
    return row ? definitionOf(row) : null;
  }

  /**
   * Save an agent from its fields: a new one, or (with `id`) a change to one. A proposal from the model is always saved
   * off, never over one of the user's own, and at most MAX_AGENT_PROPOSALS wait at once. A change the user saves
   * keeps the agent on or off as it was, unless `enabled` says otherwise; one by the model turns it off again for review.
   */
  save(input: unknown, origin: AgentOrigin, enabled: boolean | undefined, { id, version, copiedFrom }: AgentSave = {}): AgentResult {
    let agent: AgentInput;
    try {
      agent = checkAgent(input);
    } catch (error) {
      if (error instanceof AgentError) return { error: error.message };
      throw error;
    }
    const existing = id === undefined ? null : this.get(id);
    if (id !== undefined && !existing) return { error: "No such agent." };
    if (existing && version !== undefined && existing.version !== version) {
      return { error: `The agent "${existing.name}" changed since you read it (version ${existing.version}); read it again first.` };
    }
    if (existing && origin === "agent" && existing.origin === "user")
      return { error: `"${existing.name}" is one of the user's own agents; the model cannot change it.` };
    const named = this.byName(agent.name);
    if (named && named.id !== id) return { error: `There is already an agent named "${agent.name}"; pick another name.` };
    if (!existing) {
      const n = this.#sql.exec("SELECT COUNT(*) AS n FROM agents").toArray()[0].n as number;
      if (n >= MAX_AGENTS) return { error: `There are ${MAX_AGENTS} agents, the most there can be; delete one first.` };
      if (origin === "agent") {
        const pending = this.#sql.exec("SELECT COUNT(*) AS n FROM agents WHERE origin = 'agent' AND enabled = 0").toArray()[0].n as number;
        if (pending >= MAX_AGENT_PROPOSALS)
          return { error: `${MAX_AGENT_PROPOSALS} proposed agents already wait for review; ask the user to look at them first.` };
      }
    }
    // Strictly newer than the version it replaces, even within one millisecond: a chat compares them.
    const now = Math.max(this.#now(), (existing?.updatedAt ?? 0) + 1);
    const on = origin === "agent" ? false : (enabled ?? existing?.enabled ?? true);
    // A change keeps where the agent came from (its copied_from is never updated): `copiedFrom` is only for a new one.
    if (existing) {
      this.#sql.exec(
        "UPDATE agents SET name = ?, definition = ?, origin = ?, enabled = ?, version = version + 1, updated_at = ? WHERE id = ?",
        agent.name,
        JSON.stringify(agent),
        // A proposal the user saves becomes theirs, as turning a skill on does.
        origin === "user" ? "user" : existing.origin,
        on ? 1 : 0,
        now,
        existing.id,
      );
      return this.get(existing.id)!;
    }
    const newId = randomHex(8);
    this.#sql.exec(
      "INSERT INTO agents (id, name, definition, origin, enabled, version, created_at, updated_at, copied_from) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
      newId,
      agent.name,
      JSON.stringify(agent),
      origin,
      on ? 1 : 0,
      now,
      now,
      copiedFrom ? JSON.stringify(copiedFrom) : null,
    );
    return this.get(newId)!;
  }

  /**
   * Turn an agent on or off. `version` is the one the user read: turning on an agent that changed since (a proposal
   * the model revised) is refused, so they never turn on what they did not see. Turning one on makes it the user's.
   */
  setEnabled(id: string, enabled: boolean, version?: number): AgentResult {
    const existing = this.get(id);
    if (!existing) return { error: "No such agent." };
    if (enabled && version !== undefined && existing.version !== version) {
      return { error: `The agent "${existing.name}" changed since you read it; read it again before turning it on.` };
    }
    if (existing.enabled === enabled) return existing;
    const now = Math.max(this.#now(), existing.updatedAt + 1);
    // Turning it on confirms what the user saw of it: nothing shows as Assumed any more.
    this.#sql.exec(
      `UPDATE agents SET enabled = ?, ${enabled ? "origin = 'user', definition = json_remove(definition, '$.assumed'), " : ""}version = version + 1, updated_at = ? WHERE id = ?`,
      enabled ? 1 : 0,
      now,
      id,
    );
    return this.get(id)!;
  }

  /** Delete an agent, and what the index says of the chats it is in; null when it was there. */
  delete(id: string): { error: string } | null {
    if (this.#sql.exec("DELETE FROM agents WHERE id = ?", id).rowsWritten === 0) return { error: "No such agent." };
    this.#sql.exec("DELETE FROM agent_chats WHERE agent_id = ?", id);
    return null;
  }

  /**
   * Save someone's own copy of an agent another person shared (`copiedFrom`), turned off, as their draft: under its
   * name, or the first free "name-2"… when they have an agent of that name.
   */
  saveCopy(input: AgentChanges, copiedFrom: NonNullable<AgentDefinition["copiedFrom"]>): AgentResult {
    const name = copyName(String(input.name ?? "").toLowerCase(), (candidate) => this.byName(candidate) !== null);
    if (!name) return { error: `You have many agents named like "${input.name}"; rename one first.` };
    return this.save({ ...input, name }, "user", false, { copiedFrom });
  }

  /**
   * Bring in an agent from an export: under its own id when that is free, else a new one. Never over one of the
   * user's: one they have by that name is kept, and its id returned with `skipped`, so a chat's roster can point at it.
   */
  import(agent: ExportedAgent): { id: string; skipped?: true } | { error: string } {
    const named = this.byName(String(agent.name ?? ""));
    if (named) return { id: named.id, skipped: true };
    const from = agent.copiedFrom;
    const copiedFrom =
      isObject(from) && typeof from.owner === "string" && typeof from.id === "string" && typeof from.version === "number"
        ? { owner: from.owner, id: from.id, version: from.version }
        : undefined;
    const fresh = this.save(agent, agent.origin === "agent" ? "agent" : "user", agent.enabled === true, { copiedFrom });
    if ("error" in fresh) return fresh;
    const id = typeof agent.id === "string" && AGENT_ID_PATTERN.test(agent.id) && !this.get(agent.id) ? agent.id : fresh.id;
    if (id !== fresh.id) this.#sql.exec("UPDATE agents SET id = ? WHERE id = ?", id, fresh.id);
    return { id };
  }

  /**
   * A chat added the agent (`inChat`), or took it out: the index "used in M chats" and the delete's confirm read. The
   * chat object writes it, as its roster changes.
   */
  noteChat(agentId: string, chatId: string, inChat: boolean, shared = false): void {
    if (!inChat) {
      this.#sql.exec("DELETE FROM agent_chats WHERE agent_id = ? AND chat_id = ?", agentId, chatId);
      return;
    }
    // Only for an agent that is here: a chat that adds one deleted meanwhile leaves no row behind.
    this.#sql.exec(
      `INSERT INTO agent_chats (agent_id, chat_id, shared) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM agents WHERE id = ?)
       ON CONFLICT (agent_id, chat_id) DO UPDATE SET shared = excluded.shared`,
      agentId,
      chatId,
      shared ? 1 : 0,
      agentId,
    );
  }

  /** The chats an agent is in, by id, with whether it is shared in each. */
  chatsOf(agentId: string): { chatId: string; shared: boolean }[] {
    return this.#sql
      .exec("SELECT chat_id, shared FROM agent_chats WHERE agent_id = ? ORDER BY chat_id", agentId)
      .toArray()
      .map((row) => ({ chatId: row.chat_id as string, shared: row.shared === 1 }));
  }

  /** A deleted chat holds no agent any more. */
  forgetChat(chatId: string): void {
    this.#sql.exec("DELETE FROM agent_chats WHERE chat_id = ?", chatId);
  }
}
