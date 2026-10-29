import { DurableObject, exports } from "cloudflare:workers";
import type { ArtifactSummary, ChatSummary } from "../shared/protocol.ts";
import { checkSkill, MAX_USER_SKILLS, SkillError, type SavedSkillOrigin, type SkillInfo, type SkillInput, type SkillResult } from "../shared/skills.ts";
import { BUILTIN_SKILLS, builtinSkill, parseSkillFile } from "./skills/index.ts";
import { applyAuthChange, type McpAuthChange, type McpAuthRecord, type McpAuthStore } from "./mcp/oauth.ts";
import { mcpServers } from "./mcp/servers.ts";

/** One user's OAuth state for one MCP server. `uid` must come from a verified identity. */
export function mcpAuthStore(uid: string, server: string): McpAuthStore {
  const directory = exports.UserDirectory.getByName(uid);
  return { get: () => directory.mcpAuth(server), update: (change) => directory.updateMcpAuth(server, change) };
}

type SkillRow = {
  name: string;
  description: string;
  instructions: string;
  tools: string;
  origin: SavedSkillOrigin;
  enabled: number;
  updated_at: number;
};

/** One per user: the index of their chats and artifacts, and their skills. The chats themselves live in ChatAgent objects. */
export class UserDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, title TEXT NOT NULL, chat_id TEXT NOT NULL, latest INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_auth (server TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, description TEXT NOT NULL, instructions TEXT NOT NULL, tools TEXT NOT NULL, origin TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS builtin_skills_off (name TEXT PRIMARY KEY);
    `);
    // Forget sign-ins to servers this deployment no longer has, tokens included.
    const configured = mcpServers(env).map((server) => server.name);
    const placeholders = configured.map(() => "?").join(", ");
    ctx.storage.sql.exec(`DELETE FROM mcp_auth${configured.length ? ` WHERE server NOT IN (${placeholders})` : ""}`, ...configured);
  }

  /** This user's OAuth state for one MCP server (worker/mcp/oauth.ts): registration, tokens, a sign-in in progress. */
  mcpAuth(server: string): McpAuthRecord {
    const row = this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM mcp_auth WHERE server = ?", server).toArray()[0];
    return row ? (JSON.parse(row.data) as McpAuthRecord) : {};
  }

  /** Read, change and write in one step: this object runs one call at a time, and nothing here awaits. */
  updateMcpAuth(server: string, change: McpAuthChange): void {
    const record = applyAuthChange(this.mcpAuth(server), change);
    if (Object.keys(record).length === 0) this.ctx.storage.sql.exec("DELETE FROM mcp_auth WHERE server = ?", server);
    else this.ctx.storage.sql.exec("INSERT INTO mcp_auth (server, data) VALUES (?, ?) ON CONFLICT(server) DO UPDATE SET data = excluded.data", server, JSON.stringify(record));
  }

  listChats(): ChatSummary[] {
    return this.ctx.storage.sql
      .exec<{ id: string; title: string; created_at: number; updated_at: number }>("SELECT * FROM chats ORDER BY updated_at DESC")
      .toArray()
      .map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  createChat(id: string): ChatSummary {
    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", id, "New chat", now, now);
    return { id, title: "New chat", createdAt: now, updatedAt: now };
  }

  hasChat(id: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM chats WHERE id = ?", id).toArray().length > 0;
  }

  /** Bump a chat to the top. A chat still called "New chat" is named after the prompt, so the first prompt names it. */
  touchChat(id: string, prompt?: string): void {
    const now = Date.now();
    this.ctx.storage.sql.exec("UPDATE chats SET updated_at = ? WHERE id = ?", now, id);
    if (prompt) {
      const title = prompt.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
      this.ctx.storage.sql.exec("UPDATE chats SET title = ? WHERE id = ? AND title = 'New chat'", title, id);
    }
  }

  listArtifacts(): ArtifactSummary[] {
    return this.ctx.storage.sql
      .exec<{ id: string; title: string; chat_id: string; latest: number; updated_at: number }>("SELECT * FROM artifacts ORDER BY updated_at DESC")
      .toArray()
      .map((row) => ({ id: row.id, title: row.title, chatId: row.chat_id, latest: row.latest, updatedAt: row.updated_at }));
  }

  recordArtifact(artifact: ArtifactSummary): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO artifacts (id, title, chat_id, latest, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, latest = excluded.latest, updated_at = excluded.updated_at`,
      artifact.id,
      artifact.title,
      artifact.chatId,
      artifact.latest,
      artifact.updatedAt,
    );
  }

  /**
   * A short string that changes whenever the user's enabled skills do. A chat checks
   * it before every prompt and fetches the skills themselves only when it changed.
   */
  skillsVersion(): string {
    const off = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM builtin_skills_off ORDER BY name").toArray();
    const on = this.ctx.storage.sql.exec<{ name: string; updated_at: number }>("SELECT name, updated_at FROM skills WHERE enabled = 1 ORDER BY name").toArray();
    return JSON.stringify([off.map((row) => row.name), on.map((row) => [row.name, row.updated_at])]);
  }

  /** The built-in skills, then the user's own, each with whether it is on. */
  listSkills(): SkillInfo[] {
    const off = new Set(this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM builtin_skills_off").toArray().map((row) => row.name));
    const builtin = BUILTIN_SKILLS.map((skill): SkillInfo => ({ ...skill, origin: "builtin", enabled: !off.has(skill.name), updatedAt: 0 }));
    return [...builtin, ...this.ctx.storage.sql.exec<SkillRow>("SELECT * FROM skills ORDER BY name").toArray().map(skillInfo)];
  }

  getSkill(name: string): SkillInfo | null {
    const builtin = builtinSkill(name);
    if (builtin) {
      const off = this.ctx.storage.sql.exec("SELECT 1 FROM builtin_skills_off WHERE name = ?", name).toArray().length > 0;
      return { ...builtin, origin: "builtin", enabled: !off, updatedAt: 0 };
    }
    const row = this.ctx.storage.sql.exec<SkillRow>("SELECT * FROM skills WHERE name = ?", name).toArray()[0];
    return row ? skillInfo(row) : null;
  }

  /**
   * Save one of the user's skills from its fields or a SKILL.md (`{markdown}`),
   * replacing any of theirs with that name. A skill the agent proposes is always
   * saved off, and may replace only another proposal that is still off: text from
   * a tool result or a file must not become standing instructions in every chat
   * without the user turning it on.
   */
  saveSkill(input: unknown, origin: SavedSkillOrigin, enabled: boolean): SkillResult {
    let skill: SkillInput;
    try {
      const markdown = (input as { markdown?: unknown } | null)?.markdown;
      skill = typeof markdown === "string" ? parseSkillFile(markdown) : checkSkill(input);
    } catch (error) {
      if (error instanceof SkillError) return { error: error.message };
      throw error;
    }
    if (builtinSkill(skill.name)) return { error: `"${skill.name}" is a built-in skill; pick another name.` };
    const existing = this.ctx.storage.sql.exec<SkillRow>("SELECT * FROM skills WHERE name = ?", skill.name).toArray()[0];
    if (origin === "agent" && existing && (existing.origin === "user" || existing.enabled === 1)) {
      return { error: `The user already has a skill named "${skill.name}"; propose it under another name.` };
    }
    if (!existing && this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM skills").one().n >= MAX_USER_SKILLS) {
      return { error: `You have ${MAX_USER_SKILLS} skills, the most there can be; delete one first.` };
    }
    const on = origin === "user" && enabled;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO skills (name, description, instructions, tools, origin, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET description = excluded.description, instructions = excluded.instructions, tools = excluded.tools,
         origin = excluded.origin, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      skill.name,
      skill.description,
      skill.instructions,
      JSON.stringify(skill.tools),
      origin,
      on ? 1 : 0,
      now,
    );
    return { ...skill, origin, enabled: on, updatedAt: now };
  }

  /** Turn a skill on or off; built-in ones included. */
  setSkillEnabled(name: string, enabled: boolean): SkillResult {
    if (builtinSkill(name)) {
      if (enabled) this.ctx.storage.sql.exec("DELETE FROM builtin_skills_off WHERE name = ?", name);
      else this.ctx.storage.sql.exec("INSERT OR IGNORE INTO builtin_skills_off (name) VALUES (?)", name);
    } else if (enabled) {
      // Turning a proposal on makes it the user's own: the agent can no longer replace it.
      this.ctx.storage.sql.exec("UPDATE skills SET enabled = 1, origin = 'user', updated_at = ? WHERE name = ?", Date.now(), name);
    } else {
      this.ctx.storage.sql.exec("UPDATE skills SET enabled = 0, updated_at = ? WHERE name = ?", Date.now(), name);
    }
    return this.getSkill(name) ?? { error: `No skill named "${name}".` };
  }

  deleteSkill(name: string): SkillResult | null {
    if (builtinSkill(name)) return { error: `"${name}" is a built-in skill; turn it off instead.` };
    const deleted = this.ctx.storage.sql.exec("DELETE FROM skills WHERE name = ?", name).rowsWritten;
    return deleted ? null : { error: `No skill named "${name}".` };
  }
}

function skillInfo(row: SkillRow): SkillInfo {
  return {
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    tools: JSON.parse(row.tools) as string[],
    origin: row.origin,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}
