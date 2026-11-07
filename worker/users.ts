import { DurableObject, exports } from "cloudflare:workers";
import type { ModelSetting } from "../shared/models.ts";
import { PAGE_STORAGE_LIMITS, SOCKET_PING, MAX_CHAT_TITLE, type ArtifactSummary, type ChatStatus, type ChatSummary, type ChatRowChange, type MentionNotice, type Person, type SidebarList } from "../shared/protocol.ts";
import type { ExportedAgent, ExportedChat, ExportedPageValues, ExportedSkill, ExportStart, ImportedSettings } from "../shared/data-export.ts";
import type { SkillFileInfo } from "../shared/skill-files.ts";
import { checkSystemPrompt, type ChatSystemPrompt } from "../shared/system-prompt.ts";
import { checkSkill, MAX_SKILL_PROPOSALS, MAX_USER_SKILLS, SkillError, type SavedSkillOrigin, type SkillInfo, type SkillInput, type SkillResult } from "../shared/skills.ts";
import { BUILTIN_SKILLS, builtinSkill, parseSkillFile } from "./skills/index.ts";
import { titleFromMessage, UNNAMED_CHAT } from "./agent/title.ts";
import type { McpAuthChange, McpAuthRecord, McpAuthStore } from "./mcp/oauth.ts";
import type { SignInCheck } from "./mcp/background.ts";
import { McpSignIns } from "./mcp/sign-ins.ts";
import { oauthServers } from "./mcp/servers.ts";
import { chatAgentName } from "./chat-name.ts";
import { PushSubscriptions, vapidKeys, type PushMessage } from "./push/subscriptions.ts";
import type { PushSubscriptionKeys } from "./push/web-push.ts";
import { mcpTokensKey } from "./storage/index.ts";
import type { McpSignInView, SignInNotice } from "../shared/sign-ins.ts";
import { AgentStore, type AgentSave } from "./agents/store.ts";
import { ChatRows } from "./chat-rows.ts";
import { addColumns } from "./members.ts";
import type { ChatKind } from "../shared/chat-kinds.ts";
import {
  withoutSignInShares,
  type AgentChanges,
  type AgentChatUse,
  type AgentDefinition,
  type AgentInput,
  type AgentOrigin,
  type AgentResult,
} from "../shared/agents.ts";
import { excerpt } from "../shared/replies.ts";
import { errorMessage, memoAsync, randomHex } from "../shared/util.ts";

/** One user's OAuth state for one MCP server. `uid` must come from a verified identity. */
export function mcpAuthStore(uid: string, server: string): McpAuthStore {
  const directory = exports.UserDirectory.getByName(uid);
  return { get: () => directory.mcpAuth(server), update: (change) => directory.updateMcpAuth(server, change) };
}

/** Where a user's, or a chat's, own system prompt is kept, in its object's KV storage. */
export const SYSTEM_PROMPT_KEY = "systemPrompt";

/** The system prompt kept under SYSTEM_PROMPT_KEY in `kv`; "" for none. */
export function readSystemPrompt(kv: SyncKvStorage): string {
  return kv.get<string>(SYSTEM_PROMPT_KEY) ?? "";
}

/** Check `value` as a system prompt and keep it under SYSTEM_PROMPT_KEY in `kv`; empty clears it. */
export function saveSystemPrompt(kv: SyncKvStorage, value: unknown): { text: string } | { error: string } {
  const checked = checkSystemPrompt(value);
  if ("error" in checked) return checked;
  if (checked.text) kv.put(SYSTEM_PROMPT_KEY, checked.text);
  else kv.delete(SYSTEM_PROMPT_KEY);
  return checked;
}

/** A message that tagged this user: who wrote it, its start, and when; or (`added`) the owner adding them to the chat. */
export type Tag = Pick<MentionNotice, "from" | "text" | "at" | "added">;

type ArtifactRow = { id: string; title: string; chat_id: string; latest: number; updated_at: number; seen: number };

type SkillRow = {
  name: string;
  description: string;
  instructions: string;
  tools: string;
  origin: SavedSkillOrigin;
  enabled: number;
  updated_at: number;
  /** JSON {set, list} of a skill imported as a package (SkillPackageFiles); null for others. */
  files: string | null;
};

/** The files of a skill imported as a package: the set SkillFiles wrote them as, and what is in it. */
export interface SkillPackageFiles {
  set: string;
  list: SkillFileInfo[];
}

/** An agent as an export carries it: its fields, its state and its id, without its version or times. */
function exportedAgent({ version: _version, createdAt: _created, updatedAt: _updated, ...agent }: AgentDefinition): ExportedAgent {
  return agent;
}

/**
 * One per user: the index of their chats, the chats others shared with them, their artifacts, skills and model.
 * The chats themselves live in ChatAgent objects, which decide who may open them.
 */
export class UserDirectory extends DurableObject<Env> {
  /** The user's agents (worker/agents/store.ts). */
  readonly #agents: AgentStore;
  /** The user's sign-ins to servers that sign in each user (worker/mcp/sign-ins.ts). */
  readonly #signIns: McpSignIns;
  /** The browsers the user turned notifications on in (worker/push/subscriptions.ts). */
  readonly #push: PushSubscriptions;
  /** What of each sidebar row is this user's alone (pinned, closed, their name for it), chats' kinds, page chats, people (worker/chat-rows.ts). */
  readonly #rows: ChatRows;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#agents = new AgentStore(ctx.storage.sql);
    this.#push = new PushSubscriptions(ctx.storage.sql);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, title TEXT NOT NULL, chat_id TEXT NOT NULL, latest INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, description TEXT NOT NULL, instructions TEXT NOT NULL, tools TEXT NOT NULL, origin TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS builtin_skills_off (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS shared_chats (id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, owner_name TEXT NOT NULL, title TEXT NOT NULL, joined_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS page_values (artifact_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (artifact_id, key));
      CREATE TABLE IF NOT EXISTS page_ai_spend (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cost REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS dictation_use (day TEXT PRIMARY KEY, clips INTEGER NOT NULL, seconds REAL NOT NULL);
    `);
    // Added later: what the chat's agent is doing (ChatStatus), when something last came in that this user did not
    // write, and when they last saw the chat. activity_at > seen_at is unread. Then: when someone last tagged them in
    // it; mentioned_at > seen_at is a tag they have not seen.
    const sql = ctx.storage.sql;
    const read = { status: "TEXT", activity_at: "INTEGER NOT NULL DEFAULT 0", seen_at: "INTEGER NOT NULL DEFAULT 0", mentioned_at: "INTEGER NOT NULL DEFAULT 0" };
    // With, in the user's own chats, whether the chat has members: it tells (setChatShared) when that changes, and when it opens.
    addColumns(sql, "chats", { ...read, shared: "INTEGER NOT NULL DEFAULT 0" });
    addColumns(sql, "shared_chats", read);
    this.#rows = new ChatRows(ctx.storage.sql);
    // The files of a skill imported as a package (SkillPackageFiles as JSON).
    addColumns(sql, "skills", { files: "TEXT" });
    // The newest version of each artifact its owner opened. Artifacts from before count as seen.
    if (addColumns(sql, "artifacts", { seen: "INTEGER NOT NULL DEFAULT 0" }).length) sql.exec("UPDATE artifacts SET seen = latest");
    // A sidebar's socket stays open for hours: answer its keep-alive pings without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(SOCKET_PING.request, SOCKET_PING.response));
    // The uid names the key that opens this user's sign-ins. An object woken only by its alarm may not know its name,
    // so it is kept: a wrong key would make every record look unreadable, and be forgotten.
    if (ctx.id.name) ctx.storage.kv.put("uid", ctx.id.name);
    const uid = ctx.id.name ?? ctx.storage.kv.get<string>("uid");
    this.#signIns = new McpSignIns({
      sql: ctx.storage.sql,
      env,
      key: memoAsync(async () => {
        if (!uid) throw new Error("This directory does not know its user.");
        return mcpTokensKey(env, uid);
      }),
      changed: () => this.#changed("sign-ins"),
      notify: async (notice, message) => {
        this.#changed(notice);
        await this.push(message);
      },
      signedIn: async (chatId, server) => {
        if (uid) await exports.ChatAgent.getByName(chatAgentName(uid, chatId)).signedIn(server);
      },
      setAlarm: (at) => void (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at)),
    });
  }


  /** This user's OAuth state for one MCP server (worker/mcp/oauth.ts): registration, tokens, a sign-in in progress. */
  mcpAuth(server: string): Promise<McpAuthRecord> {
    return this.#signIns.record(server);
  }

  /** Read, change and write in one step: McpSignIns runs one record change at a time. */
  updateMcpAuth(server: string, change: McpAuthChange): Promise<void> {
    return this.#signIns.update(server, change);
  }

  /** The account menu's list of sign-ins: each server that signs in each user, with when (no tokens). */
  mcpSignIns(): McpSignInView[] {
    return this.#signIns.list();
  }

  /** Remove the stored sign-in to `server`, tokens and registration. */
  async disconnectMcp(server: string): Promise<McpSignInView[]> {
    await this.#signIns.disconnect(server);
    return this.#signIns.list();
  }

  dismissSignInNotice(server: string): McpSignInView[] {
    this.#signIns.dismiss(server);
    return this.#signIns.list();
  }

  /**
   * For scheduled runs (worker/agents/runs): the servers one chat's runs use, kept refreshed daily and warned about
   * before their grant ends. Replaces that chat's list; empty clears it.
   */
  setRunServers(chatId: string, servers: readonly string[]): void {
    this.#signIns.setRunServers(chatId, servers);
  }

  /** Before a run: whether each server's sign-in works with nobody present (refreshed now). See McpSignIns.check. */
  checkSignIns(servers: readonly string[]): Promise<Record<string, SignInCheck>> {
    return this.#signIns.check(servers);
  }

  /**
   * A run needs a new sign-in to `server`: a notice with the sign-in link in the sidebar, the browser, and a push when no
   * app is open, once until they sign in. With `chatId`, that chat hears `ChatAgent.signedIn(server)` when they do.
   */
  notifySignInNeeded(server: string, context: { chatId?: string; what?: string } = {}): Promise<void> {
    return this.#signIns.needed(server, context);
  }

  /** The sign-in callback finished for `server` (worker/mcp-routes.ts). */
  onSignedIn(server: string): Promise<void> {
    return this.#signIns.onSignedIn(server);
  }

  /** The servers this user has signed in to (tokens kept), by name: never the tokens. */
  mcpSignedIn(): string[] {
    return this.#signIns
      .list()
      .filter((item) => item.signedIn)
      .map((item) => item.server)
      .sort();
  }

  /** Warnings before sign-ins end, and the daily keep-alive refresh of the ones runs use (McpSignIns.alarm). */
  async alarm(): Promise<void> {
    await this.#signIns.alarm();
  }

  addPushSubscription(sub: PushSubscriptionKeys): void {
    this.#push.add(sub);
  }

  removePushSubscription(endpoint: string): void {
    this.#push.remove(endpoint);
  }

  /**
   * Push a notification to every browser this user turned notifications on in, for when the app is closed: only when
   * none of their apps is open (an open one hears it on its socket and shows it itself). `body` says only that something
   * arrived, never data. Nothing happens without the VAPID secrets.
   */
  async push(message: PushMessage): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) await this.#push.push(message, vapidKeys(this.env));
  }

  /**
   * The sidebar's socket: it hears which list changed (SidebarList): a chat was added, named, bumped, or its agent
   * started or stopped working; an artifact was published or opened; a skill was added, changed or proposed. The app
   * reads that list again. It also hears when someone tagged this user (MentionNotice). The Worker opens it for the
   * signed-in user only.
   */
  fetch(request: Request): Response {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(): void {
    // The app sends nothing but pings, which the auto-response answers.
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** Tell the open sidebars that a list changed, or that someone tagged this user. */
  #changed(message: SidebarList | MentionNotice | SignInNotice): void {
    const sent = typeof message === "string" ? message : JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(sent);
      } catch {
        // Closing; the app reads the list again when it reconnects.
      }
    }
  }

  /** The user's own chats and the ones shared with them, most recent first. */
  listChats(): ChatSummary[] {
    return this.#rows.list((agentId, preview) => this.#contact(agentId, preview));
  }

  /** Change what of chat `id`'s row is this user's alone: pinned, closed, marked unread, their own name for it. */
  changeChatRow(id: string, change: ChatRowChange): boolean {
    const changed = this.#rows.change(id, change);
    if (changed) this.#changed("chats");
    return changed;
  }

  /** The chat `id`'s kind, which its chat object told this sidebar (setChatKind); null for a chat it does not list. */
  chatKind(id: string): ChatKind | null {
    return this.#rows.kindOf(id);
  }

  /** The chat `ownerUid`'s chat `id` is now `kind`: told by the chat, to every sidebar that lists it. */
  setChatKind(id: string, ownerUid: string, kind: ChatKind): void {
    // Written, and the sidebars told, only on a change: the chat tells a member again each time they open it.
    const own = ownerUid === this.ctx.id.name;
    const sql = own
      ? this.ctx.storage.sql.exec("UPDATE chats SET kind = ? WHERE id = ? AND kind IS NOT ?", kind, id, kind)
      : this.ctx.storage.sql.exec("UPDATE shared_chats SET kind = ? WHERE id = ? AND owner_uid = ? AND kind IS NOT ?", kind, id, ownerUid, kind);
    if (sql.rowsWritten) this.#changed("chats");
  }

  /** The chat that discusses one of this user's artifacts (Discuss on its page), or null. */
  pageChat(artifactId: string): string | null {
    return this.#rows.pageChat(artifactId);
  }

  linkPageChat(artifactId: string, chatId: string): void {
    this.#rows.linkPage(artifactId, chatId);
  }

  /** People this user shares chat `chatId` with: what "@" offers to add to a chat (see ChatRows.knowPeople). */
  knowPeople(chatId: string, people: readonly Person[]): void {
    this.#rows.knowPeople(chatId, people, this.ctx.id.name!);
  }

  /** Count a branch of this user's conversation that started in chat `root`, unless it has `max` (ChatRows.takeBranch). */
  takeBranch(root: string, max: number): boolean {
    return this.#rows.takeBranch(root, max);
  }

  returnBranch(root: string): void {
    this.#rows.returnBranch(root);
  }

  /** `uid` left chat `chatId`, or was removed from it: this user no longer knows them through it. */
  forgetPerson(chatId: string, uid: string): void {
    this.#rows.forgetPeople(chatId, uid);
  }

  knownPeople(): Person[] {
    return this.#rows.people();
  }

  knownPerson(uid: string): Person | null {
    return this.#rows.person(uid);
  }

  /** What an agent's home conversation shows of its agent in the list: its badge and last post. */
  #contact(agentId: string | null, preview: string | null): Pick<ChatSummary, "agent"> {
    const agent = agentId ? this.#agents.get(agentId) : null;
    if (!agent) return {};
    return { agent: { id: agent.id, name: agent.name, avatar: agent.avatar, color: agent.color, ...(preview && { preview }) } };
  }

  /** The chat that is an agent's own conversation; null when it has none yet. */
  agentHome(agentId: string): string | null {
    return this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM chats WHERE agent_id = ? ORDER BY created_at LIMIT 1", agentId).toArray()[0]?.id ?? null;
  }

  /**
   * An agent's own conversation, made when it has none (it is turned on, or runs for the first time): an ordinary chat
   * of this user's, named after it and marked with it, which it is told it is the home of. Null for no such agent.
   */
  ensureAgentHome(agentId: string): string | null {
    const found = this.agentHome(agentId);
    if (found) return found;
    const agent = this.#agents.get(agentId);
    if (!agent) return null;
    const id = randomHex(8);
    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO chats (id, title, created_at, updated_at, agent_id) VALUES (?, ?, ?, ?, ?)", id, `@${agent.name}`, now, now, agentId);
    this.#changed("chats");
    this.#tellHome(id, agentId, agent);
    return id;
  }

  /** Tell an agent's home conversation about it as it is now (null: deleted). Off the caller's path; a failure is logged. */
  #tellHome(chatId: string, agentId: string, agent: AgentDefinition | null): void {
    const chat = exports.ChatAgent.getByName(chatAgentName(this.ctx.id.name!, chatId));
    this.ctx.waitUntil(chat.agentChanged(agentId, agent).catch((error: unknown) => console.error("agent home:", errorMessage(error))));
  }

  /** One of this user's agents was saved, turned on or off, or deleted: the lists and its home conversation follow. */
  #agentChanged(agentId: string): void {
    this.#changed("agents");
    const agent = this.#agents.get(agentId);
    const home = this.agentHome(agentId);
    if (!home) {
      if (agent?.enabled) this.ensureAgentHome(agentId);
      return;
    }
    this.#tellHome(home, agentId, agent);
    // A deleted agent's conversation stays, as an ordinary chat.
    if (!agent && this.ctx.storage.sql.exec("UPDATE chats SET agent_id = NULL WHERE agent_id = ?", agentId).rowsWritten) this.#changed("chats");
  }

  /**
   * Change this user's row for chat `id`, which `ownerUid` owns: in `chats` when that is this user, else in
   * `shared_chats`. `set` is an SQL SET list written here, never input; its `?` take `values`. Tells the open sidebars
   * when a row changed, and returns whether one did.
   */
  #updateChat(id: string, ownerUid: string, set: string, ...values: SqlStorageValue[]): boolean {
    const own = ownerUid === this.ctx.id.name;
    const sql = own ? `UPDATE chats SET ${set} WHERE id = ?` : `UPDATE shared_chats SET ${set} WHERE id = ? AND owner_uid = ?`;
    const written = this.ctx.storage.sql.exec(sql, ...values, id, ...(own ? [] : [ownerUid])).rowsWritten > 0;
    if (written) this.#changed("chats");
    return written;
  }

  /** What the chat's agent is doing now. `replied`: it just ended a run, so the chat has a reply this user has not seen. */
  setChatStatus(id: string, ownerUid: string, status: ChatStatus | null, replied: boolean): void {
    this.#updateChat(id, ownerUid, "status = ?, activity_at = CASE WHEN ? THEN ? ELSE activity_at END", status, replied ? 1 : 0, Date.now());
  }

  /** The title a model gave the chat, unless it was renamed since it was called `placeholder`. */
  nameChat(id: string, ownerUid: string, title: string, placeholder: string): void {
    this.#updateChat(id, ownerUid, "title = CASE title WHEN ? THEN ? ELSE title END", placeholder, title);
  }

  /** Whether this user's own chat `id` has members now. */
  setChatShared(id: string, shared: boolean): void {
    const flag = shared ? 1 : 0;
    // Only a change: the chat tells again on every join and leave.
    if (this.ctx.storage.sql.exec("UPDATE chats SET shared = ? WHERE id = ? AND shared != ?", flag, id, flag).rowsWritten) this.#changed("chats");
  }

  /**
   * This user has seen everything in the chat so far. Returns when they had last seen it before, if something came in
   * since, so the app can mark what is new; null when nothing was unread, or they never looked at the chat.
   */
  markSeen(id: string): number | null {
    // Marked unread by hand (ChatRows.change) counts too, though nothing new came in.
    const unread = "WHERE id = ? AND (activity_at > seen_at OR marked_unread = 1)";
    const before = this.ctx.storage.sql
      .exec<{ seen_at: number; activity_at: number }>(
        `SELECT seen_at, activity_at FROM chats ${unread} UNION ALL SELECT seen_at, activity_at FROM shared_chats ${unread}`,
        id,
        id,
      )
      .toArray()[0];
    if (!before) return null;
    const now = Date.now();
    this.ctx.storage.sql.exec(`UPDATE chats SET seen_at = ?, marked_unread = 0 ${unread}`, now, id);
    this.ctx.storage.sql.exec(`UPDATE shared_chats SET seen_at = ?, marked_unread = 0 ${unread}`, now, id);
    this.#changed("chats");
    return before.seen_at > 0 && before.activity_at > before.seen_at ? before.seen_at : null;
  }

  /**
   * This user stopped looking at the chat: what it showed them until now is read, also what came in without making
   * it unread (an agent's reply as it streams, before its run ends). Not when something unread is waiting, which
   * stays new for them.
   */
  leftChat(id: string): void {
    const now = Date.now();
    this.ctx.storage.sql.exec("UPDATE chats SET seen_at = ? WHERE id = ? AND activity_at <= seen_at", now, id);
    this.ctx.storage.sql.exec("UPDATE shared_chats SET seen_at = ? WHERE id = ? AND activity_at <= seen_at", now, id);
  }

  /** Whose chat `id` is: this user's own uid, the owner's for a chat shared with them, or null. The chat itself still checks membership. */
  chatOwner(id: string): string | null {
    if (this.hasChat(id)) return this.ctx.id.name!;
    const row = this.ctx.storage.sql.exec<{ owner_uid: string }>("SELECT owner_uid FROM shared_chats WHERE id = ?", id).toArray()[0];
    return row?.owner_uid ?? null;
  }

  /** Index a chat this user joined by an invite. Chat ids are random, so one never names both an own and a shared chat. */
  addSharedChat(chat: { id: string; ownerUid: string; ownerName: string; title: string; status: ChatStatus | null; kind?: ChatKind }): void {
    if (this.hasChat(chat.id)) return;
    const now = Date.now();
    // Joining again opens a chat this user had closed.
    this.ctx.storage.sql.exec(
      `INSERT INTO shared_chats (id, owner_uid, owner_name, title, joined_at, updated_at, status, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET owner_name = excluded.owner_name, title = excluded.title, updated_at = excluded.updated_at, status = excluded.status,
         kind = COALESCE(excluded.kind, kind), closed_at = 0
       WHERE owner_uid = excluded.owner_uid`,
      chat.id,
      chat.ownerUid,
      chat.ownerName,
      chat.title,
      now,
      now,
      chat.status,
      chat.kind ?? null,
    );
    this.#changed("chats");
  }

  /**
   * Bump a shared chat to the top with its current title, as touchChat does for the owner. `byOther`: someone else wrote.
   * `named`: the title was just cut from this message.
   */
  touchSharedChat(id: string, ownerUid: string, title: string, byOther: boolean, tag?: Tag, named = false): void {
    this.#touch(id, ownerUid, title, byOther, tag, named);
  }

  /**
   * Bump a chat. With `tag`, the message tagged this user: the chat is marked so until they look, and the open apps hear
   * it (MentionNotice), with the chat's title unless the chat is named after this very message (`named`).
   */
  #touch(id: string, ownerUid: string, title: string, byOther: boolean, tag?: Tag, named = false): void {
    // This object's own clock for the row, as every other write to it uses: a tag's time comes from the chat, and could
    // put activity_at back behind a later write. The notice keeps the tag's time, which windows share.
    const now = Date.now();
    const set = "title = ?, updated_at = ?, activity_at = CASE WHEN ? THEN ? ELSE activity_at END, mentioned_at = CASE WHEN ? THEN ? ELSE mentioned_at END";
    if (!this.#updateChat(id, ownerUid, set, title, now, byOther ? 1 : 0, now, tag ? 1 : 0, now) || !tag) return;
    // A tag opens the chat again for someone who closed it.
    this.#rows.reopen(id);
    this.#changed({ type: "mention", chatId: id, ...(!named && { title }), ...tag });
    this.ctx.waitUntil(this.push({ title: "You were mentioned", body: "Someone mentioned you in a chat.", url: `/c/${id}`, tag: `mention:${id}` }));
  }

  /** The last post of an agent's own conversation, as its contact row shows it. */
  #notePreview(id: string, text: string): void {
    this.ctx.storage.sql.exec("UPDATE chats SET preview = ? WHERE id = ? AND agent_id IS NOT NULL", excerpt(text, 120), id);
  }

  removeSharedChat(id: string, ownerUid: string): void {
    if (!this.ctx.storage.sql.exec("DELETE FROM shared_chats WHERE id = ? AND owner_uid = ?", id, ownerUid).rowsWritten) return;
    // Out of the chat, this user shares it with nobody.
    this.#rows.forgetPeople(id);
    this.#changed("chats");
  }

  /** A new chat of this user's: unnamed (named after its first message), or with `title` (a branch, a page's chat). */
  createChat(id: string, made: { title?: string; kind?: ChatKind } = {}): ChatSummary {
    const now = Date.now();
    const title = made.title?.slice(0, MAX_CHAT_TITLE) || UNNAMED_CHAT;
    const kind = made.kind ?? "private";
    this.ctx.storage.sql.exec("INSERT INTO chats (id, title, created_at, updated_at, kind) VALUES (?, ?, ?, ?, ?)", id, title, now, now, kind);
    this.#changed("chats");
    return { id, title, createdAt: now, updatedAt: now, kind };
  }

  hasChat(id: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM chats WHERE id = ?", id).toArray().length > 0;
  }

  /**
   * Bump a chat to the top. A chat still unnamed is named after the prompt, so the first prompt names it (`named`), until
   * a model gives it a better title (nameChat). `byOther`: someone other than this user wrote it. Returns its title.
   */
  touchChat(id: string, prompt: string, byOther: boolean, tag?: Tag): { title: string; named: boolean } {
    this.#notePreview(id, prompt);
    const before = this.chatTitle(id);
    const named = before === UNNAMED_CHAT;
    const title = named || before === null ? titleFromMessage(prompt) : before;
    this.#touch(id, this.ctx.id.name!, title, byOther, tag, named);
    return { title, named };
  }

  chatTitle(id: string): string | null {
    return this.ctx.storage.sql.exec<{ title: string }>("SELECT title FROM chats WHERE id = ?", id).toArray()[0]?.title ?? null;
  }

  /** The ids of the artifacts this user published from one of their chats. */
  chatArtifactIds(chatId: string): string[] {
    return this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM artifacts WHERE chat_id = ?", chatId).toArray().map((row) => row.id);
  }

  /** Take a deleted chat, and the artifacts it published, out of this user's lists. The chat deletes the rest first. */
  forgetChat(id: string): void {
    const home = this.ctx.storage.sql.exec<{ agent_id: string | null }>("SELECT agent_id FROM chats WHERE id = ?", id).toArray()[0]?.agent_id;
    this.#signIns.forgetChat(id);
    this.#agents.forgetChat(id);
    // The values its pages saved for this user, which were everyone's defaults.
    this.ctx.storage.sql.exec("DELETE FROM page_values WHERE artifact_id IN (SELECT id FROM artifacts WHERE chat_id = ?)", id);
    if (this.ctx.storage.sql.exec("DELETE FROM artifacts WHERE chat_id = ?", id).rowsWritten) this.#changed("artifacts");
    this.#rows.forgetChat(id);
    if (this.ctx.storage.sql.exec("DELETE FROM chats WHERE id = ?", id).rowsWritten) this.#changed("chats");
    // An agent's home deleted while the agent is on: it gets a new one, so its schedule and watches go on there.
    if (home && this.#agents.get(home)?.enabled) this.ensureAgentHome(home);
  }

  listArtifacts(): ArtifactSummary[] {
    return this.#artifactSummaries(this.ctx.storage.sql.exec<ArtifactRow>("SELECT * FROM artifacts ORDER BY updated_at DESC").toArray());
  }

  #artifactSummaries(rows: ArtifactRow[]): ArtifactSummary[] {
    return rows
      .map((row) => ({
        id: row.id,
        title: row.title,
        chatId: row.chat_id,
        latest: row.latest,
        updatedAt: row.updated_at,
        ...(row.latest > row.seen && { unread: true as const }),
      }));
  }

  /** The artifacts one chat published, newest first: where a publish by title finds the artifact it revises. */
  listChatArtifacts(chatId: string): ArtifactSummary[] {
    return this.#artifactSummaries(this.ctx.storage.sql.exec<ArtifactRow>("SELECT * FROM artifacts WHERE chat_id = ? ORDER BY updated_at DESC", chatId).toArray());
  }

  /** The owner opened `version` of an artifact: it and the ones before are no longer unread. */
  markArtifactSeen(id: string, version: number): void {
    if (this.ctx.storage.sql.exec("UPDATE artifacts SET seen = ? WHERE id = ? AND seen < ?", version, id, version).rowsWritten) this.#changed("artifacts");
  }

  /** A version was published. `seen`: the user has it already (an import brought it), so it is not unread. */
  recordArtifact(artifact: ArtifactSummary, seen = false): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO artifacts (id, title, chat_id, latest, updated_at, seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, latest = excluded.latest, updated_at = excluded.updated_at, seen = MAX(seen, excluded.seen)`,
      artifact.id,
      artifact.title,
      artifact.chatId,
      artifact.latest,
      artifact.updatedAt,
      seen ? artifact.latest : 0,
    );
    this.#changed("artifacts");
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
   * without the user turning it on. `files` are the files of a skill imported as a package, which replace the ones it
   * had (`replacedFileSet`, for the caller to delete); without them, a skill keeps the files it has.
   */
  saveSkill(input: unknown, origin: SavedSkillOrigin, enabled: boolean, files?: SkillPackageFiles): (SkillInfo & { replacedFileSet?: string }) | { error: string } {
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
    const had = packageFiles(existing);
    const kept = files ?? had;
    this.ctx.storage.sql.exec(
      `INSERT INTO skills (name, description, instructions, tools, origin, enabled, updated_at, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET description = excluded.description, instructions = excluded.instructions, tools = excluded.tools,
         origin = excluded.origin, enabled = excluded.enabled, updated_at = excluded.updated_at, files = excluded.files`,
      skill.name,
      skill.description,
      skill.instructions,
      JSON.stringify(skill.tools),
      origin,
      on ? 1 : 0,
      now,
      kept && JSON.stringify(kept),
    );
    this.#changed("skills");
    const replaced = files && had && had.set !== files.set ? { replacedFileSet: had.set } : {};
    return { ...skill, origin, enabled: on, updatedAt: now, ...(kept && { files: kept.list, fileSet: kept.set }), ...replaced };
  }

  setBuiltinSkillEnabled(name: string, enabled: boolean): SkillResult {
    if (!builtinSkill(name)) return { error: `No built-in skill named "${name}".` };
    const written = enabled
      ? this.ctx.storage.sql.exec("DELETE FROM builtin_skills_off WHERE name = ?", name).rowsWritten
      : this.ctx.storage.sql.exec("INSERT OR IGNORE INTO builtin_skills_off (name) VALUES (?)", name).rowsWritten;
    if (written) this.#changed("skills");
    return this.getBuiltinSkill(name)!;
  }

  /**
   * Turn one of the user's skills on or off. `seen` is the `updatedAt` of the version
   * the user read: turning on a skill that changed since (a proposal the agent
   * replaced while the user reviewed it) is refused, so they read it again.
   */
  setSkillEnabled(name: string, enabled: boolean, seen?: number): SkillResult {
    let written: number;
    if (enabled) {
      const current = this.ctx.storage.sql.exec<{ updated_at: number }>("SELECT updated_at FROM skills WHERE name = ?", name).toArray()[0];
      if (current && seen !== undefined && current.updated_at !== seen) {
        return { error: `The skill "${name}" changed since you read it; read it again before turning it on.` };
      }
      // Turning a proposal on makes it the user's own: the agent can no longer replace it.
      written = this.ctx.storage.sql.exec("UPDATE skills SET enabled = 1, origin = 'user', updated_at = ? WHERE name = ?", Date.now(), name).rowsWritten;
    } else {
      written = this.ctx.storage.sql.exec("UPDATE skills SET enabled = 0, updated_at = ? WHERE name = ?", Date.now(), name).rowsWritten;
    }
    if (written) this.#changed("skills");
    return this.getSkill(name) ?? { error: `No skill named "${name}".` };
  }

  /** The user's agents, by name. */
  listAgents(): AgentDefinition[] {
    return this.#agents.list();
  }

  getAgent(id: string): AgentDefinition | null {
    return this.#agents.get(id);
  }

  /**
   * Save one of the user's agents (AgentStore.save): a new one, or with `save.id` a change to one. One the model
   * proposes is saved off, for the user to review and turn on.
   */
  saveAgent(input: unknown, origin: AgentOrigin, enabled?: boolean, save?: AgentSave): AgentResult {
    if (origin === "agent") {
      const signIn = new Set(oauthServers(this.env).map((server) => server.name));
      input = withoutSignInShares(input, (server) => signIn.has(server));
    }
    const saved = this.#agents.save(input, origin, enabled, save);
    if (!("error" in saved)) this.#agentChanged(saved.id);
    return saved;
  }

  /** Turn one of the user's agents on or off; `version` is the one they read (see AgentStore.setEnabled). */
  setAgentEnabled(id: string, enabled: boolean, version?: number): AgentResult {
    const before = this.#agents.get(id)?.version;
    const result = this.#agents.setEnabled(id, enabled, version);
    if (!("error" in result) && result.version !== before) this.#agentChanged(id);
    return result;
  }

  deleteAgent(id: string): { error: string } | null {
    const refused = this.#agents.delete(id);
    if (!refused) this.#agentChanged(id);
    return refused;
  }

  /** The user's own copy of an agent someone shared with them, saved off (AgentStore.saveCopy). */
  copyAgent(input: AgentChanges, copiedFrom: NonNullable<AgentDefinition["copiedFrom"]>): AgentResult {
    const saved = this.#agents.saveCopy(input, copiedFrom);
    if (!("error" in saved)) this.#changed("agents");
    return saved;
  }

  /** An agent from an export (AgentStore.import): the id it has here, `skipped` when the user had one by its name. */
  importAgent(agent: ExportedAgent): { id: string; skipped?: true } | { error: string } {
    const result = this.#agents.import(agent);
    if ("id" in result && !result.skipped) this.#changed("agents");
    return result;
  }

  /** One of the user's chats added an agent of theirs, took it out, or changed whether it shares it (AgentStore.noteChat). */
  noteAgentChat(agentId: string, chatId: string, inChat: boolean, shared = false): void {
    // Only the index: the agents list the sidebars read is the same.
    this.#agents.noteChat(agentId, chatId, inChat, shared);
  }

  /** The chats of the user's an agent is in, by title, with whether it is shared there. */
  agentChats(agentId: string): AgentChatUse[] {
    return this.#agents.chatsOf(agentId).flatMap(({ chatId, shared }) => {
      const title = this.chatTitle(chatId);
      return title === null ? [] : [{ chatId, title, shared }];
    });
  }

  /** Delete one of the user's skills. Built-in ones can only be turned off. */
  deleteSkill(name: string): SkillResult | null {
    const deleted = this.ctx.storage.sql.exec("DELETE FROM skills WHERE name = ?", name).rowsWritten;
    if (deleted) this.#changed("skills");
    return deleted ? null : { error: `No skill named "${name}".` };
  }

  /** The model and effort the user last picked in any chat: what their new chats start on. Checked by the chat that reads it. */
  modelChoice(): ModelSetting | null {
    return this.ctx.storage.kv.get<ModelSetting>("model") ?? null;
  }

  setModelChoice(choice: ModelSetting): void {
    this.ctx.storage.kv.put("model", choice);
  }

  /** The user's own system prompt, added to the built-in one in all their chats; "" for none. Always theirs to change. */
  systemPrompt(): ChatSystemPrompt {
    return { text: readSystemPrompt(this.ctx.storage.kv), editable: true };
  }

  /**
   * What one page saved for this user, by key. A null value is a key they removed that the page's author has: it
   * stays removed for them instead of falling back to the author's.
   */
  pageValues(artifactId: string): Record<string, string | null> {
    const rows = this.ctx.storage.sql.exec<{ key: string; value: string | null }>("SELECT key, value FROM page_values WHERE artifact_id = ?", artifactId).toArray();
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  /**
   * Save a page's changes for this user: a string sets a key, null removes it. `author`: the user wrote the page, so a
   * removed key is gone; anyone else keeps it as removed (see pageValues). All or nothing, within PAGE_STORAGE_LIMITS.
   */
  writePageValues(artifactId: string, changes: Record<string, string | null>, author: boolean): { ok: true } | { error: string } {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    try {
      this.ctx.storage.transactionSync(() => {
        for (const [key, value] of Object.entries(changes)) {
          if (value === null && author) sql.exec("DELETE FROM page_values WHERE artifact_id = ? AND key = ?", artifactId, key);
          else {
            sql.exec(
              "INSERT INTO page_values (artifact_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(artifact_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
              artifactId,
              key,
              value,
              now,
            );
          }
        }
        const { keys, chars } = sql
          .exec<{ keys: number; chars: number | null }>("SELECT COUNT(*) AS keys, SUM(length(key) + COALESCE(length(value), 0)) AS chars FROM page_values WHERE artifact_id = ?", artifactId)
          .one();
        if (keys > PAGE_STORAGE_LIMITS.keys) throw new PageLimitError(`A page saves at most ${PAGE_STORAGE_LIMITS.keys} keys.`);
        if ((chars ?? 0) > PAGE_STORAGE_LIMITS.totalChars) throw new PageLimitError(`A page saves at most ${PAGE_STORAGE_LIMITS.totalChars} characters.`);
      });
    } catch (error) {
      if (error instanceof PageLimitError) return { error: error.message };
      throw error;
    }
    return { ok: true };
  }

  /** Drop everything one page saved for this user. */
  resetPageValues(artifactId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM page_values WHERE artifact_id = ?", artifactId);
  }

  /** What this user's calls to pages' models cost today (UTC), in dollars. */
  pageAiSpentToday(): number {
    return this.ctx.storage.sql.exec<{ cost: number }>("SELECT cost FROM page_ai_spend WHERE day = ?", utcDay()).toArray()[0]?.cost ?? 0;
  }

  /** Count one call to a page's model against this user, who typed what it answered. */
  recordPageAi(usage: { input: number; output: number; cost: number }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO page_ai_spend (day, calls, input, output, cost) VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET calls = calls + 1, input = input + excluded.input, output = output + excluded.output, cost = cost + excluded.cost`,
      utcDay(),
      usage.input,
      usage.output,
      usage.cost,
    );
  }

  /**
   * What an export of this user's data takes from here (shared/data-export.ts): their settings and skills, what pages
   * saved for them, their own chats and artifacts, and by name the chats others shared with them. Not their sign-ins
   * to MCP servers (tokens, which belong to this deployment), nor what their pages' model calls cost.
   */
  exportAccount(): Pick<ExportStart, "account" | "chats" | "artifacts" | "sharedWithMe"> {
    const sql = this.ctx.storage.sql;
    const values = new Map<string, Record<string, string | null>>();
    for (const row of sql.exec<{ artifact_id: string; key: string; value: string | null }>("SELECT artifact_id, key, value FROM page_values ORDER BY artifact_id, key")) {
      const page = values.get(row.artifact_id) ?? {};
      page[row.key] = row.value;
      values.set(row.artifact_id, page);
    }
    const skills = sql
      .exec<SkillRow>("SELECT * FROM skills ORDER BY name")
      .toArray()
      .map(skillInfo)
      .map(({ name, description, instructions, tools, origin, enabled, files }): ExportedSkill => ({ name, description, instructions, tools, origin: origin as SavedSkillOrigin, enabled, ...(files && { files }) }));
    return {
      account: {
        systemPrompt: readSystemPrompt(this.ctx.storage.kv),
        model: this.modelChoice(),
        builtinSkillsOff: sql.exec<{ name: string }>("SELECT name FROM builtin_skills_off ORDER BY name").toArray().map((row) => row.name),
        skills,
        agents: this.#agents.list().map(exportedAgent),
        pageValues: [...values].map(([artifactId, entries]): ExportedPageValues => ({ artifactId, values: entries })),
      },
      chats: sql
        .exec<{ id: string; title: string; created_at: number; updated_at: number; shared: number }>("SELECT id, title, created_at, updated_at, shared FROM chats ORDER BY created_at")
        .toArray()
        .map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.shared === 1 && { shared: true as const }) })),
      artifacts: sql
        .exec<ArtifactRow>("SELECT * FROM artifacts ORDER BY updated_at")
        .toArray()
        .map((row) => ({ id: row.id, title: row.title, chatId: row.chat_id, latest: row.latest })),
      sharedWithMe: sql
        .exec<{ title: string; owner_name: string }>("SELECT title, owner_name FROM shared_chats ORDER BY joined_at")
        .toArray()
        .map((row) => ({ title: row.title, ownerName: row.owner_name })),
    };
  }

  /**
   * An import's settings, each only where this user has none of their own yet: an import adds to what is here, never
   * over it. Built-in skills turned off there are turned off here too. Returns what it set.
   */
  importSettings(input: ImportedSettings): string[] {
    const applied: string[] = [];
    if (input.systemPrompt && !readSystemPrompt(this.ctx.storage.kv) && !("error" in saveSystemPrompt(this.ctx.storage.kv, input.systemPrompt))) applied.push("system prompt");
    // The chat that reads it checks it against the models this deployment has (ChatAgent.#savedModel).
    if (input.model && typeof input.model === "object" && !this.modelChoice()) {
      this.setModelChoice(input.model);
      applied.push("model");
    }
    let off = 0;
    for (const name of Array.isArray(input.builtinSkillsOff) ? input.builtinSkillsOff : []) {
      if (typeof name === "string" && builtinSkill(name)) off += this.ctx.storage.sql.exec("INSERT OR IGNORE INTO builtin_skills_off (name) VALUES (?)", name).rowsWritten;
    }
    if (off) {
      applied.push("built-in skills turned off");
      this.#changed("skills");
    }
    return applied;
  }

  /** Add a chat an import filled (ChatAgent.importFinish) to this user's list, read: the import is the commit point. */
  importChat(chat: Pick<ExportedChat, "id" | "title" | "createdAt" | "updatedAt">, kind: ChatKind = "private"): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO chats (id, title, created_at, updated_at, seen_at, kind) VALUES (?, ?, ?, ?, ?, ?)",
      chat.id,
      chat.title.slice(0, MAX_CHAT_TITLE) || UNNAMED_CHAT,
      chat.createdAt || now,
      chat.updatedAt || now,
      now,
      kind,
    );
    this.#changed("chats");
  }

  /**
   * Keep what pages saved for this user, as an import brings it: only for a page that has saved nothing for them here,
   * and within PAGE_STORAGE_LIMITS. Returns how many pages' values it kept.
   */
  importPageValues(pages: readonly ExportedPageValues[]): number {
    let kept = 0;
    for (const { artifactId, values } of pages) {
      if (!Object.keys(this.pageValues(artifactId)).length && "ok" in this.writePageValues(artifactId, values, false)) kept++;
    }
    return kept;
  }

  /** Which of `ids` are this user's own chats. */
  ownChats(ids: readonly string[]): string[] {
    return ids.filter((id) => this.hasChat(id));
  }

  /** This user's artifacts among `ids`, with the chat each is in and its latest version. */
  ownArtifacts(ids: readonly string[]): Pick<ArtifactRow, "id" | "chat_id" | "latest">[] {
    const wanted = new Set(ids);
    return this.ctx.storage.sql
      .exec<ArtifactRow>("SELECT id, chat_id, latest FROM artifacts")
      .toArray()
      .filter((row) => wanted.has(row.id));
  }

  /** How many seconds of audio the Worker transcribed for this user today (UTC) (worker/dictation.ts). */
  dictationSecondsToday(): number {
    return this.ctx.storage.sql.exec<{ seconds: number }>("SELECT seconds FROM dictation_use WHERE day = ?", utcDay()).toArray()[0]?.seconds ?? 0;
  }

  /** Count one transcribed clip against this user. */
  recordDictation(seconds: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO dictation_use (day, clips, seconds) VALUES (?, 1, ?)
       ON CONFLICT(day) DO UPDATE SET clips = clips + 1, seconds = seconds + excluded.seconds`,
      utcDay(),
      seconds,
    );
  }

  /** Save the user's system prompt; their chats use it from their next message on. */
  setSystemPrompt(value: unknown): ChatSystemPrompt | { error: string } {
    const saved = saveSystemPrompt(this.ctx.storage.kv, value);
    return "error" in saved ? saved : { ...saved, editable: true };
  }
}

/** A page's write that would go over PAGE_STORAGE_LIMITS: it rolls the write back. */
class PageLimitError extends Error {}

/** Today, as YYYY-MM-DD in UTC. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

const packageFiles = (row: Pick<SkillRow, "files"> | undefined) => (row?.files ? (JSON.parse(row.files) as SkillPackageFiles) : null);

function skillInfo(row: SkillRow): SkillInfo {
  const files = packageFiles(row);
  return {
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    tools: JSON.parse(row.tools) as string[],
    origin: row.origin,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
    ...(files && { files: files.list, fileSet: files.set }),
  };
}

/** A built-in skill as the user sees it: `replaced` when one of their own, turned on, has its name. */
function builtinInfo(skill: SkillInput, off: boolean, replaced: boolean): SkillInfo {
  return { ...skill, origin: "builtin", enabled: !off, updatedAt: 0, ...(replaced && { replaced: true as const }) };
}
