import type { EntryReactions, Reaction, Reactions } from "../shared/reactions.ts";
import type { Sql } from "./members.ts";

/**
 * One chat's reactions, in the chat object's own SQLite: who reacted to which transcript entry with which emoji. The
 * transcript itself never changes once written, so they live beside it. The chat checks who may react, and to what.
 */
export class ChatReactions {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS chat_reactions (entry INTEGER NOT NULL, emoji TEXT NOT NULL, uid TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (entry, emoji, uid))",
    );
  }

  /** Add (`on`) or take back `uid`'s `emoji` on `entry`; whether that changed anything. */
  set(entry: number, emoji: Reaction, uid: string, on: boolean): boolean {
    const result = on
      ? this.#sql.exec("INSERT OR IGNORE INTO chat_reactions (entry, emoji, uid, at) VALUES (?, ?, ?, ?)", entry, emoji, uid, Date.now())
      : this.#sql.exec("DELETE FROM chat_reactions WHERE entry = ? AND emoji = ? AND uid = ?", entry, emoji, uid);
    return result.rowsWritten > 0;
  }

  /** Whether anyone reacted to `entry`. */
  has(entry: number): boolean {
    return this.#sql.exec("SELECT 1 FROM chat_reactions WHERE entry = ? LIMIT 1", entry).toArray().length > 0;
  }

  /** Every entry's reactions (see `of`). */
  all(): Reactions {
    return this.#group(this.#sql.exec("SELECT entry, emoji, uid FROM chat_reactions ORDER BY entry, at, uid").toArray());
  }

  /** One entry's reactions: each emoji's people in the order they reacted. */
  of(entry: number): EntryReactions {
    return this.#group(this.#sql.exec("SELECT entry, emoji, uid FROM chat_reactions WHERE entry = ? ORDER BY at, uid", entry).toArray())[entry] ?? {};
  }

  #group(rows: Record<string, unknown>[]): Reactions {
    const reactions: Reactions = {};
    for (const { entry, emoji, uid } of rows) ((reactions[entry as number] ??= {})[emoji as Reaction] ??= []).push(uid as string);
    return reactions;
  }
}
