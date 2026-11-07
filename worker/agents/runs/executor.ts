// The run executor: an agent's workflow, step by step, for one due time. Every step runs in code but `work`, which is
// the only one that calls the model. Each item of the run (an element of its scope's list, or the run itself) gets a
// fresh pi session: the results of its reads go in as passive writes, so its work steps and a reply to its report see
// them. Deliveries (tell, page, hand over) wait until every item is done and go out once, each with the parts of the
// items that reached it. A test run records them instead.

import {
  workflowOf,
  mayUseServer,
  runServers,
  serversNamed,
  stepKey,
  walkSteps,
  type AgentDefinition,
  type AgentStep,
  type LookStep,
  type StepInput,
  type StepValue,
} from "../../../shared/agents.ts";
import { canonicalJson } from "../../../shared/canonical.ts";
import { ConditionError, evaluate, holds, type Value } from "../../../shared/conditions.ts";
import { excerpt, firstLine } from "../../../shared/replies.ts";
import {
  MAX_RUN_ITEMS,
  RUN_CONCURRENCY,
  STEP_LABELS,
  stepSummary,
  type RunDelivery,
  type RunItemStatus,
  type RunItemView,
  type RunStatus,
  type RunStepRecord,
  type RunWhy,
} from "../../../shared/runs.ts";
import type { PendingActionView } from "../../../shared/limits.ts";
import { clip, errorMessage, mapLimit, plural } from "../../../shared/util.ts";
import { describeSchedule } from "./schedule.ts";
import { actedMark, turnedOff, type ActedStep, type AgentRuns, type ItemKept, type KeptElement, type RunRecord } from "./store.ts";

/** How much of a read's result goes into the run's session (the rest is cut, with a note); a do result is kept up to it. */
const MAX_RESULT_CHARS = 12_000;
/** The largest look result an item keeps for going through again (its scope's list may be four times that). */
const MAX_KEPT_CHARS = 64_000;
/** How much of a result a step's trace row shows. */
const DETAIL_CHARS = 160;

/** A read that needs its owner to sign in again: the run waits, with no model call. */
export class SignInNeeded extends Error {
  constructor(readonly server: string) {
    super(`Sign in to ${server} again.`);
  }
}

/** What a work step's run came to. */
export interface WorkResult {
  status: "done" | "unanswered";
  text?: string;
  reason?: string;
  /** In dollars. */
  cost: number;
  model?: string;
}

/** A delivery a run makes once its items are done: what, where, and the text. */
export type DeliveryRequest = {
  /** The workflow step it comes from. */
  step: Extract<AgentStep, { kind: "tell" | "page" | "handOver" }>;
  /** Unique within the run: a delivery placed again after a restart is placed once. */
  key: string;
  /** The report: each item's part. */
  text: string;
  agent: AgentDefinition;
  run: Pick<RunRecord, "agentId" | "dueAt" | "why" | "test">;
  /** A page rebuild's session: the same one again when the run goes on after a restart, so its turn is placed once. */
  session?: string;
};

/** What a call that changes data came to: it ran (its result's payload), was held for the owner, or was refused. */
export type ActResult = { status: "ran"; value: Value } | { status: "held" | "refused"; message: string };

/** Where in a run a call is made: the write gate reads the agent's level and rules from it. */
export interface ActContext {
  agentId: string;
  dueAt: number;
  item: string;
  /** The step's key. */
  step: string;
}

/** What the executor needs from the chat object it runs in. Tests pass fakes. */
export interface RunHost {
  readonly runs: AgentRuns;
  /**
   * A read-only call through the hub, as the agent's owner: the result's payload. Throws SignInNeeded for a sign-in.
   * `agentId`: whose share of the hub's read cache it is kept in.
   */
  read(server: string, tool: string, input: StepInput, agentId?: string): Promise<Value>;
  /**
   * A call that changes data, as this run's: through the write gate, at the agent's level and within its rules (run,
   * held for the owner, or refused). Throws SignInNeeded for a sign-in.
   */
  act(call: { server: string; tool: string; input: StepInput }, context: ActContext): Promise<ActResult>;
  /**
   * The servers that sign in each user (`auth: "oauth"`) its owner has a sign-in record for (signed in now, or lapsed):
   * a work step's tools may come from them, so a run checks them too. One they never signed in to (or Disconnected) is
   * no reason to wait.
   */
  signInServers(): Promise<readonly string[]>;
  /** Which of these servers need their owner to sign in again before a run can read them. */
  needsSignIn(servers: readonly string[]): Promise<string[]>;
  /**
   * `agent`'s run waits for the owner to sign in to these servers again: this chat hears when they do, and they are
   * told (a notice, a push) unless `quiet` (a test run).
   */
  signInNeeded(agent: AgentDefinition, servers: readonly string[], quiet: boolean): void;
  /** The owner's definition of an agent as it is now; null when it is gone. */
  definition(agentId: string): Promise<AgentDefinition | null>;
  /** Keep the object alive until `promise` settles: work that goes on after the call that started it. */
  waitUntil(promise: Promise<unknown>): void;
  /** A fresh pi session for one item. */
  newSession(): Promise<string>;
  /**
   * Set an item's session up for its work steps: the agent's model (or `model`), instructions and read tools. `dueAt`
   * names the run, which the session's model calls are tagged with.
   */
  configure(session: string, agent: AgentDefinition, model?: string, dueAt?: number): Promise<void>;
  /** A passive write into a session: context, no model call. Placed once per `requestId`. */
  write(session: string, text: string, requestId: string): Promise<void>;
  /** A work step's prompt into its session, waited for. Placed once per `operationId`. */
  work(session: string, prompt: string, operationId: string): Promise<WorkResult>;
  /** Deliver a report: post it, notify, publish a page version, hand it over. Placed once per key. */
  deliver(request: DeliveryRequest): Promise<RunDelivery>;
  /** The run's list changed, or a run started or ended: tell the people looking. */
  changed(agentId: string): void;
  /**
   * Why a run may not spend today (its owner's daily spend cap is reached), its owner told once a day; undefined when it
   * may. Not asked for a test, which its owner started by hand.
   */
  spendCap?(): Promise<string | undefined>;
  /** A run went through its items and ended (not one stopped before, by the cap or a sign-in): for the metrics. */
  ended?(run: { agentId: string; dueAt: number; status: RunStatus; items: number; wallMs: number }): void;
}

/** A run to start. */
export interface RunStart {
  agent: AgentDefinition;
  dueAt: number;
  why: RunWhy;
  test?: boolean;
  /** The result of the watch that started it: its steps read it as `watch`, and as the watch step's name. */
  watch?: Value;
  /** The watch's result before that one, when it was kept: its steps read it as `previous`. */
  previous?: Value;
}

/** How a run that waited starts again: as it began, its watch's values kept. */
export function startOf(agent: AgentDefinition, run: RunRecord): RunStart {
  const { watch, previous } = run.detail as { watch?: Value; previous?: Value };
  return { agent, dueAt: run.dueAt, why: run.why, test: run.test, watch, previous };
}

/** The name a look step's result goes by: its `as`, else its tool's name as a name. */
export function resultName(step: LookStep): string {
  return step.as ?? (step.tool.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1") || "result");
}

/** What a run going on must find unchanged: its agent's workflow and scope. */
function shapeOf(agent: AgentDefinition): string {
  return canonicalJson({ workflow: workflowOf(agent), scope: agent.scope ?? null });
}

/** The skills a workflow's work steps name. */
function skillsNamed(steps: readonly AgentStep[]): string[] {
  return [...walkSteps(steps)].flatMap(({ step }) => (step.kind === "work" && step.skill ? [step.skill] : []));
}

/** A value as JSON (a string as itself). */
export function jsonOf(value: unknown): string {
  try {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  } catch {
    return String(value);
  }
}

/** `input` with each `{{expression}}` in its text replaced by its value over `scope`; a whole `{{…}}` keeps its type. */
export function fillInput(input: StepInput, scope: Readonly<Record<string, Value>>): StepInput {
  const fill = (value: StepValue): StepValue => {
    if (typeof value === "string") {
      const whole = /^\{\{([^{}]+)\}\}$/.exec(value.trim());
      if (whole) return evaluate(whole[1], scope) as StepValue;
      return value.replace(/\{\{([^{}]+)\}\}/g, (_, expression: string) => {
        const filled = evaluate(expression, scope);
        return typeof filled === "string" ? filled : JSON.stringify(filled);
      });
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item as StepValue)]));
    return value;
  };
  return fill(input) as StepInput;
}

/** The elements a scope's list returned: the result itself when it is a list, else its first list field. */
export function itemsOf(result: Value): Value[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    for (const key of ["items", "results", "data", "rows", "list", "records"]) if (Array.isArray(result[key])) return result[key];
    const list = Object.values(result).find(Array.isArray);
    if (list) return list;
  }
  return [];
}

/** An element's key in its run, and what people call it. */
export function itemKey(element: Value, index: number): { key: string; label: string } {
  const field = (names: readonly string[]) => {
    if (!element || typeof element !== "object" || Array.isArray(element)) return undefined;
    for (const name of names) {
      const value = element[name];
      if ((typeof value === "string" && value) || typeof value === "number") return String(value);
    }
    return undefined;
  };
  if (typeof element === "string" || typeof element === "number") return { key: String(element).slice(0, 80), label: String(element).slice(0, 80) };
  const key = (field(["id", "key", "slug", "code", "name"]) ?? `#${index + 1}`).slice(0, 80);
  return { key, label: (field(["name", "title", "label", "key", "id"]) ?? key).slice(0, 80) };
}

/**
 * A read of the agent's: refused for a server outside its `servers` when it has that list, as its work steps' tools are
 * (runTools). A definition naming one is refused on save too (checkAgent); this holds for one saved before that.
 */
export async function readFor(host: Pick<RunHost, "read">, agent: AgentDefinition, step: Pick<LookStep, "server" | "tool">, input: StepInput): Promise<Value> {
  if (!mayUseServer(agent, step.server)) throw new Error(`${step.server} is not one of the servers @${agent.name} may use.`);
  return host.read(step.server, step.tool, input, agent.id);
}

/** What a work step's prompt says around the step's own words. */
function workPrompt(step: Extract<AgentStep, { kind: "work" }>, when: string, item?: { label: string; value: Value }): string {
  return [
    `Your schedule started this run (${when}).${item ? ` This run is for ${item.label}: ${excerpt(jsonOf(item.value), 2_000)}` : ""}`,
    "The results of the run's reads are above. Do this step:",
    step.prompt,
    ...(step.skill ? [`Use the skill "${step.skill}" for it (activate_skill).`] : []),
    "Answer with the report itself, briefly: it is sent as you write it. If there is nothing worth reporting, say so in one line.",
  ].join("\n\n");
}

/**
 * A value an item going through again cannot read: a do step's result too large to keep. A condition or an input
 * reading it stops the item with this, rather than read nothing (null) where the first time read the result.
 */
class MissingValue extends ConditionError {}

/** `name` in `scope` as missing (MissingValue when read) until a later step sets it. */
function setMissing(scope: Record<string, Value>, name: string, why: string): void {
  Object.defineProperty(scope, name, {
    configurable: true,
    enumerable: true,
    get: () => {
      throw new MissingValue(why);
    },
    set: (value: Value) => {
      Object.defineProperty(scope, name, { value, writable: true, enumerable: true, configurable: true });
    },
  });
}

/** Where an item stopped before its last step, and why. */
type ItemStop = { status: "not_today" | "waiting"; reason: string };

/** One item's way through the steps. */
interface ItemRun {
  agent: AgentDefinition;
  run: RunRecord;
  item: string;
  session: string;
  scope: Record<string, Value>;
  steps: RunStepRecord[];
  /** The delivery steps it reached, by key. */
  reached: string[];
  texts: string[];
  /** The item's text as it was at each delivery step it reached, while later work steps add to it. */
  textAt: Record<string, string>;
  /**
   * What it kept the times it went through before (its look steps' results, read again only when not kept, and how its
   * conditions came out), by step key: it takes the same way again.
   */
  kept: ItemKept;
  cost: number;
  configured?: string;
  when: string;
  element?: { label: string; value: Value };
}

/** The result of a run, as `start` ends it. */
export interface RunEnd {
  status: RunStatus;
  /** False when the run was there already (a second alarm for the same time). */
  started: boolean;
}

/**
 * Runs agents' workflows (see the file's head). One run per agent and due time, however often it is started: the run's
 * row says whether it ended, and a run cut off by a restart goes on where its rows say, sending what it had not sent.
 */
export class RunExecutor {
  readonly #host: RunHost;
  /** Runs going in this object now, by agent and due time. */
  readonly #active = new Map<string, Promise<RunEnd>>();

  constructor(host: RunHost) {
    this.#host = host;
  }

  /** Whether a run of the agent is going now. */
  busy(agentId: string): boolean {
    return [...this.#active.keys()].some((key) => key.startsWith(`${agentId}:`));
  }

  /** Run an agent's workflow for one due time; a second start for the same time ends at once. */
  start(start: RunStart): Promise<RunEnd> {
    const key = `${start.agent.id}:${start.dueAt}`;
    const going = this.#active.get(key);
    if (going) return going.then((end) => ({ ...end, started: false }));
    // The run's row is stored before start returns, or start throws: a caller told only that much (a Source) can count on it.
    const { agent, dueAt, why, test = false, watch, previous } = start;
    const begun = this.#host.runs.begin(agent.id, dueAt, why, test, {
      when: whenOf(agent),
      ...(watch !== undefined && { watch }),
      ...(previous !== undefined && { previous }),
      used: { skills: skillsNamed(workflowOf(agent)), servers: serversNamed(agent, { reads: true }), models: [] },
      shape: shapeOf(agent),
    });
    const run = this.#run(agent, begun)
      .finally(() => this.#active.delete(key))
      .then((end) => {
        // Ended without going: an older run that waited for this one (its sign-in came meanwhile) goes now, on its own.
        // A run that went on from its row (resumed after a restart, or restarted after a sign-in) counts too.
        const went = end.status !== "failed" && end.status !== "needs_sign_in";
        // A failed wake leaves the older run to resume() or a sign-in: this run's end stands.
        if (!went) {
          try {
            this.#wakeDeferred(agent.id, dueAt, test);
          } catch (error) {
            console.error("runs: waking a run that waited failed:", errorMessage(error));
          }
        }
        return end;
      });
    this.#active.set(key, run);
    return run;
  }

  async #run(agent: AgentDefinition, { run, started }: { run: RunRecord; started: boolean }): Promise<RunEnd> {
    const runs = this.#host.runs;
    const { dueAt } = run;
    const when = whenOf(agent);
    // Ended, or waiting for a sign-in that has not come: an alarm that fires twice sends once.
    if (!started && run.status !== "running") return { status: run.status, started: false };
    this.#host.changed(agent.id);
    const startedAt = Date.now();
    try {
      // Here, not before the start, so it waits for a pass of the run still going (start).
      const stopped = started ? null : this.#stopIfChanged(agent, run);
      if (stopped) return { status: stopped, started };
      const [capped, needed] = await Promise.all([
        run.test ? undefined : this.#host.spendCap?.(),
        this.#host.signInServers().then((signedIn) => this.#host.needsSignIn(runServers(agent, signedIn))),
      ]);
      if (capped) {
        // A run going on (a held call decided, a sign-in come) has items open: they end with it, not left running.
        runs.stop(agent.id, dueAt, { item: capped, status: "failed", summary: capped });
        return { status: "failed", started };
      }
      let missing = needed;
      // Read before the check for a late sign-in below, so no await comes between that and the wait.
      const off = missing.length ? await this.#turnedOffNow(agent, run) : null;
      if (off) return off;
      // A sign-in that came while this checked (an older run waits for this one, released): checked once more, not asked.
      const released = missing.length ? (runs.deferred(agent.id, dueAt, run.test)?.detail.released ?? []) : [];
      const again = missing.filter((server) => released.includes(server));
      if (again.length) {
        const still = new Set(await this.#host.needsSignIn(again));
        missing = missing.filter((server) => !again.includes(server) || still.has(server));
        // Turned off during that check: asked again, as before it.
        const off = missing.length ? await this.#turnedOffNow(agent, run) : null;
        if (off) return off;
      }
      if (missing.length) return this.#waitForSignIn(agent, run, missing);
      const elements = await this.#elements(agent, run);
      let outcomes: RunItemView[];
      // An item decided while the others ran is running again: it goes through again before the run ends. The read
      // and the update after it have no await between them, so a decision is never lost between them.
      let pass = 0;
      let current = agent;
      do {
        // An item decided during the pass before goes through with the agent as it is now: not once it was turned
        // off or its workflow changed meanwhile.
        if (pass++ > 0) {
          const now = await this.#host.definition(agent.id).catch(() => current);
          const changed = this.#stopIfChanged(now ?? { ...current, enabled: false }, run);
          if (changed) return { status: changed, started };
          if (now) current = now;
        }
        await mapLimit(elements, RUN_CONCURRENCY, (element) => this.#item(current, run, element, when));
        outcomes = this.#outcomes(agent.id, dueAt, elements);
      } while (outcomes.some((item) => item.status === "running"));
      const held = outcomes.filter((item) => item.status === "waiting");
      if (held.length) {
        const which = held.length > 1 ? ` for ${plural(held.length, "item")}` : held[0].label ? ` for ${held[0].label}` : "";
        runs.update(agent.id, dueAt, { status: "waiting", summary: `Waiting for you to approve a call${which}.` });
        return { status: "waiting", started };
      }
      const status = await this.#finish(current, runs.get(agent.id, dueAt)!, outcomes);
      this.#host.ended?.({ agentId: agent.id, dueAt, status, items: outcomes.length, wallMs: Date.now() - startedAt });
      return { status, started };
    } catch (error) {
      if (error instanceof SignInNeeded) return (await this.#turnedOffNow(agent, run)) ?? this.#waitForSignIn(agent, run, [error.server]);
      runs.update(agent.id, dueAt, { status: "failed", summary: `Failed: ${errorMessage(error)}` });
      return { status: "failed", started };
    } finally {
      this.#host.changed(agent.id);
    }
  }

  /** The run's items as their rows have them, in the order of its elements: one read. */
  #outcomes(agentId: string, dueAt: number, elements: readonly { key: string }[]): RunItemView[] {
    const rows = new Map(this.#host.runs.items(agentId, dueAt).map((item) => [item.item, item]));
    return elements.map((element) => rows.get(element.key)!);
  }

  /**
   * A run going on whose agent (as `agent` is now) changed while it waited, or since a restart cut it off: going on
   * would run steps it never had and send through deliveries it never had, so it stops. Or one turned off since (a
   * test's apart): a call its owner approved ran all the same; nothing after it does. Null when it goes on.
   */
  #stopIfChanged(agent: AgentDefinition, run: RunRecord): RunStatus | null {
    if (run.detail.shape !== undefined && run.detail.shape !== shapeOf(agent)) {
      const why = `@${agent.name}'s workflow changed while this run waited, so it did nothing more and sent nothing`;
      return this.#stop(agent, run, "Its workflow changed while it waited: it stopped there.", why, "failed");
    }
    if (!run.test && !agent.enabled) {
      const why = `@${agent.name} was turned off, so it did nothing more and sent nothing`;
      return this.#stop(agent, run, `@${agent.name} was turned off: it stopped there.`, why, "not_today");
    }
    return null;
  }

  /**
   * A run that goes on no more (its agent changed or was turned off while it waited): its open items stop, nothing more
   * is sent, and it says why, ending as `otherwise`, or as sent when a restart cut it off while it sent (what went out went).
   */
  #stop(agent: AgentDefinition, run: RunRecord, item: string, why: string, otherwise: "failed" | "not_today"): RunStatus {
    const sent = run.detail.deliveries.some((delivery) => delivery.status === "sent");
    const status = sent ? "sent" : otherwise;
    this.#host.runs.stop(agent.id, run.dueAt, { item, status, summary: sent ? `Stopped part way: ${why} more.` : `Stopped: ${why}.` });
    return status;
  }

  /**
   * The run at `dueAt` ended without going: the newest older run released for it (its sign-in came while this one went)
   * goes now. Its row is running again before any await, so a reset meanwhile leaves it to resume(), not waiting with
   * nothing to wake it. It does not go when it is replaced: by a newer run that went, or by this one, which waits itself
   * (only the newest goes); a newer one still going wakes it in turn.
   */
  #wakeDeferred(agentId: string, dueAt: number, test: boolean): void {
    const runs = this.#host.runs;
    const deferred = runs.deferred(agentId, dueAt, test);
    if (!deferred) return;
    const newer = runs.newer(agentId, deferred.dueAt, test);
    if (newer === "going") return;
    const waits = runs.get(agentId, dueAt)?.status === "needs_sign_in";
    if (newer === "went" || waits) {
      runs.skipWaiting(agentId, deferred.dueAt, `Skipped: a newer run ${newer === "went" ? "went" : "waits"} instead.`);
      this.#host.changed(agentId);
      return;
    }
    if (!runs.restart(agentId, deferred.dueAt)) return;
    this.#host.changed(agentId);
    this.#host.waitUntil(
      (async () => {
        const agent = await this.#host.definition(agentId);
        if (!agent || (!test && !agent.enabled)) {
          const summary = agent ? turnedOff(agent) : "Failed: the agent was deleted.";
          runs.update(agentId, deferred.dueAt, { status: agent ? "not_today" : "failed", summary });
          return;
        }
        await this.start(startOf(agent, { ...deferred, status: "running" }));
      })().catch((error: unknown) => console.error("runs: starting a run that waited failed (resume() goes on with it):", errorMessage(error))),
    );
  }

  /**
   * A run about to wait for a sign-in whose agent was turned off (or deleted) while it went: its waiting runs were
   * skipped then, before this one waited, so it ends skipped and does not wait, nor ask. Null when it may wait (a test).
   */
  async #turnedOffNow(agent: AgentDefinition, run: RunRecord): Promise<RunEnd | null> {
    if (run.test) return null;
    const now = await this.#host.definition(agent.id).catch(() => agent);
    if (now?.enabled) return null;
    this.#host.runs.update(run.agentId, run.dueAt, { status: "not_today", summary: now ? turnedOff(agent) : `Skipped: @${agent.name} was deleted.` });
    return { status: "not_today", started: true };
  }

  #waitForSignIn(agent: AgentDefinition, run: RunRecord, servers: string[]): RunEnd {
    // This chat hears when the owner signs in (AgentRunner.signedIn); they are asked to (a notice, a push), unless a test.
    this.#host.signInNeeded(agent, servers, run.test);
    this.#host.runs.update(run.agentId, run.dueAt, {
      status: "needs_sign_in",
      summary: `Waiting for you to sign in to ${servers.join(", ")}.`,
      detail: { needsSignIn: servers },
    });
    return { status: "needs_sign_in", started: true };
  }

  /**
   * The run's items: each element of its scope's list (read once, and kept: an element too large to keep is `missing`
   * going on), or the run itself.
   */
  async #elements(agent: AgentDefinition, run: RunRecord): Promise<KeptElement[]> {
    if (!agent.scope) return [{ key: "", label: "" }];
    // A run that goes on goes through the elements it kept: never a list read again (hours later), whose rows may have
    // moved, gone or come since (index keys would match other rows).
    const kept = this.#host.runs.keptElements(agent.id, run.dueAt);
    if (kept) return kept;
    const list = agent.scope.list;
    const result = await readFor(this.#host, agent, list, list.input);
    const seen = new Set<string>();
    const elements = itemsOf(result)
      .slice(0, MAX_RUN_ITEMS)
      .map((value, index) => {
        let { key, label } = itemKey(value, index);
        while (seen.has(key)) key = `${key}~`;
        seen.add(key);
        return { key, label, value };
      });
    this.#host.runs.keepElements(agent.id, run.dueAt, elements, MAX_KEPT_CHARS);
    return elements;
  }

  /** One item through the workflow, in a session of its own; an item that ended already is read back as it was. */
  async #item(agent: AgentDefinition, run: RunRecord, element: KeptElement, when: string): Promise<void> {
    const runs = this.#host.runs;
    const { view, started } = await runs.beginItem(agent.id, run.dueAt, element.key, element.label, () => this.#host.newSession());
    if (!started && view.status !== "running") return;
    if (element.missing) {
      // Its element was too large to keep: going on (after a decision, or a restart), it cannot read it, so it stops
      // (as at a do result too large).
      const reason = "Its element of the list was too large to keep, so the run going on again could not read it: stopped here.";
      runs.endItem(agent.id, run.dueAt, element.key, { status: "failed", steps: view.steps, reason, cost: 0 });
      this.#host.changed(agent.id);
      return;
    }
    const watched = run.detail.watch as Value | undefined;
    const trigger = agent.trigger?.kind === "watch" ? agent.trigger : undefined;
    const scope = trigger && watched !== undefined ? watchScope(resultName(trigger.step), watched, run.detail.previous as Value | undefined) : bareScope();
    const value = (element.value ?? null) as Value;
    if (agent.scope) scope.item = value;
    const state: ItemRun = {
      agent,
      run,
      item: element.key,
      session: view.session!,
      scope,
      steps: [],
      reached: [],
      texts: [],
      textAt: {},
      kept: runs.kept(agent.id, run.dueAt, element.key),
      cost: 0,
      when,
      ...(agent.scope && { element: { label: element.label, value } }),
    };
    let status: RunItemStatus = "acted";
    let reason: string | undefined;
    try {
      // The value that started a watch's run goes into its session first: its work steps, and a reply to its report
      // (a fork of this session), see what fired it.
      if (trigger && watched !== undefined) {
        const { server, tool } = trigger.step;
        const read = `${server}.${tool}, as ${resultName(trigger.step)} and watch`;
        const text = `The watch that started this run (${read}) read:\n${clip(jsonOf(watched), MAX_RESULT_CHARS)}`;
        await this.#host.write(state.session, text, `${opId(state)}:watch`);
      }
      const stopped = await this.#steps(state, workflowOf(agent), "");
      if (stopped) ({ status, reason } = stopped);
    } catch (error) {
      if (error instanceof SignInNeeded) throw error;
      status = "failed";
      reason = errorMessage(error);
    }
    runs.endItem(agent.id, run.dueAt, element.key, {
      status,
      steps: state.steps,
      ...(state.texts.length && { text: state.texts.join("\n\n") }),
      ...(reason !== undefined && { reason }),
      ...(state.reached.length && { reached: state.reached }),
      // Only where it differs from the item's text: a delivery after the last work step goes out with that.
      ...textsBefore(state),
      cost: state.cost,
    });
    this.#host.changed(agent.id);
  }

  /**
   * Run steps in order. Returns where the item stopped and why (a condition that did not hold or a do step not done:
   * not today; a do step held for the owner: waiting), or undefined when it went through.
   */
  async #steps(state: ItemRun, steps: readonly AgentStep[], path: string): Promise<ItemStop | undefined> {
    for (const [index, step] of steps.entries()) {
      const key = stepKey(path, index);
      const started = Date.now();
      const record = (label: string, ok: boolean, detail?: string, cost?: number) =>
        state.steps.push({ kind: step.kind, label, ok, ms: Date.now() - started, ...(detail && { detail }), ...(cost !== undefined && { cost }) });
      switch (step.kind) {
        case "look": {
          const input = fillInput(step.input, state.scope);
          const label = `${STEP_LABELS.look} ${step.server}.${step.tool}`;
          let value: Value;
          if (key in state.kept.looked) value = state.kept.looked[key] as Value;
          else {
            try {
              value = await readFor(this.#host, state.agent, step, input);
            } catch (error) {
              if (!(error instanceof SignInNeeded)) record(label, false, errorMessage(error));
              throw error;
            }
            if (jsonOf(value).length <= MAX_KEPT_CHARS) this.#host.runs.keep(state.agent.id, state.run.dueAt, state.item, "looked", key, value);
          }
          const name = resultName(step);
          state.scope[name] = value;
          state.scope.last = value;
          const json = jsonOf(value);
          await this.#host.write(state.session, `Result of ${step.server}.${step.tool} (${name}):\n${clip(json, MAX_RESULT_CHARS)}`, `${opId(state)}:look:${key}`);
          record(label, true, excerpt(json, DETAIL_CHARS));
          break;
        }
        case "onlyIf": {
          const label = `${STEP_LABELS.onlyIf} ${step.condition}`;
          if (!this.#condition(state, key, step.condition, record, label)) {
            record(label, false, "did not hold: stopped here");
            return { status: "not_today", reason: `${step.condition} did not hold` };
          }
          record(label, true, "held");
          break;
        }
        case "if": {
          const label = `${STEP_LABELS.if} ${step.condition}`;
          const yes = this.#condition(state, key, step.condition, record, label);
          record(label, true, yes ? "held" : step.else ? "did not hold: the other way" : "did not hold: skipped");
          const stopped = await this.#steps(state, yes ? step.then : (step.else ?? []), `${key}.${yes ? "then" : "else"}`);
          if (stopped) return stopped;
          break;
        }
        case "work": {
          const model = step.model ?? state.agent.model;
          if (state.configured !== (model ?? "")) {
            await this.#host.configure(state.session, state.agent, step.model, state.run.dueAt);
            state.configured = model ?? "";
          }
          const result = await this.#host.work(state.session, workPrompt(step, state.when, state.element), `${opId(state)}:work:${key}`);
          state.cost += result.cost;
          if (result.model) this.#usedModel(state, result.model);
          const label = `${STEP_LABELS.work}: ${firstLine(step.prompt)}${step.skill ? `, with ${step.skill}` : ""}`;
          if (result.status !== "done") {
            record(label, false, result.reason ?? "it ended without an answer", result.cost);
            throw new Error(`The work step ended without an answer: ${result.reason ?? "no reason given"}.`);
          }
          const text = (result.text ?? "").trim();
          state.scope.answer = text;
          if (text) state.texts.push(text);
          record(label, true, firstLine(text), result.cost);
          break;
        }
        case "do": {
          const label = `${STEP_LABELS.do} ${step.server}.${step.tool}`;
          const acted = await this.#act(state, step, key);
          if (acted.value !== undefined) {
            state.scope.done = acted.value as Value;
            state.scope.last = acted.value as Value;
          } else if (acted.cut) {
            const why = `The result of ${step.server}.${step.tool} was too large to keep, so the steps after it cannot read it again: stopped here.`;
            setMissing(state.scope, "done", why);
            setMissing(state.scope, "last", why);
          }
          record(label, acted.ok, acted.detail);
          // Held: the item stops here, its deliveries unsent, until the owner decides (then it goes through again,
          // to this step's outcome). Declined or expired, it stops as at a condition that did not hold.
          if (acted.end === "waiting") return { status: "waiting", reason: `Waits for you to approve ${step.server}.${step.tool}.` };
          if (acted.end === "stopped") return { status: "not_today", reason: `${step.server}.${step.tool} was not done: ${acted.detail}` };
          break;
        }
        case "tell":
        case "page":
        case "handOver":
          state.reached.push(key);
          // What it sends is the work done before it; a work step after it adds to the text of later deliveries only.
          state.textAt[key] = state.texts.join("\n\n");
          record(deliveryLabel(step), true, "sent once every item is done");
          break;
      }
    }
    return undefined;
  }

  /**
   * A do step: its call, with its input filled from the results so far, through the write gate (the agent's level and
   * rules decide whether it runs, waits for the owner, or is refused). Kept as it starts and as it ends, so a run that
   * goes on after a restart makes it at most once. A test run calls nothing: it says what it would call.
   */
  async #act(state: ItemRun, step: Extract<AgentStep, { kind: "do" }>, key: string): Promise<ActedStep> {
    const runs = this.#host.runs;
    const mark = actedMark(state.item, key);
    const before = runs.get(state.agent.id, state.run.dueAt)?.detail.acted?.[mark];
    if (before) {
      // An approved call's result (it ran in the chat) goes into the item's session as a result that ran here does
      // (placed once: one that ran here is there already).
      // (A restart may have come between the decision and its own write of it.)
      if (before.value !== undefined) await this.#wroteResult(state, step, key, jsonOf(before.value));
      return before;
    }
    if (!mayUseServer(state.agent, step.server)) return { ok: false, detail: `not done: ${step.server} is not one of the servers @${state.agent.name} may use` };
    const input = fillInput(step.input, state.scope);
    if (state.run.test) return { ok: true, detail: `a test: would call it with ${excerpt(jsonOf(input), DETAIL_CHARS)}` };
    const context: ActContext = { agentId: state.agent.id, dueAt: state.run.dueAt, item: state.item, step: key };
    const keep = (acted: ActedStep | undefined) => runs.setActed(state.agent.id, state.run.dueAt, mark, acted);
    // Kept before the call: a restart while it runs finds it, and never makes it again (it may have reached the server).
    keep({ ok: false, detail: "cut off by a restart while it ran: it may or may not have been done; check before doing it again" });
    let acted: ActedStep;
    try {
      const result = await this.#host.act({ server: step.server, tool: step.tool, input }, context);
      if (result.status === "ran") {
        const json = jsonOf(result.value);
        acted = { ok: true, detail: excerpt(json, DETAIL_CHARS), value: result.value };
        await this.#wroteResult(state, step, key, json);
        // A large result is not kept with the run: an item going through again has only its excerpt (keptOf).
        keep(keptOf(acted, json));
        return acted;
      }
      acted = { ok: false, detail: result.message, ...(result.status === "held" && { end: "waiting" as const }) };
    } catch (error) {
      if (error instanceof SignInNeeded) {
        // Nothing reached the server: asked again once signed in.
        keep(undefined);
        throw error;
      }
      acted = { ok: false, detail: `failed: ${errorMessage(error)}` };
    }
    keep(acted);
    return acted;
  }

  /** A do step's result, into the item's session: what its later work steps read. */
  #wroteResult(state: ItemRun, step: Extract<AgentStep, { kind: "do" }>, key: string, json: string): Promise<void> {
    return this.#host.write(state.session, doResult(`${step.server}.${step.tool}`, json), `${opId(state)}:do:${key}`);
  }

  /**
   * The owner decided a do step a run's item waited at: its outcome is kept as the step's, and the item and run go back
   * to running (start the run again to go on). False when that item was not waiting there (decided already, or gone).
   */
  async decided(agentId: string, dueAt: number, item: string, step: string, acted: ActedStep): Promise<boolean> {
    const runs = this.#host.runs;
    const mark = actedMark(item, step);
    if (runs.get(agentId, dueAt)?.detail.acted?.[mark]?.end !== "waiting") return false;
    // Reopened first: the outcome is kept only for an item that goes through again (no await between the two).
    if (!runs.reopen(agentId, dueAt, item)) return false;
    const json = acted.value === undefined ? null : jsonOf(acted.value);
    runs.setActed(agentId, dueAt, mark, json === null ? acted : keptOf(acted, json));
    // The whole result goes into the item's session, kept or not: its later work steps read it there.
    const session = runs.item(agentId, dueAt, item)?.session;
    if (json !== null && session) {
      await this.#host.write(session, doResult("the call you approved", json), `${itemOpId(agentId, dueAt, item)}:do:${step}`);
    }
    return true;
  }

  /**
   * Start a run once the start of it going now (if any) has ended: an item reopened just as that one ended (after its
   * last read of its items) is gone through by this one.
   */
  async again(start: RunStart): Promise<RunEnd> {
    await this.#active.get(`${start.agent.id}:${start.dueAt}`)?.catch(() => undefined);
    return this.start(start);
  }

  /**
   * Whether a condition holds: as it came out the first time the item went through (kept), else over its results now
   * (then kept). Going through again after a decision, the item takes the same way, whatever was not kept.
   */
  #condition(state: ItemRun, key: string, condition: string, record: (label: string, ok: boolean, detail?: string) => void, label: string): boolean {
    const before = state.kept.conditions[key];
    if (before !== undefined) return before;
    const yes = this.#holds(condition, state, record, label);
    this.#host.runs.keep(state.agent.id, state.run.dueAt, state.item, "conditions", key, yes);
    return yes;
  }

  /** Whether a condition holds over the item's results; a condition that cannot be read fails the item. */
  #holds(condition: string, state: ItemRun, record: (label: string, ok: boolean, detail?: string) => void, label: string): boolean {
    try {
      return holds(condition, state.scope);
    } catch (error) {
      if (!(error instanceof ConditionError)) throw error;
      record(label, false, error.message);
      throw new Error(`The condition "${condition}" could not be read: ${error.message}`);
    }
  }

  #usedModel(state: ItemRun, model: string): void {
    const run = this.#host.runs.get(state.agent.id, state.run.dueAt);
    const used = run?.detail.used ?? { skills: [], servers: [], models: [] };
    if (!used.models.includes(model)) this.#host.runs.update(state.agent.id, state.run.dueAt, { detail: { used: { ...used, models: [...used.models, model] } } });
  }

  /**
   * Every item is done: send each delivery step once, with the parts of the items that reached it (also an item a later
   * condition stopped, or a later step failed: it got there), and end the run.
   */
  async #finish(agent: AgentDefinition, run: RunRecord, items: readonly RunItemView[]): Promise<RunStatus> {
    const runs = this.#host.runs;
    const acted = items.filter((item) => item.status === "acted");
    const deliveries = [...run.detail.deliveries];
    const sent = new Set(run.detail.sent ?? []);
    for (const { key, step } of deliverySteps(workflowOf(agent))) {
      const parts = items.filter((item) => item.reached?.includes(key)).map((item) => ({ label: item.label, text: item.textAt?.[key] ?? item.text }));
      if (!parts.length || sent.has(key)) continue;
      const text = reportOf(parts);
      const request: DeliveryRequest = { step, key, text, agent, run: { agentId: agent.id, dueAt: run.dueAt, why: run.why, test: run.test } };
      let delivery: RunDelivery;
      if (run.test) delivery = recorded(request);
      else {
        try {
          if (step.kind === "page" && step.edit === "rebuild") request.session = await this.#deliverySession(run, key);
          // A tell through an outside tool changes data there: kept as sent before the call, as a do step is, so a
          // restart while it runs never makes it again (it may have reached the server).
          if (kindOf(step) === "tool") {
            const cutOff: RunDelivery = {
              kind: "tool",
              to: targetOf(step),
              status: "failed",
              detail: "cut off by a restart while it ran: it may or may not have been sent; check before sending it again",
            };
            runs.update(agent.id, run.dueAt, { detail: { deliveries: [...deliveries, cutOff], sent: [...sent, key] } });
          }
          delivery = await this.#host.deliver(request);
        } catch (error) {
          delivery = { kind: kindOf(step), to: targetOf(step), status: "failed", detail: errorMessage(error) };
        }
      }
      deliveries.push(delivery);
      sent.add(key);
      // Each delivery is written as it goes out: a restart sends only the rest.
      runs.update(agent.id, run.dueAt, { detail: { deliveries, sent: [...sent] } });
    }
    const failed = items.filter((item) => item.status === "failed");
    // An item stopped after a delivery step still sent it: the run sent something.
    const delivered = deliveries.some((delivery) => delivery.status === "sent" || delivery.status === "recorded");
    // And one whose report went out to nobody (every send failed) failed, even with items acted: nobody heard.
    const undelivered = deliveries.find((delivery) => delivery.status === "failed" || delivery.status === "refused");
    const status: RunStatus = delivered ? "sent" : undelivered ? "failed" : acted.length ? "sent" : failed.length ? "failed" : "not_today";
    const first = deliveries.find((delivery) => delivery.text)?.text ?? acted.find((item) => item.text)?.text;
    const summary =
      status === "sent"
        ? firstLine(first ?? `Acted on ${acted.length} of ${items.length}.`)
        : status === "failed"
          ? `Failed: ${(undelivered ? undelivered.detail : failed[0]?.reason) ?? "a step failed"}`
          : `Not today: ${items[0]?.reason ?? "nothing to report"}`;
    runs.update(agent.id, run.dueAt, { status, summary });
    // It went: older runs still waiting for a sign-in would only post after it.
    if (status !== "failed") runs.skipReplaced(agent.id, run.dueAt, run.test);
    return status;
  }

  /** A delivery's own session (a page rebuild's), made once and kept in the run's row before it is used. */
  async #deliverySession(run: RunRecord, key: string): Promise<string> {
    const sessions = this.#host.runs.get(run.agentId, run.dueAt)?.detail.sessions ?? {};
    if (sessions[key]) return sessions[key];
    const session = await this.#host.newSession();
    this.#host.runs.update(run.agentId, run.dueAt, { detail: { sessions: { ...sessions, [key]: session } } });
    return session;
  }
}

/** A do step's result as its item's session reads it (the same op id for a call made here or approved: placed once). */
function doResult(call: string, json: string): string {
  return `Result of ${call} (done):\n${clip(json, MAX_RESULT_CHARS)}`;
}

/** A do step's outcome as its run keeps it: a result too large to keep only as its excerpt, marked cut. */
function keptOf(acted: ActedStep, json: string): ActedStep {
  return json.length > MAX_RESULT_CHARS ? { ok: acted.ok, detail: acted.detail, cut: true } : acted;
}

/**
 * A decided action as the do step that held it ends: approved and ran (`value`, the call's result: what later steps
 * read as `done`, kept as any do result is), approved but failed (the item goes on, as after any failed call), or
 * declined or expired (the item stops there). Null while it has not ended.
 */
export function actedOf(view: Pick<PendingActionView, "status" | "result">, value?: unknown): ActedStep | null {
  switch (view.status) {
    case "done": {
      const detail = `approved: ${excerpt(view.result ?? "", DETAIL_CHARS)}`;
      // Without the call's own result (the action keeps only its start), later steps cannot read it.
      return value === undefined ? { ok: true, detail, cut: true } : { ok: true, detail, value };
    }
    case "failed":
      return { ok: false, detail: `approved, but failed: ${view.result ?? "no reason given"}` };
    case "declined":
      return { ok: false, end: "stopped", detail: "you declined it" };
    case "expired":
      return { ok: false, end: "stopped", detail: "it expired before you decided" };
    default:
      // Not decided yet (pending), or still running: nothing to go on with.
      return null;
  }
}

/** Where a held action's run waits: its item and step. */
export type ActionRunRef = { agentId: string; dueAt: number; item: string; step: string };

/**
 * Of a chat's actions, those that ended while their run's item still waits at their step (a restart came between the
 * end and AgentRunner.decided), with what each came to: the decisions their runs did not hear.
 */
export function missedDecisions(
  runs: Pick<AgentRuns, "get">,
  actions: readonly { view: PendingActionView; run?: ActionRunRef }[],
): { ref: ActionRunRef; acted: ActedStep }[] {
  // Each run read once, however many of its actions ended.
  const read = new Map<string, RunRecord | null>();
  return actions.flatMap(({ view, run }) => {
    const acted = run && actedOf(view);
    if (!run || !acted) return [];
    const key = `${run.agentId}:${run.dueAt}`;
    if (!read.has(key)) read.set(key, runs.get(run.agentId, run.dueAt));
    return read.get(key)?.detail.acted?.[actedMark(run.item, run.step)]?.end === "waiting" ? [{ ref: run, acted }] : [];
  });
}

/** A run's operation ids, per item: `run:<agentId>:<dueAt>:<item>` (the step key follows). */
function opId(state: Pick<ItemRun, "agent" | "run" | "item">): string {
  return itemOpId(state.agent.id, state.run.dueAt, state.item);
}

function itemOpId(agentId: string, dueAt: number, item: string): string {
  return `run:${agentId}:${dueAt}:${item}`;
}

/** The delivery steps of a workflow with their keys, in order, those inside ifs too. */
function deliverySteps(steps: readonly AgentStep[]): { key: string; step: DeliveryRequest["step"] }[] {
  return [...walkSteps(steps)].flatMap(({ key, step }) => (step.kind === "tell" || step.kind === "page" || step.kind === "handOver" ? [{ key, step }] : []));
}

/** The report of the items that reached a delivery: one item's text, or each item's under its name. */
export function reportOf(items: readonly Pick<RunItemView, "label" | "text">[]): string {
  const parts = items.map((item) => ({ label: item.label, text: item.text?.trim() || "(nothing worked out)" }));
  if (parts.length === 1 && !parts[0].label) return parts[0].text;
  return parts.map((part) => `**${part.label}**\n${part.text}`).join("\n\n");
}

function kindOf(step: DeliveryRequest["step"]): RunDelivery["kind"] {
  if (step.kind === "page") return "page";
  if (step.kind === "handOver") return "handOver";
  return step.via === "chat" ? "chat" : step.via === "notify" ? "notify" : "tool";
}

function targetOf(step: DeliveryRequest["step"]): string {
  if (step.kind === "page") return `page ${step.artifactId}`;
  if (step.kind === "handOver") return `@${step.agent}`;
  return typeof step.via === "object" ? `${step.via.server}.${step.via.tool}` : step.to.join(", ");
}

function deliveryLabel(step: DeliveryRequest["step"]): string {
  return `${STEP_LABELS[step.kind]} ${stepSummary(step)}`;
}

/** A test run's delivery: what it would have sent, and to whom. */
function recorded(request: DeliveryRequest): RunDelivery {
  return { kind: kindOf(request.step), to: targetOf(request.step), text: request.text, status: "recorded", detail: "a test: nothing was sent or changed" };
}

/** A definition's trigger in words. */
export function whenOf(agent: Pick<AgentDefinition, "trigger">): string {
  const trigger = agent.trigger;
  if (!trigger) return "when asked";
  if (trigger.kind === "schedule") return describeSchedule(trigger);
  return `when ${trigger.when} (checked every ${trigger.everyMinutes} minutes)`;
}

/** A condition scope with no prototype: a result named "__proto__" or "constructor" is a name like any other. */
function bareScope(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>;
}

/** What a watch's condition and its run's steps read: its value by the step's name and as `watch`, and `previous`. */
function watchScope(name: string, value: Value, previous: Value | undefined): Record<string, Value> {
  const scope = bareScope();
  scope[name] = value;
  scope.watch = value;
  scope.previous = previous ?? null;
  return scope;
}

/** An item's text at each delivery it reached, where that differs from its final text. */
function textsBefore(state: Pick<ItemRun, "textAt" | "texts">): { textAt?: Record<string, string> } {
  const final = state.texts.join("\n\n");
  const differs = Object.entries(state.textAt).filter(([, text]) => text !== final);
  return differs.length ? { textAt: Object.fromEntries(differs) } : {};
}
/** Whether a watch's value says it fires: its condition holds over the new value (and the one before, as `previous`). */
export function watchFires(when: string, name: string, value: Value, previous: Value | undefined): boolean {
  return holds(when, watchScope(name, value, previous));
}
