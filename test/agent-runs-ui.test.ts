import { describe, expect, it } from "vitest";
import type { AgentStep } from "../shared/agents.ts";
import { agentPath, agentPlace } from "../src/agents/nav.ts";
import { stepSummary } from "../shared/runs.ts";
import { deliveryLabel, deliveryStatusLabel, itemsLabel, runStatusLabel, whyLabel } from "../src/agents/runs.ts";
import { moveItem, newStep, withKeys, withoutKeys } from "../src/agents/workflow.ts";

const steps: AgentStep[] = [
  { kind: "look", server: "crm", tool: "weekly_sales", input: {}, as: "sales" },
  { kind: "if", condition: "sales.total < 10", then: [{ kind: "work", prompt: "Say why." }], else: [] },
  { kind: "tell", to: ["owner"], via: "notify" },
];

describe("the Workflow tab's steps", () => {
  it("keys every step, its branches too, and gives the steps back as they were (an empty otherwise left out)", () => {
    const keyed = withKeys(steps);
    expect(new Set([keyed[0].key, keyed[1].key, keyed[1].then![0].key]).size).toBe(3);
    expect(withoutKeys(keyed)).toEqual([steps[0], { kind: "if", condition: "sales.total < 10", then: [{ kind: "work", prompt: "Say why." }] }, steps[2]]);
  });

  it("moves a step, makes new ones empty, and sums each up", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(newStep("tell")).toEqual({ kind: "tell", to: ["owner"], via: "chat" });
    expect(stepSummary(steps[0])).toBe("crm.weekly_sales as sales");
    expect(stepSummary(steps[2])).toBe("owner as a notification");
    expect(stepSummary(newStep("work"))).toBe("(not set)");
    expect(stepSummary({ kind: "work", prompt: "\n  Say which channel fell.\nThen why." })).toBe("Say which channel fell.");
    expect(stepSummary({ kind: "handOver", agent: "finance" })).toBe("to @finance");
  });
});

describe("the Runs tab's words", () => {
  it("says a run's state, what started it, its items and where it sent", () => {
    expect(runStatusLabel({ status: "sent" })).toEqual({ text: "Sent", tone: "on" });
    expect(runStatusLabel({ status: "sent", test: true }).text).toBe("Would send");
    expect(runStatusLabel({ status: "not_today", test: true }).text).toBe("Not today");
    expect(whyLabel("watch")).toBe("Its watch fired");
    expect(whyLabel("manual")).toBe("Run by hand");
    expect(itemsLabel({ total: 1, acted: 1, notToday: 0, failed: 0 })).toBe("");
    expect(itemsLabel({ total: 6, acted: 3, notToday: 3, failed: 0 })).toBe("3 of 6 acted · 3 not today");
    expect(deliveryLabel({ kind: "chat", to: "its chat", status: "sent" })).toBe("Posted in its chat");
    expect(deliveryLabel({ kind: "notify", to: "you", status: "recorded" })).toBe("Would notify you");
    expect(deliveryLabel({ kind: "page", to: "Signups brief", status: "failed" })).toBe("Did not update Signups brief");
    expect(deliveryStatusLabel("refused")).toEqual({ text: "Not sent", tone: "off" });
  });

  it("puts a run in the agent page's address and reads it back", () => {
    const path = agentPath({ id: "a1b2c3d4e5f60718", tab: "runs", run: 1_762_480_800_000 });
    expect(path).toBe("/agents/a1b2c3d4e5f60718?tab=runs&run=1762480800000");
    expect(agentPlace(new URL(path, "https://app.test"))).toMatchObject({ tab: "runs", run: 1_762_480_800_000 });
    expect(agentPlace(new URL("/agents/a1b2c3d4e5f60718?run=nope", "https://app.test"))).not.toHaveProperty("run");
  });
});
