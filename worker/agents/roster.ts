import {
  MAX_CHAT_AGENTS,
  type AgentColor,
  type AgentTurnStatus,
  type AgentDraftView,
  type AgentTurnView,
  type ChatAgentReplyData,
  type ChatAgentView,
} from "../../shared/agents.ts";
import type { ArtifactMeta } from "../../shared/protocol.ts";
import type { RunRef } from "../../shared/runs.ts";
import { addColumns, type Sql } from "../members.ts";

/** One agent of a chat's roster: which definition it points at, and the pi session it runs in. */
export interface RosterEntry {
  agentId: string;
  ownerUid: string;
  /** Its handle in this chat: unique here. */
  name: string;
  /** Its pi session (PiSessionId), made when it was added. */
  session: string;
  /** What everyone sees of it, as its definition last read: refreshed at each of its turns. */
  avatar: string;
  color: AgentColor;
  job: string;
  /** The newest entry of the chat's log its session has read (see ChatRoster.setMirrored). */
  mirrored: number;
  /** Its owner turned it off since: it takes no turns until they turn it on. */
  off: boolean;
  /** Its owner shares it with the people of the chat: they may open it read-only and copy it. */
  shared: boolean;
  /**
   * For an agent of someone else's than the chat's owner (a member's): the chat of its owner's whose object it runs in,
   * as a seat (worker/agents/seats/). Its turns are given there by RPC, and `session` is unused. Absent: it runs here.
   */
  seat?: string;
  /**
   * A member's agent whose own name was taken here when it joined: that name, which its handle here is an alias of
   * (memberAgentName). The alias is kept while the agent's name is still this one; a rename ends it.
   */
  aliasOf?: string;
  /**
   * The first log entry whose messages by its owner it reads as theirs: where a member's agent joined. What the log
   * held before, such as an import's entries, no one checked the authors of for it (OwnerMarks in turns.ts).
   */
  ownerFrom?: number;
  /** Someone in the chat muted it here: it posts nothing unprompted in this chat. */
  muted: boolean;
}

/** A turn running in this object, as the chat's sockets follow it: `only` the person who may see it live, when not everyone. */
export type RunningTurn = { agentId: string; session: string; turn: number; only?: string };

/** What everyone sees of an agent, as its definition says now. */
export type RosterView = Pick<RosterEntry, "name" | "avatar" | "color" | "job" | "off">;

/** A turn an agent was given, as the chat keeps it: who called it, and the chain of hand-offs it is in. */
export interface AgentTurn extends AgentTurnView {
  /** The turn that started the chain of hand-offs this one is in (its own id for a turn a person gave). */
  root: number;
  /** The message it answers, as its session reads it: one labelled line, which the turn's input carries. */
  ask: string;
  /** Its input reached its session (see ChatRoster.markSubmitted). */
  submitted?: true;
  /**
   * A session of its own to run in, not its agent's: one that has what the turn is about (a reply to a run's report
   * runs in a fork of the run's), which reads nothing of the chat, so it catches up on nothing; or, `forked`, a fork of
   * the agent's session made as the turn started, for a turn its owner asked for that may reach a private server (see
   * forksFor in turns.ts): only its reply returns to the agent's session.
   */
  session?: string;
  /** Its session is a fork made for a private turn (`session`): it shows only its owner live, and its reply only shared records. */
  forked?: true;
  /** The run its reply carries, so a reply to that continues the run too. */
  run?: RunRef;
  /**
   * In a chain no person started (a run's hand-over), or one a Yes to an offer started (it may only draft): it and its
   * hand-offs never hand pi a turn, which would run with the owner's full tools; pi only reads their replies.
   */
  unattended?: true;
  /** The person whose message started its chain, also when an agent or pi handed it on: whom its rate limit counts. */
  by?: string;
}

/**
 * A turn to queue. `askKey` says which log entry `ask` is (see askKey in turns.ts), so the catch-up before a turn
 * leaves out what its input already says; absent when it is no entry of the log. Without a `root`, the turn starts a
 * chain of hand-offs of its own.
 */
export type TurnRequest = Pick<AgentTurn, "agentId" | "hop" | "calledBy" | "byOwner" | "ask" | "session" | "run" | "unattended" | "by"> & {
  root?: number;
  askKey?: string;
};

/** What an ended turn still has to deliver: its reply to the log, and whether pi is handed a turn for it. */
export interface Outbox {
  reply: ChatAgentReplyData;
  toPi: boolean;
  /** It waits for its agent's owner to review it (reviewBeforePosting): only they see it until they post it. */
  held?: boolean;
}

type RosterRow = {
  agent_id: string;
  owner_uid: string;
  name: string;
  session: string;
  added_at: number;
  avatar: string;
  color: string;
  job: string;
  mirrored: number;
  off: number;
  shared: number;
  seat: string | null;
  alias_of: string | null;
  owner_from: number;
  muted: number;
};

/**
 * A session apart from the chat (ChatRoster.forks): whether its reply was `posted`, whether its turn `ended` (it takes
 * no more entries; never for a session later turns run in again), the newest entry it inherited (`from`, after which its own start), and whether its owner reviews it.
 */
/**
 * A session apart from the chat: `from`, where what is apart starts (a fork's own entries; a reused session's, what came
 * after its newest entry when its first turn apart began); `reused`: later turns run in it again (setApart), each in a
 * window of its own (ApartWindow). `posted`: the reply of its turn apart (a reused session's newest) was posted.
 */
export type Fork = { posted: boolean; ended: boolean; from?: number; review: boolean; reused: boolean };
type ForkRow = { session: string; posted: number; from_entry: number | null; review: number; reused: number; open: number };

/**
 * One turn apart in a reused session (setApart): its entries are those after `from` and through `through` (to the end
 * while it is the newest), the chat's once its reply was `posted`, and withheld for good when it never is.
 */
export type ApartWindow = { turn: number; from: number; through?: number; posted: boolean };

/** The sessions apart from the chat with a turn's reply not posted (ChatRoster.withheld). */
/**
 * Rows (of chat_agent_fork_pages, _files, _drafts) the current turn of a session made (bound twice): an earlier turn
 * in a session later turns run in again (a run's reply session), whose reply is not posted, is apart from it too.
 */
const THIS_TURN = "(session IS ? AND turn IS (SELECT apart_turn FROM chat_agent_forks WHERE session = ?))";

const WITHHELD = "SELECT session FROM chat_agent_forks WHERE posted = 0 UNION SELECT session FROM chat_agent_apart_windows WHERE posted = 0";

/** The session of a draft a conversation the chat sees saved (ChatRoster.recordDraft): no session is named so. */
const CHAT_DRAFT = "";
/** How many of those it keeps: well over the drafts a chat keeps (worker/storage/drafts.ts). */
const MAX_CHAT_DRAFTS = 200;

const FORKS = `SELECT f.session, f.posted, f.from_entry, f.review, f.reused,
  EXISTS (SELECT 1 FROM chat_agent_turns t WHERE t.session = f.session AND t.status IN ('queued', 'running')) AS open
  FROM chat_agent_forks f`;
const forkOf = (row: ForkRow): Fork => ({
  posted: row.posted === 1,
  ended: row.reused !== 1 && row.open !== 1,
  ...(row.from_entry !== null && { from: row.from_entry }),
  review: row.review === 1,
  reused: row.reused === 1,
});

/** What of a page is not its chat's yet: all of it, or these versions (ChatAgent.held). */
export type HeldPage = { page: boolean; versions: number[] };

/**
 * The newest of versions `floor` to `latest` not `withheld` (ChatRoster.withheldVersions, SessionRules.hiddenVersion):
 * `floor - 1` when there is none.
 */
export function newestShown(latest: number, withheld: ReadonlySet<number> | ((version: number) => boolean), floor = 1): number {
  const hidden = typeof withheld === "function" ? withheld : (version: number) => withheld.has(version);
  let version = latest;
  while (version >= floor && hidden(version)) version--;
  return version;
}

/** `meta` as its chat has it (`held`, ChatAgent.held): newest and versions without the held ones; null when none is its yet. */
export function shownOf(meta: ArtifactMeta, held: HeldPage): ArtifactMeta | null {
  const hidden = new Set(held.versions);
  const latest = held.page ? 0 : newestShown(meta.latest, hidden);
  return latest ? { ...meta, latest, versions: meta.versions.filter((version) => !hidden.has(version.version)) } : null;
}

/** A version a turn apart published, the chat's now that its reply was posted (ChatRoster.release). */
export type PostedPage = { artifactId: string; version: number };

type TurnRow = {
  id: number;
  agent_id: string;
  status: AgentTurnStatus;
  hop: number;
  called_by: string;
  by_owner: number;
  root: number | null;
  ask: string;
  ask_key: string | null;
  created_at: number;
  started_at: number | null;
  submitted_at: number | null;
  ended_at: number | null;
  reply: string | null;
  to_pi: number;
  delivered_at: number | null;
  session: string | null;
  held: number;
  forked: number;
  run: string | null;
  unattended: number;
  by_uid: string | null;
};

function entryOf(row: RosterRow): RosterEntry {
  return {
    agentId: row.agent_id,
    ownerUid: row.owner_uid,
    name: row.name,
    session: row.session,
    avatar: row.avatar,
    color: row.color as AgentColor,
    job: row.job,
    mirrored: row.mirrored,
    off: row.off === 1,
    shared: row.shared === 1,
    ...(row.seat !== null && { seat: row.seat }),
    ...(row.alias_of !== null && { aliasOf: row.alias_of }),
    ...(row.owner_from >= 0 && { ownerFrom: row.owner_from }),
    muted: row.muted === 1,
  };
}

function turnOf(row: TurnRow): AgentTurn {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    hop: row.hop,
    calledBy: JSON.parse(row.called_by) as AgentTurn["calledBy"],
    byOwner: row.by_owner === 1,
    root: row.root ?? row.id,
    ask: row.ask,
    createdAt: row.created_at,
    ...(row.started_at !== null && { startedAt: row.started_at }),
    ...(row.submitted_at !== null && { submitted: true }),
    ...(row.ended_at !== null && { endedAt: row.ended_at }),
    ...(row.session !== null && { session: row.session }),
    ...(row.forked === 1 && { forked: true }),
    ...(row.run !== null && { run: JSON.parse(row.run) as RunRef }),
    ...(row.unattended === 1 && { unattended: true }),
    ...(row.by_uid !== null && { by: row.by_uid }),
  };
}

/** Turns kept per agent once ended: the newest, for the runs list; older ones go. */
const KEPT_TURNS = 200;
/** A turn not ended yet. */
const OPEN = "status IN ('queued', 'running')";
/** An ended turn whose reply is not delivered yet, held for review or not: kept until it is. */
const PENDING = "reply IS NOT NULL AND delivered_at IS NULL";
/** An ended turn whose reply is to be delivered now: not one held for its owner's review. */
const UNDELIVERED = `${PENDING} AND held = 0`;
/** A turn's reply held for its owner's review. */
const HELD = `${PENDING} AND held = 1`;

/**
 * One chat's agents and their turns, in the chat object's own SQLite. The roster points at definitions in their
 * owners' directories and never copies one: only what everyone sees of an agent (name, badge, job line) is kept, to
 * show without asking the owner's directory. Turns are queued per agent and run one at a time, so the session's tools
 * can be set for who asked before each one starts. An ended turn keeps its reply until it is delivered (its outbox),
 * so a restart in between delivers it then.
 */
export class ChatRoster {
  readonly #sql: Sql;
  readonly #now: () => number;

  constructor(sql: Sql, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS chat_agents (
        agent_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, name TEXT NOT NULL UNIQUE, session TEXT NOT NULL, added_at INTEGER NOT NULL,
        avatar TEXT NOT NULL, color TEXT NOT NULL, job TEXT NOT NULL, mirrored INTEGER NOT NULL DEFAULT -1, off INTEGER NOT NULL DEFAULT 0,
        shared INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chat_agent_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, status TEXT NOT NULL, hop INTEGER NOT NULL, called_by TEXT NOT NULL,
        by_owner INTEGER NOT NULL, root INTEGER, ask TEXT NOT NULL, ask_key TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
        submitted_at INTEGER, ended_at INTEGER, reply TEXT, to_pi INTEGER NOT NULL DEFAULT 0, delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS chat_agent_turns_by_agent ON chat_agent_turns (agent_id, status, id);
      CREATE INDEX IF NOT EXISTS chat_agent_turns_by_status ON chat_agent_turns (status);
      CREATE INDEX IF NOT EXISTS chat_agent_turns_by_root ON chat_agent_turns (root);
      CREATE TABLE IF NOT EXISTS chat_agent_forks (session TEXT PRIMARY KEY, posted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chat_agent_fork_pages (
        session TEXT NOT NULL, artifact_id TEXT NOT NULL, version INTEGER NOT NULL, posted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session, artifact_id, version)
      );
      CREATE INDEX IF NOT EXISTS chat_agent_fork_pages_by_page ON chat_agent_fork_pages (artifact_id, version);
      CREATE TABLE IF NOT EXISTS chat_agent_fork_files (
        session TEXT NOT NULL, path TEXT NOT NULL, posted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session, path)
      );
      CREATE TABLE IF NOT EXISTS chat_agent_fork_drafts (
        session TEXT NOT NULL, draft_id TEXT NOT NULL, turn INTEGER, posted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session, draft_id)
      );
      CREATE TABLE IF NOT EXISTS chat_agent_apart_windows (
        session TEXT NOT NULL, turn INTEGER NOT NULL, from_entry INTEGER NOT NULL, through_entry INTEGER, posted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session, turn)
      );
    `);
    // From where a fork's own entries start (what it inherited is its parent's), whether its owner reviews its reply,
    // and whether later turns run in it again (a run's reply session, setApart): such a session never ends for good.
    // The turn apart in it now: what it publishes and saves is recorded as that turn's, and posted with its reply.
    addColumns(sql, "chat_agent_forks", {
      from_entry: "INTEGER",
      review: "INTEGER NOT NULL DEFAULT 0",
      reused: "INTEGER NOT NULL DEFAULT 0",
      apart_turn: "INTEGER",
    });
    addColumns(sql, "chat_agent_fork_pages", { turn: "INTEGER" });
    addColumns(sql, "chat_agent_fork_files", { turn: "INTEGER" });
    // Columns added later: a roster or turn table made before them lacks them.
    addColumns(sql, "chat_agents", {
      shared: "INTEGER NOT NULL DEFAULT 0",
      seat: "TEXT",
      alias_of: "TEXT",
      owner_from: "INTEGER NOT NULL DEFAULT -1",
      muted: "INTEGER NOT NULL DEFAULT 0",
    });
    addColumns(sql, "chat_agent_turns", {
      session: "TEXT",
      run: "TEXT",
      unattended: "INTEGER NOT NULL DEFAULT 0",
      held: "INTEGER NOT NULL DEFAULT 0",
      forked: "INTEGER NOT NULL DEFAULT 0",
      by_uid: "TEXT",
    });
    // A fork's view (FORKS) asks whether a turn still runs in its session, for every session every trace read.
    sql.exec("CREATE INDEX IF NOT EXISTS chat_agent_turns_by_session ON chat_agent_turns (session)");
    // Rows from before turns apart were kept per turn: a fork's are its one turn's (posted with its reply), and what a
    // reused session holds apart from where it was apart from is a window no turn posts: withheld for good, never the chat's.
    sql.exec(`
      UPDATE chat_agent_forks SET apart_turn = (SELECT MAX(t.id) FROM chat_agent_turns t WHERE t.session = chat_agent_forks.session)
        WHERE apart_turn IS NULL AND reused = 0 AND EXISTS (SELECT 1 FROM chat_agent_turns t WHERE t.session = chat_agent_forks.session);
      UPDATE chat_agent_fork_pages SET turn = (SELECT f.apart_turn FROM chat_agent_forks f WHERE f.session = chat_agent_fork_pages.session)
        WHERE turn IS NULL AND session IN (SELECT session FROM chat_agent_forks WHERE reused = 0 AND apart_turn IS NOT NULL);
      UPDATE chat_agent_fork_files SET turn = (SELECT f.apart_turn FROM chat_agent_forks f WHERE f.session = chat_agent_fork_files.session)
        WHERE turn IS NULL AND session IN (SELECT session FROM chat_agent_forks WHERE reused = 0 AND apart_turn IS NOT NULL);
      INSERT INTO chat_agent_apart_windows (session, turn, from_entry)
        SELECT session, -1, COALESCE(from_entry, -1) FROM chat_agent_forks f WHERE reused = 1 AND posted = 0
        AND NOT EXISTS (SELECT 1 FROM chat_agent_apart_windows w WHERE w.session = f.session);
    `);
  }

  /** The roster's clock: what its turns' times are taken from. */
  now(): number {
    return this.#now();
  }

  #entries(where = "", ...params: (string | number)[]): RosterEntry[] {
    return (this.#sql.exec(`SELECT * FROM chat_agents ${where} ORDER BY added_at, name`, ...params).toArray() as RosterRow[]).map(entryOf);
  }

  #turns(where: string, ...params: (string | number)[]): AgentTurn[] {
    return (this.#sql.exec(`SELECT * FROM chat_agent_turns WHERE ${where}`, ...params).toArray() as TurnRow[]).map(turnOf);
  }

  list(): RosterEntry[] {
    return this.#entries();
  }

  get(agentId: string): RosterEntry | null {
    return this.#entries("WHERE agent_id = ?", agentId)[0] ?? null;
  }

  byName(name: string): RosterEntry | null {
    return this.#entries("WHERE name = ?", name.toLowerCase())[0] ?? null;
  }

  hasAny(): boolean {
    return this.#sql.exec("SELECT 1 FROM chat_agents LIMIT 1").toArray().length > 0;
  }

  /**
   * Add an agent, in the session made for it. Refused when the chat holds MAX_CHAT_AGENTS, or another agent has its
   * name here. Adding one already in the roster changes nothing.
   */
  add(
    entry: Pick<RosterEntry, "agentId" | "ownerUid" | "name" | "session" | "avatar" | "color" | "job" | "seat" | "aliasOf" | "ownerFrom">,
  ): { error: string } | null {
    const here = this.get(entry.agentId);
    // Agent ids are unique per user only: another person's agent with this id keeps it.
    if (here) return here.ownerUid === entry.ownerUid ? null : { error: "Another agent with this id is in the chat." };
    const refused = this.refusal(entry.name);
    if (refused) return refused;
    this.#sql.exec(
      "INSERT INTO chat_agents (agent_id, owner_uid, name, session, added_at, avatar, color, job, seat, alias_of, owner_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      entry.agentId,
      entry.ownerUid,
      entry.name.toLowerCase(),
      entry.session,
      this.#now(),
      entry.avatar,
      entry.color,
      entry.job,
      entry.seat ?? null,
      entry.aliasOf?.toLowerCase() ?? null,
      entry.ownerFrom ?? -1,
    );
    return null;
  }

  /** The agents someone brought into the chat, as their owner. */
  ownedBy(uid: string): RosterEntry[] {
    return this.#entries("WHERE owner_uid = ?", uid);
  }

  /**
   * Why a new agent named `name` cannot join, as `add` would refuse it: the chat holds MAX_CHAT_AGENTS, or another
   * agent has the name here. Null when it can.
   */
  refusal(name: string): { error: string } | null {
    const n = this.#sql.exec("SELECT COUNT(*) AS n FROM chat_agents").toArray()[0].n as number;
    if (n >= MAX_CHAT_AGENTS) return { error: `A chat holds at most ${MAX_CHAT_AGENTS} agents besides pi; remove one first.` };
    if (this.byName(name)) return { error: `This chat already has an agent named "${name}".` };
    return null;
  }

  /**
   * Take an agent out of the roster, and its turns not run yet with it, and the replies its owner had not reviewed yet.
   * Its past replies stay in the log.
   */
  remove(agentId: string): RosterEntry | null {
    const entry = this.get(agentId);
    if (!entry) return null;
    this.#sql.exec("DELETE FROM chat_agents WHERE agent_id = ?", agentId);
    this.stopAll(agentId);
    this.#sql.exec(`UPDATE chat_agent_turns SET held = 0, reply = NULL, delivered_at = ? WHERE agent_id = ? AND ${HELD}`, this.#now(), agentId);
    return entry;
  }

  /**
   * Keep what everyone sees of an agent as its definition now says. A rename that another agent here has taken keeps
   * the old name. The entry as it is now, and whether anything everyone sees changed; null when it is not here.
   */
  refresh(agentId: string, view: RosterView): { entry: RosterEntry; changed: boolean } | null {
    const before = this.get(agentId);
    if (!before) return null;
    const name = view.name.toLowerCase();
    // A name taken here when it joined keeps the handle it got then ("planner-ana" for "planner") while that is still
    // its name; any rename ends the alias, and the new name is taken when free.
    const alias = before.aliasOf === name;
    const holder = alias || name === before.name ? null : this.byName(name);
    const { aliasOf: _, ...rest } = before;
    const entry: RosterEntry = { ...rest, ...view, name: alias || holder ? before.name : name, ...(alias && { aliasOf: name }) };
    const changed = (["name", "avatar", "color", "job", "off"] as const).some((field) => entry[field] !== before[field]);
    if (changed || entry.aliasOf !== before.aliasOf) {
      this.#sql.exec(
        "UPDATE chat_agents SET name = ?, avatar = ?, color = ?, job = ?, off = ?, alias_of = ? WHERE agent_id = ?",
        entry.name,
        entry.avatar,
        entry.color,
        entry.job,
        entry.off ? 1 : 0,
        entry.aliasOf ?? null,
        agentId,
      );
    }
    return { entry, changed };
  }

  /** Share an agent with the people of the chat, or stop; false when it is not here. */
  setShared(agentId: string, shared: boolean): boolean {
    return this.#sql.exec("UPDATE chat_agents SET shared = ? WHERE agent_id = ?", shared ? 1 : 0, agentId).rowsWritten > 0;
  }

  /** Mute an agent in this chat, or unmute it; false when it is not here. */
  setMuted(agentId: string, muted: boolean): boolean {
    return this.#sql.exec("UPDATE chat_agents SET muted = ? WHERE agent_id = ?", muted ? 1 : 0, agentId).rowsWritten > 0;
  }

  /** The newest log entry an agent's session has read: what it is sent next starts after it. */
  setMirrored(agentId: string, through: number): void {
    this.#sql.exec("UPDATE chat_agents SET mirrored = MAX(mirrored, ?) WHERE agent_id = ?", through, agentId);
  }

  /** Queue a turn for an agent. */
  enqueue(turn: TurnRequest): AgentTurn {
    const row = this.#sql
      .exec(
        `INSERT INTO chat_agent_turns (agent_id, status, hop, called_by, by_owner, root, ask, ask_key, created_at, session, run, unattended, by_uid)
         VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        turn.agentId,
        turn.hop,
        JSON.stringify(turn.calledBy),
        turn.byOwner ? 1 : 0,
        turn.root ?? null,
        turn.ask,
        turn.askKey ?? null,
        this.#now(),
        turn.session ?? null,
        turn.run ? JSON.stringify(turn.run) : null,
        turn.unattended ? 1 : 0,
        turn.by ?? null,
      )
      .toArray()[0] as TurnRow;
    return turnOf(row);
  }

  /**
   * Someone left the chat: stop every turn not ended that they asked for, or that their messages' turns handed on, and
   * hand pi none of those chains' replies not delivered yet, so nothing of theirs runs as the owner after they are out.
   * The ones stopped.
   */
  stopFor(uid: string): AgentTurn[] {
    const asked = "json_extract(called_by, '$.uid') = ?";
    const theirs = `(${asked} OR root IN (SELECT id FROM chat_agent_turns WHERE ${asked}))`;
    this.#sql.exec(`UPDATE chat_agent_turns SET to_pi = 0 WHERE to_pi = 1 AND ${UNDELIVERED} AND ${theirs}`, uid, uid);
    const rows = this.#sql
      .exec(`UPDATE chat_agent_turns SET status = 'stopped', ended_at = ? WHERE ${OPEN} AND ${theirs} RETURNING *`, this.#now(), uid, uid)
      .toArray() as TurnRow[];
    return rows.map(turnOf);
  }

  /**
   * How many hand-offs the chain that `root` started has made, pi's among them (a turn that handed pi one): they stay
   * within MAX_HOPS, however they branch.
   */
  handOffsFrom(root: number): number {
    return this.#sql.exec("SELECT COALESCE(SUM((hop > 0) + to_pi), 0) AS n FROM chat_agent_turns WHERE root = ? OR id = ?", root, root).toArray()[0]
      .n as number;
  }

  /**
   * What the newest turns of an agent answered (askKey), the ones its session was given and `current`: its catch-up
   * leaves them out, as their inputs carry them. A turn still waiting, or one stopped before it started, is read there,
   * and so is one that ran in a session of its own (a reply to a run's report), which its own session never saw.
   */
  askKeys(agentId: string, current: number, limit = 50): Set<string> {
    const rows = this.#sql
      .exec(
        "SELECT ask_key FROM chat_agent_turns WHERE agent_id = ? AND ask_key IS NOT NULL AND ((submitted_at IS NOT NULL AND session IS NULL) OR id = ?) ORDER BY id DESC LIMIT ?",
        agentId,
        current,
        limit,
      )
      .toArray();
    return new Set(rows.map((row) => row.ask_key as string));
  }

  /**
   * A turn runs in a session of its own (a fork of its agent's): set before its input goes in. What the fork publishes
   * or saves is withheld from the chat's listings until its reply is posted (`forks`). `from`: the newest entry it
   * inherited, after which its own start; `review`: its agent's owner reviews its reply before it is posted.
   */
  setFork(id: number, session: string, apart: { from?: number; review: boolean }): void {
    if (this.#sql.exec("UPDATE chat_agent_turns SET session = ?, forked = 1 WHERE id = ? AND status = 'running'", session, id).rowsWritten) {
      this.#sql.exec(
        "INSERT INTO chat_agent_forks (session, from_entry, review, apart_turn) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        session,
        apart.from ?? null,
        apart.review ? 1 : 0,
        id,
      );
    }
  }

  /**
   * A turn in a session of its own that is not a fork (a reply to a run's report, in the run's reply session) runs apart
   * from the chat as a fork does: what it publishes or saves now is withheld until its reply is posted. Each turn apart
   * has a window of the session's entries (ApartWindow), from `from` (its newest entry now) on, which closes the one
   * before: what came before the first is the chat's, and each window is the chat's once its own reply is posted. So an
   * earlier turn held for review is posted as its own, and one discarded, failed or stopped stays withheld for good
   * without holding back the turns after it. Given again (requeued), a turn keeps its window.
   */
  setApart(session: string, review: boolean, from: number | undefined, turn: number): void {
    const at = from ?? -1;
    this.#sql.exec(
      `INSERT INTO chat_agent_forks (session, review, reused, from_entry, apart_turn) VALUES (?, ?, 1, ?, ?) ON CONFLICT (session) DO UPDATE SET
       posted = CASE WHEN apart_turn IS excluded.apart_turn THEN posted ELSE 0 END, review = excluded.review, apart_turn = excluded.apart_turn`,
      session,
      review ? 1 : 0,
      at,
      turn,
    );
    if (this.#sql.exec("SELECT 1 FROM chat_agent_apart_windows WHERE session = ? AND turn = ?", session, turn).toArray().length) return;
    this.#sql.exec("UPDATE chat_agent_apart_windows SET through_entry = ? WHERE session = ? AND through_entry IS NULL", at, session);
    this.#sql.exec("INSERT INTO chat_agent_apart_windows (session, turn, from_entry) VALUES (?, ?, ?)", session, turn, at);
  }

  /** A reused session's windows (setApart), oldest first; none for any other session. */
  windows(session: string): ApartWindow[] {
    const rows = this.#sql
      .exec("SELECT turn, from_entry, through_entry, posted FROM chat_agent_apart_windows WHERE session = ? ORDER BY from_entry, turn", session)
      .toArray();
    return rows.map((row) => ({
      turn: row.turn as number,
      from: row.from_entry as number,
      ...(row.through_entry !== null && { through: row.through_entry as number }),
      posted: row.posted === 1,
    }));
  }

  /** A session apart from the chat (setFork, setApart), as `forks` has it; undefined for any other. */
  fork(session: string): Fork | undefined {
    const [row] = this.#sql.exec(`${FORKS} WHERE f.session = ?`, session).toArray() as ForkRow[];
    return row && forkOf(row);
  }

  /**
   * A version `session` published while apart from the chat with its reply not posted: withheld from members until it
   * is (withheldVersion), and for good when it never is. Nothing for any other session.
   */
  recordPage(session: string, artifactId: string, version: number): boolean {
    return (
      this.#sql.exec(
        `INSERT INTO chat_agent_fork_pages (session, artifact_id, version, turn)
         SELECT session, ?, ?, apart_turn FROM chat_agent_forks WHERE session = ? AND posted = 0 ON CONFLICT DO NOTHING`,
        artifactId,
        version,
        session,
      ).rowsWritten > 0
    );
  }

  /**
   * Files `session` is about to save while apart from the chat with its reply not posted: recorded before they are
   * saved, so one saved by a tool that was stopped or cut off, which no result names, is withheld too (withheldFiles).
   * A path saved again is the newest turn's: its content is. Nothing for any other session.
   */
  recordFiles(session: string, paths: readonly string[]): void {
    for (const path of paths) {
      this.#sql.exec(
        `INSERT INTO chat_agent_fork_files (session, path, turn)
         SELECT session, ?, apart_turn FROM chat_agent_forks WHERE session = ? AND posted = 0
         ON CONFLICT DO UPDATE SET turn = excluded.turn, posted = 0`,
        path,
        session,
      );
    }
  }

  /**
   * A draft `session` saved (worker/storage/drafts.ts, by its id, a hash of the page): one a session apart from the chat
   * saved with its reply not posted is that turn's, which no other conversation lists or uses until it is posted
   * (withheldDrafts). Saved from a conversation the chat sees, the page is the chat's, whoever else saved it too, before
   * or after: a row of no session (CHAT_DRAFT) says so, for the newest MAX_CHAT_DRAFTS such drafts.
   */
  recordDraft(session: string, draftId: string): void {
    const apart = this.#sql.exec(
      `INSERT INTO chat_agent_fork_drafts (session, draft_id, turn)
       SELECT session, ?, apart_turn FROM chat_agent_forks WHERE session = ? AND posted = 0
       AND NOT EXISTS (SELECT 1 FROM chat_agent_fork_drafts WHERE session = ? AND draft_id = ?)
       ON CONFLICT DO UPDATE SET turn = excluded.turn, posted = 0`,
      draftId,
      session,
      CHAT_DRAFT,
      draftId,
    ).rowsWritten;
    if (apart) return;
    this.#sql.exec("DELETE FROM chat_agent_fork_drafts WHERE draft_id = ?", draftId);
    this.#sql.exec("INSERT INTO chat_agent_fork_drafts (session, draft_id, posted) VALUES (?, ?, 1)", CHAT_DRAFT, draftId);
    this.#sql.exec(
      `DELETE FROM chat_agent_fork_drafts WHERE session = ? AND rowid NOT IN
       (SELECT rowid FROM chat_agent_fork_drafts WHERE session = ? ORDER BY rowid DESC LIMIT ?)`,
      CHAT_DRAFT,
      CHAT_DRAFT,
      MAX_CHAT_DRAFTS,
    );
  }

  /**
   * The drafts turns apart from the chat other than the current turn of `except` saved, with their replies not posted,
   * and that turn did not save too: an earlier turn of `except` itself whose reply is not posted is apart from it.
   */
  withheldDrafts(except: string): Set<string> {
    const rows = this.#sql
      .exec(
        `SELECT DISTINCT draft_id FROM chat_agent_fork_drafts WHERE posted = 0 AND NOT ${THIS_TURN}
         AND draft_id NOT IN (SELECT draft_id FROM chat_agent_fork_drafts WHERE ${THIS_TURN})`,
        except,
        except,
        except,
        except,
      )
      .toArray();
    return new Set(rows.map((row) => row.draft_id as string));
  }

  /** The files sessions apart from the chat saved (recordFiles), with their replies not posted: not the chat's yet. */
  withheldFiles(): Set<string> {
    const rows = this.#sql.exec("SELECT DISTINCT path FROM chat_agent_fork_files WHERE posted = 0").toArray();
    return new Set(rows.map((row) => row.path as string));
  }

  /**
   * Whether a turn apart from the chat (other than the current turn of `except`) published `version` of a page (any
   * version, when unset), with its reply not posted. Version 1: the page is one such a turn made.
   */
  withheldVersion(artifactId: string, version?: number, except?: string): boolean {
    return (
      this.#sql
        .exec(
          `SELECT 1 FROM chat_agent_fork_pages WHERE artifact_id = ? AND (? IS NULL OR version = ?) AND posted = 0 AND NOT ${THIS_TURN} LIMIT 1`,
          artifactId,
          version ?? null,
          version ?? null,
          except ?? null,
          except ?? null,
        )
        .toArray().length > 0
    );
  }

  /** The versions of a page turns apart from the chat other than the current turn of `except` published, with their replies not posted. */
  withheldVersions(artifactId: string, except?: string): Set<number> {
    const rows = this.#sql
      .exec(
        `SELECT version FROM chat_agent_fork_pages WHERE artifact_id = ? AND posted = 0 AND NOT ${THIS_TURN}`,
        artifactId,
        except ?? null,
        except ?? null,
      )
      .toArray();
    return new Set(rows.map((row) => row.version as number));
  }

  /** Whether any session apart from the chat has a turn's reply not posted: until one does, nothing is withheld. */
  anyWithheld(): boolean {
    return this.#sql.exec(`${WITHHELD} LIMIT 1`).toArray().length > 0;
  }

  /** The pages a session apart from the chat made (their first version), with its reply not posted: not the chat's yet. */
  madeApart(): Set<string> {
    return this.#pageIds("version = 1 AND posted = 0");
  }

  /**
   * The pages the current turn of `session` published while apart from the chat with its reply not posted
   * (recordPage). Not those of an earlier turn in it (a run's reply session): posted, they are the chat's; not, they
   * are apart from this turn too.
   */
  pagesOf(session: string): Set<string> {
    return this.#pageIds(`posted = 0 AND ${THIS_TURN}`, session, session);
  }

  #pageIds(where: string, ...bindings: string[]): Set<string> {
    const rows = this.#sql.exec(`SELECT DISTINCT artifact_id FROM chat_agent_fork_pages WHERE ${where}`, ...bindings).toArray();
    return new Set(rows.map((row) => row.artifact_id as string));
  }

  /**
   * Every fork made for a turn, kept for good (a turn row is not): whether its reply was `posted` (until then what it
   * published or saved is not the chat's for anyone but its owner: it runs, is held for review, was discarded or
   * stopped), and whether it `ended`, after which its session takes no more entries.
   */
  forks(): Map<string, Fork> {
    const rows = this.#sql.exec(FORKS).toArray() as ForkRow[];
    return new Map(rows.map((row) => [row.session, forkOf(row)]));
  }

  /** The sessions apart from the chat with a turn's reply not posted: forks() not posted, and reused ones with such a window. */
  withheld(): Set<string> {
    return new Set(
      this.#sql
        .exec(WITHHELD)
        .toArray()
        .map((row) => row.session as string),
    );
  }

  /** A running turn's input reached its session: a restart waits on it, where one not submitted yet starts again. */
  markSubmitted(id: number): void {
    this.#sql.exec("UPDATE chat_agent_turns SET submitted_at = ? WHERE id = ? AND submitted_at IS NULL", this.#now(), id);
  }

  /** After a restart: the running turns whose input never reached their session go back to the queue, at their place. */
  requeueUnsubmitted(): void {
    // A fork made for it stays its session: its input may be in it already, and goes in again there, placed once.
    this.#sql.exec("UPDATE chat_agent_turns SET status = 'queued', started_at = NULL WHERE status = 'running' AND submitted_at IS NULL");
  }

  /** Whether any turn waits, runs or has a reply to deliver: what a restarted object picks up again. */
  hasWork(): boolean {
    return this.#sql.exec(`SELECT 1 FROM chat_agent_turns WHERE ${OPEN} OR (${UNDELIVERED}) LIMIT 1`).toArray().length > 0;
  }

  turn(id: number): AgentTurn | null {
    return this.#turns("id = ?", id)[0] ?? null;
  }

  /** Every turn running now, in every agent: what a restarted object waits on again. */
  allRunning(): AgentTurn[] {
    return this.#turns("status = 'running' ORDER BY id");
  }

  /** The agents that have turns waiting. */
  waitingAgents(): string[] {
    return this.#sql
      .exec("SELECT DISTINCT agent_id FROM chat_agent_turns WHERE status = 'queued' ORDER BY agent_id")
      .toArray()
      .map((row) => row.agent_id as string);
  }

  /**
   * Start an agent's next waiting turn, oldest first, unless one is running: at most one at a time per agent. Null
   * when nothing starts.
   */
  startNext(agentId: string): AgentTurn | null {
    if (this.#turns("agent_id = ? AND status = 'running' LIMIT 1", agentId).length) return null;
    const row = this.#sql
      .exec(
        `UPDATE chat_agent_turns SET status = 'running', started_at = ?
         WHERE id = (SELECT id FROM chat_agent_turns WHERE agent_id = ? AND status = 'queued' ORDER BY id LIMIT 1) RETURNING *`,
        this.#now(),
        agentId,
      )
      .toArray()[0] as TurnRow | undefined;
    return row ? turnOf(row) : null;
  }

  /**
   * End a turn not ended yet, with what it still has to deliver. Only once: a turn that ended already (a second wait on
   * it, a stop meanwhile) stays as it ended, and null says so, so its reply is delivered once.
   */
  end(id: number, status: Exclude<AgentTurnStatus, "queued" | "running">, outbox?: Outbox): AgentTurn | null {
    const row = this.#sql
      .exec(
        `UPDATE chat_agent_turns SET status = ?, ended_at = ?, reply = ?, to_pi = ?, held = ? WHERE id = ? AND ${OPEN} RETURNING *`,
        status,
        this.#now(),
        outbox ? JSON.stringify(outbox.reply) : null,
        outbox?.toPi ? 1 : 0,
        outbox?.held ? 1 : 0,
        id,
      )
      .toArray()[0] as TurnRow | undefined;
    if (!row) return null;
    this.#prune(row.agent_id);
    return turnOf(row);
  }

  /** What an ended turn has still to deliver; null once delivered (or for a turn with nothing to). */
  outbox(id: number): Outbox | null {
    const row = this.#sql.exec(`SELECT reply, to_pi FROM chat_agent_turns WHERE id = ? AND ${UNDELIVERED}`, id).toArray()[0] as
      | Pick<TurnRow, "reply" | "to_pi">
      | undefined;
    return row?.reply ? { reply: JSON.parse(row.reply) as ChatAgentReplyData, toPi: row.to_pi === 1 } : null;
  }

  /** The replies of `ownerUid`'s agents held for their review, oldest first. */
  held(ownerUid: string): AgentDraftView[] {
    const rows = this.#sql
      .exec(
        `SELECT t.id, t.agent_id, t.reply FROM chat_agent_turns t JOIN chat_agents a ON a.agent_id = t.agent_id
         WHERE ${HELD} AND a.owner_uid = ? ORDER BY t.id`,
        ownerUid,
      )
      .toArray() as { id: number; agent_id: string; reply: string }[];
    return rows.map((row) => ({ turn: row.id, agentId: row.agent_id, reply: JSON.parse(row.reply) as ChatAgentReplyData }));
  }

  /**
   * Let an ended turn's reply go to the chat as `reply` (a held one as its owner posts it, maybe edited), handing pi a
   * turn when it names pi: it is then delivered. Nothing when it has nothing to deliver (delivered or discarded already).
   * Only a reply with text that did not fail (a done one, or one its owner posts) makes its fork's pages and files the
   * chat's.
   */
  release(id: number, reply: ChatAgentReplyData, toPi: boolean): PostedPage[] {
    const row = this.#sql
      .exec(
        `UPDATE chat_agent_turns SET held = 0, reply = ?, to_pi = ? WHERE id = ? AND ${PENDING} RETURNING session, forked`,
        JSON.stringify(reply),
        toPi ? 1 : 0,
        id,
      )
      .toArray()[0] as Pick<TurnRow, "session" | "forked"> | undefined;
    // What this turn apart made is the chat's now, as its reply is: its window of a reused session, and the pages and
    // files recorded as its own. Not an earlier turn's in the same session, nor a later one's.
    if (reply.failed || !reply.text || !row?.session) return [];
    const session = row.session;
    this.#sql.exec("UPDATE chat_agent_forks SET posted = 1 WHERE session = ? AND apart_turn = ?", session, id);
    this.#sql.exec("UPDATE chat_agent_apart_windows SET posted = 1 WHERE session = ? AND turn = ?", session, id);
    this.#sql.exec("UPDATE chat_agent_fork_files SET posted = 1 WHERE session = ? AND turn = ?", session, id);
    this.#sql.exec("UPDATE chat_agent_fork_drafts SET posted = 1 WHERE session = ? AND turn = ?", session, id);
    const pages = this.#sql
      .exec("UPDATE chat_agent_fork_pages SET posted = 1 WHERE session = ? AND turn = ? AND posted = 0 RETURNING artifact_id, version", session, id)
      .toArray();
    return pages.map((page) => ({ artifactId: page.artifact_id as string, version: page.version as number }));
  }

  /** Drop a held reply, as its owner discards it: it never reaches the chat. */
  discard(id: number): void {
    this.#sql.exec(`UPDATE chat_agent_turns SET held = 0, reply = NULL, delivered_at = ? WHERE id = ? AND ${HELD}`, this.#now(), id);
  }

  /** The ended turns whose replies are not delivered yet, oldest first: what a restart delivers. */
  undelivered(): number[] {
    return this.#sql
      .exec(`SELECT id FROM chat_agent_turns WHERE ${UNDELIVERED} ORDER BY id`)
      .toArray()
      .map((row) => row.id as number);
  }

  /** A turn's reply is delivered: it is in the log now, so the row lets it go. */
  markDelivered(id: number): void {
    this.#sql.exec("UPDATE chat_agent_turns SET delivered_at = ?, reply = NULL WHERE id = ?", this.#now(), id);
  }

  /**
   * Stop every turn of every agent, or of one, that has not ended: what a person's Stop does. A reply not delivered yet
   * still is, but hands pi no turn. The ones stopped.
   */
  stopAll(agentId?: string): AgentTurn[] {
    const which = agentId === undefined ? "" : "agent_id = ? AND ";
    const params = agentId === undefined ? [] : [agentId];
    this.#sql.exec(`UPDATE chat_agent_turns SET to_pi = 0 WHERE ${which}to_pi = 1 AND ${UNDELIVERED}`, ...params);
    const rows = this.#sql
      .exec(`UPDATE chat_agent_turns SET status = 'stopped', ended_at = ? WHERE ${which}${OPEN} RETURNING *`, this.#now(), ...params)
      .toArray() as TurnRow[];
    return rows.map(turnOf);
  }

  /**
   * An agent's turns nobody asked for (calledBy.unprompted), those it passed included: how many were queued since
   * `since`, and when the last one was, whenever that was (a cooldown runs across midnight). What the funnel's daily cap
   * and cooldown read (worker/agents/funnel.ts).
   */
  unpromptedSince(agentId: string, since: number): { count: number; lastAt?: number } {
    const row = this.#sql
      .exec(
        `SELECT SUM(created_at >= ?) AS n, MAX(created_at) AS last FROM chat_agent_turns
         WHERE agent_id = ? AND json_extract(called_by, '$.unprompted') IS NOT NULL`,
        since,
        agentId,
      )
      .toArray()[0] as { n: number | null; last: number | null };
    return { count: row.n ?? 0, ...(row.last !== null && { lastAt: row.last }) };
  }

  /** Whether an agent has a turn waiting or running. */
  isBusy(agentId: string): boolean {
    return this.#sql.exec(`SELECT 1 FROM chat_agent_turns WHERE agent_id = ? AND ${OPEN} LIMIT 1`, agentId).toArray().length > 0;
  }

  /** The newest turns, for a runs list. */
  recentTurns(agentId: string, limit = 20): AgentTurn[] {
    return this.#turns("agent_id = ? ORDER BY id DESC LIMIT ?", agentId, limit);
  }

  /**
   * What everyone sees of the roster: who is working, on which turn and for how long, and how many turns wait, with the
   * oldest of them. `ownerName` names an owner.
   */
  views(ownerName: (uid: string) => string): ChatAgentView[] {
    // The turns not ended, oldest first: few, so one read serves every agent.
    const open = new Map<string, AgentTurn[]>();
    for (const turn of this.#turns(`${OPEN} ORDER BY id`)) {
      const mine = open.get(turn.agentId);
      if (mine) mine.push(turn);
      else open.set(turn.agentId, [turn]);
    }
    const ended = new Map(
      this.#turns(`id IN (SELECT MAX(id) FROM chat_agent_turns WHERE NOT (${OPEN}) GROUP BY agent_id)`).map((turn) => [turn.agentId, turn]),
    );
    const now = this.#now();
    return this.list().map((entry) => {
      const mine = open.get(entry.agentId) ?? [];
      const last = ended.get(entry.agentId);
      const running = mine.find((turn) => turn.status === "running");
      const queued = mine.filter((turn) => turn.status === "queued");
      return {
        id: entry.agentId,
        name: entry.name,
        avatar: entry.avatar,
        color: entry.color,
        job: entry.job,
        ownerUid: entry.ownerUid,
        ownerName: ownerName(entry.ownerUid),
        ...(running && {
          busy: true as const,
          running: { turn: running.id, calledBy: running.calledBy, hop: running.hop, elapsedMs: Math.max(0, now - (running.startedAt ?? now)) },
        }),
        ...(queued.length && { queued: queued.length, next: { calledBy: queued[0].calledBy, hop: queued[0].hop } }),
        ...(last && { ended: { turn: last.id, status: last.status as NonNullable<ChatAgentView["ended"]>["status"] } }),
        ...(entry.off && { off: true as const }),
        ...(entry.shared && { shared: true as const }),
        ...(entry.seat !== undefined && { seat: true as const }),
        ...(entry.muted && { muted: true as const }),
      };
    });
  }

  /**
   * The turns running here now, each with its session: what the chat's sockets follow live. A turn in a fork may read
   * its owner's private servers: only its owner (`only`) follows it. A seat's turns run in another object, and are not
   * followed.
   */
  runningSessions(): RunningTurn[] {
    const running = this.allRunning();
    if (!running.length) return [];
    const entries = new Map(this.list().map((entry) => [entry.agentId, entry]));
    return running.flatMap((turn) => {
      const entry = entries.get(turn.agentId);
      if (!entry || entry.seat !== undefined) return [];
      // A run's reply turn works in its own session (a fork of the run's, with what the run read as its owner), not the
      // agent's; so does a private turn in a fork. Either shows only its owner.
      return [{ agentId: turn.agentId, session: sessionOf(entry, turn), turn: turn.id, ...(turn.session !== undefined && { only: entry.ownerUid }) }];
    });
  }

  #prune(agentId: string): void {
    this.#sql.exec(
      `DELETE FROM chat_agent_turns WHERE agent_id = ? AND NOT (${OPEN}) AND NOT (${PENDING}) AND id NOT IN (
         SELECT id FROM chat_agent_turns WHERE agent_id = ? ORDER BY id DESC LIMIT ?
       )`,
      agentId,
      agentId,
      KEPT_TURNS,
    );
  }
}

/** The session a turn runs in: its own (a fork), else its agent's. */
export function sessionOf(entry: Pick<RosterEntry, "session">, turn: Pick<AgentTurn, "session">): string {
  return turn.session ?? entry.session;
}
