// The run executor: an agent's workflow, step by step, for one due time. Every step runs in code but `work`, which is
// the only one that calls the model. Each item of the run (an element of its scope's list, or the run itself) gets a
// fresh pi session: the results of its reads go in as passive writes, so its work steps and a reply to its report see
// them. Deliveries (tell, page, hand over) wait until every item is done and go out once, each with the parts of the
// items that reached it. A test run records them instead.

import {
  AUTONOMY_LABELS,
  hasWork,
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
import { clip, errorMessage, mapLimit } from "../../../shared/util.ts";
import { describeSchedule } from "./schedule.ts";
import type { AgentRuns, RunRecord } from "./store.ts";

/** How much of a read's result goes into the run's session: the rest is cut, with a note. */
const MAX_RESULT_CHARS = 12_000;
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

/** What the executor needs from the chat object it runs in. Tests pass fakes. */
export interface RunHost {
  readonly runs: AgentRuns;
  /** A read-only call through the hub, as the agent's owner: the result's payload. Throws SignInNeeded for a sign-in. */
  read(server: string, tool: string, input: StepInput): Promise<Value>;
  /** The servers that sign in each user (`auth: "oauth"`): a work step's tools may come from them. */
  signInServers(): readonly string[];
  /** Which of these servers need their owner to sign in again before a run can read them. */
  needsSignIn(servers: readonly string[]): Promise<string[]>;
  /**
   * `agent`'s run waits for the owner to sign in to these servers again: this chat hears when they do, and they are
   * told (a notice, a push) unless `quiet` (a test run).
   */
  signInNeeded(agent: AgentDefinition, servers: readonly string[], quiet: boolean): void;
  /** A fresh pi session for one item. */
  newSession(): Promise<string>;
  /** Set an item's session up for its work steps: the agent's model (or `model`), instructions and read tools. */
  configure(session: string, agent: AgentDefinition, model?: string): Promise<void>;
  /** A passive write into a session: context, no model call. Placed once per `requestId`. */
  write(session: string, text: string, requestId: string): Promise<void>;
  /** A work step's prompt into its session, waited for. Placed once per `operationId`. */
  work(session: string, prompt: string, operationId: string): Promise<WorkResult>;
  /** Deliver a report: post it, notify, publish a page version, hand it over. Placed once per key. */
  deliver(request: DeliveryRequest): Promise<RunDelivery>;
  /** The run's list changed, or a run started or ended: tell the people looking. */
  changed(agentId: string): void;
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

/** The workflow a definition runs: its own, else its instructions as one work step reported to its home chat. */
function workflowOf(agent: Pick<AgentDefinition, "workflow" | "instructions">): AgentStep[] {
  if (agent.workflow?.length) return agent.workflow;
  return [
    { kind: "work", prompt: "Do what your instructions say, for this run." },
    { kind: "tell", to: ["owner"], via: "chat" },
  ];
}

/** The name a look step's result goes by: its `as`, else its tool's name as a name. */
export function resultName(step: LookStep): string {
  return step.as ?? (step.tool.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1") || "result");
}

/** The skills a workflow's work steps name. */
function skillsNamed(steps: readonly AgentStep[]): string[] {
  return [...walkSteps(steps)].flatMap(({ step }) => (step.kind === "work" && step.skill ? [step.skill] : []));
}

/** A value as JSON (a string as itself). */
function jsonOf(value: unknown): string {
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
  return host.read(step.server, step.tool, input);
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
    const run = this.#run(start).finally(() => this.#active.delete(key));
    this.#active.set(key, run);
    return run;
  }

  async #run({ agent, dueAt, why, test = false, watch, previous }: RunStart): Promise<RunEnd> {
    const runs = this.#host.runs;
    const when = whenOf(agent);
    const reads = serversNamed(agent, { reads: true });
    const { run, started } = runs.begin(agent.id, dueAt, why, test, {
      when,
      ...(watch !== undefined && { watch }),
      ...(previous !== undefined && { previous }),
      used: { skills: skillsNamed(workflowOf(agent)), servers: reads, models: [] },
    });
    // Ended, or waiting for a sign-in that has not come: an alarm that fires twice sends once.
    if (!started && run.status !== "running") return { status: run.status, started: false };
    this.#host.changed(agent.id);
    try {
      const missing = await this.#host.needsSignIn(runServers(agent, this.#host.signInServers()));
      if (missing.length) return this.#waitForSignIn(agent, run, missing);
      const elements = await this.#elements(agent);
      const outcomes = await mapLimit(elements, RUN_CONCURRENCY, (element) => this.#item(agent, run, element, when));
      const status = await this.#finish(agent, runs.get(agent.id, dueAt)!, outcomes);
      return { status, started };
    } catch (error) {
      if (error instanceof SignInNeeded) return this.#waitForSignIn(agent, run, [error.server]);
      runs.update(agent.id, dueAt, { status: "failed", summary: `Failed: ${errorMessage(error)}` });
      return { status: "failed", started };
    } finally {
      this.#host.changed(agent.id);
    }
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

  /** The run's items: each element of its scope's list (read once), or the run itself. */
  async #elements(agent: AgentDefinition): Promise<{ key: string; label: string; value?: Value }[]> {
    if (!agent.scope) return [{ key: "", label: "" }];
    // Listed again by a run cut off by a restart: the items it ended are read back as they were (#item).
    const list = agent.scope.list;
    const result = await readFor(this.#host, agent, list, list.input);
    const seen = new Set<string>();
    return itemsOf(result)
      .slice(0, MAX_RUN_ITEMS)
      .map((value, index) => {
        let { key, label } = itemKey(value, index);
        while (seen.has(key)) key = `${key}~`;
        seen.add(key);
        return { key, label, value };
      });
  }

  /** One item through the workflow, in a session of its own; an item that ended already is read back as it was. */
  async #item(agent: AgentDefinition, run: RunRecord, element: { key: string; label: string; value?: Value }, when: string): Promise<RunItemView> {
    const runs = this.#host.runs;
    const { view, started } = await runs.beginItem(agent.id, run.dueAt, element.key, element.label, () => this.#host.newSession());
    if (!started && view.status !== "running") return view;
    const watched = run.detail.watch as Value | undefined;
    const trigger = agent.trigger?.kind === "watch" ? agent.trigger : undefined;
    const scope = trigger && watched !== undefined ? watchScope(resultName(trigger.step), watched, run.detail.previous as Value | undefined) : bareScope();
    if (agent.scope) scope.item = element.value ?? null;
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
      cost: 0,
      when,
      ...(agent.scope && { element: { label: element.label, value: element.value ?? null } }),
    };
    let status: RunItemStatus = "acted";
    let reason: string | undefined;
    try {
      // The value that started a watch's run goes into its session first, so its work steps see what fired it.
      if (trigger && watched !== undefined && hasWork(workflowOf(agent))) {
        const { server, tool } = trigger.step;
        const read = `${server}.${tool}, as ${resultName(trigger.step)} and watch`;
        const text = `The watch that started this run (${read}) read:\n${clip(jsonOf(watched), MAX_RESULT_CHARS)}`;
        await this.#host.write(state.session, text, `${opId(state)}:watch`);
      }
      const stopped = await this.#steps(state, workflowOf(agent), "");
      if (stopped) {
        status = "not_today";
        reason = stopped;
      }
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
    return runs.item(agent.id, run.dueAt, element.key)!;
  }

  /** Run steps in order. Returns why the item stopped at a condition, or undefined when it went through. */
  async #steps(state: ItemRun, steps: readonly AgentStep[], path: string): Promise<string | undefined> {
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
          try {
            value = await readFor(this.#host, state.agent, step, input);
          } catch (error) {
            if (!(error instanceof SignInNeeded)) record(label, false, errorMessage(error));
            throw error;
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
          if (!this.#holds(step.condition, state, record, label)) {
            record(label, false, "did not hold: stopped here");
            return `${step.condition} did not hold`;
          }
          record(label, true, "held");
          break;
        }
        case "if": {
          const label = `${STEP_LABELS.if} ${step.condition}`;
          const yes = this.#holds(step.condition, state, record, label);
          record(label, true, yes ? "held" : step.else ? "did not hold: the other way" : "did not hold: skipped");
          const stopped = await this.#steps(state, yes ? step.then : (step.else ?? []), `${key}.${yes ? "then" : "else"}`);
          if (stopped) return stopped;
          break;
        }
        case "work": {
          const model = step.model ?? state.agent.model;
          if (state.configured !== (model ?? "")) {
            await this.#host.configure(state.session, state.agent, step.model);
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
        case "do":
          record(
            `${STEP_LABELS.do} ${step.server}.${step.tool}`,
            false,
            `not done: at ${AUTONOMY_LABELS[state.agent.autonomy]}, writes wait for approvals, which come later`,
          );
          break;
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
    const unsent = !delivered && undelivered;
    const status: RunStatus = delivered ? "sent" : unsent ? "failed" : acted.length ? "sent" : failed.length ? "failed" : "not_today";
    const first = deliveries.find((delivery) => delivery.text)?.text ?? acted.find((item) => item.text)?.text;
    const summary =
      status === "sent"
        ? firstLine(first ?? `Acted on ${acted.length} of ${items.length}.`)
        : status === "failed"
          ? `Failed: ${(unsent ? undelivered.detail : failed[0]?.reason) ?? "a step failed"}`
          : `Not today: ${items[0]?.reason ?? "nothing to report"}`;
    runs.update(agent.id, run.dueAt, { status, summary });
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

/** A run's operation ids, per item: `run:<agentId>:<dueAt>:<item>` (the step key follows). */
function opId(state: Pick<ItemRun, "agent" | "run" | "item">): string {
  return `run:${state.agent.id}:${state.run.dueAt}:${state.item}`;
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
