// When agents run on their own: the schedules and watches of the agents whose home conversation this chat object is,
// and the ways a run starts (its alarm, a watch whose condition holds, Test it, a sign-in that came, a restart). The
// runs themselves are the executor's (executor.ts).

import { canonicalJson } from "../../../shared/canonical.ts";
import type { Value } from "../../../shared/conditions.ts";
import { mayUseServer, type AgentDefinition, type AgentTrigger, type LookStep } from "../../../shared/agents.ts";
import { errorMessage, sha256Hex } from "../../../shared/util.ts";
import { readFor, resultName, RunExecutor, startOf, watchFires, type RunEnd, type RunHost, type RunStart } from "./executor.ts";
import { turnedOff, type RunRecord } from "./store.ts";
import { nextRunAt } from "./schedule.ts";
import { sourceName } from "./source.ts";
import type { Sql } from "../../members.ts";

/** What a run's alarm carries. */
export type RunAlarm = { agentId: string; dueAt: number };
/** What a watch's interval carries. */
export type WatchAlarm = { agentId: string };

/** The longest a watch's last value is kept, as JSON: a larger one is compared by a hash of it. */
const MAX_KEPT_VALUE = 100_000;
/** How long until a due time is tried again, when its run could not start (a failed read, a reset). */
const RETRY_MS = 5 * 60_000;

/** What the runner needs besides the executor's host: alarms, the owner's definitions, and shared watches. */
export interface RunnerHost extends RunHost {
  /** A one-shot alarm (the chat object's Scheduler): its schedule id. */
  alarmAt(at: number, payload: RunAlarm): Promise<string>;
  /** An alarm every `seconds`: its schedule id. */
  alarmEvery(seconds: number, payload: WatchAlarm): Promise<string>;
  cancelAlarm(id: string): Promise<void>;
  /** When a set alarm fires next (ms); null when it is no longer set (its job ran or was cancelled). */
  alarmTime(id: string): Promise<number | null>;
  /**
   * Whether a watch's read can be shared with everyone watching the same call (a server whose results all viewers
   * share, and that does not sign in each user): it then goes through a Source object, which polls once for all.
   */
  sharedWatch(step: LookStep): boolean;
  subscribe(agentId: string, step: LookStep, everyMinutes: number): Promise<void>;
  /** Leave the Source named `source` (sourceName). */
  unsubscribe(agentId: string, source: string): Promise<void>;
  /** Keep the object alive for work that outlives the call that started it. */
}

type ScheduleRow = { agent_id: string; kind: string; key: string; schedule_id: string | null; due_at: number | null };

/** How a trigger is set, as a key: a definition saved with the same trigger keeps its alarm. */
function triggerKey(agent: AgentDefinition): string {
  const trigger = agent.trigger!;
  return trigger.kind === "schedule" ? canonicalJson(trigger) : canonicalJson({ step: trigger.step, everyMinutes: trigger.everyMinutes });
}

const HASHED = "sha256:";

/** A value as it is compared with the last one: its canonical JSON, or a hash of a large one. */
async function fingerprint(value: Value): Promise<string> {
  const json = canonicalJson(value);
  return json.length <= MAX_KEPT_VALUE ? json : `${HASHED}${await sha256Hex(json)}`;
}

/**
 * The schedules and watches of one chat object's agents, in its SQLite (`agent_schedules`, `agent_watch_last`), and
 * the entry points that start runs. A schedule is a one-shot alarm at the next local time (schedule.ts), set again as
 * each run starts; a watch is an alarm on an interval, or a Source shared with everyone watching the same read, and
 * starts a run only when its value moved and its condition holds.
 */
export class AgentRunner {
  readonly executor: RunExecutor;
  readonly #host: RunnerHost;
  readonly #sql: Sql;
  /** Applying a definition and an alarm's run are one at a time per agent: a stale alarm never runs over a new one. */
  #applying: Promise<unknown> = Promise.resolve();

  constructor(host: RunnerHost, sql: Sql) {
    this.#host = host;
    this.#sql = sql;
    this.executor = new RunExecutor(host);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_schedules (
        agent_id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, schedule_id TEXT, due_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_watch_last (agent_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_versions (agent_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
    `);
  }

  #one<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#applying.then(work);
    this.#applying = next.catch(() => {});
    return next;
  }

  #row(agentId: string): ScheduleRow | undefined {
    return this.#sql.exec("SELECT * FROM agent_schedules WHERE agent_id = ?", agentId).toArray()[0] as ScheduleRow | undefined;
  }

  /** When an agent runs next on its schedule; null for none (off, a watch, or no trigger). */
  nextRun(agentId: string): number | null {
    const row = this.#row(agentId);
    return row?.kind === "schedule" ? row.due_at : null;
  }

  /**
   * Set an agent's alarms from its definition as it is now: its schedule's next run, or its watch; none when it is off,
   * has no trigger, or is gone (`agent` null). A definition saved with the same trigger keeps the alarm it had.
   */
  async apply(agentId: string, agent: AgentDefinition | null): Promise<void> {
    let moved = true;
    try {
      moved = await this.#one(() => this.#apply(agentId, agent));
    } finally {
      // Turned on or off, a new time, or gone (or failed halfway): the Runs tab reads its next run again. A run that
      // fires tells it itself.
      if (moved) this.#host.changed(agentId);
    }
  }

  /**
   * Whether to act on `agent` as the definition of `agentId`: not when it is older than one acted on before (two saves,
   * their notices out of order, or a read that came late). Remembers the newest; a deleted agent (null) is forgotten.
   * Everything that acts on a definition (apply, the home chat's agentChanged) asks this first.
   */
  accepts(agentId: string, agent: AgentDefinition | null): boolean {
    if (!agent) {
      this.#sql.exec("DELETE FROM agent_versions WHERE agent_id = ?", agentId);
      return true;
    }
    const known = this.#sql.exec("SELECT version FROM agent_versions WHERE agent_id = ?", agentId).toArray()[0] as { version: number } | undefined;
    if (known && agent.version < known.version) return false;
    if (known?.version !== agent.version) this.#sql.exec("INSERT OR REPLACE INTO agent_versions (agent_id, version) VALUES (?, ?)", agentId, agent.version);
    return true;
  }

  /** Whether the alarms changed. */
  async #apply(agentId: string, agent: AgentDefinition | null, after = this.#host.runs.now()): Promise<boolean> {
    if (!this.accepts(agentId, agent)) return false;
    if (agent && !agent.enabled) this.#skipWaiting(agent);
    const row = this.#row(agentId);
    const wanted = agent?.enabled && agent.trigger ? agent : null;
    const key = wanted ? triggerKey(wanted) : "";
    if (row && wanted && row.kind === wanted.trigger!.kind && row.key === key && (row.kind === "watch" || (row.due_at ?? 0) > after)) return false;
    if (!row && !wanted) return false;
    await this.#set(agentId, row, wanted, key, after);
    return true;
  }

  async #set(agentId: string, row: ScheduleRow | undefined, wanted: AgentDefinition | null, key: string, after: number): Promise<void> {
    if (row) await this.#clear(row);
    if (!wanted) return;
    const trigger = wanted.trigger!;
    if (trigger.kind === "schedule") {
      const dueAt = nextRunAt(trigger, after);
      if (dueAt === null) return;
      const id = await this.#host.alarmAt(dueAt, { agentId, dueAt });
      this.#setRow({ agent_id: agentId, kind: "schedule", key, schedule_id: id, due_at: dueAt });
      return;
    }
    let id: string | null = null;
    if (this.#host.sharedWatch(trigger.step)) await this.#host.subscribe(agentId, trigger.step, trigger.everyMinutes);
    else id = await this.#host.alarmEvery(trigger.everyMinutes * 60, { agentId });
    this.#setRow({ agent_id: agentId, kind: "watch", key, schedule_id: id, due_at: null });
  }

  /**
   * The agent is off: its runs waiting for a sign-in are skipped, as signing in would skip them (signedIn), so none
   * waits on its owner nor goes once it is on again. A test's waits, as it would go off or on.
   */
  #skipWaiting(agent: AgentDefinition): void {
    const waiting = this.#host.runs.unfinished().filter((run) => run.agentId === agent.id && run.status === "needs_sign_in" && !run.test);
    let skipped = 0;
    for (const run of waiting) if (this.#host.runs.skipWaiting(run.agentId, run.dueAt, turnedOff(agent))) skipped++;
    if (skipped) this.#host.changed(agent.id);
  }

  #setRow(row: ScheduleRow): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO agent_schedules (agent_id, kind, key, schedule_id, due_at) VALUES (?, ?, ?, ?, ?)",
      row.agent_id,
      row.kind,
      row.key,
      row.schedule_id,
      row.due_at,
    );
  }

  /**
   * After a restart, for the agent whose home this is: when it has no schedule or watch set, or its row's alarm is no
   * longer set (its job ran or went before the next one was set), read its definition and set them.
   */
  async reconcile(agentId: string): Promise<void> {
    const row = this.#row(agentId);
    // A row whose alarm is still set is fine (a shared watch has none); one whose job went is set again.
    if (row && (row.schedule_id === null || (await this.#host.alarmTime(row.schedule_id)) !== null)) return;
    const agent = await this.#host.definition(agentId);
    await this.apply(agentId, agent);
  }

  /** Take an agent's alarm down, and its watch's last value with it. */
  async #clear(row: ScheduleRow): Promise<void> {
    if (row.schedule_id) await this.#host.cancelAlarm(row.schedule_id).catch((error: unknown) => console.error("agent alarm:", errorMessage(error)));
    if (row.kind === "watch" && !row.schedule_id) {
      const step = (JSON.parse(row.key) as { step: LookStep }).step;
      await this.#host.unsubscribe(row.agent_id, await sourceName(step)).catch((error: unknown) => console.error("agent watch:", errorMessage(error)));
    }
    this.#sql.exec("DELETE FROM agent_schedules WHERE agent_id = ?", row.agent_id);
    this.#sql.exec("DELETE FROM agent_watch_last WHERE agent_id = ?", row.agent_id);
  }

  /**
   * A run's alarm came: the next run is set first (so a run that never ends does not stop the schedule), then this
   * one runs. An alarm for a time the agent no longer runs at (its definition changed since) runs nothing; one that
   * fires twice runs once. Before anything else the same time is armed again a few minutes on (#retry), so a failed
   * read or a reset before the next run is set tries it again; setting the next run replaces that alarm.
   */
  async fired({ agentId, dueAt }: RunAlarm): Promise<RunEnd | null> {
    const reading = this.#host.definition(agentId);
    reading.catch(() => {}); // awaited below, once the retry is armed
    await this.#one(() => this.#retry(agentId, dueAt));
    const agent = await reading;
    const due = await this.#one(async () => {
      const row = this.#row(agentId);
      const current = agent?.enabled && agent.trigger?.kind === "schedule" && row?.kind === "schedule" && row.key === triggerKey(agent);
      if (!current || row.due_at !== dueAt) {
        if (row?.due_at !== dueAt) return false;
        await this.#apply(agentId, agent);
        return false;
      }
      // From the later of the due time and now: an alarm that came late does not set one in the past.
      await this.#apply(agentId, agent, Math.max(dueAt, this.#host.runs.now()));
      return true;
    });
    if (!due || !agent) return null;
    return this.executor.start({ agent, dueAt, why: "schedule" });
  }

  /**
   * The due time `dueAt` came: arm it again RETRY_MS from now, until that would reach the next due time of the trigger
   * the row was set from; then arm that one instead (this time is given up). Only for the row's own due time.
   */
  async #retry(agentId: string, dueAt: number): Promise<void> {
    const row = this.#row(agentId);
    if (row?.kind !== "schedule" || row.due_at !== dueAt) return;
    const now = this.#host.runs.now();
    // Already armed ahead (the same alarm fired twice at once): one retry is enough.
    const armed = row.schedule_id === null ? null : await this.#host.alarmTime(row.schedule_id);
    if (armed !== null && armed > now) return;
    const next = nextRunAt(JSON.parse(row.key) as Extract<AgentTrigger, { kind: "schedule" }>, Math.max(dueAt, now));
    const again = next === null || now + RETRY_MS < next;
    const due = again ? dueAt : next;
    const id = await this.#host.alarmAt(again ? now + RETRY_MS : next, { agentId, dueAt: due });
    this.#sql.exec("UPDATE agent_schedules SET schedule_id = ?, due_at = ? WHERE agent_id = ?", id, due, agentId);
  }

  /** A watch's interval came: read it, and run when its value moved and its condition holds. */
  async watchTick({ agentId }: WatchAlarm): Promise<RunEnd | null> {
    const agent = await this.#host.definition(agentId);
    if (!agent?.enabled || agent.trigger?.kind !== "watch") {
      await this.apply(agentId, agent);
      return null;
    }
    const step = agent.trigger.step;
    return this.moved(agent, await readFor(this.#host, agent, step, step.input));
  }

  /**
   * The Source named `source` says the value the agent watches through it moved. A Source that is not the agent's watch
   * as it is now (its trigger changed, it is off or gone, or the server is no longer one of its own) is left. With
   * `detach`, see moved.
   */
  async sourceMoved(agentId: string, value: Value, source: string, options: { detach?: boolean } = {}): Promise<RunEnd | null> {
    const agent = await this.#host.definition(agentId);
    const step = agent?.enabled && agent.trigger?.kind === "watch" ? agent.trigger.step : null;
    if (!step || !mayUseServer(agent!, step.server) || !this.#host.sharedWatch(step) || (await sourceName(step)) !== source) {
      await this.#host.unsubscribe(agentId, source).catch((error: unknown) => console.error("agent watch:", errorMessage(error)));
      if (!step) await this.apply(agentId, agent);
      // Still a watch it may read: a row set from that Source (no longer shared, or its notice not applied yet) is set
      // again, so the watch goes on through its own interval or its new Source rather than stopping here.
      else if (mayUseServer(agent!, step.server)) await this.#one(() => this.#resubscribe(agentId, agent!, source));
      return null;
    }
    return this.moved(agent!, value, options);
  }

  /** The agent's row says it watches through the Source named `source`, which it left: set its watch again from `agent`. */
  async #resubscribe(agentId: string, agent: AgentDefinition, source: string): Promise<void> {
    const row = this.#row(agentId);
    if (row?.kind !== "watch" || row.schedule_id) return;
    if ((await sourceName((JSON.parse(row.key) as { step: LookStep }).step)) !== source) return;
    this.#sql.exec("DELETE FROM agent_schedules WHERE agent_id = ?", agentId);
    await this.#apply(agentId, agent);
  }

  /**
   * A watch read `value`: a run when it differs from the last one and the condition holds over it (and `previous`).
   * With `detach`, the run goes on in the background and this resolves once its row is stored, so a caller that is told
   * it was handled (a Source) can count on the run; when the row could not be stored, the value is forgotten again and
   * this rejects, so the same value is handled when it comes again.
   */
  async moved(agent: AgentDefinition, value: Value, { detach = false } = {}): Promise<RunEnd | null> {
    if (agent.trigger?.kind !== "watch") return null;
    const now = this.#host.runs.now();
    const print = await fingerprint(value);
    const last = this.#sql.exec("SELECT fingerprint, at FROM agent_watch_last WHERE agent_id = ?", agent.id).toArray()[0] as
      | { fingerprint: string; at: number }
      | undefined;
    if (last?.fingerprint === print) return null;
    this.#sql.exec("INSERT OR REPLACE INTO agent_watch_last (agent_id, fingerprint, at) VALUES (?, ?, ?)", agent.id, print, now);
    // A small value is kept as its JSON, so the condition can compare with it; a large one only as its hash.
    const previous = last && !last.fingerprint.startsWith(HASHED) ? (JSON.parse(last.fingerprint) as Value) : undefined;
    let fires: boolean;
    try {
      fires = watchFires(agent.trigger.when, resultName(agent.trigger.step), value, previous);
    } catch (error) {
      console.error("agent watch:", errorMessage(error));
      return null;
    }
    if (!fires) return null;
    const start: RunStart = { agent, dueAt: now, why: "watch", watch: value, ...(previous !== undefined && { previous }) };
    if (!detach) return this.executor.start(start);
    try {
      // start stores the run's row before it returns, or throws.
      this.#host.waitUntil(this.executor.start(start));
    } catch (error) {
      if (last) this.#sql.exec("UPDATE agent_watch_last SET fingerprint = ?, at = ? WHERE agent_id = ?", last.fingerprint, last.at, agent.id);
      else this.#sql.exec("DELETE FROM agent_watch_last WHERE agent_id = ?", agent.id);
      throw error;
    }
    return null;
  }

  /**
   * A run now, outside the schedule: Test it (`test`: nothing is sent or changed) or one a person asked for. Returns
   * its due time, which names it, at once; the run goes on in the background.
   */
  async now(agentId: string, test: boolean): Promise<{ dueAt: number } | { error: string }> {
    const agent = await this.#host.definition(agentId);
    if (!agent) return { error: "No such agent." };
    if (!test && !agent.enabled) return { error: `@${agent.name} is off: turn it on first.` };
    let dueAt = this.#host.runs.now();
    while (this.#host.runs.get(agentId, dueAt)) dueAt++;
    this.#host.waitUntil(this.executor.start({ agent, dueAt, why: test ? "test" : "manual", test }));
    return { dueAt };
  }

  /**
   * The owner signed in to `server`: of each agent's runs waiting for it, the newest goes again and the older ones are
   * skipped (three mornings of waiting would post three near-same reports). The runs of an agent now off are skipped,
   * a test's apart. Returns how many went again.
   */
  async signedIn(server: string): Promise<number> {
    const waiting = this.#host.runs.unfinished().filter((run) => run.status === "needs_sign_in" && run.detail.needsSignIn?.includes(server));
    // Oldest first: the last one per agent (and per kind, a test apart from the real ones) is its newest.
    const newest = new Map(waiting.map((run) => [`${run.agentId}:${run.test}`, run]));
    // The list was read before the definitions' await: a run another path ended meanwhile (it went, a skip) is left be.
    const skip = (run: RunRecord, why: string) => this.#host.runs.skipWaiting(run.agentId, run.dueAt, `Skipped once you signed in: ${why}.`);
    const agentIds = [...new Set(waiting.map((run) => run.agentId))];
    const definitions = new Map(await Promise.all(agentIds.map(async (id) => [id, await this.#host.definition(id)] as const)));
    let restarted = 0;
    for (const run of newest.values()) {
      const agent = definitions.get(run.agentId);
      if (!agent) continue;
      if (!run.test && !agent.enabled) {
        skip(run, `@${agent.name} was off`);
        continue;
      }
      // A later run went meanwhile (without the server, after its sign-in lapsed): this one would post after it. One
      // still going may yet go: this one waits for it, marked released, and is skipped when it goes, or goes itself when
      // it ends without going (RunExecutor).
      const newer = this.#host.runs.newer(run.agentId, run.dueAt, run.test);
      if (newer === "went") {
        skip(run, "a newer run went since");
        continue;
      }
      if (newer === "going") {
        const released = [...new Set([...(run.detail.released ?? []), server])];
        this.#host.runs.update(run.agentId, run.dueAt, { detail: { released } });
        continue;
      }
      if (!this.#host.runs.restart(run.agentId, run.dueAt)) continue;
      restarted++;
      this.#host.waitUntil(this.executor.start(startOf(agent, run)));
    }
    // The older ones go as their newest did: replaced by it when it went, skipped too when the agent is off, and left
    // waiting when its definition could not be read.
    for (const run of waiting) {
      const agent = definitions.get(run.agentId);
      if (!agent || newest.get(`${run.agentId}:${run.test}`) === run) continue;
      skip(run, !run.test && !agent.enabled ? `@${agent.name} was off` : "a newer run went instead");
    }
    for (const agentId of agentIds) this.#host.changed(agentId);
    return restarted;
  }

  /** After a restart: the runs that were going go on, from where their rows say. Cheap when there are none. */
  resume(): void {
    for (const run of this.#host.runs.unfinished()) {
      if (run.status !== "running" || this.executor.busy(run.agentId)) continue;
      this.#host.waitUntil(
        this.#host.definition(run.agentId).then((agent) => {
          if (!agent) {
            this.#host.runs.update(run.agentId, run.dueAt, { status: "failed", summary: "Failed: the agent was deleted." });
            return null;
          }
          return this.executor.start(startOf(agent, run));
        }),
      );
    }
  }

  /** Take every alarm and watch down: the chat is being deleted. */
  async clearAll(): Promise<void> {
    for (const row of this.#sql.exec("SELECT * FROM agent_schedules").toArray() as ScheduleRow[]) await this.#clear(row);
  }

  /** Whether an agent has runs going or set. */
  hasWork(): boolean {
    return this.#sql.exec("SELECT 1 FROM agent_schedules LIMIT 1").toArray().length > 0 || this.#host.runs.unfinished().length > 0;
  }
}
