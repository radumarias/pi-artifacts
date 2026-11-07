// Agents: named helpers a user defines once and brings into their chats. Each one has its own name (called as
// "@name"), job line, instructions, model and effort, and the MCP servers it may use. A definition lives in its owner's
// UserDirectory; a chat keeps only a roster that points at definitions, and runs each agent in a Pi session of its
// own. An agent always acts as its owner. The fields for running on its own (a trigger, a scope, a workflow, an
// autonomy level) are stored here too, for the scheduler.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { conditionProblem, MAX_CONDITION } from "./conditions.ts";
import type { ItemRef } from "./items.ts";
import { AGENT_NAME } from "./mentions.ts";
import { EFFORT_LABELS } from "./models.ts";
import type { RunRef } from "./runs.ts";
import { isObject } from "./util.ts";

/** An agent's handle, as "@name" calls it: a lowercase letter, then letters, digits or hyphens. */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;
/** Handles no agent may take: the chat's own agent, and words people use to call everyone. */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([AGENT_NAME, "all", "everyone", "here", "channel", "agent", "agents", "me", "you", "owner"]);
export const MAX_AGENT_JOB = 140;
export const MAX_AGENT_INSTRUCTIONS = 20_000;
export const MAX_AGENT_AVATAR = 3;
export const MAX_AGENT_SERVERS = 50;
/** Per user. */
export const MAX_AGENTS = 30;
/** Proposals from the agent waiting for review, within MAX_AGENTS: one chat cannot fill the user's list. */
export const MAX_AGENT_PROPOSALS = 10;
/** Agents one chat's roster may hold, besides pi (the proposal's starting cap, until one busy object is measured). */
export const MAX_CHAT_AGENTS = 6;
/** Hand-offs one person's message may start: an agent naming another starts its turn, at most this many times. */
export const MAX_HOPS = 3;
/** The colours an agent's badge can take; the app maps each to a token that works in both themes. */
export const AGENT_COLORS = ["blue", "green", "purple", "orange", "teal", "pink", "slate"] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

/** The efforts an agent may name: the model picker's. */
export const AGENT_EFFORTS = Object.keys(EFFORT_LABELS) as ModelThinkingLevel[];
/** An agent's id, as its owner's directory makes it (randomHex(8)). */
export const AGENT_ID_PATTERN = /^[a-f0-9]{16}$/;

/**
 * How far an agent may go on its own: 1 inform (read, work out, tell its owner), 2 recommend (propose actions as
 * cards the owner presses), 3 approve (queue actions for approval), 4 run (carry out writes within the guardrails).
 */
export type AutonomyLevel = 1 | 2 | 3 | 4;
export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = { 1: "Inform", 2: "Recommend", 3: "Approve", 4: "Run" };

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * A value in a step's tool input: any JSON value (checkAgent keeps only JSON). Typed as `{} | null`, since `unknown`
 * cannot cross RPC and a recursive JSON type makes the RPC types too deep to check.
 */
export type StepValue = {} | null;
/** A tool's input in a step. */
export type StepInput = { [key: string]: StepValue };

/**
 * An MCP read through the hub, run in code: no model is involved. `as` names its result for the conditions and inputs
 * of later steps (`{{as.path}}` in an input); its tool's name, as a name, when absent.
 */
export type LookStep = { kind: "look"; server: string; tool: string; input: StepInput; as?: string };
/** A name a look step's result goes by: a letter, then letters, digits or underscores. */
export const RESULT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** One step of a workflow compiled from an agent's instructions. Only `work` calls a model. A type, so pi can store it. */
export type AgentStep =
  | LookStep
  | { kind: "work"; prompt: string; skill?: string; model?: string }
  | { kind: "onlyIf"; condition: string }
  | { kind: "if"; condition: string; then: AgentStep[]; else?: AgentStep[] }
  | { kind: "do"; server: string; tool: string; input: StepInput }
  | { kind: "tell"; to: string[]; via: "chat" | "notify" | { server: string; tool: string } }
  | { kind: "page"; artifactId: string; edit: "findings" | "rebuild" }
  | { kind: "handOver"; agent: string };
export const STEP_KINDS: readonly AgentStep["kind"][] = ["look", "work", "onlyIf", "if", "do", "tell", "page", "handOver"];
export const MAX_WORKFLOW_STEPS = 30;
/** How long one step's tool input may be, as JSON. */
export const MAX_STEP_INPUT = 4_000;

/** What starts a run of an agent on its own: a local time each day (or on some days), or a watch on an interval. */
export type AgentTrigger =
  | { kind: "schedule"; at: string; tz: string; days?: Weekday[] }
  | { kind: "watch"; step: LookStep; everyMinutes: number; when: string };
/** The shortest and longest interval of a watch. */
export const MIN_WATCH_MINUTES = 15;
export const MAX_WATCH_MINUTES = 7 * 24 * 60;

/** What a person or the model writes when making or changing an agent. */
export interface AgentInput {
  /** The handle, as "@name" calls it (AGENT_NAME_PATTERN). */
  name: string;
  /** Up to MAX_AGENT_AVATAR characters for its badge; its name's first two letters when none. */
  avatar?: string;
  color?: AgentColor;
  /** One line on what it is for: the people bar, the "@" picker and the router read it. */
  job: string;
  /** How it works, in Markdown: the text people read and edit, and the source of truth for its workflow. */
  instructions: string;
  /** The picker's model id; the chat's default model when none. */
  model?: string;
  effort?: ModelThinkingLevel;
  /** The MCP servers it may use when its owner asks, by name; every server when absent. */
  servers?: string[];
  /**
   * The servers anyone else in a shared chat can make it use, read-only. When absent: those of `servers` that do not
   * sign in each user (the owner can widen it, knowing the chat sees what the agent reads).
   */
  sharedServers?: string[];
  trigger?: AgentTrigger;
  /** One run per item of a list: "each region on its own". */
  scope?: { list: LookStep; each: true };
  workflow?: AgentStep[];
  autonomy?: AutonomyLevel;
  /** The fields the model guessed, shown as "Assumed" until a person confirms them. */
  assumed?: string[];
}

/** Who made an agent: its owner, or the model in a chat (saved off until the owner turns it on, as skills are). */
export type AgentOrigin = "user" | "agent";

/** An agent as its owner's directory keeps it. */
export interface AgentDefinition extends AgentInput {
  id: string;
  avatar: string;
  color: AgentColor;
  autonomy: AutonomyLevel;
  origin: AgentOrigin;
  enabled: boolean;
  /** Counts up with every change; a chat applies a definition again when it differs from the one it last applied. */
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Set on a copy someone made of an agent another person shared: where it came from. */
  copiedFrom?: { owner: string; id: string; version: number };
}

/** A definition's own fields, as checkAgent and saving take them: its id, look and bookkeeping left out. */
export function inputOf(agent: AgentDefinition): AgentInput {
  const { id: _i, avatar: _a, color: _c, origin: _o, enabled: _e, version: _v, createdAt: _cr, updatedAt: _u, copiedFrom: _f, ...input } = agent;
  return input;
}

/** Whether a definition is a proposal waiting for its owner: made by the model and not turned on yet. */
export function isDraftAgent(agent: Pick<AgentDefinition, "origin" | "enabled">): boolean {
  return agent.origin === "agent" && !agent.enabled;
}

/** A failed change to an agent, with what to fix. RPC keeps an error's message but not its class. */
/** A save's answer: the definition, or why not; `conflict` when it changed since the version the caller read. */
export type AgentResult = AgentDefinition | { error: string; conflict?: true };

/** Thrown by checkAgent with what to fix. */
export class AgentError extends Error {}

function fail(message: string): never {
  throw new AgentError(message);
}

/**
 * A text field, trimmed. `field` words its messages: what a missing one needs ("An agent needs a job line") and whose
 * it is ("An agent's job line").
 */
function str(value: unknown, field: { needs: string; its: string }, max: number, { required = true } = {}): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${field.needs}.`);
    return undefined;
  }
  if (typeof value !== "string") fail(`${field.its} must be text.`);
  const trimmed = value.trim();
  if (!trimmed && required) fail(`${field.needs}.`);
  if (trimmed.length > max) fail(`${field.its} is at most ${max} characters.`);
  return trimmed || undefined;
}

/** A field of `owner` ("An agent", "A look step"), named with its article for `needs`: ("a", "job line"). */
function field(owner: string, article: string, name: string): { needs: string; its: string } {
  return { needs: `${owner} needs ${article ? `${article} ` : ""}${name}`, its: `${owner}'s ${name}` };
}

/** How many characters a person sees in `text`: an emoji or a flag is one. */
function graphemes(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
  return [...text].length;
}

function names(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200))
    fail(`An agent's ${field} must be a list of names.`);
  if (value.length > MAX_AGENT_SERVERS) fail(`An agent lists at most ${MAX_AGENT_SERVERS} ${field}.`);
  return [...new Set((value as string[]).map((item) => item.trim()))];
}

function checkTime(value: unknown): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('A schedule\'s time is "HH:MM", 24-hour, such as "07:00".');
  return value;
}

/** Whether the runtime knows `tz` as an IANA time zone. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function checkLook(value: unknown, what: string): LookStep {
  if (!isObject(value)) fail(`${what} must be a read: {server, tool, input}.`);
  const server = str(value.server, field(what, "a", "server"), 200)!;
  const tool = str(value.tool, field(what, "a", "tool"), 200)!;
  const input = value.input === undefined ? {} : value.input;
  if (!isObject(input)) fail(`${what}'s input must be an object.`);
  // Plain JSON, kept small: it is stored with the definition and read back as JSON anyway.
  const json = JSON.stringify(input);
  if (json.length > MAX_STEP_INPUT) fail(`${what}'s input is too long (at most ${MAX_STEP_INPUT} characters as JSON).`);
  const as = value.as ?? undefined;
  if (as !== undefined && (typeof as !== "string" || !RESULT_NAME_PATTERN.test(as)))
    fail(`${what}'s result name ("as") is a letter, then letters, digits or underscores, as in "signups".`);
  return { kind: "look", server, tool, input: JSON.parse(json) as StepInput, ...(as !== undefined && { as }) };
}

/** A condition, trimmed and parsed (shared/conditions.ts): one that does not parse is refused with what is wrong. */
function condition(value: unknown, what: { needs: string; its: string }): string {
  const text = str(value, what, MAX_CONDITION)!;
  const problem = conditionProblem(text);
  if (problem) fail(`${what.its} does not read: ${problem}`);
  return text;
}

function checkTrigger(value: unknown): AgentTrigger | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) fail("An agent's trigger must be an object.");
  if (value.kind === "schedule") {
    if (!isTimeZone(value.tz)) fail('A schedule needs a time zone, such as "Europe/Bucharest".');
    const days = value.days;
    if (days != null && (!Array.isArray(days) || !days.length || days.some((day) => !(WEEKDAYS as readonly unknown[]).includes(day)))) {
      fail(`A schedule's days are some of ${WEEKDAYS.join(", ")}.`);
    }
    return { kind: "schedule", at: checkTime(value.at), tz: value.tz, ...(days != null && { days: [...new Set(days as Weekday[])] }) };
  }
  if (value.kind === "watch") {
    const every = value.everyMinutes;
    if (typeof every !== "number" || !Number.isInteger(every) || every < MIN_WATCH_MINUTES || every > MAX_WATCH_MINUTES) {
      fail(`A watch checks every ${MIN_WATCH_MINUTES} to ${MAX_WATCH_MINUTES} minutes.`);
    }
    return {
      kind: "watch",
      step: checkLook(value.step, "A watch's step"),
      everyMinutes: every,
      when: condition(value.when, field("A watch", "a", "condition")),
    };
  }
  fail('An agent\'s trigger is a "schedule" or a "watch".');
}

/** Whether an agent may use a server: every one when it has no `servers` list, else those on it. */
export function mayUseServer(agent: Pick<AgentDefinition, "servers">, server: string): boolean {
  return !agent.servers || agent.servers.includes(server);
}

/** The key of step `index` of the steps at `path`: what a run's trace, deliveries and operation ids go by. */
export function stepKey(path: string, index: number): string {
  return path ? `${path}.${index}` : String(index);
}

/** Every step of a workflow with its key, in order, those inside ifs (at `<key>.then.<i>`, `<key>.else.<i>`) too. */
export function* walkSteps(steps: readonly AgentStep[], path = ""): Generator<{ key: string; step: AgentStep }> {
  for (const [index, step] of steps.entries()) {
    const key = stepKey(path, index);
    yield { key, step };
    if (step.kind === "if") {
      yield* walkSteps(step.then, `${key}.then`);
      yield* walkSteps(step.else ?? [], `${key}.else`);
    }
  }
}

/**
 * The servers a definition's trigger, scope and steps name, nested steps included: those it reads (`reads`: look
 * steps, its scope's and its watch's), else those it calls too (do steps, a tell through a tool).
 */
export function serversNamed(agent: Pick<AgentDefinition, "trigger" | "scope" | "workflow">, { reads = false } = {}): string[] {
  const found = new Set<string>();
  if (agent.trigger?.kind === "watch") found.add(agent.trigger.step.server);
  if (agent.scope) found.add(agent.scope.list.server);
  for (const { step } of walkSteps(agent.workflow ?? [])) {
    if (step.kind === "look") found.add(step.server);
    else if (reads) continue;
    else if (step.kind === "do") found.add(step.server);
    else if (step.kind === "tell" && typeof step.via === "object") found.add(step.via.server);
  }
  return [...found];
}

/** The servers `agent` reads in a step (a look, its scope's list, its watch): a run cannot go on without them. */
export function stepServers(agent: Pick<AgentDefinition, "trigger" | "scope" | "workflow">): Set<string> {
  return new Set(serversNamed(agent, { reads: true }));
}

/** The steps a run of `agent` goes through: its workflow, or, without one, its instructions as one work step for its owner. */
export function workflowOf(agent: Pick<AgentDefinition, "workflow">): AgentStep[] {
  if (agent.workflow?.length) return agent.workflow;
  return [
    { kind: "work", prompt: "Do what your instructions say, for this run." },
    { kind: "tell", to: ["owner"], via: "chat" },
  ];
}

/** Whether a workflow calls the model at all. */
function hasWork(steps: readonly AgentStep[]): boolean {
  return [...walkSteps(steps)].some(({ step }) => step.kind === "work");
}

/**
 * The servers a run of `agent` may need a sign-in for: those its steps read, and with a work step also each of
 * `signIn` (the servers that sign in each user) it may use, since a work step's tools come from all of its servers.
 */
export function runServers(agent: Pick<AgentDefinition, "trigger" | "scope" | "workflow" | "servers">, signIn: readonly string[]): string[] {
  const reads = serversNamed(agent, { reads: true });
  if (!hasWork(workflowOf(agent))) return reads;
  return [...new Set([...reads, ...signIn.filter((server) => mayUseServer(agent, server))])];
}
/** A workflow's steps, counting those inside an if's branches toward MAX_WORKFLOW_STEPS. */
function checkSteps(value: unknown, depth = 0, count = { steps: 0 }): AgentStep[] {
  if (!Array.isArray(value)) fail("A workflow is a list of steps.");
  if (depth > 3) fail("A workflow nests at most three ifs deep.");
  count.steps += value.length;
  if (count.steps > MAX_WORKFLOW_STEPS) fail(`A workflow has at most ${MAX_WORKFLOW_STEPS} steps.`);
  return value.map((step): AgentStep => {
    if (!isObject(step) || !(STEP_KINDS as readonly unknown[]).includes(step.kind)) fail(`Each workflow step is one of ${STEP_KINDS.join(", ")}.`);
    switch (step.kind) {
      case "look":
        return checkLook(step, "A look step");
      case "work": {
        const skill = str(step.skill, field("A work step", "a", "skill"), 64, { required: false });
        const model = str(step.model, field("A work step", "a", "model"), 200, { required: false });
        return { kind: "work", prompt: str(step.prompt, field("A work step", "a", "prompt"), 4_000)!, ...(skill && { skill }), ...(model && { model }) };
      }
      case "onlyIf":
        return { kind: "onlyIf", condition: condition(step.condition, field("An onlyIf step", "a", "condition")) };
      case "if":
        return {
          kind: "if",
          condition: condition(step.condition, field("An if step", "a", "condition")),
          then: checkSteps(step.then, depth + 1, count),
          ...(step.else != null && { else: checkSteps(step.else, depth + 1, count) }),
        };
      case "do": {
        const { server, tool, input } = checkLook({ ...step, kind: "look" }, "A do step");
        return { kind: "do", server, tool, input };
      }
      case "tell": {
        const to = names(step.to, "recipients");
        if (!to?.length) fail("A tell step names who it tells.");
        const via = step.via;
        if (via === "chat" || via === "notify") return { kind: "tell", to, via };
        if (!isObject(via)) fail('A tell step goes "chat", "notify" or through {server, tool}.');
        return {
          kind: "tell",
          to,
          via: { server: str(via.server, field("A tell step", "a", "server"), 200)!, tool: str(via.tool, field("A tell step", "a", "tool"), 200)! },
        };
      }
      case "page":
        if (step.edit !== "findings" && step.edit !== "rebuild") fail('A page step edits "findings" or does a "rebuild".');
        return { kind: "page", artifactId: str(step.artifactId, field("A page step", "an", "artifact"), 64)!, edit: step.edit };
      default:
        return { kind: "handOver", agent: str(step.agent, field("A hand-over", "an", "agent to go to"), 64)! };
    }
  });
}

/** An agent's fields checked and trimmed. Throws an AgentError with what to fix. */
export function checkAgent(input: unknown): AgentInput {
  if (!isObject(input)) fail("Expected an agent as an object.");
  const name = str(input.name, field("An agent", "a", "name"), 24)!.toLowerCase();
  if (!AGENT_NAME_PATTERN.test(name)) fail('An agent\'s name is 2 to 24 lowercase letters, digits or hyphens, starting with a letter, as in "research".');
  if (RESERVED_AGENT_NAMES.has(name)) fail(`"${name}" is taken by the app; pick another name.`);
  // Up to MAX_AGENT_AVATAR characters as people see them (an emoji or a flag is one), and a few code units each.
  const avatar = str(input.avatar, field("An agent", "an", "avatar"), MAX_AGENT_AVATAR * 8, { required: false });
  if (avatar && graphemes(avatar) > MAX_AGENT_AVATAR) fail(`An agent's avatar is at most ${MAX_AGENT_AVATAR} characters.`);
  // null is none, as a client clearing a field sends it.
  const color = input.color ?? undefined;
  if (color !== undefined && !(AGENT_COLORS as readonly unknown[]).includes(color)) fail(`An agent's colour is one of ${AGENT_COLORS.join(", ")}.`);
  const effort = input.effort ?? undefined;
  if (effort !== undefined && !AGENT_EFFORTS.includes(effort as ModelThinkingLevel)) fail(`An agent's effort is one of ${AGENT_EFFORTS.join(", ")}.`);
  const autonomy = input.autonomy ?? undefined;
  if (autonomy !== undefined && autonomy !== 1 && autonomy !== 2 && autonomy !== 3 && autonomy !== 4) fail("An agent's autonomy is 1 (inform) to 4 (run).");
  const model = str(input.model, field("An agent", "a", "model"), 200, { required: false });
  const servers = names(input.servers, "servers");
  const sharedServers = names(input.sharedServers, "servers for shared chats");
  if (servers && sharedServers?.some((server) => !servers.includes(server))) fail("An agent shares only servers it may use itself.");
  const trigger = checkTrigger(input.trigger);
  const scope =
    input.scope === undefined || input.scope === null
      ? undefined
      : { list: checkLook(isObject(input.scope) ? input.scope.list : undefined, "A scope's list"), each: true as const };
  const workflow = input.workflow === undefined || input.workflow === null ? undefined : checkSteps(input.workflow);
  if (servers) {
    // A run reads and calls only the servers the agent may use, as its work steps' tools do.
    const outside = serversNamed({ trigger, scope, workflow }).find((server) => !servers.includes(server));
    if (outside) fail(`A step names ${outside}, which is not one of the agent's servers: add it to its servers, or change the step.`);
  }
  const assumed = names(input.assumed, "assumed fields");
  return {
    name,
    ...(avatar && { avatar }),
    ...(color !== undefined && { color: color as AgentColor }),
    job: str(input.job, field("An agent", "a", "job line"), MAX_AGENT_JOB)!,
    instructions: str(input.instructions, field("An agent", "", "instructions"), MAX_AGENT_INSTRUCTIONS)!,
    ...(model && { model }),
    ...(effort !== undefined && { effort: effort as ModelThinkingLevel }),
    ...(servers && { servers }),
    ...(sharedServers && { sharedServers }),
    ...(trigger && { trigger }),
    ...(scope && { scope }),
    ...(workflow && { workflow }),
    ...(autonomy !== undefined && { autonomy: autonomy as AutonomyLevel }),
    ...(assumed?.length && { assumed }),
  };
}

/** An agent's badge when it has none of its own: its name's first two letters. */
export function defaultAvatar(name: string): string {
  return name.replace(/[^a-z0-9]/g, "").slice(0, 2) || "ag";
}

/** A colour for a new agent, the same for the same name. */
export function defaultColor(name: string): AgentColor {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}

/** One agent of a chat's roster, as everyone in the chat sees it: never its instructions, which stay its owner's. */
export interface ChatAgentView {
  id: string;
  name: string;
  avatar: string;
  color: AgentColor;
  job: string;
  ownerUid: string;
  ownerName: string;
  /** Working on a turn now. */
  busy?: true;
  /** Turns waiting for it. */
  queued?: number;
  /** Its owner turned it off since it was added: it does not answer until they turn it on again. */
  off?: true;
  /** The turn it works on now (with `busy`): who gave it, how many hand-offs led to it, and how long it has run, as of this view. */
  running?: { turn: number; calledBy: ChatAgentReplyData["calledBy"]; hop: number; elapsedMs: number };
  /** The oldest turn waiting for it (with `queued`): who gave it, and how many hand-offs led to it. */
  next?: { calledBy: ChatAgentReplyData["calledBy"]; hop: number };
  /** Its latest turn that ended, and how: a stopped one posts no reply, so the chat says it stopped. */
  ended?: { turn: number; status: Exclude<AgentTurnStatus, "queued" | "running"> };
  /** Its owner shares it with the people of this chat: they can open it read-only, and copy it (SharedAgentView). */
  shared?: true;
}

/** An MCP server of the deployment, as the agent editor lists it: whether it signs in each user, and this one now. */
export interface AgentServerInfo {
  name: string;
  /** It signs in each user (MCP OAuth): an agent reads it as its owner, so a shared chat would see what the owner sees. */
  signsIn: boolean;
  /** This user has signed in to it. */
  signedIn?: true;
}

/** One chat an agent is in, as its owner's directory keeps it (the chats tell it when they add or remove the agent). */
export interface AgentChatUse {
  chatId: string;
  /** The chat's title in the owner's list. */
  title: string;
  /** Whether its owner shares the agent with the people of that chat. */
  shared: boolean;
}

/**
 * An agent its owner shares with a chat, as the people in that chat may open it: what it does and how, never who it
 * is signed in as. It keeps running as its owner; a change someone else makes is saved as their own copy.
 */
export type SharedAgentView = Pick<AgentDefinition, CopiedField | "id" | "version"> & {
  ownerUid: string;
  ownerName: string;
  /** Its latest turns in this chat, newest first. */
  turns: AgentTurnView[];
};

/** The fields of a definition a copy takes from the one it copies: what it does, never its state or who made it. */
export const COPIED_FIELDS = [
  "name",
  "avatar",
  "color",
  "job",
  "instructions",
  "model",
  "effort",
  "servers",
  "sharedServers",
  "trigger",
  "scope",
  "workflow",
] as const satisfies readonly (keyof AgentInput)[];
export type CopiedField = (typeof COPIED_FIELDS)[number];

/** Changes to a definition's fields, as a request carries them: null clears an optional one (checkAgent reads it as none). */
export type AgentChanges = { [K in keyof AgentInput]?: AgentInput[K] | null };

/**
 * A definition the model drafted, without the servers that sign in each user (`signsIn`) among those it shares: a
 * shared chat could make it read what its owner sees there. Only its owner adds one, in Setup, under its warning.
 */
export function withoutSignInShares(input: unknown, signsIn: (server: string) => boolean): unknown {
  if (!isObject(input) || !Array.isArray(input.sharedServers)) return input;
  return { ...input, sharedServers: input.sharedServers.filter((server) => typeof server !== "string" || !signsIn(server)) };
}

/** The fields a copy takes of `agent`, those it has. */
export function copiedFields(agent: Pick<AgentInput, CopiedField>): Pick<AgentInput, CopiedField> {
  const fields: AgentChanges = {};
  for (const field of COPIED_FIELDS) if (agent[field] !== undefined) Object.assign(fields, { [field]: agent[field] });
  return fields as Pick<AgentInput, CopiedField>;
}

/**
 * The fields of someone's copy of `original`: what they changed (`changes`, a request's body, checked by checkAgent when
 * saved), else the original's. Only the fields a copy takes: never its state, its guesses or where it came from.
 */
export function copyInput(original: Pick<AgentInput, CopiedField>, changes: AgentChanges): AgentChanges {
  const fields: AgentChanges = {};
  for (const field of COPIED_FIELDS) {
    const value = Object.hasOwn(changes, field) ? changes[field] : original[field];
    if (value !== undefined) Object.assign(fields, { [field]: value });
  }
  return fields;
}

/** A free handle for a copy of `name` among `taken`: the name itself, else "name-2", "name-3"… within the pattern's length. */
export function copyName(name: string, taken: (name: string) => boolean): string | null {
  if (!taken(name)) return name;
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    const candidate = `${name.slice(0, 24 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return null;
}

/**
 * The transcript entry an agent's reply is posted as, in the chat's log everyone sees (the root conversation). A
 * passive write: the model of every other agent, pi's included, reads it as context, and it starts no run. A type,
 * so pi can store it.
 */
export const CHAT_AGENT_KIND = "chat.agent";
export type ChatAgentReplyData = {
  agentId: string;
  name: string;
  avatar: string;
  color: AgentColor;
  ownerUid: string;
  /** The reply's text, as its session's final answer gave it; empty when it ended without one. */
  text: string;
  /** Who gave it this turn: a person, another agent (a hand-off), or its schedule. */
  calledBy: { name: string; uid?: string; agentId?: string; schedule?: true };
  /** The turn's id in the chat's turn table. */
  turn: number;
  /** How many hand-offs led to this turn: 0 when a person called it. */
  hop: number;
  startedAt: number;
  endedAt: number;
  /** Why it ended with no answer (failed, stopped). */
  failed?: string;
  /** Artifacts it published in this turn, for the app to show their cards. */
  published?: { artifactId: string; title: string; version: number }[];
  /** Set on a run's report and on a reply continuing it: which run, so a reply to it continues that run (shared/runs.ts). */
  run?: RunRef;
  /** The records its tool results held (shared/items.ts), as chips under the reply: from the servers, never its text. */
  items?: ItemRef[];
};

export type AgentTurnStatus = "queued" | "running" | "done" | "failed" | "stopped";

/** One turn an agent of a chat was given, as the people in the chat see it (its runs). */
export interface AgentTurnView {
  id: number;
  agentId: string;
  status: AgentTurnStatus;
  /** How many hand-offs led to it: 0 when a person or its schedule called it. */
  hop: number;
  calledBy: ChatAgentReplyData["calledBy"];
  /** Whether its owner asked for it (directly): only such a turn may use the owner's private servers and write tools. */
  byOwner: boolean;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

/** A chat's agents besides pi, and each one's latest turns, newest first. */
export interface ChatAgents {
  agents: ChatAgentView[];
  turns: Record<string, AgentTurnView[]>;
}

/**
 * What a turn is placed as in an agent's own session: a one-line input naming who asked, in place of pi's `pi.user`,
 * so its step panel shows where the turn came from. Also how pi itself is handed a turn by another agent: `turn` is
 * then the turn that named pi, and `root` the chain it is in, which pi's answer carries on.
 */
export const CHAT_TURN_KIND = "chat.turn";
export type ChatTurnData = { turn: number; calledBy: ChatAgentReplyData["calledBy"]; hop: number; root?: number };

/** How an agent is labelled in the lines its sessions read: "[research · agent]", "[Ana · person · your owner]". */
export function speakerLabel(speaker: { name: string; kind: "person" | "agent"; owner?: boolean }): string {
  // A name cannot close the label or add a part to it ("Ana · person · your owner" as a display name).
  const name =
    speaker.name
      .replace(/[[\]·\r\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "someone";
  return `[${name} · ${speaker.kind}${speaker.owner ? " · your owner" : ""}]`;
}

/** The tool the model proposes an agent with (saved off, for its owner to review). */
export const AGENT_PROPOSE_TOOL = "agent_propose";
/** What agent_propose's result carries, for the app to show the draft card. A type, so pi can store it. */
export type AgentProposedDetails = { agentId: string; name: string; version: number; assumed?: string[] };

/** The agent a proposal's result drafted, which shows as a draft card; undefined for any other entry. */
export function proposedBy(entry: { kind: string; model?: readonly unknown[] }): AgentProposedDetails | undefined {
  if (entry.kind !== "pi.tool-result") return undefined;
  const message = entry.model?.[0] as { toolName?: string; isError?: boolean; details?: unknown } | undefined;
  if (message?.toolName !== AGENT_PROPOSE_TOOL || message.isError) return undefined;
  const details = message.details as Partial<AgentProposedDetails> | undefined;
  return typeof details?.agentId === "string" && AGENT_ID_PATTERN.test(details.agentId) && typeof details.name === "string"
    ? (details as AgentProposedDetails)
    : undefined;
}
