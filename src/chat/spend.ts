import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { modelKeyOfLedger } from "../../shared/models.ts";
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

/** `a` less `b`, never below zero: sums of the same costs in another order can differ in the last digits. */
function minus(a: Spend, b: Spend): Spend {
  const at = (key: keyof Spend) => Math.max(0, a[key] - b[key]);
  return { cost: at("cost"), input: at("input"), output: at("output"), cacheRead: at("cacheRead"), cacheWrite: at("cacheWrite") };
}

/** How long work took: wall-clock time, and how long model replies and tools ran within it (tools can overlap). */
export interface Timing {
  ms: number;
  modelMs: number;
  toolMs: number;
  replies: number;
  tools: number;
  prompts: number;
}

/** What a prompt cost, and how long it took. */
export type PromptSpend = Spend & { time: Timing };

const NO_TIME: Timing = { ms: 0, modelMs: 0, toolMs: 0, replies: 0, tools: 0, prompts: 0 };

function plusTime(a: Timing, b: Timing): Timing {
  return { ms: a.ms + b.ms, modelMs: a.modelMs + b.modelMs, toolMs: a.toolMs + b.toolMs, replies: a.replies + b.replies, tools: a.tools + b.tools, prompts: a.prompts + b.prompts };
}

/**
 * What each prompt cost and took: the model replies, and the tool results that report a spend, from a person's
 * message up to the next one. Keyed by the id of the prompt's last reply or tool result, which is where the app shows
 * it. Messages placed together (sent while the agent was busy) make one prompt; one the model never answered is left
 * out. While `running`, the newest prompt no one has written after is left out too: it may cost more yet. Its time
 * runs from when its messages were placed (where the app's run timer starts too) to when its last reply or tool
 * result came in.
 */
export function promptSpend(entries: readonly EntryRecord[], running: boolean): Map<number, PromptSpend> {
  const spend = new Map<number, PromptSpend>();
  let total = NONE;
  let [modelMs, toolMs, replies, tools, end] = [0, 0, 0, 0, 0];
  let start: number | undefined;
  let at: number | undefined;
  for (const entry of entries) {
    const message = entry.model?.[0];
    // A person's message: a prompt starts. `pi.user` is one from before chats were shared.
    if (entry.kind === CHAT_MESSAGE_KIND || entry.kind === "pi.user") {
      total = NONE;
      [modelMs, toolMs, replies, tools, end] = [0, 0, 0, 0, 0];
      // Messages placed together share one time, so the newest one's is the prompt's. An earlier one whose run failed
      // before any reply is not part of it: the person wrote again later.
      start = message?.role === "user" ? message.timestamp : undefined;
      at = undefined;
      continue;
    }
    let usage: Usage | undefined;
    if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      usage = message.usage;
      // Replies from before pi timed them have no duration: they count from their start.
      modelMs += message.durationMs ?? 0;
      replies++;
      start ??= message.timestamp;
      end = Math.max(end, message.timestamp + (message.durationMs ?? 0));
    } else if (entry.kind === "pi.tool-result" && message?.role === "toolResult" && at !== undefined) {
      usage = message.usage;
      toolMs += message.durationMs ?? 0;
      tools++;
      end = Math.max(end, message.timestamp);
    } else continue;
    if (usage) total = plus(total, spendOf(usage));
    if (at !== undefined) spend.delete(at);
    at = entry.id;
    // A reply came first in this prompt (a tool result needs one), so `start` is set.
    spend.set(at, { ...total, time: { ms: Math.max(0, end - start!), modelMs, toolMs, replies, tools, prompts: 1 } });
  }
  if (running && at !== undefined) spend.delete(at);
  return spend;
}

/** The time of all the prompts in `prompts`, added up. */
export function totalTime(prompts: Iterable<PromptSpend>): Timing {
  return [...prompts].reduce((sum, prompt) => plusTime(sum, prompt.time), NO_TIME);
}

/** One row of a chat's spend: a model at one effort (none for replies from before efforts were recorded), or a tool. */
export type Share = Spend & { model: string; effort?: ModelThinkingLevel };

/** What a model's replies cost at each effort. */
type EffortSpend = Map<ModelThinkingLevel | undefined, Spend>;

/** What each model's replies in `entries` cost at each effort, keyed like pi's ledger: `provider/modelId`. */
function replySpend(entries: readonly EntryRecord[]): Map<string, EffortSpend> {
  const models = new Map<string, EffortSpend>();
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind !== "pi.assistant" || message?.role !== "assistant") continue;
    const key = `${message.provider}/${message.model}`;
    let efforts = models.get(key);
    if (!efforts) models.set(key, (efforts = new Map()));
    efforts.set(message.thinkingLevel, plus(efforts.get(message.thinkingLevel) ?? NONE, spendOf(message.usage)));
  }
  return models;
}

/**
 * A model's share of the ledger, by the effort its replies were asked at. The ledger also counts calls that are no
 * reply (those that summarize a long conversation, at the chat's effort then). When `entries` hold every reply and
 * they all ran at one effort, those did too; otherwise which one is not known (after a summary, a reloaded chat's
 * entries start at it, and the replies before it are in the ledger only), and they go with the replies whose effort is
 * not known either. A leftover without tokens is only the rounding of the same costs summed in another order.
 */
function byEffort(model: string, total: Spend, efforts: EffortSpend | undefined, everyReply: boolean): Share[] {
  if (!efforts) return [{ ...total, model }];
  const left = minus(total, [...efforts.values()].reduce(plus, NONE));
  const rest = left.input + left.output + left.cacheRead + left.cacheWrite > 0 ? left : NONE;
  const to = everyReply && efforts.size === 1 ? efforts.keys().next().value : undefined;
  const shares = new Map(efforts).set(to, plus(efforts.get(to) ?? NONE, rest));
  return [...shares].map(([effort, spend]) => ({ ...spend, model, effort }));
}

/**
 * A chat's spend from pi's ledger, by model and the effort each reply in `entries` was asked at, costliest first: model
 * replies, and the calls that summarize a long conversation. A tool that reports a spend of its own counts too, under
 * the tool's name.
 */
export function chatSpend(usage: UsageState | undefined, entries: readonly EntryRecord[] = []): { total: Spend; models: Share[] } {
  const replies = replySpend(entries);
  // Entries that open with a head marker (a summary's) start there: the replies before it are left out.
  const everyReply = entries[0]?.head === undefined;
  const models = [
    // Keyed `provider/modelId`: named as the picker names the model.
    ...Object.entries(usage?.models ?? {}).flatMap(([key, value]) => byEffort(modelKeyOfLedger(key), spendOf(value as Usage), replies.get(key), everyReply)),
    ...Object.entries(usage?.tools ?? {}).map(([model, value]): Share => ({ ...spendOf(value as Usage), model })),
  ]
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

const COUNT = new Intl.NumberFormat("en-US");
export const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

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
