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

/**
 * What each prompt cost: the model replies, and the tool results that report a spend, from a person's message up to
 * the next one. Keyed by the id of the prompt's last reply or tool result, which is where the app shows it. Messages
 * placed together (sent while the agent was busy) make one prompt; one the model never answered is left out. While
 * `running`, the newest prompt no one has written after is left out too: it may cost more yet.
 */
export function promptSpend(entries: readonly EntryRecord[], running: boolean): Map<number, Spend> {
  const spend = new Map<number, Spend>();
  let total = NONE;
  let at: number | undefined;
  for (const entry of entries) {
    // A person's message: a prompt starts. `pi.user` is one from before chats were shared.
    if (entry.kind === CHAT_MESSAGE_KIND || entry.kind === "pi.user") {
      total = NONE;
      at = undefined;
      continue;
    }
    const message = entry.model?.[0];
    let usage: Usage | undefined;
    if (entry.kind === "pi.assistant" && message?.role === "assistant") usage = message.usage;
    else if (entry.kind === "pi.tool-result" && message?.role === "toolResult" && at !== undefined) usage = message.usage;
    else continue;
    if (usage) total = plus(total, spendOf(usage));
    if (at !== undefined) spend.delete(at);
    at = entry.id;
    spend.set(at, total);
  }
  if (running && at !== undefined) spend.delete(at);
  return spend;
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

const SMALL = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 2 });
const LARGE = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Dollars: two significant digits below a dollar ($0.0042, $0.37), cents from a dollar on ($12.40). */
export function formatCost(dollars: number): string {
  if (dollars <= 0) return "$0.00";
  if (dollars < 0.0001) return "<$0.0001";
  // Below 0.995, two significant digits stay below a dollar.
  return dollars < 0.995 ? SMALL.format(dollars) : LARGE.format(dollars);
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
