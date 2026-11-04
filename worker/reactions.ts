import { isReaction, REACTIONS, type Reaction, type Reactions } from "../shared/reactions.ts";
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

  /** Every reaction, each emoji's people in the order they reacted and the emoji in the set's order. */
  all(): Reactions {
    const reactions: Reactions = {};
    const rows = this.#sql.exec("SELECT entry, emoji, uid FROM chat_reactions ORDER BY entry, at, uid").toArray();
    for (const { entry, emoji, uid } of rows) {
      if (!isReaction(emoji)) continue;
      const byEmoji = (reactions[entry as number] ??= {});
      (byEmoji[emoji] ??= []).push(uid as string);
    }
    const order = (emoji: string) => REACTIONS.indexOf(emoji as Reaction);
    for (const [entry, byEmoji] of Object.entries(reactions)) {
      reactions[Number(entry)] = Object.fromEntries(Object.entries(byEmoji).sort(([a], [b]) => order(a) - order(b)));
    }
    return reactions;
  }
}
