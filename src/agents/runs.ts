// What the Runs tab says of a run, in plain functions the tests read without a browser.

import type { AgentRunView, RunDelivery, RunDeliveryKind, RunItemStatus, RunStatus, RunWhy } from "../../shared/runs.ts";

/** A pill's tone, as the stylesheet colours it. */
export type Tone = "on" | "draft" | "off" | "error";

const RUN_STATUS: Record<RunStatus, { text: string; tone: Tone }> = {
  running: { text: "Running", tone: "draft" },
  sent: { text: "Sent", tone: "on" },
  not_today: { text: "Not today", tone: "off" },
  failed: { text: "Failed", tone: "error" },
  needs_sign_in: { text: "Needs sign-in", tone: "error" },
};

/** A run's status as its pill says it, and the pill's tone: a test that acted "Would send". */
export function runStatusLabel(run: Pick<AgentRunView, "status" | "test">): { text: string; tone: Tone } {
  return run.test && run.status === "sent" ? { ...RUN_STATUS.sent, text: "Would send" } : RUN_STATUS[run.status];
}

const WHY: Record<RunWhy, string> = { schedule: "On its schedule", watch: "Its watch fired", test: "A test run", manual: "Run by hand" };

/** What started a run, in words: the runs list says it as is, a run's post in its byline in lower case. */
export function whyLabel(why: RunWhy): string {
  return WHY[why];
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

/** Each kind of delivery as done, as a test would have done it, and as not done. */
const DELIVERY_WORDS: Record<RunDeliveryKind, [done: string, would: string, not: string]> = {
  chat: ["Posted in", "Would post in", "Did not post in"],
  notify: ["Notified", "Would notify", "Did not notify"],
  page: ["Updated", "Would update", "Did not update"],
  handOver: ["Handed to", "Would hand to", "Did not hand to"],
  tool: ["Called", "Would call", "Did not call"],
};

/** Where a delivery went, in words: "Posted in its chat", "Would notify you", "Did not update Signups brief". */
export function deliveryLabel(delivery: Pick<RunDelivery, "kind" | "to" | "status">): string {
  const [done, would, not] = DELIVERY_WORDS[delivery.kind];
  return `${delivery.status === "sent" ? done : delivery.status === "recorded" ? would : not} ${delivery.to}`;
}

const DELIVERY_STATUS: Record<RunDelivery["status"], { text: string; tone: Tone }> = {
  sent: { text: "Sent", tone: "on" },
  recorded: { text: "Recorded", tone: "draft" },
  refused: { text: "Not sent", tone: "off" },
  failed: { text: "Failed", tone: "error" },
};

/** A delivery's status as its pill says it, and the pill's tone. */
export function deliveryStatusLabel(status: RunDelivery["status"]): { text: string; tone: Tone } {
  return DELIVERY_STATUS[status];
}
