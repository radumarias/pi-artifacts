// One person's feed and follows, over their UserDirectory's SQLite (see shared/feed.ts). The fan-out to followers is
// the directory's (worker/users.ts): these tables only keep and read what it hands them.

import { isChatKind, mayLeave, type ChatKind } from "../../shared/chat-kinds.ts";
import {
  FEED_PAGE,
  MAX_FEED_ITEMS,
  MAX_FEED_TEXT,
  MAX_FEED_TITLE,
  MAX_FOLLOWERS,
  MAX_FOLLOWS,
  NEEDS_YOU,
  type FeedInput,
  type FeedItem,
  type FeedKind,
  type FeedList,
  type FollowKind,
  type FollowView,
} from "../../shared/feed.ts";
import { clip, mapLimit } from "../../shared/util.ts";
import { addColumns, type Sql } from "../members.ts";

type FeedRow = { id: number; kind: FeedKind; at: number; read: number; needs: number; data: string };

/** What a feed row keeps as JSON: the item's fields that are not columns. */
type FeedData = Pick<FeedItem, "title" | "text" | "from" | "open" | "status">;

/**
 * What `about` names an item by, so a page or agent that is gone takes its items with it: with its owner, since agent
 * ids are unique only per person (and an import keeps them).
 */
export function aboutOf(kind: FollowKind, id: string, ownerUid: string): string {
  return `${kind}:${ownerUid}:${id}`;
}

/** The most items one feed keeps waiting on the person: half of it, the rest for what comes in. */
const MAX_WAITING = MAX_FEED_ITEMS / 2;

/** The `needs` column: nothing waits, it waits until resolved by ref, or until the person writes in its chat. */
const NEEDS = { none: 0, resolve: 1, reply: 2 } as const;

/** Whether `add` kept an item: a new one, a newer state of one it had, the same again, or refused (off the record). */
export type FeedAdded = "added" | "updated" | "same" | "refused";

/**
 * A person's feed (`feed`): one row per item, unique by its ref. Items about a chat keep its id (`chat_id`), and items
 * about a followed page or agent what they are about (`about`), so either going takes them along. An item waiting for
 * the person's reply keeps the agent that asked (`waits_on`); `answered` keeps when they last wrote to each agent in
 * each chat, so a question that reaches the feed after its answer (a run's report, added when the run ends) is answered.
 */
export class FeedStore {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0, needs INTEGER NOT NULL DEFAULT 0, chat_id TEXT, about TEXT, waits_on TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS feed_by_at ON feed (at);
      CREATE INDEX IF NOT EXISTS feed_by_chat ON feed (chat_id) WHERE chat_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS feed_answered (chat_id TEXT NOT NULL, agent_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (chat_id, agent_id));
    `);
    // A feed made before waits_on: what waited there for a reply waits on the agent that asked it.
    if (addColumns(sql, "feed", { waits_on: "TEXT" }).length) {
      sql.exec("UPDATE feed SET waits_on = json_extract(data, '$.from.agent.id') WHERE needs = ? AND chat_id IS NOT NULL", NEEDS.reply);
    }
  }

  /**
   * Keep an item. One from a chat is refused when that chat is off the record, as the sender says or as this person's
   * own sidebar row says (`known`, which may be newer): the strictest wins (mayLeave). The same ref again with the same
   * content changes nothing; with new content (a run that went on and sent) it replaces the item, unread again.
   */
  add(input: FeedInput, known: ChatKind | null = null, about?: string): FeedAdded {
    if (input.chat) {
      const kinds: (ChatKind | null)[] = [isChatKind(input.chat.kind) ? input.chat.kind : null];
      if (known) kinds.push(known);
      if (!mayLeave({ what: "feed" }, ...kinds)) return "refused";
    }
    const data: FeedData = {
      title: clip(input.title, MAX_FEED_TITLE),
      ...(input.text && { text: clip(input.text, MAX_FEED_TEXT) }),
      ...(input.from && { from: input.from }),
      open: input.open,
      ...(input.status && { status: input.status }),
    };
    const json = JSON.stringify(data);
    const waits = input.needsYou ?? NEEDS_YOU[input.kind];
    const chatId = input.chat?.id ?? (input.open.to === "chat" ? input.open.chatId : null);
    // A reply answers the agent that asked: one with no agent, or in no chat, waits until resolved by its ref.
    const waitsOn = waits === "reply" && chatId ? (input.from?.agent?.id ?? null) : null;
    const before = this.#sql.exec("SELECT data FROM feed WHERE ref = ?", input.ref).toArray()[0] as { data: string } | undefined;
    if (before?.data === json) return "same";
    // Asked before, answered since (a run's report, added when the run ends): it waits on nothing.
    const answered = waitsOn !== null && this.#answeredAt(chatId!, waitsOn) >= input.at;
    const needs = answered ? NEEDS.none : waitsOn !== null ? NEEDS.reply : waits ? NEEDS.resolve : NEEDS.none;
    const read = input.quiet || answered ? 1 : 0;
    this.#sql.exec(
      `INSERT INTO feed (kind, ref, at, read, needs, chat_id, about, waits_on, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET kind = excluded.kind, at = excluded.at, read = excluded.read, needs = excluded.needs,
         chat_id = excluded.chat_id, about = excluded.about, waits_on = excluded.waits_on, data = excluded.data`,
      input.kind,
      input.ref,
      input.at,
      read,
      needs,
      chatId,
      about ?? null,
      waitsOn,
      json,
    );
    if (!before) this.#prune();
    return before ? "updated" : "added";
  }

  /** The newest items, only the unread ones or only those needing the person when asked, and the counts. */
  list(filter: { unread?: boolean; needsYou?: boolean } = {}, limit = FEED_PAGE): FeedList {
    const where = [filter.unread && "read = 0", filter.needsYou && "needs > 0"].filter(Boolean);
    const rows = this.#sql
      .exec(`SELECT id, kind, at, read, needs, data FROM feed ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ?`, limit)
      .toArray() as FeedRow[];
    return { items: rows.map(itemOf), ...this.counts() };
  }

  /** How many items are unread, and how many still wait on the person, read or not: what the sidebar's entry shows. */
  counts(): { unread: number; needsYou: number } {
    const row = this.#sql.exec("SELECT COALESCE(SUM(read = 0), 0) AS unread, COALESCE(SUM(needs > 0), 0) AS needs FROM feed").toArray()[0];
    return { unread: Number(row?.unread ?? 0), needsYou: Number(row?.needs ?? 0) };
  }

  /** Mark items read (or unread again): by id, or every one. Returns how many changed. */
  mark(ids: readonly number[] | "all", read = true): number {
    const flag = read ? 1 : 0;
    if (ids === "all") return this.#sql.exec("UPDATE feed SET read = ? WHERE read != ?", flag, flag).rowsWritten;
    return this.#sql.exec("UPDATE feed SET read = ? WHERE read != ? AND id IN (SELECT value FROM json_each(?))", flag, flag, JSON.stringify(ids)).rowsWritten;
  }

  /** The person saw chat `chatId`: what its items told them of (tags, questions, runs posted there) is read. */
  markChatRead(chatId: string): number {
    return this.#sql.exec("UPDATE feed SET read = 1 WHERE chat_id = ? AND read = 0", chatId).rowsWritten;
  }

  /** What `ref` asked of the person is done (an agent's guesses confirmed, an approval decided): it waits no more, and is read. */
  resolve(ref: string): number {
    return this.#sql.exec("UPDATE feed SET needs = 0, read = 1 WHERE ref = ? AND (needs > 0 OR read = 0)", ref).rowsWritten;
  }

  /**
   * The person wrote in chat `chatId` to `agents` (those the message reached: called, replied to, or the chat's own):
   * what those agents waited there for their reply, asked by `now` (when the message was sent), is answered. An aside,
   * or a message to another agent, answers nothing.
   */
  resolveReplies(chatId: string, agents: readonly string[], now = Date.now()): number {
    if (!agents.length) return 0;
    const list = JSON.stringify(agents);
    this.#sql.exec(
      `INSERT INTO feed_answered (chat_id, agent_id, at) SELECT ?, value, ? FROM json_each(?) WHERE true
       ON CONFLICT(chat_id, agent_id) DO UPDATE SET at = MAX(at, excluded.at)`,
      chatId,
      now,
      list,
    );
    const sql = "UPDATE feed SET needs = 0, read = 1 WHERE chat_id = ? AND needs = ? AND at <= ? AND waits_on IN (SELECT value FROM json_each(?))";
    return this.#sql.exec(sql, chatId, NEEDS.reply, now, list).rowsWritten;
  }

  /** When the person last wrote to `agent` in chat `chatId`; 0 for never. */
  #answeredAt(chatId: string, agent: string): number {
    return Number(this.#sql.exec("SELECT at FROM feed_answered WHERE chat_id = ? AND agent_id = ?", chatId, agent).toArray()[0]?.at ?? 0);
  }

  /**
   * What `about` names is moot (one of the person's agents turned off): none of its items of `kind` (its runs) waits on
   * them, and they are read.
   */
  resolveAbout(about: string, kind: FeedKind): number {
    return this.#sql.exec("UPDATE feed SET needs = 0, read = 1 WHERE about = ? AND kind = ? AND needs > 0", about, kind).rowsWritten;
  }

  /** A chat is gone, or the person is out of it: its items go. */
  forgetChat(chatId: string): number {
    this.#sql.exec("DELETE FROM feed_answered WHERE chat_id = ?", chatId);
    return this.#sql.exec("DELETE FROM feed WHERE chat_id = ?", chatId).rowsWritten;
  }

  /** A followed page or agent is gone, or no longer followed: its items go. */
  forgetAbout(about: string): number {
    return this.#sql.exec("DELETE FROM feed WHERE about = ?", about).rowsWritten;
  }

  /**
   * At most MAX_FEED_ITEMS: what waits on the person is kept before the rest, but only up to MAX_WAITING of it (the
   * oldest waiting go first), so there is always room for what comes in; then the oldest read ones go, then the oldest.
   */
  #prune(): void {
    // Every time, not only for a new item that waits: an update (a run now waiting for a sign-in) can add to what waits.
    this.#sql.exec("DELETE FROM feed WHERE id IN (SELECT id FROM feed WHERE needs > 0 ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)", MAX_WAITING);
    const keep = "(needs > 0) DESC, read ASC, at DESC, id DESC";
    this.#sql.exec(`DELETE FROM feed WHERE id IN (SELECT id FROM feed ORDER BY ${keep} LIMIT -1 OFFSET ?)`, MAX_FEED_ITEMS);
  }
}

function itemOf(row: FeedRow): FeedItem {
  const data = JSON.parse(row.data) as FeedData;
  const flags = { ...(row.read === 1 && { read: true as const }), ...(row.needs > 0 && { needsYou: true as const }) };
  return { id: row.id, kind: row.kind, at: row.at, ...data, ...flags };
}

/** A follower of one of this person's pages or agents, and the chat that let them follow it (an agent's: it is shared there). */
export interface Follower {
  uid: string;
  via?: { ownerUid: string; chatId: string };
}

/** A follow as the follower keeps it: with whose the target is, which the app is told only for an agent. */
export interface FollowRecord extends FollowView {
  ownerUid: string;
  /** For an agent: the owner of the chat it is shared in (with `chatId`). */
  chatOwner?: string;
}

/**
 * Both sides of following, in each person's directory: `follows`, what this person follows (with whose it is), and
 * `followers`, who follows this person's pages and agents (with, for an agent, the chat it was followed from, which
 * must still share it for a post to reach them).
 */
export class FollowStore {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS follows (kind TEXT NOT NULL, target_id TEXT NOT NULL, owner_uid TEXT NOT NULL, title TEXT NOT NULL,
        chat_owner TEXT, chat_id TEXT, at INTEGER NOT NULL, PRIMARY KEY (kind, target_id, owner_uid));
      CREATE TABLE IF NOT EXISTS followers (kind TEXT NOT NULL, target_id TEXT NOT NULL, follower_uid TEXT NOT NULL,
        chat_owner TEXT, chat_id TEXT, at INTEGER NOT NULL, PRIMARY KEY (kind, target_id, follower_uid));
    `);
  }

  /** Follow a target (again: its title and chat updated). Refused past MAX_FOLLOWS. */
  follow(record: Omit<FollowRecord, "at">, now = Date.now()): { ok: true } | { error: string } {
    const had = this.get(record.kind, record.id, record.ownerUid);
    if (!had && Number(this.#sql.exec("SELECT COUNT(*) AS n FROM follows").toArray()[0]?.n ?? 0) >= MAX_FOLLOWS) {
      return { error: `You follow ${MAX_FOLLOWS} pages and agents, the most there can be; stop following one first.` };
    }
    this.#sql.exec(
      `INSERT INTO follows (kind, target_id, owner_uid, title, chat_owner, chat_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, target_id, owner_uid) DO UPDATE SET title = excluded.title, chat_owner = excluded.chat_owner, chat_id = excluded.chat_id`,
      record.kind,
      record.id,
      record.ownerUid,
      record.title,
      record.chatOwner ?? null,
      record.chatId ?? null,
      had?.at ?? now,
    );
    return { ok: true };
  }

  /** Stop following `ownerUid`'s target; the follow as it was, or null when there was none. */
  unfollow(kind: FollowKind, id: string, ownerUid: string): FollowRecord | null {
    const had = this.get(kind, id, ownerUid);
    if (had) this.#sql.exec("DELETE FROM follows WHERE kind = ? AND target_id = ? AND owner_uid = ?", kind, id, ownerUid);
    return had;
  }

  get(kind: FollowKind, id: string, ownerUid: string): FollowRecord | null {
    const row = this.#sql.exec("SELECT * FROM follows WHERE kind = ? AND target_id = ? AND owner_uid = ?", kind, id, ownerUid).toArray()[0];
    return row ? followOf(row) : null;
  }

  /** A followed page, which the app names by id alone (a page's id is the same for everyone). */
  findPage(id: string): FollowRecord | null {
    const row = this.#sql.exec("SELECT * FROM follows WHERE kind = 'page' AND target_id = ? ORDER BY at DESC", id).toArray()[0];
    return row ? followOf(row) : null;
  }

  /** The follows made through chat `chatId` of `chatOwner`'s: they go when this person leaves it. */
  through(chatOwner: string, chatId: string): FollowRecord[] {
    return this.#sql.exec("SELECT * FROM follows WHERE chat_owner = ? AND chat_id = ?", chatOwner, chatId).toArray().map(followOf);
  }

  /** What this person follows, newest first, as the app lists it: whose it is only for an agent, as its chat shows. */
  list(): FollowView[] {
    return this.#sql
      .exec("SELECT * FROM follows ORDER BY at DESC")
      .toArray()
      .map((row) => {
        const { ownerUid, chatOwner: _chatOwner, ...view } = followOf(row);
        return view.kind === "agent" ? { ...view, ownerUid } : view;
      });
  }

  /** A followed target's title changed (a page published under a new one), as an item from it says. */
  retitle(kind: FollowKind, id: string, ownerUid: string, title: string): boolean {
    const sql = "UPDATE follows SET title = ? WHERE kind = ? AND target_id = ? AND owner_uid = ? AND title != ?";
    return this.#sql.exec(sql, title, kind, id, ownerUid, title).rowsWritten > 0;
  }

  /** Someone follows one of this person's targets. Refused past MAX_FOLLOWERS. */
  addFollower(kind: FollowKind, id: string, follower: Follower, now = Date.now()): { ok: true } | { error: string } {
    const had = this.#sql.exec("SELECT 1 FROM followers WHERE kind = ? AND target_id = ? AND follower_uid = ?", kind, id, follower.uid).toArray().length > 0;
    if (!had && Number(this.#sql.exec("SELECT COUNT(*) AS n FROM followers WHERE kind = ? AND target_id = ?", kind, id).toArray()[0]?.n ?? 0) >= MAX_FOLLOWERS) {
      return { error: `This ${kind} has ${MAX_FOLLOWERS} followers, the most there can be.` };
    }
    this.#sql.exec(
      `INSERT INTO followers (kind, target_id, follower_uid, chat_owner, chat_id, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, target_id, follower_uid) DO UPDATE SET chat_owner = excluded.chat_owner, chat_id = excluded.chat_id`,
      kind,
      id,
      follower.uid,
      follower.via?.ownerUid ?? null,
      follower.via?.chatId ?? null,
      now,
    );
    return { ok: true };
  }

  removeFollower(kind: FollowKind, id: string, uid: string): void {
    this.#sql.exec("DELETE FROM followers WHERE kind = ? AND target_id = ? AND follower_uid = ?", kind, id, uid);
  }

  followersOf(kind: FollowKind, id: string): Follower[] {
    return this.#sql
      .exec("SELECT follower_uid, chat_owner, chat_id FROM followers WHERE kind = ? AND target_id = ? ORDER BY at", kind, id)
      .toArray()
      .map((row) => ({
        uid: row.follower_uid as string,
        ...(row.chat_owner && row.chat_id ? { via: { ownerUid: row.chat_owner as string, chatId: row.chat_id as string } } : {}),
      }));
  }

  /** One of this person's targets is gone: its followers are forgotten, and returned, to be told. */
  dropTarget(kind: FollowKind, id: string): string[] {
    const uids = this.followersOf(kind, id).map((follower) => follower.uid);
    this.#sql.exec("DELETE FROM followers WHERE kind = ? AND target_id = ?", kind, id);
    return uids;
  }
}

function followOf(row: Record<string, unknown>): FollowRecord {
  return {
    kind: row.kind as FollowKind,
    id: row.target_id as string,
    ownerUid: row.owner_uid as string,
    title: row.title as string,
    ...(row.chat_id ? { chatId: row.chat_id as string } : {}),
    ...(row.chat_owner ? { chatOwner: row.chat_owner as string } : {}),
    at: row.at as number,
  };
}

/** Followers grouped by the chat that let them follow (an agent's), for one check per chat; those with none apart. */
export function byChat(followers: readonly Follower[]): { via?: Follower["via"]; uids: string[] }[] {
  const groups = new Map<string, { via?: Follower["via"]; uids: string[] }>();
  for (const follower of followers) {
    const key = follower.via ? `${follower.via.ownerUid}/${follower.via.chatId}` : "";
    const group = groups.get(key) ?? { ...(follower.via && { via: follower.via }), uids: [] };
    group.uids.push(follower.uid);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Whether what an agent's run reads may reach people who follow it: only when every server it may read is one it
 * shares with chats (its `sharedServers`, or when it names none, those that do not sign in each user), so a follower
 * reads nothing they could not have asked it for in the chat where it is shared. `servers` are the agent's own, absent
 * for every server of the deployment (`all`).
 */
export function postsReachFollowers(
  agent: { servers?: readonly string[]; sharedServers?: readonly string[] },
  all: readonly string[],
  signsIn: (server: string) => boolean,
): boolean {
  const reads = agent.servers ?? all;
  return reads.every((server) => (agent.sharedServers ? agent.sharedServers.includes(server) : !signsIn(server)));
}

/** What a fan-out needs: who may still read the target, and a way to hand one follower the item. */
export interface FanOutHost {
  /** Of `uids`, who followed an agent from the chat `via` and may still open it there (ChatAgent.followersIn). */
  stillIn(via: NonNullable<Follower["via"]>, uids: readonly string[]): Promise<string[]>;
  /** Hand the item to one follower's directory: false when they no longer follow the target. */
  deliver(uid: string): Promise<boolean>;
  /** Forget a follower who no longer follows it. */
  forget(uid: string): void;
  /** A follower who may no longer open it (out of the chat they followed it from, or not shared there now): forget them, and tell them. */
  lost(uid: string): void;
}

/**
 * Hand one item to the followers of a target, `limit` directories at a time. A page's followers all get it: anyone
 * signed in may open a page. An agent's only where the chat each followed it from says they still may (`stillIn`);
 * one without such a chat gets nothing. A follower who no longer follows it is forgotten, and so is one the chat said
 * may no longer open it (`lost`); a failed check or delivery forgets nobody. Returns who got it.
 */
export async function fanOut(kind: FollowKind, followers: readonly Follower[], host: FanOutHost, limit = FAN_OUT): Promise<string[]> {
  const allowed =
    kind === "page"
      ? followers.map((follower) => follower.uid)
      : (
          await mapLimit(byChat(followers), limit, async ({ via, uids }) => {
            const answer = via ? await host.stillIn(via, uids).catch(() => null) : [];
            if (!answer) return [];
            const still = new Set(answer);
            for (const uid of uids) if (!still.has(uid)) host.lost(uid);
            return uids.filter((uid) => still.has(uid));
          })
        ).flat();
  const delivered = await mapLimit(allowed, limit, async (uid) => {
    const got = await host.deliver(uid).catch(() => null);
    if (got === false) host.forget(uid);
    return got ? uid : null;
  });
  return delivered.filter((uid) => uid !== null);
}

/** How many followers' directories (or chats checking them) one fan-out calls at a time. */
export const FAN_OUT = 8;

/**
 * Of `uids`, those who may follow `ownerUid`'s agent from a chat: the chat is there, the agent is on its roster as that
 * owner's and shared, and each is in the chat (not the owner, who needs no follow).
 */
export function followersAllowed(
  entry: { ownerUid: string; shared: boolean } | null,
  ownerUid: string,
  uids: readonly string[],
  inChat: (uid: string) => boolean,
): string[] {
  if (!entry || entry.ownerUid !== ownerUid || !entry.shared) return [];
  return uids.filter((uid) => uid !== ownerUid && inChat(uid));
}
