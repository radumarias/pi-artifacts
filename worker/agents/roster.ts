import { MAX_CHAT_AGENTS, type AgentColor, type AgentTurnStatus, type AgentTurnView, type ChatAgentView } from "../../shared/agents.ts";
import type { Sql } from "../members.ts";

/** One agent of a chat's roster: which definition it points at, and the pi session it runs in. */
export interface RosterEntry {
  agentId: string;
  ownerUid: string;
  /** Its handle in this chat: unique here. */
  name: string;
  /** Its pi session (PiSessionId), made when it was added. */
  session: string;
  addedBy: string;
  addedAt: number;
  /** What everyone sees of it, as its definition last read: refreshed at each of its turns. */
  avatar: string;
  color: AgentColor;
  job: string;
  /** The definition's version the session was last configured from; 0 before its first turn. */
  applied: number;
  /** The newest entry of the chat's log its session has read (see ChatRoster.mirrored). */
  mirrored: number;
  /** Its owner turned it off since: it takes no turns until they turn it on. */
  off: boolean;
}

/** A turn an agent was given, as the chat keeps it: who called it, its chain of hand-offs, and what it answers. */
export interface AgentTurn extends AgentTurnView {
  /** The turn that started the chain of hand-offs this one is in (its own id for a turn a person or schedule gave). */
  root: number;
  /** The message it answers, as its session reads it: one labelled line, which the turn's input carries. */
  ask: string;
  /**
   * Which log entry `ask` is (see askKey in turns.ts), so the catch-up before a turn leaves out what the input already
   * says. Absent when it is no entry of the log.
   */
  askKey?: string;
}

type RosterRow = {
  agent_id: string;
  owner_uid: string;
  name: string;
  session: string;
  added_by: string;
  added_at: number;
  avatar: string;
  color: string;
  job: string;
  applied: number;
  mirrored: number;
  off: number;
};

type TurnRow = {
  id: number;
  agent_id: string;
  status: AgentTurnStatus;
  hop: number;
  called_by: string;
  answers: number | null;
  by_owner: number;
  root: number | null;
  ask: string;
  ask_key: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
};

function entryOf(row: RosterRow): RosterEntry {
  return {
    agentId: row.agent_id,
    ownerUid: row.owner_uid,
    name: row.name,
    session: row.session,
    addedBy: row.added_by,
    addedAt: row.added_at,
    avatar: row.avatar,
    color: row.color as AgentColor,
    job: row.job,
    applied: row.applied,
    mirrored: row.mirrored,
    off: row.off === 1,
  };
}

function turnOf(row: TurnRow): AgentTurn {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    hop: row.hop,
    calledBy: JSON.parse(row.called_by) as AgentTurn["calledBy"],
    ...(row.answers !== null && { answers: row.answers }),
    byOwner: row.by_owner === 1,
    root: row.root ?? row.id,
    ask: row.ask,
    ...(row.ask_key !== null && { askKey: row.ask_key }),
    createdAt: row.created_at,
    ...(row.started_at !== null && { startedAt: row.started_at }),
    ...(row.ended_at !== null && { endedAt: row.ended_at }),
  };
}

/** Turns kept per agent once ended: the newest, for the runs list; older ones go. */
const KEPT_TURNS = 200;

/**
 * One chat's agents and their turns, in the chat object's own SQLite. The roster points at definitions in their
 * owners' directories and never copies one: only what everyone sees of an agent (name, badge, job line) is kept, to
 * show without asking the owner's directory. Turns are queued per agent and run one at a time, so the session's tools
 * can be set for who asked before each one starts.
 */
export class ChatRoster {
  readonly #sql: Sql;
  readonly #now: () => number;

  constructor(sql: Sql, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS chat_agents (
        agent_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, name TEXT NOT NULL UNIQUE, session TEXT NOT NULL, added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL, avatar TEXT NOT NULL, color TEXT NOT NULL, job TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0,
        mirrored INTEGER NOT NULL DEFAULT -1, off INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chat_agent_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, status TEXT NOT NULL, hop INTEGER NOT NULL, called_by TEXT NOT NULL,
        answers INTEGER, by_owner INTEGER NOT NULL, root INTEGER, ask TEXT NOT NULL, ask_key TEXT, created_at INTEGER NOT NULL,
        started_at INTEGER, ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS chat_agent_turns_by_agent ON chat_agent_turns (agent_id, status, id);
    `);
  }

  list(): RosterEntry[] {
    return (this.#sql.exec("SELECT * FROM chat_agents ORDER BY added_at, name").toArray() as RosterRow[]).map(entryOf);
  }

  get(agentId: string): RosterEntry | null {
    const row = this.#sql.exec("SELECT * FROM chat_agents WHERE agent_id = ?", agentId).toArray()[0] as RosterRow | undefined;
    return row ? entryOf(row) : null;
  }

  byName(name: string): RosterEntry | null {
    const row = this.#sql.exec("SELECT * FROM chat_agents WHERE name = ?", name.toLowerCase()).toArray()[0] as RosterRow | undefined;
    return row ? entryOf(row) : null;
  }

  /** The agent whose session `session` is, if any. */
  bySession(session: string): RosterEntry | null {
    const row = this.#sql.exec("SELECT * FROM chat_agents WHERE session = ?", session).toArray()[0] as RosterRow | undefined;
    return row ? entryOf(row) : null;
  }

  hasAny(): boolean {
    return this.#sql.exec("SELECT 1 FROM chat_agents LIMIT 1").toArray().length > 0;
  }

  /**
   * Add an agent, in the session made for it. Refused when the chat holds MAX_CHAT_AGENTS, or another agent has its
   * name here. Adding one already in the roster changes nothing.
   */
  add(entry: Pick<RosterEntry, "agentId" | "ownerUid" | "name" | "session" | "addedBy" | "avatar" | "color" | "job">): { error: string } | null {
    if (this.get(entry.agentId)) return null;
    const n = this.#sql.exec("SELECT COUNT(*) AS n FROM chat_agents").toArray()[0].n as number;
    if (n >= MAX_CHAT_AGENTS) return { error: `A chat holds at most ${MAX_CHAT_AGENTS} agents besides pi; remove one first.` };
    if (this.byName(entry.name)) return { error: `This chat already has an agent named "${entry.name}".` };
    this.#sql.exec(
      "INSERT INTO chat_agents (agent_id, owner_uid, name, session, added_by, added_at, avatar, color, job) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      entry.agentId,
      entry.ownerUid,
      entry.name.toLowerCase(),
      entry.session,
      entry.addedBy,
      this.#now(),
      entry.avatar,
      entry.color,
      entry.job,
    );
    return null;
  }

  /** Take an agent out of the roster, and its turns not run yet with it. Its past replies stay in the log. */
  remove(agentId: string): RosterEntry | null {
    const entry = this.get(agentId);
    if (!entry) return null;
    this.#sql.exec("DELETE FROM chat_agents WHERE agent_id = ?", agentId);
    this.#sql.exec("UPDATE chat_agent_turns SET status = 'stopped', ended_at = ? WHERE agent_id = ? AND status IN ('queued', 'running')", this.#now(), agentId);
    return entry;
  }

  /**
   * Keep what everyone sees of an agent as its definition now says, and the version its session was set from. A
   * rename that another agent here has taken keeps the old name. Returns whether anything everyone sees changed.
   */
  refresh(agentId: string, view: { name: string; avatar: string; color: AgentColor; job: string; off: boolean }, applied?: number): boolean {
    const before = this.get(agentId);
    if (!before) return false;
    const taken = view.name !== before.name && this.byName(view.name) !== null;
    const name = taken ? before.name : view.name.toLowerCase();
    this.#sql.exec(
      "UPDATE chat_agents SET name = ?, avatar = ?, color = ?, job = ?, off = ?, applied = ? WHERE agent_id = ?",
      name,
      view.avatar,
      view.color,
      view.job,
      view.off ? 1 : 0,
      applied ?? before.applied,
      agentId,
    );
    return name !== before.name || view.avatar !== before.avatar || view.color !== before.color || view.job !== before.job || view.off !== before.off;
  }

  /** The newest log entry an agent's session has read: what it is sent next starts after it. */
  setMirrored(agentId: string, through: number): void {
    this.#sql.exec("UPDATE chat_agents SET mirrored = MAX(mirrored, ?) WHERE agent_id = ?", through, agentId);
  }

  /** Queue a turn for an agent. Without a `root`, it starts a chain of hand-offs of its own. */
  enqueue(turn: Pick<AgentTurn, "agentId" | "hop" | "calledBy" | "answers" | "byOwner" | "ask" | "askKey"> & { root?: number }): AgentTurn {
    const row = this.#sql
      .exec(
        `INSERT INTO chat_agent_turns (agent_id, status, hop, called_by, answers, by_owner, root, ask, ask_key, created_at)
         VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        turn.agentId,
        turn.hop,
        JSON.stringify(turn.calledBy),
        turn.answers ?? null,
        turn.byOwner ? 1 : 0,
        turn.root ?? null,
        turn.ask,
        turn.askKey ?? null,
        this.#now(),
      )
      .toArray()[0] as TurnRow;
    return turnOf(row);
  }

  /** Drop the turns waiting that someone asked for: they left the chat, and none of theirs is answered. Whether any went. */
  dropQueuedBy(uid: string): boolean {
    const dropped = this.#sql.exec(
      "UPDATE chat_agent_turns SET status = 'stopped', ended_at = ? WHERE status = 'queued' AND json_extract(called_by, '$.uid') = ?",
      this.#now(),
      uid,
    );
    return dropped.rowsWritten > 0;
  }

  /** How many hand-offs the chain that `root` started has made: they stay within MAX_HOPS, however they branch. */
  handOffsFrom(root: number): number {
    return this.#sql.exec("SELECT COUNT(*) AS n FROM chat_agent_turns WHERE hop > 0 AND (root = ? OR id = ?)", root, root).toArray()[0].n as number;
  }

  /** What the newest turns of an agent answered (askKey): its catch-up leaves them out, as its inputs carried them. */
  askKeys(agentId: string, limit = 50): Set<string> {
    const rows = this.#sql.exec("SELECT ask_key FROM chat_agent_turns WHERE agent_id = ? AND ask_key IS NOT NULL ORDER BY id DESC LIMIT ?", agentId, limit).toArray();
    return new Set(rows.map((row) => row.ask_key as string));
  }

  turn(id: number): AgentTurn | null {
    const row = this.#sql.exec("SELECT * FROM chat_agent_turns WHERE id = ?", id).toArray()[0] as TurnRow | undefined;
    return row ? turnOf(row) : null;
  }

  /** The turn an agent runs now, if any. */
  running(agentId: string): AgentTurn | null {
    const row = this.#sql.exec("SELECT * FROM chat_agent_turns WHERE agent_id = ? AND status = 'running' ORDER BY id LIMIT 1", agentId).toArray()[0] as TurnRow | undefined;
    return row ? turnOf(row) : null;
  }

  /** Every turn running now, in every agent: what a restarted object waits on again. */
  allRunning(): AgentTurn[] {
    return (this.#sql.exec("SELECT * FROM chat_agent_turns WHERE status = 'running' ORDER BY id").toArray() as TurnRow[]).map(turnOf);
  }

  /** The agents that have turns waiting. */
  waitingAgents(): string[] {
    return this.#sql.exec("SELECT DISTINCT agent_id FROM chat_agent_turns WHERE status = 'queued' ORDER BY agent_id").toArray().map((row) => row.agent_id as string);
  }

  /** How many turns wait for each agent. */
  queuedCounts(): Map<string, number> {
    const rows = this.#sql.exec("SELECT agent_id, COUNT(*) AS n FROM chat_agent_turns WHERE status = 'queued' GROUP BY agent_id").toArray();
    return new Map(rows.map((row) => [row.agent_id as string, row.n as number]));
  }

  /**
   * Start an agent's next waiting turn, oldest first, unless one is running: at most one at a time per agent. Null
   * when nothing starts.
   */
  startNext(agentId: string): AgentTurn | null {
    if (this.running(agentId)) return null;
    const next = this.#sql.exec("SELECT id FROM chat_agent_turns WHERE agent_id = ? AND status = 'queued' ORDER BY id LIMIT 1", agentId).toArray()[0];
    if (!next) return null;
    const row = this.#sql
      .exec("UPDATE chat_agent_turns SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued' RETURNING *", this.#now(), next.id as number)
      .toArray()[0] as TurnRow | undefined;
    return row ? turnOf(row) : null;
  }

  /**
   * End a running turn. Only once: a turn that ended already (a second wait on it, a stop meanwhile) stays as it
   * ended, and null says so, so its reply is posted once.
   */
  end(id: number, status: Exclude<AgentTurnStatus, "queued" | "running">): AgentTurn | null {
    const row = this.#sql
      .exec("UPDATE chat_agent_turns SET status = ?, ended_at = ? WHERE id = ? AND status IN ('queued', 'running') RETURNING *", status, this.#now(), id)
      .toArray()[0] as TurnRow | undefined;
    if (!row) return null;
    this.#prune(row.agent_id);
    return turnOf(row);
  }

  /** Stop every turn of every agent, or of one, that has not ended: what a person's Stop does. The ones stopped. */
  stopAll(agentId?: string): AgentTurn[] {
    const rows = (
      agentId === undefined
        ? this.#sql.exec("UPDATE chat_agent_turns SET status = 'stopped', ended_at = ? WHERE status IN ('queued', 'running') RETURNING *", this.#now())
        : this.#sql.exec("UPDATE chat_agent_turns SET status = 'stopped', ended_at = ? WHERE agent_id = ? AND status IN ('queued', 'running') RETURNING *", this.#now(), agentId)
    ).toArray() as TurnRow[];
    return rows.map(turnOf);
  }

  /** The newest turns, for a runs list. */
  recentTurns(agentId: string, limit = 20): AgentTurn[] {
    return (this.#sql.exec("SELECT * FROM chat_agent_turns WHERE agent_id = ? ORDER BY id DESC LIMIT ?", agentId, limit).toArray() as TurnRow[]).map(turnOf);
  }

  /** What everyone sees of the roster, with who is working and how many turns wait. `ownerName` names an owner. */
  views(ownerName: (uid: string) => string): ChatAgentView[] {
    const queued = this.queuedCounts();
    const busy = new Set(this.allRunning().map((turn) => turn.agentId));
    return this.list().map((entry) => ({
      id: entry.agentId,
      name: entry.name,
      avatar: entry.avatar,
      color: entry.color,
      job: entry.job,
      ownerUid: entry.ownerUid,
      ownerName: ownerName(entry.ownerUid),
      ...(busy.has(entry.agentId) && { busy: true as const }),
      ...(queued.get(entry.agentId) && { queued: queued.get(entry.agentId) }),
      ...(entry.off && { off: true as const }),
    }));
  }

  #prune(agentId: string): void {
    this.#sql.exec(
      `DELETE FROM chat_agent_turns WHERE agent_id = ? AND status NOT IN ('queued', 'running') AND id NOT IN (
         SELECT id FROM chat_agent_turns WHERE agent_id = ? ORDER BY id DESC LIMIT ?
       )`,
      agentId,
      agentId,
      KEPT_TURNS,
    );
  }
}
