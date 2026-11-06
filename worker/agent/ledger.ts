import type { Usage } from "@earendil-works/pi-ai";
import { UsageDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";

/** Add a call's usage to the conversation's spend ledger under `tools` as `key`, as pi adds a tool's spend. */
export async function recordSpend(tx: Tx, conversationId: ConversationId, key: string, usage: Usage): Promise<void> {
  const totals = (await tx.doc(UsageDoc, conversationId)).tools as Record<string, Usage>;
  const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
  // Drafts take strict JSON: no undefined counters.
  if (!total) {
    totals[key] = JSON.parse(JSON.stringify(usage)) as Usage;
    return;
  }
  for (const counter of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[counter] += usage[counter];
  // Optional counters, as pi adds them: once either side reports one.
  for (const counter of ["cacheWrite1h", "reasoning"] as const) if (usage[counter] !== undefined) total[counter] = (total[counter] ?? 0) + usage[counter];
  for (const counter of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[counter] += usage.cost[counter];
}
