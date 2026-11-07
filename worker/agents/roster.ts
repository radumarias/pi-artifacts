import {
  MAX_CHAT_AGENTS,
  type AgentColor,
  type AgentTurnStatus,
  type AgentTurnView,
  type ChatAgentReplyData,
  type ChatAgentView,
} from "../../shared/agents.ts";
import type { RunRef } from "../../shared/runs.ts";
import type { Sql } from "../members.ts";

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
}

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
   * runs in a fork of the run's). It reads nothing of the chat, so it catches up on nothing.
   */
  session?: string;
  /** The run its reply carries, so a reply to that continues the run too. */
  run?: RunRef;
  /**
   * In a chain no person started (a run's hand-over): it and its hand-offs never hand pi a turn, which would run with
   * the owner's full tools; pi only reads their replies.
   */
  unattended?: true;
}

/**
 * A turn to queue. `askKey` says which log entry `ask` is (see askKey in turns.ts), so the catch-up before a turn
 * leaves out what its input already says; absent when it is no entry of the log. Without a `root`, the turn starts a
 * chain of hand-offs of its own.
 */
export type TurnRequest = Pick<AgentTurn, "agentId" | "hop" | "calledBy" | "byOwner" | "ask" | "session" | "run" | "unattended"> & {
  root?: number;
  askKey?: string;
};

/** What an ended turn still has to deliver: its reply to the log, and whether pi is handed a turn for it. */
export interface Outbox {
  reply: ChatAgentReplyData;
  toPi: boolean;
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
};

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
  run: string | null;
  unattended: number;
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
    ...(row.run !== null && { run: JSON.parse(row.run) as RunRef }),
    ...(row.unattended === 1 && { unattended: true }),
  };
}

/** Turns kept per agent once ended: the newest, for the runs list; older ones go. */
const KEPT_TURNS = 200;
/** A turn not ended yet. */
const OPEN = "status IN ('queued', 'running')";
/** An ended turn whose reply is not delivered yet. */
const UNDELIVERED = "reply IS NOT NULL AND delivered_at IS NULL";

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
        shared INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chat_agent_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, status TEXT NOT NULL, hop INTEGER NOT NULL, called_by TEXT NOT NULL,
        by_owner INTEGER NOT NULL, root INTEGER, ask TEXT NOT NULL, ask_key TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
        submitted_at INTEGER, ended_at INTEGER, reply TEXT, to_pi INTEGER NOT NULL DEFAULT 0, delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS chat_agent_turns_by_agent ON chat_agent_turns (agent_id, status, id);
      CREATE INDEX IF NOT EXISTS chat_agent_turns_by_status ON chat_agent_turns (status);
      CREATE INDEX IF NOT EXISTS chat_agent_turns_by_root ON chat_agent_turns (root);
    `);
    // Added later: a turn's own session, and the run its reply carries.
    const columns = sql.exec("SELECT name FROM pragma_table_info('chat_agent_turns')").toArray();
    for (const name of ["session", "run"]) if (!columns.some((column) => column.name === name)) sql.exec(`ALTER TABLE chat_agent_turns ADD COLUMN ${name} TEXT`);
    if (!columns.some((column) => column.name === "unattended")) sql.exec("ALTER TABLE chat_agent_turns ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0");
    // A roster made before agents could be shared lacks the column.
    if (!sql.exec("SELECT 1 FROM pragma_table_info('chat_agents') WHERE name = 'shared'").toArray().length) {
      sql.exec("ALTER TABLE chat_agents ADD COLUMN shared INTEGER NOT NULL DEFAULT 0");
    }
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
  add(entry: Pick<RosterEntry, "agentId" | "ownerUid" | "name" | "session" | "avatar" | "color" | "job">): { error: string } | null {
    if (this.get(entry.agentId)) return null;
    const refused = this.refusal(entry.name);
    if (refused) return refused;
    this.#sql.exec(
      "INSERT INTO chat_agents (agent_id, owner_uid, name, session, added_at, avatar, color, job) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      entry.agentId,
      entry.ownerUid,
      entry.name.toLowerCase(),
      entry.session,
      this.#now(),
      entry.avatar,
      entry.color,
      entry.job,
    );
    return null;
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

  /** Take an agent out of the roster, and its turns not run yet with it. Its past replies stay in the log. */
  remove(agentId: string): RosterEntry | null {
    const entry = this.get(agentId);
    if (!entry) return null;
    this.#sql.exec("DELETE FROM chat_agents WHERE agent_id = ?", agentId);
    this.stopAll(agentId);
    return entry;
  }

  /**
   * Keep what everyone sees of an agent as its definition now says. A rename that another agent here has taken keeps
   * the old name. The entry as it is now, and whether anything everyone sees changed; null when it is not here.
   */
  refresh(agentId: string, view: RosterView): { entry: RosterEntry; changed: boolean } | null {
    const before = this.get(agentId);
    if (!before) return null;
    const taken = view.name !== before.name && this.byName(view.name) !== null;
    const entry = { ...before, ...view, name: taken ? before.name : view.name.toLowerCase() };
    const changed = (["name", "avatar", "color", "job", "off"] as const).some((field) => entry[field] !== before[field]);
    if (changed) {
      this.#sql.exec(
        "UPDATE chat_agents SET name = ?, avatar = ?, color = ?, job = ?, off = ? WHERE agent_id = ?",
        entry.name,
        entry.avatar,
        entry.color,
        entry.job,
        entry.off ? 1 : 0,
        agentId,
      );
    }
    return { entry, changed };
  }

  /** Share an agent with the people of the chat, or stop; false when it is not here. */
  setShared(agentId: string, shared: boolean): boolean {
    return this.#sql.exec("UPDATE chat_agents SET shared = ? WHERE agent_id = ?", shared ? 1 : 0, agentId).rowsWritten > 0;
  }

  /** The newest log entry an agent's session has read: what it is sent next starts after it. */
  setMirrored(agentId: string, through: number): void {
    this.#sql.exec("UPDATE chat_agents SET mirrored = MAX(mirrored, ?) WHERE agent_id = ?", through, agentId);
  }

  /** Queue a turn for an agent. */
  enqueue(turn: TurnRequest): AgentTurn {
    const row = this.#sql
      .exec(
        `INSERT INTO chat_agent_turns (agent_id, status, hop, called_by, by_owner, root, ask, ask_key, created_at, session, run, unattended)
         VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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

  /** A running turn's input reached its session: a restart waits on it, where one not submitted yet starts again. */
  markSubmitted(id: number): void {
    this.#sql.exec("UPDATE chat_agent_turns SET submitted_at = ? WHERE id = ? AND submitted_at IS NULL", this.#now(), id);
  }

  /** After a restart: the running turns whose input never reached their session go back to the queue, at their place. */
  requeueUnsubmitted(): void {
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
        `UPDATE chat_agent_turns SET status = ?, ended_at = ?, reply = ?, to_pi = ? WHERE id = ? AND ${OPEN} RETURNING *`,
        status,
        this.#now(),
        outbox ? JSON.stringify(outbox.reply) : null,
        outbox?.toPi ? 1 : 0,
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
      };
    });
  }

  /** The turns running now, each with its agent's session: what the chat's sockets follow live. */
  runningSessions(): { agentId: string; session: string; turn: number }[] {
    const running = this.allRunning();
    if (!running.length) return [];
    const sessions = new Map(this.list().map((entry) => [entry.agentId, entry.session]));
    return running.flatMap((turn) => {
      // A run's reply turn works in its own session (a fork of the run's), not the agent's.
      const session = turn.session ?? sessions.get(turn.agentId);
      return session ? [{ agentId: turn.agentId, session, turn: turn.id }] : [];
    });
  }

  #prune(agentId: string): void {
    this.#sql.exec(
      `DELETE FROM chat_agent_turns WHERE agent_id = ? AND NOT (${OPEN}) AND NOT (${UNDELIVERED}) AND id NOT IN (
         SELECT id FROM chat_agent_turns WHERE agent_id = ? ORDER BY id DESC LIMIT ?
       )`,
      agentId,
      agentId,
      KEPT_TURNS,
    );
  }
}
