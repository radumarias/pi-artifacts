import {
  MAX_NOTES,
  NOTE_ID_PATTERN,
  MAX_UNCONFIRMED,
  MAX_UNCONFIRMED_ALL,
  confirmsKept,
  reads,
  type MemoryKind,
  type MemoryNote,
  type MemoryReader,
  type MemoryScope,
  type MemorySource,
  type NoteChange,
} from "../../shared/memory.ts";
import { randomHex } from "../../shared/util.ts";
import { addColumns, type Sql } from "../members.ts";

/** A note that waits for its owner's confirm, as SQL. */
const WAITING = "confirmed = 0 AND forgotten_at IS NULL";

type NoteRow = {
  id: string;
  scope: MemoryScope;
  agent_id: string | null;
  chat_id: string | null;
  text: string;
  source: MemorySource;
  kind: MemoryKind;
  learned_by: string | null;
  uses: number;
  pinned: number;
  confirmed: number;
  forgotten_at: number | null;
  created_at: number;
  updated_at: number;
};

function noteOf(row: NoteRow): MemoryNote {
  return {
    id: row.id,
    scope: row.scope,
    ...(row.agent_id && { agentId: row.agent_id }),
    ...(row.chat_id && { chatId: row.chat_id }),
    text: row.text,
    source: row.source,
    kind: row.kind,
    ...(row.learned_by && { learnedBy: row.learned_by }),
    uses: row.uses,
    pinned: row.pinned === 1,
    confirmed: row.confirmed === 1,
    ...(row.forgotten_at !== null && { forgottenAt: row.forgotten_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A note to keep: where it goes, what it says, and how it came. */
export type NoteFields = Pick<MemoryNote, "scope" | "text" | "source" | "kind" | "confirmed"> &
  Partial<Pick<MemoryNote, "agentId" | "chatId" | "learnedBy" | "pinned">> & {
    /** False for a save in a turn the owner did not ask for (MemoryWriter.byOwner): see add. */
    byOwner?: boolean;
  };

/** What adding a note did: the note, and whether it was one already kept (the same text, for the same reader). */
export type NoteAdded = { note: MemoryNote; existed?: true } | { error: string };

/**
 * One user's memory notes (shared/memory.ts), in their UserDirectory's SQLite. The rules of who reads a note are in
 * `reads`; this keeps them, counts their uses, and keeps a forgotten note until it is brought back or deleted.
 */
export class MemoryStore {
  readonly #sql: Sql;
  readonly #now: () => number;

  constructor(sql: Sql, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT, chat_id TEXT, text TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
        learned_by TEXT, uses INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, confirmed INTEGER NOT NULL, forgotten_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    // Whether the save was in a turn the owner asked for (see add).
    addColumns(sql, "memory", { by_owner: "INTEGER NOT NULL DEFAULT 1" });
  }

  #rows(where = "", ...params: (string | number)[]): MemoryNote[] {
    return (this.#sql.exec(`SELECT * FROM memory ${where}`, ...params).toArray() as NoteRow[]).map(noteOf);
  }

  /** Every note, forgotten ones too, newest first. */
  list(): MemoryNote[] {
    return this.#rows("ORDER BY created_at DESC, id DESC");
  }

  get(id: string): MemoryNote | null {
    return this.#rows("WHERE id = ?", id)[0] ?? null;
  }

  /** The notes `reader` reads (see `reads`, which has the last word), oldest first. */
  readable(reader: MemoryReader): MemoryNote[] {
    // Only the rows that may be read: the user's own, the reader's agent's, the reader's chat's.
    return this.#rows(
      "WHERE forgotten_at IS NULL AND confirmed = 1 AND (scope = 'user' OR (scope = 'agent' AND agent_id = ?) OR (scope = 'chat' AND chat_id = ?)) ORDER BY created_at, id",
      reader.agentId ?? "",
      reader.chatId,
    ).filter((note) => reads(reader, note));
  }

  /** The notes that take the owner's room: all but those waiting from saves they did not ask for (see add). */
  #ownersCount(): number {
    return this.#count(`WHERE NOT (by_owner = 0 AND ${WAITING})`);
  }

  #count(where = "", ...params: (string | number | null)[]): number {
    return this.#sql.exec(`SELECT COUNT(*) AS n FROM memory ${where}`, ...params).toArray()[0].n as number;
  }

  /** Write `note` as a new row. */
  #insert(note: MemoryNote & Pick<NoteFields, "byOwner">): void {
    this.#sql.exec(
      `INSERT INTO memory (id, scope, agent_id, chat_id, text, source, kind, learned_by, uses, pinned, confirmed, forgotten_at, created_at, updated_at, by_owner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      note.id,
      note.scope,
      note.agentId ?? null,
      note.chatId ?? null,
      note.text,
      note.source,
      note.kind,
      note.learnedBy ?? null,
      note.uses,
      note.pinned ? 1 : 0,
      note.confirmed ? 1 : 0,
      note.forgottenAt ?? null,
      note.createdAt,
      note.updatedAt,
      note.byOwner === false ? 0 : 1,
    );
  }

  /**
   * Keep a note. One with the same text for the same reader (scope, agent, chat) that is in use is not kept twice:
   * it is returned (`existed`), confirmed when the new save confirms it (confirmsKept). Waiting at once, MAX_UNCONFIRMED
   * in the chat it was learned in (so nobody in one chat fills another's). Saves the owner did not ask for wait only in
   * their chat's room: they never take the owner's (MAX_NOTES for the rest, MAX_UNCONFIRMED_ALL for the owner's own).
   */
  add(fields: NoteFields): NoteAdded {
    const byOwner = fields.byOwner !== false;
    const same = this.#same(fields);
    if (same) {
      if (confirmsKept(fields, same)) this.#sql.exec("UPDATE memory SET confirmed = 1, updated_at = ? WHERE id = ?", this.#at(same), same.id);
      return { note: this.get(same.id)!, existed: true };
    }
    if ((byOwner ? this.#ownersCount() : this.#count()) >= MAX_NOTES)
      return { error: `There are ${MAX_NOTES} memory notes, the most there can be; the owner deletes some first.` };
    if (!fields.confirmed) {
      if (this.#count(`WHERE ${WAITING} AND chat_id IS ?`, fields.chatId ?? null) >= MAX_UNCONFIRMED)
        return { error: `${MAX_UNCONFIRMED} notes from this chat already wait for the owner to confirm them; ask them to look at Memory first.` };
      if (byOwner && this.#count(`WHERE ${WAITING} AND by_owner = 1`) >= MAX_UNCONFIRMED_ALL)
        return { error: `${MAX_UNCONFIRMED_ALL} notes already wait for the owner to confirm them; ask them to look at Memory first.` };
    }
    const now = this.#now();
    const id = randomHex(6);
    this.#insert({ ...fields, id, uses: 0, pinned: fields.pinned === true, createdAt: now, updatedAt: now });
    return { note: this.get(id)! };
  }

  /** A note in use with the same text for the same reader as `fields`. */
  #same(fields: Pick<NoteFields, "scope" | "agentId" | "chatId" | "text">): MemoryNote | undefined {
    // Every note's text is already on one line (checkNoteText): only its case can differ. lower() on both sides, so
    // both are lowered by the same rule.
    const reader = fields.scope === "agent" ? "AND agent_id = ?" : fields.scope === "chat" ? "AND chat_id = ?" : "";
    const target = fields.scope === "agent" ? [fields.agentId ?? ""] : fields.scope === "chat" ? [fields.chatId ?? ""] : [];
    return this.#rows(`WHERE scope = ? ${reader} AND forgotten_at IS NULL AND lower(text) = lower(?)`, fields.scope, ...target, fields.text)[0];
  }

  /** A time strictly after `note`'s last change, so a view can tell the two apart. */
  #at(note: Pick<MemoryNote, "updatedAt">): number {
    return Math.max(this.#now(), note.updatedAt + 1);
  }

  /** Count one read of each note `ids` names. */
  use(ids: readonly string[]): void {
    const unique = [...new Set(ids)];
    if (unique.length) this.#sql.exec(`UPDATE memory SET uses = uses + 1 WHERE id IN (${unique.map(() => "?").join(", ")})`, ...unique);
  }

  /**
   * Change a note as its owner asks (a change already checked: checkNoteChange, and the agent or chat it moves to is
   * theirs). A note moved keeps the chat it was learned in, and the agent that learned it, for the view.
   */
  change(id: string, change: NoteChange): MemoryNote | { error: string } {
    const note = this.get(id);
    if (!note) return { error: "No such note." };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (change.text !== undefined) set("text", change.text);
    if (change.pinned !== undefined) set("pinned", change.pinned ? 1 : 0);
    if (change.confirmed) set("confirmed", 1);
    if (change.scope !== undefined) {
      set("scope", change.scope);
      if (change.scope === "agent") set("agent_id", change.agentId ?? null);
      if (change.scope === "chat") set("chat_id", change.chatId ?? null);
    }
    if (!sets.length) return note;
    const moved = { ...note, ...change };
    // Moved onto a note that says the same for the same reader: the two are one. A forgotten note is in no one's way
    // until it is brought back (restore checks then).
    const same = note.forgottenAt === undefined && (change.text !== undefined || change.scope !== undefined) && this.#same(moved);
    if (same && same.id !== id) return { error: "Another note already says this, for the same reader." };
    set("updated_at", this.#at(note));
    this.#sql.exec(`UPDATE memory SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
    return this.get(id)!;
  }

  /** Forget a note: no agent reads it from now on, until it is brought back. `changed`: it was in use until now. */
  forget(id: string): { note: MemoryNote; changed: boolean } | { error: string } {
    const note = this.get(id);
    if (!note) return { error: "No such note." };
    if (note.forgottenAt !== undefined) return { note, changed: false };
    const at = this.#at(note);
    this.#sql.exec("UPDATE memory SET forgotten_at = ?, updated_at = ? WHERE id = ?", at, at, id);
    return { note: { ...note, forgottenAt: at, updatedAt: at }, changed: true };
  }

  /** Bring a forgotten note back. Refused when another note in use says the same for the same reader. */
  restore(id: string): MemoryNote | { error: string } {
    const note = this.get(id);
    if (!note) return { error: "No such note." };
    if (note.forgottenAt === undefined) return note;
    if (this.#same(note)) return { error: "Another note in use already says this; that one stays." };
    this.#sql.exec("UPDATE memory SET forgotten_at = NULL, updated_at = ? WHERE id = ?", this.#at(note), id);
    return this.get(id)!;
  }

  /** Delete a note for good. */
  delete(id: string): boolean {
    return this.#sql.exec("DELETE FROM memory WHERE id = ?", id).rowsWritten > 0;
  }

  /** A deleted chat: its notes go, and the others learned in it no longer name it. */
  forgetChat(chatId: string): void {
    this.#sql.exec("DELETE FROM memory WHERE scope = 'chat' AND chat_id = ?", chatId);
    this.#sql.exec("UPDATE memory SET chat_id = NULL WHERE chat_id = ?", chatId);
  }

  /** A deleted agent: its own notes go, and the others it learned no longer name it. */
  forgetAgent(agentId: string): void {
    this.#sql.exec("DELETE FROM memory WHERE scope = 'agent' AND agent_id = ?", agentId);
    this.#sql.exec("UPDATE memory SET agent_id = NULL WHERE agent_id = ?", agentId);
  }

  /**
   * A note from an export, as it was (its id when free, its times, uses and state): not when one in use already says
   * the same for the same reader (`skipped`). The caller checks where it goes (its agent, its chat).
   */
  import(note: MemoryNote): { id: string; skipped?: true } | { error: string } {
    // The same note kept here already (an import run again, or an export of this account), forgotten or not: as it is here.
    const kept = this.get(note.id);
    if (kept && kept.scope === note.scope && kept.text.toLowerCase() === note.text.toLowerCase()) return { id: kept.id, skipped: true };
    const same = note.forgottenAt === undefined ? this.#same(note) : undefined;
    if (same) return { id: same.id, skipped: true };
    if (this.#ownersCount() >= MAX_NOTES) return { error: `There are ${MAX_NOTES} memory notes already.` };
    const id = NOTE_ID_PATTERN.test(note.id) && !this.get(note.id) ? note.id : randomHex(6);
    // Its times as exported (recency ranks the notes), never later than now.
    const now = this.#now();
    const createdAt = pastTime(note.createdAt, now);
    const forgottenAt = note.forgottenAt === undefined ? undefined : pastTime(note.forgottenAt, now);
    const updatedAt = Math.max(createdAt, pastTime(note.updatedAt, createdAt, now));
    this.#insert({ ...note, id, uses: Math.max(0, Math.floor(note.uses) || 0), createdAt, updatedAt, forgottenAt });
    return { id };
  }
}

/** `time` when it is a time no later than `now`, else `fallback`. */
function pastTime(time: number | undefined, fallback: number, now = fallback): number {
  return typeof time === "number" && Number.isFinite(time) && time > 0 && time <= now ? time : fallback;
}
