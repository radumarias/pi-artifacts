// Runs of an agent on its own: what started one, how it went step by step, what it sent and to whom. A run is one due
// time of one agent; with a scope ("each region") it has an item per element of the scope's list, each in a session of
// its own. The run records live in the agent's home conversation (a chat object of its owner), and the app reads them
// as these views.

import type { AgentStep } from "./agents.ts";

/** What started a run: its schedule, a watch whose condition held, Test it, or a person asking for one now. */
export type RunWhy = "schedule" | "watch" | "test" | "manual";

/**
 * How a run ended: `sent` when it acted on at least one item, `not_today` when every item stopped at a condition (no
 * model call), `failed`, or `needs_sign_in` when a server it reads needs its owner to sign in again (kept to retry).
 */
export type RunStatus = "running" | "sent" | "not_today" | "failed" | "needs_sign_in";
export type RunItemStatus = "running" | "acted" | "not_today" | "failed";

/** One step as a run went through it, for the run detail's "How it got there". */
export interface RunStepRecord {
  kind: AgentStep["kind"] | "when" | "scope";
  /** What the step was, in words: "Look at sales.query", "Only if signups vs lastYear < -5%". */
  label: string;
  /** What came of it: a result's start, "held", "did not hold: stopped here", why it failed. */
  detail?: string;
  /** Whether it did what it was for: false for a condition that stopped the item, or a step that failed. */
  ok: boolean;
  /** How long it took, and what it cost (work steps). */
  ms: number;
  cost?: number;
}

/** Where a run's report went: a chat, a notification, an outside tool, a page version, another agent. */
export type RunDeliveryKind = "chat" | "notify" | "tool" | "page" | "handOver";

/** One thing a run sent or changed, or would have (a test run records them instead). */
export interface RunDelivery {
  kind: RunDeliveryKind;
  /** Who or where: "you", a chat's title, "server.tool", a page's title, "@agent". */
  to: string;
  /** What it sent: the report as posted. */
  text?: string;
  /** `recorded`: a test run's, nothing was sent; `refused`: not at this autonomy level, or not allowed. */
  status: "sent" | "recorded" | "refused" | "failed";
  /** Why it was refused or failed, or what came of it ("Signups brief v38 published"). */
  detail?: string;
  /** The page version a page step published. */
  version?: number;
}

/** One item of a run: an element of its scope's list, or the run itself when it has no scope. */
export interface RunItemView {
  /** The item's key in the run ("" when the run has no scope). */
  item: string;
  /** What people call it: the element's name or title, else its key. */
  label: string;
  status: RunItemStatus;
  /** Its pi session, whose entries are the full trace. */
  session?: string;
  steps: RunStepRecord[];
  /** What its work steps came to: its part of the report. */
  text?: string;
  /** Why it stopped: the condition that did not hold, or the failure. */
  reason?: string;
  /** The delivery steps (tell, page, hand over) it reached, by their place in the workflow: what its text goes out with. */
  reached?: string[];
  /** For a delivery step it reached before its last work step: its text as it was then, which that delivery sends. */
  textAt?: Record<string, string>;
  cost: number;
  startedAt: number;
  endedAt?: number;
}

/** A run in the runs list. */
export interface AgentRunView {
  agentId: string;
  /** When it was due (epoch ms): with the agent, what names the run. */
  dueAt: number;
  why: RunWhy;
  status: RunStatus;
  /** Set on a run from Test it: nothing was sent or changed. */
  test?: true;
  startedAt: number;
  endedAt?: number;
  /** In dollars, every work step of every item. */
  cost: number;
  /** How many items it had, acted on, or stopped at a condition ("not today"). */
  items: { total: number; acted: number; notToday: number; failed: number };
  /** The report's first line, or why it failed. */
  summary?: string;
  /** The servers whose sign-in it waits for (status needs_sign_in). */
  needsSignIn?: string[];
}

/** An agent's runs as its Runs tab reads them: newest first, when it runs next, and its own chat (null before one). */
export interface AgentRunList {
  runs: AgentRunView[];
  nextRunAt: number | null;
  homeChatId: string | null;
}

/** One run in full, for its detail page. */
export interface AgentRunDetail extends AgentRunView {
  /** "Every day at 07:00 (Europe/Bucharest)", "when signups vs lastYear < -5% (checked every 60 minutes)". */
  when: string;
  itemsList: RunItemView[];
  deliveries: RunDelivery[];
  /** What it used: the skills its work steps named, the servers it read, the models it ran on. */
  used: { skills: string[]; servers: string[]; models: string[] };
}

/** What a run's post in a chat carries (ChatAgentReplyData.run): which run, so a reply can continue it. */
export type RunRef = { dueAt: number; why: RunWhy; test?: true };

/** The ref of a run, from anything that has its due time, why it ran and whether it was a test. */
export function runRef(run: { dueAt: number; why: RunWhy; test?: boolean }): RunRef {
  return { dueAt: run.dueAt, why: run.why, ...(run.test && { test: true as const }) };
}

/** How many runs the runs list keeps per agent; older ones go. */
export const KEPT_RUNS = 200;
/** How many items of a scope's list one run takes at most. */
export const MAX_RUN_ITEMS = 50;
/** How many items run at once. */
export const RUN_CONCURRENCY = 4;

/** The labels of the workflow steps, as the Workflow tab and a run's trace show them. */
export const STEP_LABELS: Record<AgentStep["kind"] | "when" | "scope", string> = {
  when: "When",
  scope: "For each",
  look: "Look at",
  work: "Work out",
  onlyIf: "Only if",
  if: "If",
  do: "Do",
  tell: "Tell",
  page: "Page",
  handOver: "Hand over",
};

/**
 * What a step does, after its label: "sales.weekly_sales as sales", "sales vs lastYear < -5%", "owner in chat". The
 * Workflow tab's cards and a run's steps both say a step this way.
 */
export function stepSummary(step: AgentStep): string {
  switch (step.kind) {
    case "look":
    case "do":
      return step.server || step.tool ? `${step.server}.${step.tool}${step.kind === "look" && step.as ? ` as ${step.as}` : ""}` : "(not set)";
    case "work":
      return step.prompt.split("\n").find((line) => line.trim())?.trim() || "(not set)";
    case "onlyIf":
    case "if":
      return step.condition || "(not set)";
    case "tell":
      return `${step.to.join(", ")} ${typeof step.via === "object" ? `through ${step.via.server}.${step.via.tool}` : step.via === "notify" ? "as a notification" : "in chat"}`;
    case "page":
      return `${step.artifactId || "(not set)"}, ${step.edit === "findings" ? "its findings" : "rebuilt"}`;
    case "handOver":
      return `to @${step.agent || "(not set)"}`;
  }
}
