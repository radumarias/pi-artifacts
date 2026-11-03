import type { Usage } from "@earendil-works/pi-ai";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { CHAT_MESSAGE_KIND } from "../../shared/protocol.ts";

/**
 * What model calls cost. pi-ai prices each model reply when it comes in, from its model's prices (worker/models.ts
 * keeps them current), and stores the price with the reply; pi also keeps a ledger of the conversation's spend by
 * model, which counts the calls that summarize a long conversation too.
 */
export interface Spend {
  /** In dollars. */
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One model's share of a chat's spend: `model` as the replies name it (anthropic/claude-opus-5.5, @cf/…). */
export type ModelSpend = Spend & { model: string };

const NONE: Spend = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** `total` plus one reply's usage, or one ledger bucket's. */
function add(total: Spend, usage: Partial<Usage> | undefined): Spend {
  return {
    cost: total.cost + (usage?.cost?.total ?? 0),
    input: total.input + (usage?.input ?? 0),
    output: total.output + (usage?.output ?? 0),
    cacheRead: total.cacheRead + (usage?.cacheRead ?? 0),
    cacheWrite: total.cacheWrite + (usage?.cacheWrite ?? 0),
  };
}

function plus(a: Spend, b: Spend): Spend {
  return { cost: a.cost + b.cost, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** A person's message: where a prompt starts. `pi.user` is a message from before chats were shared. */
function isPrompt(entry: EntryRecord): boolean {
  return entry.kind === CHAT_MESSAGE_KIND || entry.kind === "pi.user";
}

/**
 * What each prompt cost: the model replies from a person's message up to the next one. Keyed by the id of the
 * prompt's last reply or tool result, which is where the app shows it. Messages placed together (sent while the agent
 * was busy) make one prompt; one the model never answered is left out. `open` is the newest prompt's key when no one
 * has written since: while a run goes, that prompt may cost more yet.
 */
export function promptSpend(entries: readonly EntryRecord[]): { spend: Map<number, Spend>; open?: number } {
  const spend = new Map<number, Spend>();
  let total = NONE;
  let at: number | undefined;
  for (const entry of entries) {
    if (isPrompt(entry)) {
      if (at !== undefined) spend.set(at, total);
      total = NONE;
      at = undefined;
      continue;
    }
    const message = entry.model?.[0];
    if (entry.kind === "pi.assistant" && message?.role === "assistant") total = add(total, message.usage);
    else if (entry.kind !== "pi.tool-result" || at === undefined) continue;
    at = entry.id;
  }
  if (at !== undefined) spend.set(at, total);
  return { spend, open: at };
}

/**
 * A chat's spend from pi's ledger, by model, costliest first: model replies, and the calls that summarize a long
 * conversation. A tool that reports a spend of its own counts too, under the tool's name.
 */
export function chatSpend(usage: UsageState | undefined): { total: Spend; models: ModelSpend[] } {
  const buckets = [
    // Keyed `provider/modelId`; every model comes through the one provider, so its name says nothing.
    ...Object.entries(usage?.models ?? {}).map(([key, value]) => ({ model: key.slice(key.indexOf("/") + 1), usage: value as Usage })),
    ...Object.entries(usage?.tools ?? {}).map(([key, value]) => ({ model: key, usage: value as Usage })),
  ];
  const models = buckets
    .map(({ model, usage }) => ({ ...add(NONE, usage), model }))
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

/** The tokens behind a spend, for a tooltip. */
export function describeTokens(spend: Spend): string {
  const parts = [`${COUNT.format(spend.input)} input`];
  if (spend.cacheRead) parts.push(`${COUNT.format(spend.cacheRead)} read from cache`);
  if (spend.cacheWrite) parts.push(`${COUNT.format(spend.cacheWrite)} written to cache`);
  parts.push(`${COUNT.format(spend.output)} output tokens`);
  return parts.join(", ");
}
