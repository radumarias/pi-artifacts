import {
  KEPT_RUNS,
  runEnded,
  type AgentRunView,
  type EndedRunStatus,
  type RunDelivery,
  type RunItemStatus,
  type RunItemView,
  type RunStatus,
  type RunStepRecord,
  type RunWhy,
} from "../../../shared/runs.ts";
import type { Sql } from "../../members.ts";

/** The run itself, among its items: the row its status, deliveries and totals are kept in. */
const RUN = "";

/** An item's row key: the one item of a run with no scope ("") is kept as "*", apart from the run's own row. */
function rowKey(item: string): string {
  return item || "*";
}

type Counts = { total: number; acted: number | null; not_today: number | null; failed: number | null; waiting: number | null; cost: number | null };
const NO_ITEMS: Counts = { total: 0, acted: 0, not_today: 0, failed: 0, waiting: 0, cost: 0 };

type RunRow = {
  agent_id: string;
  due_at: number;
  item: string;
  why: RunWhy;
  status: string;
  test: number;
  label: string | null;
  session: string | null;
  started_at: number;
  ended_at: number | null;
  cost: number;
  summary: string | null;
  detail: string | null;
  reply_session: string | null;
};

/** Why a run of an agent turned off did not go. */
export function turnedOff(agent: { name: string }): string {
  return `Skipped: @${agent.name} was turned off.`;
}

/** What a run's own row keeps besides its status: what it sent, and what it waits for. */
export interface RunDetail {
  deliveries: RunDelivery[];
  needsSignIn?: string[];
  /**
   * The sign-ins it waits for that came while a newer run of the agent was going: it waits for that run instead, and
   * goes when that one ends without going (RunExecutor). A newer run that would wait for one of them checks once more.
   */
  released?: string[];
  when?: string;
  used?: { skills: string[]; servers: string[]; models: string[] };
  /** The watch result that started it, for its steps to read as `watch`, and the one before it (`previous`). */
  watch?: unknown;
  previous?: unknown;
  /** The delivery keys it sent already: a run that goes on after a restart sends each once. */
  sent?: string[];
  /** A page rebuild's session, by its delivery's key, kept before it starts: a run that goes on uses it again. */
  sessions?: Record<string, string>;
  /**
   * What each do step came to, by `<item>:<step key>`, kept as it ends: a run that goes on after a restart makes its
   * calls that change data once.
   */
  acted?: Record<string, ActedStep>;
  /**
   * Its scope's list was read, and its elements kept (`agent_run_elements`, keepElements): a run that goes on (after a
   * restart, or once its owner decided a held call) goes through those, never a list read again hours later.
   */
  listed?: true;
  /** Its agent's workflow and scope as it started (canonical JSON): a run going on after they changed stops instead. */
  shape?: string;
}

/** A do step's outcome, as a run keeps it (RunDetail.acted). */
export interface ActedStep {
  ok: boolean;
  detail: string;
  /** The call's result, when it ran: what later steps read as `done`. */
  value?: unknown;
  /**
   * Where the item ends at this step: `waiting` while it is held for its owner (until they decide, AgentRunner.decided),
   * `stopped` once they declined it or it expired (as at a condition that did not hold).
   */
  end?: "waiting" | "stopped";
  /** It ran, but its result was too large to keep: an item going through again cannot read it (`done` is missing). */
  cut?: true;
}

/** Where a do step's outcome is kept in its run (RunDetail.acted): by item and step. */
export function actedMark(item: string, step: string): string {
  return `${item}:${step}`;
}

/** What an item's row keeps: its steps, its part of the report and why it stopped. */
interface ItemDetail {
  steps: RunStepRecord[];
  text?: string;
  reason?: string;
  /** The keys of the delivery steps (tell, page, hand over) it reached: what its text goes out with. */
  reached?: string[];
  /** For a delivery step it reached before its last work step: its text as it was then (by the step's key). */
  textAt?: Record<string, string>;
  /**
   * What its look steps read, by step key, when small enough to keep: an item that goes through again (after a
   * restart, or once its owner decided a held call) sees the same results and takes the same way to where it stopped.
   */
  looked?: Record<string, unknown>;
  /** How its conditions (if, only if) came out, by step key: going through again, it takes the same way. */
  conditions?: Record<string, boolean>;
}

/** An item of a run as a run going on goes over it again: its element, unless it was too large to keep. */
export interface KeptElement {
  key: string;
  label: string;
  value?: unknown;
  /** Its element was not kept: it cannot go on. */
  missing?: true;
}

/** What an item keeps for going through again the way it went (ItemDetail). */
export type ItemKept = Required<Pick<ItemDetail, "looked" | "conditions">>;

/** A run that ended, as AgentRuns tells its owner's feed. */
export type EndedRun = RunRecord & { status: EndedRunStatus };

/** A run as its own row has it. */
export interface RunRecord {
  agentId: string;
  dueAt: number;
  why: RunWhy;
  status: RunStatus;
  test: boolean;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  detail: RunDetail;
  /** The session replies to its post continue in: a fork of its session, made at the first reply. */
  replySession?: string;
}

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function recordOf(row: RunRow): RunRecord {
  return {
    agentId: row.agent_id,
    dueAt: row.due_at,
    why: row.why,
    status: row.status as RunStatus,
    test: row.test === 1,
    startedAt: row.started_at,
    ...(row.ended_at !== null && { endedAt: row.ended_at }),
    ...(row.summary !== null && { summary: row.summary }),
    detail: parse<RunDetail>(row.detail, { deliveries: [] }),
    ...(row.reply_session !== null && { replySession: row.reply_session }),
  };
}

function itemOf(row: RunRow): RunItemView {
  const detail = parse<ItemDetail>(row.detail, { steps: [] });
  return {
    item: row.item === "*" ? "" : row.item,
    label: row.label ?? row.item,
    status: row.status as RunItemStatus,
    ...(row.session !== null && { session: row.session }),
    steps: detail.steps,
    ...(detail.text !== undefined && { text: detail.text }),
    ...(detail.reason !== undefined && { reason: detail.reason }),
    ...(detail.reached?.length && { reached: detail.reached }),
    ...(detail.textAt && { textAt: detail.textAt }),
    cost: row.cost,
    startedAt: row.started_at,
    ...(row.ended_at !== null && { endedAt: row.ended_at }),
  };
}

/**
 * The runs of the agents whose home conversation this chat object is, in its SQLite: one row per run, with the item
 * "" (its status, what it sent), and one per item of its scope. Rows are keyed by (agent, due time, item), so an
 * alarm that fires twice finds the run it started and stops, and an item is never started twice.
 */
export class AgentRuns {
  readonly #sql: Sql;
  readonly #now: () => number;

  /** Hears each run that ends (or waits for a sign-in), as its row then says; never a test's. */
  readonly #onEnded: ((run: EndedRun) => void) | undefined;
  readonly #onResumed: ((agentId: string, dueAt: number) => void) | undefined;

  /**
   * `onEnded` hears every run end (its owner's feed: worker/users.ts runEnded); `onResumed`, a run that waited for a
   * sign-in going on (what the feed asked of its owner is done then, not at its end).
   */
  constructor(sql: Sql, now: () => number = Date.now, onEnded?: (run: EndedRun) => void, onResumed?: (agentId: string, dueAt: number) => void) {
    this.#sql = sql;
    this.#now = now;
    this.#onEnded = onEnded;
    this.#onResumed = onResumed;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        agent_id TEXT NOT NULL, due_at INTEGER NOT NULL, item TEXT NOT NULL, why TEXT NOT NULL, status TEXT NOT NULL,
        test INTEGER NOT NULL DEFAULT 0, label TEXT, session TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
        cost REAL NOT NULL DEFAULT 0, summary TEXT, detail TEXT, reply_session TEXT,
        PRIMARY KEY (agent_id, due_at, item)
      );
      CREATE INDEX IF NOT EXISTS agent_runs_by_status ON agent_runs (status, item);
      CREATE TABLE IF NOT EXISTS agent_run_elements (
        agent_id TEXT NOT NULL, due_at INTEGER NOT NULL, idx INTEGER NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, value TEXT,
        PRIMARY KEY (agent_id, due_at, idx)
      );
    `);
  }

  now(): number {
    return this.#now();
  }

  #rows(where: string, ...params: (string | number)[]): RunRow[] {
    return this.#sql.exec(`SELECT * FROM agent_runs WHERE ${where}`, ...params).toArray() as RunRow[];
  }

  /**
   * Start a run, or find the one started for the same due time. `started` is false when it was there already: the
   * caller runs it only when it has not ended (a run cut off by a restart goes on, a finished one never repeats).
   */
  begin(agentId: string, dueAt: number, why: RunWhy, test: boolean, detail: Omit<RunDetail, "deliveries"> = {}): { run: RunRecord; started: boolean } {
    const written = this.#sql.exec(
      `INSERT INTO agent_runs (agent_id, due_at, item, why, status, test, started_at, detail) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
       ON CONFLICT (agent_id, due_at, item) DO NOTHING`,
      agentId,
      dueAt,
      RUN,
      why,
      test ? 1 : 0,
      this.#now(),
      JSON.stringify({ deliveries: [], ...detail } satisfies RunDetail),
    ).rowsWritten;
    if (written) this.#prune(agentId);
    return { run: this.get(agentId, dueAt)!, started: written > 0 };
  }

  /**
   * Keep the newest KEPT_RUNS runs of an agent, items included, and any run waiting for its owner to decide a call. A
   * real run still waiting for a sign-in ends as it goes (skipped, as a newer run would skip it): its owner's feed hears
   * of it, so its item waits no more.
   */
  #prune(agentId: string): void {
    const gone = this.#sql
      .exec(
        `DELETE FROM agent_runs WHERE agent_id = ? AND due_at < (
           SELECT MIN(due_at) FROM (SELECT due_at FROM agent_runs WHERE agent_id = ? AND item = '' ORDER BY due_at DESC LIMIT ?)
         ) AND due_at NOT IN (SELECT due_at FROM agent_runs WHERE agent_id = ? AND item = '' AND status = 'waiting') RETURNING *`,
        agentId,
        agentId,
        KEPT_RUNS,
        agentId,
      )
      .toArray() as RunRow[];
    // Kept elements serve only a run that may go on (keptElements): those of runs gone, or ended for good, go too.
    this.#sql.exec(
      `DELETE FROM agent_run_elements WHERE agent_id = ? AND due_at NOT IN (
         SELECT due_at FROM agent_runs WHERE agent_id = ? AND item = '' AND status IN ('running', 'waiting', 'needs_sign_in')
       )`,
      agentId,
      agentId,
    );
    for (const row of gone) {
      if (row.item !== RUN || row.test || row.status !== "needs_sign_in") continue;
      this.#onEnded?.({ ...recordOf(row), status: "not_today", summary: "Skipped: too old to go on." });
    }
  }

  get(agentId: string, dueAt: number): RunRecord | null {
    const row = this.#rows("agent_id = ? AND due_at = ? AND item = ''", agentId, dueAt)[0];
    return row ? recordOf(row) : null;
  }

  /**
   * What became of the runs of the agent (a test, or a real one, as `test` says) after `dueAt`: `went` when one was sent
   * or found nothing to do, `going` when one is still going (it may yet wait for a sign-in too), else null (none, or
   * they failed or wait as well, which replaced nothing).
   */
  newer(agentId: string, dueAt: number, test: boolean): "went" | "going" | null {
    const where = "agent_id = ? AND due_at > ? AND item = '' AND test = ? AND status IN ('sent', 'not_today', 'running')";
    const statuses = new Set(this.#rows(where, agentId, dueAt, test ? 1 : 0).map((row) => row.status));
    return statuses.has("sent") || statuses.has("not_today") ? "went" : statuses.has("running") ? "going" : null;
  }

  /** The agent's runs before `dueAt` still waiting for a sign-in: one at `dueAt` went, so they are skipped. */
  skipReplaced(agentId: string, dueAt: number, test: boolean): void {
    const where = "agent_id = ? AND due_at < ? AND item = '' AND test = ? AND status = 'needs_sign_in'";
    for (const row of this.#rows(where, agentId, dueAt, test ? 1 : 0)) this.skipWaiting(agentId, row.due_at, "Skipped: a newer run went instead.");
  }

  /**
   * End a run that still waits for a sign-in as skipped, saying why. False, and nothing changes, when it no longer waits
   * (it went again, another skip ended it, or it was pruned): a list read before an await may be stale.
   */
  skipWaiting(agentId: string, dueAt: number, summary: string): boolean {
    const waiting = "agent_id = ? AND due_at = ? AND item = '' AND status = 'needs_sign_in'";
    const changed =
      this.#sql.exec(
        `UPDATE agent_runs SET status = 'not_today', ended_at = ?, summary = ? WHERE ${waiting}`,
        this.#now(),
        summary,
        agentId,
        dueAt,
      ).rowsWritten > 0;
    const run = changed ? this.get(agentId, dueAt) : null;
    if (run && !run.test) this.#onEnded?.({ ...run, status: "not_today" });
    return changed;
  }

  /**
   * Mark a waiting run released for `server` (its sign-in came while a newer run went), as its row is now: two sign-ins
   * at once both stay marked, and a run that no longer waits is left be.
   */
  release(agentId: string, dueAt: number, server: string): void {
    const run = this.get(agentId, dueAt);
    if (run?.status !== "needs_sign_in" || run.detail.released?.includes(server)) return;
    this.update(agentId, dueAt, { detail: { released: [...(run.detail.released ?? []), server] } });
  }

  /** The newest of the agent's runs before `dueAt` waiting for a newer one to end (detail.released), if any. */
  deferred(agentId: string, dueAt: number, test: boolean): RunRecord | null {
    const where = "agent_id = ? AND due_at < ? AND item = '' AND test = ? AND status = 'needs_sign_in' ORDER BY due_at DESC";
    return this.#rows(where, agentId, dueAt, test ? 1 : 0).map(recordOf).find((run) => run.detail.released?.length) ?? null;
  }

  /** A run waiting for sign-in goes again: back to running, the servers it waited for forgotten. False when it no longer waits. */
  restart(agentId: string, dueAt: number): boolean {
    const run = this.get(agentId, dueAt);
    if (!run || run.status !== "needs_sign_in") return false;
    const { needsSignIn: _, released: __, ...detail } = run.detail;
    this.#sql.exec(
      "UPDATE agent_runs SET status = 'running', ended_at = NULL, summary = NULL, detail = ? WHERE agent_id = ? AND due_at = ? AND item = ''",
      JSON.stringify(detail),
      agentId,
      dueAt,
    );
    if (!run.test) this.#onResumed?.(agentId, dueAt);
    return true;
  }

  /** Keep what a do step came to, by `<item>:<step key>` (undefined forgets it). */
  setActed(agentId: string, dueAt: number, mark: string, acted: ActedStep | undefined): void {
    const { [mark]: _before, ...rest } = this.get(agentId, dueAt)?.detail.acted ?? {};
    this.update(agentId, dueAt, { detail: { acted: acted ? { ...rest, [mark]: acted } : rest } });
  }

  /**
   * The owner decided a do step an item waited at: the item and its run go back to running, to go on from that step
   * (the step's outcome is in the run's `acted`). False when the item was not waiting, or its run ended meanwhile (a
   * newer run went instead, a later pass failed): nothing would go through it again, so it stays as it was.
   */
  reopen(agentId: string, dueAt: number, item: string): boolean {
    const run = this.get(agentId, dueAt);
    if (!run || !(["waiting", "running", "needs_sign_in"] as RunStatus[]).includes(run.status)) return false;
    const reopened = this.#sql.exec(
      "UPDATE agent_runs SET status = 'running', ended_at = NULL WHERE agent_id = ? AND due_at = ? AND item = ? AND status = 'waiting'",
      agentId,
      dueAt,
      rowKey(item),
    ).rowsWritten;
    if (!reopened) return false;
    this.#sql.exec(
      "UPDATE agent_runs SET status = 'running', ended_at = NULL, summary = NULL WHERE agent_id = ? AND due_at = ? AND item = '' AND status IN ('waiting', 'running')",
      agentId,
      dueAt,
    );
    return true;
  }

  /** Change what a run's row keeps: its status (an end once it is not running), summary, detail. */
  update(agentId: string, dueAt: number, change: { status?: RunStatus; summary?: string; detail?: Partial<RunDetail> }): void {
    const run = this.get(agentId, dueAt);
    if (!run) return;
    const status = change.status ?? run.status;
    // A change of detail only (a waiting run marked released) keeps when it ended.
    const endedAt = status === "running" ? null : change.status ? this.#now() : (run.endedAt ?? this.#now());
    const summary = change.summary ?? run.summary;
    const detail = { ...run.detail, ...change.detail };
    this.#sql.exec(
      "UPDATE agent_runs SET status = ?, ended_at = ?, summary = ?, detail = ? WHERE agent_id = ? AND due_at = ? AND item = ''",
      status,
      endedAt,
      summary ?? null,
      JSON.stringify(detail),
      agentId,
      dueAt,
    );
    // Every way a run ends comes through here: its owner's feed hears of it (worker/users.ts runEnded). One waiting for
    // a held call has not ended: the call's own feed item asks for it. The row as it is now, without reading it again.
    if (change.status && runEnded(status) && !run.test) this.#onEnded?.({ ...run, status, endedAt: endedAt!, ...(summary !== undefined && { summary }), detail });
  }

  /** Start an item of a run in its session, or find it: an item that ended is not run again. */
  async beginItem(
    agentId: string,
    dueAt: number,
    item: string,
    label: string,
    session: () => Promise<string>,
  ): Promise<{ view: RunItemView; started: boolean }> {
    const found = this.item(agentId, dueAt, item);
    if (found && found.session) return { view: found, started: false };
    const id = await session();
    // A second start of the same item while the first made its session finds the first's row.
    this.#sql.exec(
      `INSERT INTO agent_runs (agent_id, due_at, item, why, status, label, session, started_at, detail)
       SELECT ?, ?, ?, why, 'running', ?, ?, ?, ? FROM agent_runs WHERE agent_id = ? AND due_at = ? AND item = ''
       ON CONFLICT (agent_id, due_at, item) DO NOTHING`,
      agentId,
      dueAt,
      rowKey(item),
      label,
      id,
      this.#now(),
      JSON.stringify({ steps: [] } satisfies ItemDetail),
      agentId,
      dueAt,
    );
    return { view: this.item(agentId, dueAt, item)!, started: true };
  }

  /**
   * Keep a run's scope's elements as first listed, in order, each without its value when that is over `maxChars`
   * (going on, its item cannot read it): a run going on goes through these (keptElements), never a list read again.
   */
  keepElements(agentId: string, dueAt: number, elements: readonly KeptElement[], maxChars: number): void {
    elements.forEach((element, idx) => {
      const json = element.missing ? null : JSON.stringify(element.value ?? null);
      this.#sql.exec(
        "INSERT OR REPLACE INTO agent_run_elements (agent_id, due_at, idx, key, label, value) VALUES (?, ?, ?, ?, ?, ?)",
        agentId,
        dueAt,
        idx,
        element.key,
        element.label,
        json !== null && json.length <= maxChars ? json : null,
      );
    });
    this.update(agentId, dueAt, { detail: { listed: true } });
  }

  /** The elements a run kept of its scope's list (keepElements), in order; null when it has not listed it yet. */
  keptElements(agentId: string, dueAt: number): KeptElement[] | null {
    if (!this.get(agentId, dueAt)?.detail.listed) return null;
    const rows = this.#sql
      .exec("SELECT key, label, value FROM agent_run_elements WHERE agent_id = ? AND due_at = ? ORDER BY idx", agentId, dueAt)
      .toArray() as { key: string; label: string; value: string | null }[];
    return rows.map(({ key, label, value }) => ({ key, label, ...(value === null ? { missing: true as const } : { value: JSON.parse(value) as unknown }) }));
  }

  /** An item of a run; "" names the item of a run with no scope. */
  item(agentId: string, dueAt: number, item: string): RunItemView | null {
    const row = this.#rows("agent_id = ? AND due_at = ? AND item = ?", agentId, dueAt, rowKey(item))[0];
    return row ? itemOf(row) : null;
  }

  #itemDetail(agentId: string, dueAt: number, item: string): ItemDetail {
    const row = this.#rows("agent_id = ? AND due_at = ? AND item = ?", agentId, dueAt, rowKey(item))[0];
    return parse<ItemDetail>(row?.detail ?? null, { steps: [] });
  }

  /** What an item's look steps read and how its conditions came out before, by step key (ItemDetail). */
  kept(agentId: string, dueAt: number, item: string): ItemKept {
    const { looked = {}, conditions = {} } = this.#itemDetail(agentId, dueAt, item);
    return { looked, conditions };
  }

  /** Keep what an item's look step read, or how one of its conditions came out. */
  keep<K extends keyof ItemKept>(agentId: string, dueAt: number, item: string, what: K, key: string, value: ItemKept[K][string]): void {
    const detail = this.#itemDetail(agentId, dueAt, item);
    detail[what] = { ...detail[what], [key]: value } as ItemDetail[K];
    this.#sql.exec("UPDATE agent_runs SET detail = ? WHERE agent_id = ? AND due_at = ? AND item = ?", JSON.stringify(detail), agentId, dueAt, rowKey(item));
  }

  /** A run stops where it is: its items that did not end end as not today (`item`: why), and the run as `status`. */
  stop(agentId: string, dueAt: number, end: { item: string; status: EndedRunStatus; summary: string }): void {
    this.stopItems(agentId, dueAt, end.item);
    this.update(agentId, dueAt, { status: end.status, summary: end.summary });
  }

  /** A run's items that did not end (running, or waiting for a decision) end as not today, with why. */
  stopItems(agentId: string, dueAt: number, reason: string): void {
    this.#sql.exec(
      `UPDATE agent_runs SET status = 'not_today', ended_at = ?, detail = json_set(COALESCE(detail, '{"steps":[]}'), '$.reason', ?)
       WHERE agent_id = ? AND due_at = ? AND item != '' AND status IN ('running', 'waiting')`,
      this.#now(),
      reason,
      agentId,
      dueAt,
    );
  }

  /** An item ended: its status, steps, part of the report and cost (what it kept for going through again stays). */
  endItem(agentId: string, dueAt: number, item: string, end: { status: RunItemStatus; cost: number } & ItemDetail): void {
    const { status, cost, ...rest } = end;
    // Undefined ones are left out of the JSON.
    const { looked, conditions } = this.#itemDetail(agentId, dueAt, item);
    const detail: ItemDetail = { ...rest, looked, conditions };
    this.#sql.exec(
      "UPDATE agent_runs SET status = ?, ended_at = ?, cost = ?, detail = ? WHERE agent_id = ? AND due_at = ? AND item = ?",
      status,
      this.#now(),
      cost,
      JSON.stringify(detail),
      agentId,
      dueAt,
      rowKey(item),
    );
  }

  items(agentId: string, dueAt: number): RunItemView[] {
    return this.#rows("agent_id = ? AND due_at = ? AND item != '' ORDER BY started_at, item", agentId, dueAt).map(itemOf);
  }

  /** The counts and cost of runs' items, by due time. */
  #counts(agentId: string, dueAts: readonly number[]): Map<number, Counts> {
    if (!dueAts.length) return new Map();
    const rows = this.#sql
      .exec(
        `SELECT due_at, COUNT(*) AS total, SUM(status = 'acted') AS acted, SUM(status = 'not_today') AS not_today, SUM(status = 'failed') AS failed,
           SUM(status = 'waiting') AS waiting, SUM(cost) AS cost
         FROM agent_runs WHERE agent_id = ? AND due_at IN (${dueAts.map(() => "?").join(", ")}) AND item != '' GROUP BY due_at`,
        agentId,
        ...dueAts,
      )
      .toArray() as (Counts & { due_at: number })[];
    return new Map(rows.map((row) => [row.due_at, row]));
  }

  /** The run as the runs list shows it. */
  view(run: RunRecord, counted?: Counts): AgentRunView {
    const counts = counted ?? this.#counts(run.agentId, [run.dueAt]).get(run.dueAt) ?? NO_ITEMS;
    return {
      agentId: run.agentId,
      dueAt: run.dueAt,
      why: run.why,
      status: run.status,
      ...(run.test && { test: true as const }),
      startedAt: run.startedAt,
      ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
      cost: counts.cost ?? 0,
      items: { total: counts.total, acted: counts.acted ?? 0, notToday: counts.not_today ?? 0, failed: counts.failed ?? 0, waiting: counts.waiting ?? 0 },
      ...(run.summary !== undefined && { summary: run.summary }),
      ...(run.detail.needsSignIn?.length && { needsSignIn: run.detail.needsSignIn }),
    };
  }

  /** An agent's runs, newest first. */
  list(agentId: string, limit = 50): AgentRunView[] {
    const runs = this.#rows("agent_id = ? AND item = '' ORDER BY due_at DESC LIMIT ?", agentId, limit).map(recordOf);
    const counts = this.#counts(agentId, runs.map((run) => run.dueAt));
    return runs.map((run) => this.view(run, counts.get(run.dueAt) ?? NO_ITEMS));
  }

  /** Whether any run waits for its owner to decide a held call. */
  anyWaiting(): boolean {
    return this.#sql.exec("SELECT 1 FROM agent_runs WHERE item = '' AND status = 'waiting' LIMIT 1").toArray().length > 0;
  }

  /** The runs that did not end: cut off by a restart, or waiting for a sign-in. */
  unfinished(): RunRecord[] {
    return this.#rows("item = '' AND status IN ('running', 'needs_sign_in') ORDER BY due_at").map(recordOf);
  }

  /** The session replies to a run's post continue in, once made. */
  setReplySession(agentId: string, dueAt: number, session: string): void {
    this.#sql.exec("UPDATE agent_runs SET reply_session = ? WHERE agent_id = ? AND due_at = ? AND item = '' AND reply_session IS NULL", session, agentId, dueAt);
  }

  /**
   * The agent whose run works in `session`: an item's, a reply's (a fork of an item's) or a delivery's (a page
   * rebuild's, kept in the run's detail). Null for a session no run of this chat's made.
   */
  agentOfSession(session: string): string | null {
    const row = this.#sql
      .exec(
        // Only where a session is kept: its columns, and the delivery sessions of the run's own row (never the rest of its detail).
        `SELECT agent_id FROM agent_runs WHERE session = ? OR reply_session = ?
           OR (item = '' AND instr(detail, ?) > 0 AND json_valid(detail) AND EXISTS (SELECT 1 FROM json_each(detail, '$.sessions') WHERE value = ?)) LIMIT 1`,
        session,
        session,
        JSON.stringify(session),
        session,
      )
      .toArray()[0];
    return row ? (row.agent_id as string) : null;
  }

  /** Forget an agent's runs (it was deleted). */
  forget(agentId: string): void {
    this.#sql.exec("DELETE FROM agent_runs WHERE agent_id = ?", agentId);
    this.#sql.exec("DELETE FROM agent_run_elements WHERE agent_id = ?", agentId);
  }
}
