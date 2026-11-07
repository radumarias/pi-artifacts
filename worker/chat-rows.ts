import { isChatKind, legacyKind, type ChatKind } from "../shared/chat-kinds.ts";
import { MAX_CHAT_TITLE, type ChatRowChange, type ChatStatus, type ChatSummary, type Person } from "../shared/protocol.ts";
import { isObject } from "../shared/util.ts";
import { addColumns, type Sql } from "./members.ts";

/** The most (person, chat) pairs a sidebar remembers (ChatRows.knowPeople), newest kept. */
export const MAX_KNOWN_PAIRS = 5000;

/** A change as the browser sends it, checked for shape; null when it holds nothing valid. */
export function parseRowChange(given: unknown): ChatRowChange | null {
  if (!isObject(given)) return null;
  const change: ChatRowChange = {};
  for (const key of ["pinned", "closed", "unread"] as const) if (typeof given[key] === "boolean") change[key] = given[key];
  if (typeof given.title === "string") change.title = given.title.trim().slice(0, MAX_CHAT_TITLE);
  return Object.keys(change).length ? change : null;
}

type Row = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  shared_by: string | null;
  shared: number;
  status: ChatStatus | null;
  unread: number;
  mentioned: number;
  kind: string | null;
  pinned_at: number;
  closed_at: number;
  agent_id: string | null;
  preview: string | null;
};

/**
 * The parts of one user's sidebar rows (UserDirectory's `chats`, their own, and `shared_chats`, others' they are in)
 * that are theirs alone, and what the rows say of each chat's kind: pinned, closed, marked unread, their own name for
 * it. Also which of their artifacts has its chat ("Discuss", `page_chats`), and the people they share chats with
 * (`people`), whom the "@" picker offers to add. Over the directory's own SQLite; the directory tells the open sidebars.
 */
export class ChatRows {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    for (const table of ["chats", "shared_chats"]) {
      // Copied from the chat (setKind); null in a row from before kinds, which kindOf reads as the chat was.
      addColumns(sql, table, {
        kind: "TEXT",
        pinned_at: "INTEGER NOT NULL DEFAULT 0",
        closed_at: "INTEGER NOT NULL DEFAULT 0",
        marked_unread: "INTEGER NOT NULL DEFAULT 0",
        own_title: "TEXT",
      });
    }
    // An agent's own conversation: the agent it is the home of, and its last post, shown like a contact's.
    addColumns(sql, "chats", { agent_id: "TEXT", preview: "TEXT" });
    sql.exec("CREATE INDEX IF NOT EXISTS chats_by_agent ON chats (agent_id) WHERE agent_id IS NOT NULL");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS page_chats (artifact_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS branch_counts (root TEXT PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_people (uid TEXT NOT NULL, chat_id TEXT NOT NULL, name TEXT NOT NULL, met_at INTEGER NOT NULL, PRIMARY KEY (uid, chat_id));
    `);
  }

  /** The user's own chats and the ones shared with them, most recent first, as their sidebar shows them. */
  list(contact: (agentId: string | null, preview: string | null) => Pick<ChatSummary, "agent"> = () => ({})): ChatSummary[] {
    const rows = this.#sql
      .exec(
        `SELECT id, COALESCE(own_title, title) AS title, created_at, updated_at, NULL AS shared_by, shared, status,
           (activity_at > seen_at OR marked_unread = 1) AS unread, mentioned_at > seen_at AS mentioned, kind, pinned_at, closed_at,
           agent_id, preview FROM chats
         UNION ALL SELECT id, COALESCE(own_title, title), joined_at, updated_at, owner_name, 0, status,
           (activity_at > seen_at OR marked_unread = 1), mentioned_at > seen_at, kind, pinned_at, closed_at, NULL, NULL FROM shared_chats
         ORDER BY updated_at DESC`,
      )
      .toArray() as Row[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      kind: rowKind(row.kind, row.shared_by !== null || row.shared === 1),
      ...(row.shared_by !== null ? { sharedBy: row.shared_by } : row.shared === 1 && { shared: true as const }),
      ...(row.status && { status: row.status }),
      ...(row.unread === 1 && { unread: true as const }),
      ...(row.mentioned === 1 && { mentioned: true as const }),
      ...(row.pinned_at > 0 && { pinnedAt: row.pinned_at }),
      ...(row.closed_at > 0 && { closed: true as const }),
      ...contact(row.agent_id, row.preview),
    }));
  }

  /**
   * Change the user's own row for chat `id` (ChatRowChange), in whichever table has it. Their own name is kept apart
   * from the chat's title, so the chat naming itself, or its owner renaming it, does not undo it. Whether a row changed.
   */
  change(id: string, change: ChatRowChange, now = Date.now()): boolean {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (change.pinned !== undefined) {
      sets.push("pinned_at = CASE WHEN ? THEN CASE WHEN pinned_at > 0 THEN pinned_at ELSE ? END ELSE 0 END");
      values.push(change.pinned ? 1 : 0, now);
    }
    if (change.closed !== undefined) {
      sets.push("closed_at = ?");
      values.push(change.closed ? now : 0);
    }
    if (change.unread !== undefined) {
      sets.push("marked_unread = ?");
      values.push(change.unread ? 1 : 0);
    }
    if (change.title !== undefined) {
      sets.push("own_title = ?");
      values.push(change.title || null);
    }
    if (!sets.length) return false;
    const set = sets.join(", ");
    let written = 0;
    for (const table of ["chats", "shared_chats"]) written += this.#sql.exec(`UPDATE ${table} SET ${set} WHERE id = ?`, ...values, id).rowsWritten;
    return written > 0;
  }

  /** Someone tagged this user in chat `id` (or added them to it again): a chat they closed is in their list again. */
  reopen(id: string): void {
    for (const table of ["chats", "shared_chats"]) this.#sql.exec(`UPDATE ${table} SET closed_at = 0 WHERE id = ? AND closed_at > 0`, id);
  }

  /** The names this user's own chats go by in their sidebar, by id: their own name for one, if they gave it. */
  ownTitles(): Map<string, string> {
    const rows = this.#sql.exec("SELECT id, COALESCE(own_title, title) AS title FROM chats").toArray();
    return new Map(rows.map((row) => [row.id as string, row.title as string]));
  }

  /** The kind of chat `id` as this sidebar last heard it, or null for a chat it does not list. */
  kindOf(id: string): ChatKind | null {
    const row = this.#sql
      .exec("SELECT kind, shared AS members FROM chats WHERE id = ? UNION ALL SELECT kind, 1 FROM shared_chats WHERE id = ?", id, id)
      .toArray()[0];
    return row ? rowKind(row.kind as string | null, row.members === 1) : null;
  }

  /** The chat that discusses one of this user's artifacts, made by "Discuss" on its page; null when there is none yet. */
  pageChat(artifactId: string): string | null {
    const row = this.#sql
      .exec("SELECT p.chat_id FROM page_chats p JOIN chats c ON c.id = p.chat_id WHERE p.artifact_id = ?", artifactId)
      .toArray()[0];
    return (row?.chat_id as string | undefined) ?? null;
  }

  linkPage(artifactId: string, chatId: string): void {
    this.#sql.exec(
      "INSERT INTO page_chats (artifact_id, chat_id) VALUES (?, ?) ON CONFLICT(artifact_id) DO UPDATE SET chat_id = excluded.chat_id",
      artifactId,
      chatId,
    );
  }

  /** A deleted chat no longer discusses any page, nobody is known through it, and its branches count for nothing. */
  forgetChat(chatId: string): void {
    this.#sql.exec("DELETE FROM page_chats WHERE chat_id = ?", chatId);
    // Its branches may outlive it: their count stays until the last of them is deleted (returnBranch).
    this.#sql.exec("DELETE FROM branch_counts WHERE root = ? AND n <= 0", chatId);
    this.forgetPeople(chatId);
  }

  /**
   * Count one more branch of the conversation that started in chat `root` (branchOff), unless it has `max`: whether it
   * was counted. Its branches' branches count against the same root.
   */
  takeBranch(root: string, max: number): boolean {
    const n = (this.#sql.exec("SELECT n FROM branch_counts WHERE root = ?", root).toArray()[0]?.n as number | undefined) ?? 0;
    if (n >= max) return false;
    this.#sql.exec("INSERT INTO branch_counts (root, n) VALUES (?, 1) ON CONFLICT(root) DO UPDATE SET n = n + 1", root);
    return true;
  }

  /** A branch counted against `root` was deleted, or never made: its place is free again. */
  returnBranch(root: string): void {
    this.#sql.exec("UPDATE branch_counts SET n = n - 1 WHERE root = ? AND n > 0", root);
    this.#sql.exec("DELETE FROM branch_counts WHERE root = ? AND n <= 0", root);
  }

  /**
   * Remember the people this user shares chat `chatId` with, by the name they last showed. Someone is known only while
   * they share a chat with this user: each pair goes when either leaves it, or it is deleted (forgetPeople).
   */
  knowPeople(chatId: string, people: readonly Person[], self: string, now = Date.now()): void {
    for (const person of people) {
      if (person.uid === self) continue;
      this.#sql.exec(
        `INSERT INTO chat_people (uid, chat_id, name, met_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(uid, chat_id) DO UPDATE SET name = excluded.name, met_at = excluded.met_at`,
        person.uid,
        chatId,
        person.name,
        now,
      );
    }
    const pairs = this.#sql.exec("SELECT COUNT(*) AS n FROM chat_people").toArray()[0]?.n as number;
    if (pairs > MAX_KNOWN_PAIRS) {
      this.#sql.exec(
        "DELETE FROM chat_people WHERE rowid NOT IN (SELECT rowid FROM chat_people ORDER BY met_at DESC LIMIT ?)",
        MAX_KNOWN_PAIRS,
      );
    }
  }

  /** This user no longer shares chat `chatId` with `uid`, or (no `uid`) with anyone: they left it, or it is gone. */
  forgetPeople(chatId: string, uid?: string): void {
    if (uid === undefined) this.#sql.exec("DELETE FROM chat_people WHERE chat_id = ?", chatId);
    else this.#sql.exec("DELETE FROM chat_people WHERE chat_id = ? AND uid = ?", chatId, uid);
  }

  /** The people this user shares a chat with now, most recently met first, by the name they last showed. */
  people(): Person[] {
    return this.#sql
      .exec("SELECT uid, name, MAX(met_at) AS met FROM chat_people GROUP BY uid ORDER BY met DESC")
      .toArray()
      .map((row) => ({ uid: row.uid as string, name: row.name as string }));
  }

  /** One of them, or null for someone this user shares no chat with now. */
  person(uid: string): Person | null {
    const row = this.#sql.exec("SELECT uid, name FROM chat_people WHERE uid = ? ORDER BY met_at DESC LIMIT 1", uid).toArray()[0];
    return row ? { uid: row.uid as string, name: row.name as string } : null;
  }
}

/** A row's kind: as copied from the chat, or for a row from before kinds, as the chat then was (with members a group). */
function rowKind(kind: string | null, hasMembers: boolean): ChatKind {
  return isChatKind(kind) ? kind : legacyKind(hasMembers);
}
