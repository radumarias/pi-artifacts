// The actions of one chat that wait, or waited, for its owner: proposals and approvals, each with the exact call it
// runs when approved. They live in the chat object that made the call, which holds the hub that runs it (and its
// owner's sign-ins); the owner's directory keeps an index of the pending ones, and their feed has them in "Needs you".

import type { AutonomyLevel, StepInput } from "../../../shared/agents.ts";
import type { ActionActor, ActionKind, ActionStatus, PendingActionView } from "../../../shared/limits.ts";
import type { RunRef } from "../../../shared/runs.ts";
import { randomHex } from "../../../shared/util.ts";
import type { Sql } from "../../members.ts";

/**
 * Where an action came from, so its outcome goes back there: the pi session whose tool call it was (told by a passive
 * write), or the run and step that made it. `level`: the level of the caller, kept so nothing it leads to goes above it.
 */
export interface ActionOrigin {
  session?: string;
  run?: RunRef & { agentId: string; item: string; step: string };
  level: AutonomyLevel;
}

/** A new action, as the gate holds a call. */
export interface NewAction {
  kind: ActionKind;
  actor: ActionActor;
  server: string;
  tool: string;
  input: StepInput;
  why: string;
  warnings?: string[];
  expiresAt: number;
  origin: ActionOrigin;
}

type ActionRow = {
  id: string;
  kind: ActionKind;
  status: ActionStatus;
  actor: string;
  server: string;
  tool: string;
  input: string;
  why: string;
  warnings: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  result: string | null;
  origin: string;
  alarm: string | null;
  runner: string | null;
};

/** How many ended actions a chat keeps for its cards; older ones go (their cards then say only how they were made). */
const KEPT_ENDED = 200;
/** How much of a result an action keeps. */
const RESULT_CHARS = 2_000;

export class ChatActions {
  readonly #sql: Sql;
  readonly #chatId: () => string;
  readonly #now: () => number;
  /** This instance's mark on the actions it runs: one running under another's was cut off by a restart. */
  readonly #runner = randomHex(8);

  /** `chatId`: read when a view is made (an object woken by its alarm knows its name only once it is asked). */
  constructor(sql: Sql, chatId: () => string, now: () => number = Date.now) {
    this.#sql = sql;
    this.#chatId = chatId;
    this.#now = now;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_actions (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL,
        input TEXT NOT NULL, why TEXT NOT NULL, warnings TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        decided_at INTEGER, result TEXT, origin TEXT NOT NULL, alarm TEXT, runner TEXT
      );
      CREATE INDEX IF NOT EXISTS pending_actions_status ON pending_actions (status, expires_at);
    `);
  }

  #view(row: ActionRow): PendingActionView {
    const origin = JSON.parse(row.origin) as ActionOrigin;
    return {
      id: row.id,
      chatId: this.#chatId(),
      kind: row.kind,
      actor: JSON.parse(row.actor) as ActionActor,
      server: row.server,
      tool: row.tool,
      input: JSON.parse(row.input) as StepInput,
      why: row.why,
      ...(row.warnings && { warnings: JSON.parse(row.warnings) as string[] }),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status,
      ...(row.decided_at !== null && { decidedAt: row.decided_at }),
      ...(row.result !== null && { result: row.result }),
      ...(origin.run && { run: { dueAt: origin.run.dueAt, why: origin.run.why, ...(origin.run.test && { test: true as const }) } }),
    };
  }

  #row(id: string): ActionRow | undefined {
    return this.#sql.exec("SELECT * FROM pending_actions WHERE id = ?", id).toArray()[0] as ActionRow | undefined;
  }

  add(action: NewAction): PendingActionView {
    const id = randomHex(8);
    this.#sql.exec(
      "INSERT INTO pending_actions (id, kind, status, actor, server, tool, input, why, warnings, created_at, expires_at, origin) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      action.kind,
      JSON.stringify(action.actor),
      action.server,
      action.tool,
      JSON.stringify(action.input),
      action.why,
      action.warnings?.length ? JSON.stringify(action.warnings) : null,
      this.#now(),
      action.expiresAt,
      JSON.stringify(action.origin),
    );
    this.#prune();
    return this.get(id)!;
  }

  get(id: string): PendingActionView | null {
    const row = this.#row(id);
    return row ? this.#view(row) : null;
  }

  origin(id: string): ActionOrigin | null {
    const row = this.#row(id);
    return row ? (JSON.parse(row.origin) as ActionOrigin) : null;
  }

  /**
   * Every action kept (the waiting and running ones, and the KEPT_ENDED newest that ended), newest first: what the
   * chat's cards show. All of them, so no card of one that ended falls back to how it was made (waiting, with buttons).
   */
  list(): PendingActionView[] {
    return (this.#sql.exec("SELECT * FROM pending_actions ORDER BY created_at DESC").toArray() as ActionRow[]).map((row) => this.#view(row));
  }

  setAlarm(id: string, alarm: string): void {
    this.#sql.exec("UPDATE pending_actions SET alarm = ? WHERE id = ?", alarm, id);
  }

  alarmOf(id: string): string | null {
    return this.#row(id)?.alarm ?? null;
  }

  /**
   * Move an action from `from` to `to`, only when it is in `from` (so two presses, or a press and its expiry, end it
   * once): the action as it is after, or null when it was not in `from`. One moved to running is this instance's.
   */
  move(id: string, from: ActionStatus, to: ActionStatus, result?: string): PendingActionView | null {
    const decided = from === "pending" ? this.#now() : null;
    const changed = this.#sql.exec(
      "UPDATE pending_actions SET status = ?, decided_at = COALESCE(?, decided_at), result = COALESCE(?, result), runner = COALESCE(?, runner) WHERE id = ? AND status = ?",
      to,
      decided,
      result === undefined ? null : result.slice(0, RESULT_CHARS),
      to === "running" ? this.#runner : null,
      id,
      from,
    ).rowsWritten;
    return changed ? this.get(id) : null;
  }

  /** Running under an instance that stopped: what restarts find. Never run again (the call may have reached the server). */
  interrupted(): PendingActionView[] {
    return (this.#sql.exec("SELECT * FROM pending_actions WHERE status = 'running' AND runner IS NOT ?", this.#runner).toArray() as ActionRow[]).map(
      (row) => this.#view(row),
    );
  }

  #prune(): void {
    this.#sql.exec(
      `DELETE FROM pending_actions WHERE status NOT IN ('pending', 'running') AND id NOT IN (
         SELECT id FROM pending_actions WHERE status NOT IN ('pending', 'running') ORDER BY created_at DESC LIMIT ?
       )`,
      KEPT_ENDED,
    );
  }
}
