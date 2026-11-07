// What the Runs tab says of a run, in plain functions the tests read without a browser.

import { stepServers, type AgentDefinition } from "../../shared/agents.ts";
import { readsInStepText } from "../../shared/sign-ins.ts";
import type { AgentRunView, RunDelivery, RunDeliveryKind, RunItemStatus, RunStatus, RunWhy } from "../../shared/runs.ts";

/** A pill's tone, as the stylesheet colours it. */
export type Tone = "on" | "draft" | "off" | "error";

const RUN_STATUS: Record<RunStatus, { text: string; tone: Tone }> = {
  running: { text: "Running", tone: "draft" },
  sent: { text: "Sent", tone: "on" },
  not_today: { text: "Not today", tone: "off" },
  failed: { text: "Failed", tone: "error" },
  needs_sign_in: { text: "Needs sign-in", tone: "error" },
  waiting: { text: "Waits for you", tone: "draft" },
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

const ITEM_STATUS: Record<RunItemStatus, string> = {
  running: "Running",
  acted: "Acted",
  not_today: "Not today",
  failed: "Failed",
  waiting: RUN_STATUS.waiting.text,
};

/** An item's status, in words. */
export function itemStatusLabel(status: RunItemStatus): string {
  return ITEM_STATUS[status];
}

/** How a run's items went, when it had a scope: "3 of 6 acted · 3 not today". Empty for a run with one item. */
export function itemsLabel(items: AgentRunView["items"]): string {
  if (items.total <= 1) return "";
  return [`${items.acted} of ${items.total} acted`, items.notToday && `${items.notToday} not today`, items.failed && `${items.failed} failed`, items.waiting && `${items.waiting} wait for you`]
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
  if (delivery.status === "waiting") return `${would} ${delivery.to} once you approve it`;
  return `${delivery.status === "sent" ? done : delivery.status === "recorded" ? would : not} ${delivery.to}`;
}

const DELIVERY_STATUS: Record<RunDelivery["status"], { text: string; tone: Tone }> = {
  sent: { text: "Sent", tone: "on" },
  recorded: { text: "Recorded", tone: "draft" },
  waiting: { text: "Waits for you", tone: "draft" },
  refused: { text: "Not sent", tone: "off" },
  failed: { text: "Failed", tone: "error" },
};

/** A delivery's status as its pill says it, and the pill's tone. */
export function deliveryStatusLabel(status: RunDelivery["status"]): { text: string; tone: Tone } {
  return DELIVERY_STATUS[status];
}

/**
 * What a run waiting for these sign-ins can do without them: a server its agent reads in a step it cannot go without
 * (change the steps, or turn it off); one its work only may use, Disconnect lets the runs go on without.
 */
export function signInWayOut(agent: Pick<AgentDefinition, "name" | "trigger" | "scope" | "workflow">, servers: readonly string[]): string[] {
  const steps = stepServers(agent);
  const read = servers.filter((server) => steps.has(server));
  const rest = servers.filter((server) => !steps.has(server));
  return [
    ...(read.length ? [`No access any more? ${readsInStepText(`@${agent.name}`, read)}`] : []),
    ...(rest.length
      ? [`Signed in to ${rest.join(", ")} before and no access any more? Disconnect it under Sign-ins in the account menu, and runs go on without it.`]
      : []),
  ];
}
