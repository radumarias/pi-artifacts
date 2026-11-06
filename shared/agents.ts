// Agents: named helpers a user defines once and brings into their chats. Each one has its own name (called as
// "@name"), job line, instructions, model and effort, and the MCP servers it may use. A definition lives in its owner's
// UserDirectory; a chat keeps only a roster that points at definitions, and runs each agent in a Pi session of its
// own. An agent always acts as its owner. The fields for running on its own (a trigger, a scope, a workflow, an
// autonomy level) are stored here too, for the scheduler.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AGENT_NAME } from "./mentions.ts";

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

const EFFORTS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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

/** An MCP read through the hub, run in code: no model is involved. */
export type LookStep = { kind: "look"; server: string; tool: string; input: StepInput };

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

/** Whether a definition is a proposal waiting for its owner: made by the model and not turned on yet. */
export function isDraftAgent(agent: Pick<AgentDefinition, "origin" | "enabled">): boolean {
  return agent.origin === "agent" && !agent.enabled;
}

/** A failed change to an agent, with what to fix. RPC keeps an error's message but not its class. */
export type AgentResult = AgentDefinition | { error: string };

/** Thrown by checkAgent with what to fix. */
export class AgentError extends Error {}

function fail(message: string): never {
  throw new AgentError(message);
}

function str(value: unknown, field: string, max: number, { required = true } = {}): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`An agent needs ${field}.`);
    return undefined;
  }
  if (typeof value !== "string") fail(`An agent's ${field} must be text.`);
  const trimmed = value.trim();
  if (!trimmed && required) fail(`An agent needs ${field}.`);
  if (trimmed.length > max) fail(`An agent's ${field} is at most ${max} characters.`);
  return trimmed || undefined;
}

function names(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) fail(`An agent's ${field} must be a list of names.`);
  if (value.length > MAX_AGENT_SERVERS) fail(`An agent lists at most ${MAX_AGENT_SERVERS} ${field}.`);
  return [...new Set((value as string[]).map((item) => item.trim()))];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const server = str(value.server, `${what}'s server`, 200)!;
  const tool = str(value.tool, `${what}'s tool`, 200)!;
  const input = value.input === undefined ? {} : value.input;
  if (!isObject(input)) fail(`${what}'s input must be an object.`);
  // Plain JSON, kept small: it is stored with the definition and read back as JSON anyway.
  const json = JSON.stringify(input);
  if (json.length > MAX_STEP_INPUT) fail(`${what}'s input is too long (at most ${MAX_STEP_INPUT} characters as JSON).`);
  return { kind: "look", server, tool, input: JSON.parse(json) as StepInput };
}

function checkTrigger(value: unknown): AgentTrigger | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) fail("An agent's trigger must be an object.");
  if (value.kind === "schedule") {
    if (!isTimeZone(value.tz)) fail("A schedule needs a time zone, such as \"Europe/Bucharest\".");
    const days = value.days;
    if (days !== undefined && (!Array.isArray(days) || !days.length || days.some((day) => !(WEEKDAYS as readonly unknown[]).includes(day)))) {
      fail(`A schedule's days are some of ${WEEKDAYS.join(", ")}.`);
    }
    return { kind: "schedule", at: checkTime(value.at), tz: value.tz, ...(days !== undefined && { days: [...new Set(days as Weekday[])] }) };
  }
  if (value.kind === "watch") {
    const every = value.everyMinutes;
    if (typeof every !== "number" || !Number.isInteger(every) || every < MIN_WATCH_MINUTES || every > MAX_WATCH_MINUTES) {
      fail(`A watch checks every ${MIN_WATCH_MINUTES} to ${MAX_WATCH_MINUTES} minutes.`);
    }
    return { kind: "watch", step: checkLook(value.step, "A watch's step"), everyMinutes: every, when: str(value.when, "a watch's condition", 500)! };
  }
  fail('An agent\'s trigger is a "schedule" or a "watch".');
}

function checkSteps(value: unknown, depth = 0): AgentStep[] {
  if (!Array.isArray(value)) fail("A workflow is a list of steps.");
  if (value.length > MAX_WORKFLOW_STEPS) fail(`A workflow has at most ${MAX_WORKFLOW_STEPS} steps.`);
  if (depth > 3) fail("A workflow nests at most three ifs deep.");
  return value.map((step): AgentStep => {
    if (!isObject(step) || !(STEP_KINDS as readonly unknown[]).includes(step.kind)) fail(`Each workflow step is one of ${STEP_KINDS.join(", ")}.`);
    switch (step.kind) {
      case "look":
        return checkLook(step, "A look step");
      case "work":
        return {
          kind: "work",
          prompt: str(step.prompt, "a work step's prompt", 4_000)!,
          ...(step.skill !== undefined && { skill: str(step.skill, "a work step's skill", 64)! }),
          ...(step.model !== undefined && { model: str(step.model, "a work step's model", 200)! }),
        };
      case "onlyIf":
        return { kind: "onlyIf", condition: str(step.condition, "a condition", 500)! };
      case "if":
        return {
          kind: "if",
          condition: str(step.condition, "a condition", 500)!,
          then: checkSteps(step.then, depth + 1),
          ...(step.else !== undefined && { else: checkSteps(step.else, depth + 1) }),
        };
      case "do": {
        const { server, tool, input } = checkLook({ ...step, kind: "look" }, "A do step");
        return { kind: "do", server, tool, input };
      }
      case "tell": {
        const to = names(step.to, "recipients") ?? fail("A tell step names who it tells.");
        const via = step.via;
        if (via === "chat" || via === "notify") return { kind: "tell", to, via };
        if (!isObject(via)) fail('A tell step goes "chat", "notify" or through {server, tool}.');
        return { kind: "tell", to, via: { server: str(via.server, "a tell step's server", 200)!, tool: str(via.tool, "a tell step's tool", 200)! } };
      }
      case "page":
        if (step.edit !== "findings" && step.edit !== "rebuild") fail('A page step edits "findings" or does a "rebuild".');
        return { kind: "page", artifactId: str(step.artifactId, "a page step's artifact", 64)!, edit: step.edit };
      default:
        return { kind: "handOver", agent: str(step.agent, "the agent a hand-over goes to", 64)! };
    }
  });
}

/** An agent's fields checked and trimmed. Throws an AgentError with what to fix. */
export function checkAgent(input: unknown): AgentInput {
  if (!isObject(input)) fail("Expected an agent as an object.");
  const name = str(input.name, "a name", 24)!.toLowerCase();
  if (!AGENT_NAME_PATTERN.test(name)) fail("An agent's name is 2 to 24 lowercase letters, digits or hyphens, starting with a letter, as in \"research\".");
  if (RESERVED_AGENT_NAMES.has(name)) fail(`"${name}" is taken by the app; pick another name.`);
  const avatar = str(input.avatar, "avatar", MAX_AGENT_AVATAR, { required: false });
  const color = input.color;
  if (color !== undefined && !(AGENT_COLORS as readonly unknown[]).includes(color)) fail(`An agent's colour is one of ${AGENT_COLORS.join(", ")}.`);
  const effort = input.effort;
  if (effort !== undefined && !EFFORTS.includes(effort as ModelThinkingLevel)) fail(`An agent's effort is one of ${EFFORTS.join(", ")}.`);
  const autonomy = input.autonomy;
  if (autonomy !== undefined && autonomy !== 1 && autonomy !== 2 && autonomy !== 3 && autonomy !== 4) fail("An agent's autonomy is 1 (inform) to 4 (run).");
  const model = str(input.model, "model", 200, { required: false });
  const servers = names(input.servers, "servers");
  const sharedServers = names(input.sharedServers, "servers for shared chats");
  if (servers && sharedServers?.some((server) => !servers.includes(server))) fail("An agent shares only servers it may use itself.");
  const trigger = checkTrigger(input.trigger);
  const scope = input.scope === undefined || input.scope === null ? undefined : { list: checkLook(isObject(input.scope) ? input.scope.list : undefined, "A scope's list"), each: true as const };
  const workflow = input.workflow === undefined || input.workflow === null ? undefined : checkSteps(input.workflow);
  const assumed = names(input.assumed, "assumed fields");
  return {
    name,
    ...(avatar && { avatar }),
    ...(color !== undefined && { color: color as AgentColor }),
    job: str(input.job, "a job line", MAX_AGENT_JOB)!,
    instructions: str(input.instructions, "instructions", MAX_AGENT_INSTRUCTIONS)!,
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
  /** The transcript entry of the message it answered, when there is one. */
  answers?: number;
  /** Artifacts it published in this turn, for the app to show their cards. */
  published?: { artifactId: string; title: string; version: number }[];
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
  /** The log entry of the message that called it, if any. */
  answers?: number;
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
 * so its step panel shows where the turn came from. Also how pi itself is handed a turn by another agent.
 */
export const CHAT_TURN_KIND = "chat.turn";
export type ChatTurnData = { turn: number; calledBy: ChatAgentReplyData["calledBy"]; hop: number };

/** "@name" as a word, the way AGENT_PATTERN in mentions.ts finds "@pi": not in an address, a longer name or a path. */
function callPattern(name: string, flags: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(^|[^\\w@.])@${escaped}(?![\\w/@-]|\\.\\w)`, flags);
}

/** The names among `names` the text calls with "@name", in the order it first calls them. */
export function calledNames(text: string, names: readonly string[]): string[] {
  const found: { name: string; at: number }[] = [];
  for (const name of names) {
    const match = callPattern(name, "i").exec(text);
    if (match) found.push({ name, at: match.index + match[1].length });
  }
  return found.sort((a, b) => a.at - b.at).map(({ name }) => name);
}

/** Each "@name" of an agent in the text, for the transcript to show as chips. */
export function splitAgentCalls(text: string, names: readonly string[]): { text: string; agent?: string }[] {
  const hits: { at: number; end: number; agent: string }[] = [];
  for (const name of names) {
    for (const match of text.matchAll(callPattern(name, "gi"))) {
      const at = match.index + match[1].length;
      hits.push({ at, end: at + name.length + 1, agent: name });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const parts: { text: string; agent?: string }[] = [];
  let plain = 0;
  for (const hit of hits) {
    if (hit.at < plain) continue;
    if (hit.at > plain) parts.push({ text: text.slice(plain, hit.at) });
    parts.push({ text: text.slice(hit.at, hit.end), agent: hit.agent });
    plain = hit.end;
  }
  if (plain < text.length) parts.push({ text: text.slice(plain) });
  return parts;
}

/** How an agent is labelled in the lines its sessions read: "[research · agent]", "[Ana · person · your owner]". */
export function speakerLabel(speaker: { name: string; kind: "person" | "agent"; owner?: boolean }): string {
  return `[${speaker.name} · ${speaker.kind}${speaker.owner ? " · your owner" : ""}]`;
}

/** The tool the model proposes an agent with (saved off, for its owner to review). */
export const AGENT_PROPOSE_TOOL = "agent_propose";
/** What agent_propose's result carries, for the app to show the draft card. A type, so pi can store it. */
export type AgentProposedDetails = { agentId: string; name: string; version: number; assumed?: string[] };
