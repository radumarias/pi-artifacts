// What the Runs tab says of a run, in plain functions the tests read without a browser.

import type { AgentRunView, RunDelivery, RunItemStatus, RunStatus, RunWhy } from "../../shared/runs.ts";

/** A run's status as its pill says it, and the pill's tone. */
export function runStatusLabel(run: Pick<AgentRunView, "status" | "test">): { text: string; tone: "on" | "draft" | "off" | "error" } {
  const labels: Record<RunStatus, { text: string; tone: "on" | "draft" | "off" | "error" }> = {
    running: { text: "Running", tone: "draft" },
    sent: { text: run.test ? "Would send" : "Sent", tone: "on" },
    not_today: { text: "Not today", tone: "off" },
    failed: { text: "Failed", tone: "error" },
    needs_sign_in: { text: "Needs sign-in", tone: "error" },
  };
  return labels[run.status];
}

/** What started a run, in words. */
export function whyLabel(why: RunWhy): string {
  return { schedule: "On its schedule", watch: "Its watch fired", test: "Test it", manual: "Run now" }[why];
}

/** An item's status, in words. */
export function itemStatusLabel(status: RunItemStatus): string {
  return { running: "Running", acted: "Acted", not_today: "Not today", failed: "Failed" }[status];
}

/** How a run's items went, when it had a scope: "3 of 6 acted · 3 not today". Empty for a run with one item. */
export function itemsLabel(items: AgentRunView["items"]): string {
  if (items.total <= 1) return "";
  return [`${items.acted} of ${items.total} acted`, items.notToday && `${items.notToday} not today`, items.failed && `${items.failed} failed`]
    .filter(Boolean)
    .join(" · ");
}

/** Where a delivery went, in words: "Posted in its chat", "Notified you", "Page Signups brief", "Handed to @finance". */
export function deliveryLabel(delivery: Pick<RunDelivery, "kind" | "to" | "status">): string {
  const would = delivery.status === "recorded";
  switch (delivery.kind) {
    case "chat":
      return `${would ? "Would post" : "Posted"} in ${delivery.to}`;
    case "notify":
      return `${would ? "Would notify" : "Notified"} ${delivery.to}`;
    case "page":
      return `${would ? "Would update" : "Updated"} ${delivery.to}`;
    case "handOver":
      return `${would ? "Would hand" : "Handed"} to ${delivery.to}`;
    default:
      return `${would ? "Would call" : "Called"} ${delivery.to}`;
  }
}

/** How long a run or item took, from start to end: "0.4s", "12s", "3 min". */
export function took(startedAt: number, endedAt: number | undefined): string {
  if (endedAt === undefined) return "";
  const ms = Math.max(0, endedAt - startedAt);
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 120_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Whether a list of runs has one still going: the tab reads it again soon. */
export function anyRunning(runs: readonly Pick<AgentRunView, "status">[]): boolean {
  return runs.some((run) => run.status === "running");
}
