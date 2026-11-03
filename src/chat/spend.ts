import type { Usage } from "@earendil-works/pi-ai";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { CHAT_MESSAGE_KIND } from "../../shared/protocol.ts";

/**
 * What model calls cost. pi-ai prices each model reply when it comes in, from its model's prices (worker/models.ts
 * keeps them current), and stores the price with the reply; a tool that calls a model reports its spend on its result.
 * pi also keeps a ledger of the conversation's spend by model and tool, which counts the calls that summarize a long
 * conversation too.
 */
export interface Spend {
  /** In dollars. */
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const NONE: Spend = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function spendOf(usage: Usage): Spend {
  return { cost: usage.cost.total, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
}

function plus(a: Spend, b: Spend): Spend {
  return { cost: a.cost + b.cost, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** How long work took: wall-clock time, and how long model replies and tools ran within it (tools can overlap). */
export interface Timing {
  ms: number;
  modelMs: number;
  toolMs: number;
  /** Model replies and tool calls. */
  calls: number;
  tools: number;
}

/** What a prompt cost, and how long it took. */
export type PromptSpend = Spend & { time: Timing };

const NO_TIME: Timing = { ms: 0, modelMs: 0, toolMs: 0, calls: 0, tools: 0 };

/**
 * What each prompt cost and took: the model replies, and the tool results that report a spend, from a person's
 * message up to the next one. Keyed by the id of the prompt's last reply or tool result, which is where the app shows
 * it. Messages placed together (sent while the agent was busy) make one prompt; one the model never answered is left
 * out. While `running`, the newest prompt no one has written after is left out too: it may cost more yet. Its time
 * runs from when the person's message was placed (the run's start, as the app's timer has it) to when its last reply
 * or tool result came in.
 */
export function promptSpend(entries: readonly EntryRecord[], running: boolean): Map<number, PromptSpend> {
  const spend = new Map<number, PromptSpend>();
  let total = NONE;
  let time = NO_TIME;
  let start: number | undefined;
  let at: number | undefined;
  for (const entry of entries) {
    const message = entry.model?.[0];
    // A person's message: a prompt starts. `pi.user` is one from before chats were shared.
    if (entry.kind === CHAT_MESSAGE_KIND || entry.kind === "pi.user") {
      total = NONE;
      time = NO_TIME;
      start = message?.role === "user" ? message.timestamp : undefined;
      at = undefined;
      continue;
    }
    let usage: Usage | undefined;
    let end: number;
    if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      usage = message.usage;
      // Replies from before pi timed them have no duration: they count from their start.
      end = message.timestamp + (message.durationMs ?? 0);
      start ??= message.timestamp;
      time = { ...time, modelMs: time.modelMs + (message.durationMs ?? 0), calls: time.calls + 1 };
    } else if (entry.kind === "pi.tool-result" && message?.role === "toolResult" && at !== undefined) {
      usage = message.usage;
      end = message.timestamp;
      time = { ...time, toolMs: time.toolMs + (message.durationMs ?? 0), tools: time.tools + 1 };
    } else continue;
    if (usage) total = plus(total, spendOf(usage));
    time = { ...time, ms: Math.max(time.ms, end - (start ?? end)) };
    if (at !== undefined) spend.delete(at);
    at = entry.id;
    spend.set(at, { ...total, time });
  }
  if (running && at !== undefined) spend.delete(at);
  return spend;
}

/** The time of all the prompts in `prompts`, added up. */
export function totalTime(prompts: Iterable<PromptSpend>): Timing {
  let sum = NO_TIME;
  for (const { time } of prompts) {
    sum = { ms: sum.ms + time.ms, modelMs: sum.modelMs + time.modelMs, toolMs: sum.toolMs + time.toolMs, calls: sum.calls + time.calls, tools: sum.tools + time.tools };
  }
  return sum;
}

/**
 * A chat's spend from pi's ledger, by model, costliest first: model replies, and the calls that summarize a long
 * conversation. A tool that reports a spend of its own counts too, under the tool's name.
 */
export function chatSpend(usage: UsageState | undefined): { total: Spend; models: (Spend & { model: string })[] } {
  const models = [
    // Keyed `provider/modelId`; every model comes through the one provider, so its name says nothing.
    ...Object.entries(usage?.models ?? {}).map(([key, value]) => [key.slice(key.indexOf("/") + 1), value] as const),
    ...Object.entries(usage?.tools ?? {}),
  ]
    .map(([model, value]) => ({ ...spendOf(value as Usage), model }))
    .filter((spend) => spend.cost > 0 || spend.input + spend.output > 0)
    .sort((a, b) => b.cost - a.cost);
  return { total: models.reduce<Spend>(plus, NONE), models };
}

// Both bounds: with only a maximum, 0.5 comes out as "$0.5".
const SMALL = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumSignificantDigits: 2, maximumSignificantDigits: 2 });
const LARGE = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Dollars: two significant digits below a dollar ($0.0042, $0.37), cents from a dollar on ($12.40). */
export function formatCost(dollars: number): string {
  if (dollars <= 0) return "$0.00";
  if (dollars < 0.0001) return "<$0.0001";
  // Below 0.995, two significant digits stay below a dollar.
  return dollars < 0.995 ? SMALL.format(dollars) : LARGE.format(dollars);
}

/** A duration: 0.4s, 4.2s, 42s, 3m 5s, 1h 4m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 9.95) return `${seconds.toFixed(1)}s`;
  if (seconds < 59.5) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds) / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ${Math.round(seconds) % 60}s`;
  const rounded = Math.round(minutes);
  return `${Math.floor(rounded / 60)}h ${rounded % 60}m`;
}

/** Where the time went, for a tooltip: "model replies 48s (3), tools 31s (2)". */
export function describeTime(time: Timing): string {
  const parts = [`model replies ${formatDuration(time.modelMs)} (${time.calls})`];
  if (time.tools) parts.push(`tools ${formatDuration(time.toolMs)} (${time.tools})`);
  return parts.join(", ");
}

const COUNT = new Intl.NumberFormat("en-US");
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Tokens in and out, short: input counts what came from the cache and went into it too. */
export function shortTokens(spend: Spend): string {
  return `${COMPACT.format(spend.input + spend.cacheRead + spend.cacheWrite)} in · ${COMPACT.format(spend.output)} out`;
}

/** The tokens behind a spend, in full, for a tooltip. */
export function describeTokens(spend: Spend): string {
  const parts = [`${COUNT.format(spend.input)} input`];
  if (spend.cacheRead) parts.push(`${COUNT.format(spend.cacheRead)} read from cache`);
  if (spend.cacheWrite) parts.push(`${COUNT.format(spend.cacheWrite)} written to cache`);
  parts.push(`${COUNT.format(spend.output)} output tokens`);
  return parts.join(", ");
}
