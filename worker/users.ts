import { DurableObject, exports } from "cloudflare:workers";
import type { ModelChoice } from "../shared/models.ts";
import type { ArtifactSummary, ChatSummary } from "../shared/protocol.ts";
import { checkSkill, MAX_SKILL_PROPOSALS, MAX_USER_SKILLS, SkillError, type SavedSkillOrigin, type SkillInfo, type SkillInput, type SkillResult } from "../shared/skills.ts";
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

/**
 * One per user: the index of their chats, the chats others shared with them, their artifacts, skills and model.
 * The chats themselves live in ChatAgent objects, which decide who may open them.
 */
export class UserDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, title TEXT NOT NULL, chat_id TEXT NOT NULL, latest INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_auth (server TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, description TEXT NOT NULL, instructions TEXT NOT NULL, tools TEXT NOT NULL, origin TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS builtin_skills_off (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS shared_chats (id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, owner_name TEXT NOT NULL, title TEXT NOT NULL, joined_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
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

  /** The user's own chats and the ones shared with them, most recent first. */
  listChats(): ChatSummary[] {
    return this.ctx.storage.sql
      .exec<{ id: string; title: string; created_at: number; updated_at: number; shared_by: string | null }>(
        `SELECT id, title, created_at, updated_at, NULL AS shared_by FROM chats
         UNION ALL SELECT id, title, joined_at, updated_at, owner_name FROM shared_chats
         ORDER BY updated_at DESC`,
      )
      .toArray()
      .map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.shared_by !== null && { sharedBy: row.shared_by }) }));
  }

  /** Whose chat `id` is: this user's own uid, the owner's for a chat shared with them, or null. The chat itself still checks membership. */
  chatOwner(id: string): string | null {
    if (this.hasChat(id)) return this.ctx.id.name!;
    const row = this.ctx.storage.sql.exec<{ owner_uid: string }>("SELECT owner_uid FROM shared_chats WHERE id = ?", id).toArray()[0];
    return row?.owner_uid ?? null;
  }

  /** Index a chat this user joined by an invite. Chat ids are random, so one never names both an own and a shared chat. */
  addSharedChat(chat: { id: string; ownerUid: string; ownerName: string; title: string }): void {
    if (this.hasChat(chat.id)) return;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO shared_chats (id, owner_uid, owner_name, title, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET owner_name = excluded.owner_name, title = excluded.title, updated_at = excluded.updated_at`,
      chat.id,
      chat.ownerUid,
      chat.ownerName,
      chat.title,
      now,
      now,
    );
  }

  /** Bump a shared chat to the top with its current title, as touchChat does for the owner. */
  touchSharedChat(id: string, ownerUid: string, title: string): void {
    this.ctx.storage.sql.exec("UPDATE shared_chats SET title = ?, updated_at = ? WHERE id = ? AND owner_uid = ?", title, Date.now(), id, ownerUid);
  }

  removeSharedChat(id: string, ownerUid: string): void {
    this.ctx.storage.sql.exec("DELETE FROM shared_chats WHERE id = ? AND owner_uid = ?", id, ownerUid);
  }

  createChat(id: string): ChatSummary {
    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", id, "New chat", now, now);
    return { id, title: "New chat", createdAt: now, updatedAt: now };
  }

  hasChat(id: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM chats WHERE id = ?", id).toArray().length > 0;
  }

  /** Bump a chat to the top. A chat still called "New chat" is named after the prompt, so the first prompt names it. Returns its title. */
  touchChat(id: string, prompt: string): string {
    const title = prompt.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
    return (
      this.ctx.storage.sql
        .exec<{ title: string }>("UPDATE chats SET updated_at = ?, title = CASE title WHEN 'New chat' THEN ? ELSE title END WHERE id = ? RETURNING title", Date.now(), title, id)
        .toArray()[0]?.title ?? title
    );
  }

  chatTitle(id: string): string | null {
    return this.ctx.storage.sql.exec<{ title: string }>("SELECT title FROM chats WHERE id = ?", id).toArray()[0]?.title ?? null;
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
    const own = this.ctx.storage.sql.exec<SkillRow>("SELECT * FROM skills ORDER BY name").toArray().map(skillInfo);
    const off = new Set(this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM builtin_skills_off").toArray().map((row) => row.name));
    const ownOn = new Set(own.filter((mine) => mine.enabled).map((mine) => mine.name));
    const builtin = BUILTIN_SKILLS.map((skill) => builtinInfo(skill, off.has(skill.name), ownOn.has(skill.name)));
    return [...builtin, ...own];
  }

  /** One of the user's own skills. */
  getSkill(name: string): SkillInfo | null {
    const row = this.ctx.storage.sql.exec<SkillRow>("SELECT * FROM skills WHERE name = ?", name).toArray()[0];
    return row ? skillInfo(row) : null;
  }

  getBuiltinSkill(name: string): SkillInfo | null {
    const builtin = builtinSkill(name);
    if (!builtin) return null;
    const off = this.ctx.storage.sql.exec("SELECT 1 FROM builtin_skills_off WHERE name = ?", name).toArray().length > 0;
    return builtinInfo(builtin, off, this.getSkill(name)?.enabled === true);
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
    const pending = "SELECT COUNT(*) AS n FROM skills WHERE origin = 'agent' AND enabled = 0";
    if (origin === "agent" && !existing && this.ctx.storage.sql.exec<{ n: number }>(pending).one().n >= MAX_SKILL_PROPOSALS) {
      return { error: `The user has ${MAX_SKILL_PROPOSALS} proposals waiting for review; ask them to review those first.` };
    }
    const on = origin === "user" && enabled;
    // Strictly newer than the version it replaces, even within one millisecond: turning a skill on checks it.
    const now = Math.max(Date.now(), (existing?.updated_at ?? 0) + 1);
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

  setBuiltinSkillEnabled(name: string, enabled: boolean): SkillResult {
    if (!builtinSkill(name)) return { error: `No built-in skill named "${name}".` };
    if (enabled) this.ctx.storage.sql.exec("DELETE FROM builtin_skills_off WHERE name = ?", name);
    else this.ctx.storage.sql.exec("INSERT OR IGNORE INTO builtin_skills_off (name) VALUES (?)", name);
    return this.getBuiltinSkill(name)!;
  }

  /**
   * Turn one of the user's skills on or off. `seen` is the `updatedAt` of the version
   * the user read: turning on a skill that changed since (a proposal the agent
   * replaced while the user reviewed it) is refused, so they read it again.
   */
  setSkillEnabled(name: string, enabled: boolean, seen?: number): SkillResult {
    if (enabled) {
      const current = this.ctx.storage.sql.exec<{ updated_at: number }>("SELECT updated_at FROM skills WHERE name = ?", name).toArray()[0];
      if (current && seen !== undefined && current.updated_at !== seen) {
        return { error: `The skill "${name}" changed since you read it; read it again before turning it on.` };
      }
      // Turning a proposal on makes it the user's own: the agent can no longer replace it.
      this.ctx.storage.sql.exec("UPDATE skills SET enabled = 1, origin = 'user', updated_at = ? WHERE name = ?", Date.now(), name);
    } else {
      this.ctx.storage.sql.exec("UPDATE skills SET enabled = 0, updated_at = ? WHERE name = ?", Date.now(), name);
    }
    return this.getSkill(name) ?? { error: `No skill named "${name}".` };
  }

  /** Delete one of the user's skills. Built-in ones can only be turned off. */
  deleteSkill(name: string): SkillResult | null {
    const deleted = this.ctx.storage.sql.exec("DELETE FROM skills WHERE name = ?", name).rowsWritten;
    return deleted ? null : { error: `No skill named "${name}".` };
  }

  /** The model and effort the user last picked in any chat: what their new chats start on. Checked by the chat that reads it. */
  modelChoice(): ModelChoice | null {
    return this.ctx.storage.kv.get<ModelChoice>("model") ?? null;
  }

  setModelChoice(choice: ModelChoice): void {
    this.ctx.storage.kv.put("model", choice);
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

/** A built-in skill as the user sees it: `replaced` when one of their own, turned on, has its name. */
function builtinInfo(skill: SkillInput, off: boolean, replaced: boolean): SkillInfo {
  return { ...skill, origin: "builtin", enabled: !off, updatedAt: 0, ...(replaced && { replaced: true as const }) };
}
