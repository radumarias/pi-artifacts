// The write gate: every MCP call whose tool is not read-only goes through `WriteGate.check` before it leaves the chat
// object (McpHub.call asks it). The caller's level and the guardrails decide whether the call runs, is refused, or is
// held as an action for the owner (shared/limits.ts). An action the owner approves comes back through the same gate,
// which runs it exactly as stored, after checking the rules that block once more (a quiet date may have begun).

import { AUTONOMY_LABELS, type AgentDefinition, type AutonomyLevel, type StepInput } from "../../../shared/agents.ts";
import { canonicalJson } from "../../../shared/canonical.ts";
import {
  actorName,
  argValues,
  asNumber,
  schemaHasPath,
  DEFAULT_APPROVAL_HOURS,
  hitText,
  ruleApplies,
  violation,
  type ActionActor,
  type CallOutcome,
  type GuardrailRule,
  type PendingActionView,
  type RuleHit,
} from "../../../shared/limits.ts";
import type { ToolInfo } from "../../../shared/protocol.ts";
import { errorMessage } from "../../../shared/util.ts";
import type { Value } from "../../../shared/conditions.ts";
import { fillInput } from "../runs/executor.ts";
import type { ActionOrigin, NewAction } from "./actions.ts";

/** Who makes a call, as the caller of McpHub.call says it. */
export type GateContext =
  /** A model's tool call in one of the chat's pi sessions (pi's own, an agent's, a run's). */
  | { kind: "session"; session: string }
  /** A run's do step, or its tell through an outside tool (a Test it run calls neither). */
  | { kind: "run"; agentId: string; dueAt: number; item: string; step: string }
  /** A published page's call, by its author (pages call write tools only for their author). */
  | { kind: "page"; artifactId: string }
  /** An action its owner approved, now running: its stored call, at the level it was held at. Only the chat builds it. */
  | { kind: "approved"; action: PendingActionView; level: AutonomyLevel };

/** Who a context comes to: whose call it is, how far it may go, and where a held action's outcome goes back. */
export interface Caller {
  actor: ActionActor;
  /** The agent whose own rules and wait apply; none for pi or a page (the owner's rules for all agents still do). */
  agent?: Pick<AgentDefinition, "id" | "name" | "guardrails" | "approvalHours">;
  level: AutonomyLevel;
  /** Why it is at that level, in words: "on a member's message". */
  because: string;
  origin: Omit<ActionOrigin, "level">;
  /** A page cannot wait for an approval: what would be held is refused, with what to do instead. */
  noHold?: true;
}

/** A call as the gate sees it. */
export interface GateCall {
  server: string;
  tool: string;
  input: StepInput;
  /** Its listing; absent for a tool the server does not list (treated as one that changes data). */
  info?: ToolInfo;
}

export type GateVerdict =
  | { run: true; warnings: string[]; caller: Caller; actionId?: string; /** Its place among the calls in flight. */ reservation?: number }
  | { run: false; outcome: "refused"; message: string }
  | { run: false; outcome: "held"; message: string; action: PendingActionView };

/** What the gate needs of the chat object it guards. Tests pass fakes. */
export interface GateHost {
  now(): number;
  /** Who a context is; throws when it names nobody that may call (an unknown session). */
  caller(context: GateContext, call: GateCall): Promise<Caller>;
  /** The owner's rules for all their agents (and pi, and pages). */
  userRules(): Promise<GuardrailRule[]>;
  /** A read-only tool's result's value at `path`, for a maxChange rule; undefined when it cannot be read. */
  readValue(server: string, tool: string, input: StepInput, path: string): Promise<unknown>;
  /** How many calls of server.tool ("*" for either: any) ran since `since` (epoch ms), the owner's in all their chats. */
  callsSince(server: string, tool: string, since: number): Promise<number>;
  /** Midnight of the day `at` falls on, in `tz`. */
  dayStart(at: number, tz: string): number;
  /** Keep a call in the owner's log of calls. Never throws. */
  log(entry: { actor: string; agentId?: string; server: string; tool: string; outcome: CallOutcome; detail?: string }): Promise<void> | void;
  /** Hold a call as an action: kept, its card posted, the owner told; the action as kept. */
  hold(action: NewAction): Promise<PendingActionView>;
  /** One of the owner's agents, for the rules it has now; null when it is gone. */
  agent(agentId: string): Promise<Pick<AgentDefinition, "guardrails"> | null>;
}

/**
 * How many calls a callsPerDay rule covers that were let through and are not in the log yet (made before the one
 * checked): the checks before it settle first, so one held or refused never counts, and two in parallel never both pass.
 */
export type InFlight = (rule: Pick<GuardrailRule, "server" | "tool">) => Promise<number>;

/** The values a rule needs that the call does not carry: the current value (maxChange), today's calls (callsPerDay). */
async function factsFor(host: GateHost, rule: GuardrailRule, call: GateCall, at: number, inFlight: InFlight) {
  // The calls the rule is on: of every tool it covers ("*": any), not only the one called now; with the ones under way.
  if (rule.kind === "callsPerDay") {
    // The ones under way first, then the log: one logged in between is counted twice at worst, never missed.
    const going = await inFlight(rule);
    return { callsToday: (await host.callsSince(rule.server, rule.tool, host.dayStart(at, rule.tz ?? "UTC"))) + going };
  }
  // Read only when the call sets the argument: a rule on it says nothing otherwise.
  if (rule.kind !== "maxChange" || !rule.current || !argValues(call.input, rule.arg!).length) return {};
  try {
    const input = fillInput(rule.current.input, { input: call.input as Value });
    return { current: asNumber(await host.readValue(call.server, rule.current.tool, input, rule.current.path)) ?? null };
  } catch {
    return { current: null };
  }
}

/**
 * The rules that fire for a call, of `rules`. A rule on an argument the tool's listed schema does not have (renamed, or
 * never there) cannot be checked: it fires, rather than let every call through.
 */
export async function hitsFor(
  host: GateHost,
  rules: readonly GuardrailRule[],
  call: GateCall,
  at: number,
  inFlight: InFlight = async () => 0,
): Promise<RuleHit[]> {
  const checked = await Promise.all(
    rules.map(async (rule): Promise<RuleHit | null> => {
      if (!ruleApplies(rule, call)) return null;
      if (rule.arg && call.info && schemaHasPath(call.info.inputSchema, rule.arg) === false) {
        return { rule, reason: `${call.server}.${call.tool} has no argument ${rule.arg}, so this rule cannot be checked` };
      }
      const facts = await factsFor(host, rule, call, at, inFlight);
      const reason = violation(rule, { server: call.server, tool: call.tool, input: call.input, at }, facts);
      return reason === null ? null : { rule, reason };
    }),
  );
  return checked.filter((hit): hit is RuleHit => hit !== null);
}

/** The level names a held call's words use: "at Recommend". */
function at(level: AutonomyLevel): string {
  return `at ${AUTONOMY_LABELS[level]}`;
}

export class WriteGate {
  readonly #host: GateHost;

  constructor(host: GateHost) {
    this.#host = host;
  }

  /**
   * Calls being checked or let through and not yet in the log, by the order they came in: what a callsPerDay rule
   * counts besides the log. `checked` settles once the check ended; only the ones let through stay.
   */
  readonly #inFlight = new Map<number, Pick<GateCall, "server" | "tool"> & { checked: Promise<void> }>();
  #order = 0;

  /**
   * Whether a call that changes data may run now; when not, it is refused or held (see the file's head). A callsPerDay
   * rule waits for the checks of the calls before it and counts those let through (InFlight), until each is logged.
   */
  async check(call: GateCall, context: GateContext): Promise<GateVerdict> {
    const reservation = ++this.#order;
    let settled = () => {};
    const checked = new Promise<void>((resolve) => (settled = resolve));
    // Once it is known whether it runs (before a held one is kept, which takes a while): the checks after it go on.
    const settle = (runs: boolean) => {
      if (!runs) this.#inFlight.delete(reservation);
      settled();
    };
    this.#inFlight.set(reservation, { server: call.server, tool: call.tool, checked });
    const inFlight: InFlight = async (rule) => {
      const before = [...this.#inFlight].filter(([order, one]) => order < reservation && ruleApplies(rule, one));
      await Promise.all(before.map(([, one]) => one.checked));
      return before.filter(([order]) => this.#inFlight.has(order)).length;
    };
    let verdict: GateVerdict | undefined;
    try {
      verdict =
        context.kind === "approved"
          ? await this.#approved(call, context.action, context.level, inFlight)
          : await this.#check(call, context, inFlight, () => settle(false));
    } finally {
      // Held, refused or failed: not counted (settling twice changes nothing).
      settle(verdict?.run === true);
    }
    return verdict.run ? { ...verdict, reservation } : verdict;
  }

  async #check(call: GateCall, context: Exclude<GateContext, { kind: "approved" }>, inFlight: InFlight, holding: () => void): Promise<GateVerdict> {
    const host = this.#host;
    const userRules = host.userRules();
    let caller: Caller;
    try {
      caller = await host.caller(context, call);
    } catch (error) {
      userRules.catch(() => {});
      return this.#refuse(null, call, `Not run: ${errorMessage(error)}`);
    }
    const who = actorName(caller.actor);
    const now = host.now();
    const hits = await hitsFor(host, [...(caller.agent?.guardrails ?? []), ...(await userRules)], call, now, inFlight);
    const said = (wanted: GuardrailRule["effect"]) => hits.filter((hit) => hit.rule.effect === wanted).map(hitText);
    // The strictest rule wins: block, then approve, then warn.
    const blocks = said("block");
    if (blocks.length) return this.#refuse(caller.actor, call, `Not run: a rule blocks it: ${blocks.join("; ")}.`);
    if (caller.level === 1) {
      return this.#refuse(caller.actor, call, `Not run: ${who} is ${at(1)} ${caller.because}, so it changes nothing. Say what you would do instead.`);
    }
    const warnings = said("warn");
    const asks = said("approve");
    if (caller.level === 4 && !asks.length) {
      // Logged as it ends, with what it came to (WriteGate.ran).
      return { run: true, warnings, caller };
    }
    if (caller.noHold) {
      return this.#refuse(
        caller.actor,
        call,
        `Not run: it needs your approval (${asks.join("; ")}), which a page cannot wait for. Ask for it in a chat instead.`,
      );
    }
    const kind = caller.level === 2 ? "proposal" : "approval";
    const why =
      caller.level === 4
        ? `A rule asks for your approval: ${asks.join("; ")}.`
        : `${who} is ${at(caller.level)} ${caller.because}${asks.length ? `, and a rule asks for your approval: ${asks.join("; ")}` : ""}.`;
    const hours = caller.agent?.approvalHours ?? DEFAULT_APPROVAL_HOURS;
    holding();
    const action = await host.hold({
      kind,
      actor: caller.actor,
      server: call.server,
      tool: call.tool,
      input: call.input,
      why,
      ...(warnings.length && { warnings }),
      expiresAt: now + hours * 3_600_000,
      origin: { ...caller.origin, level: caller.level },
    });
    this.#log(caller.actor, call, "held", why);
    // A run's record is read by its owner; a session's answer by the model.
    const [owner, presses] = context.kind === "run" ? ["you", "you press"] : ["your owner", "they press"];
    const message =
      kind === "proposal"
        ? `Not run yet: proposed to ${owner} as a card with this exact call; it runs only if ${presses} Run (it expires in ${hours} hours). ${why}`
        : `Not run yet: waiting for ${owner === "you" ? "your" : "your owner's"} approval, with this exact call (it expires in ${hours} hours). ${why}`;
    return { run: false, outcome: "held", message, action };
  }

  #log(actor: ActionActor | null, call: Pick<GateCall, "server" | "tool">, outcome: CallOutcome, detail?: string): Promise<void> | void {
    return this.#host.log({
      actor: actor ? actorName(actor) : "unknown",
      ...(actor?.agentId && { agentId: actor.agentId }),
      server: call.server,
      tool: call.tool,
      outcome,
      ...(detail && { detail }),
    });
  }

  #refuse(actor: ActionActor | null, call: GateCall, message: string): GateVerdict {
    this.#log(actor, call, "refused", message);
    return { run: false, outcome: "refused", message };
  }

  /** An action its owner approved: only while it runs, only its stored call, and not when a rule now blocks it. */
  async #approved(call: GateCall, action: PendingActionView, level: AutonomyLevel, inFlight: InFlight): Promise<GateVerdict> {
    const host = this.#host;
    const same = action.server === call.server && action.tool === call.tool && canonicalJson(action.input) === canonicalJson(call.input);
    if (action.status !== "running" || !same) return this.#refuse(action.actor, call, "Not run: not the call that was approved.");
    // A failed lookup fails the action (it can be asked again), never runs it without the agent's rules.
    const [agent, userRules] = await Promise.all([action.actor.agentId ? host.agent(action.actor.agentId) : null, host.userRules()]);
    // Only the rules that block: the owner's approval answered the rest.
    const blocking = [...(agent?.guardrails ?? []), ...userRules].filter((rule) => rule.effect === "block");
    const hits = await hitsFor(host, blocking, call, host.now(), inFlight);
    if (hits.length) return this.#refuse(action.actor, call, `Not run: a rule blocks it now: ${hits.map(hitText).join("; ")}.`);
    return { run: true, warnings: [], actionId: action.id, caller: { actor: action.actor, level, because: "approved by you", origin: {} } };
  }

  /** A call the gate let through ended: logged with what it came to, and counted from the log once it is kept there. */
  ran(call: Pick<GateCall, "server" | "tool">, verdict: Extract<GateVerdict, { run: true }>, error?: string): void {
    const notes = [...(verdict.actionId ? ["approved"] : []), ...verdict.warnings, ...(error ? [error] : [])];
    const kept = this.#log(verdict.caller.actor, call, error ? "failed" : verdict.warnings.length ? "warned" : "ran", notes.join("; ").slice(0, 500));
    const done = () => verdict.reservation !== undefined && this.#inFlight.delete(verdict.reservation);
    Promise.resolve(kept).then(done, done);
  }
}
