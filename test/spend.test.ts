import type { Usage } from "@earendil-works/pi-ai";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSpend, describeTime, formatCost, formatDuration, promptSpend, totalTime } from "../src/chat/spend.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";

/** A reply's usage: `tokens`, at `total` dollars. */
const usage = (tokens: Partial<Usage>, total = 0): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  ...tokens,
});

let id = 0;
const entry = (kind: string, message?: unknown): EntryRecord => ({ id: ++id, conversationId: 1, kind, ...(message !== undefined && { model: [message] }) }) as never;
const prompt = () => entry(CHAT_MESSAGE_KIND);
const reply = (cost: number, input = 100, output = 10) => entry("pi.assistant", { role: "assistant", content: [], usage: usage({ input, output }, cost) });
const result = (cost?: number) =>
  entry("pi.tool-result", { role: "toolResult", toolCallId: "c", toolName: "t", content: [], ...(cost !== undefined && { usage: usage({ input: 1 }, cost) }) });
const notice = () => entry("chat.people");

describe("prompt spend", () => {
  it("sums each prompt's replies and tool spend under its last reply or tool result, and leaves out unanswered prompts", () => {
    const first = [prompt(), reply(0.01), result(0.005), reply(0.02)];
    const second = [prompt(), prompt(), reply(0.5), result(), notice()];
    const unanswered = [prompt()];
    const spend = promptSpend([...first, ...second, ...unanswered], false);
    expect([...spend.keys()]).toEqual([first[3].id, second[3].id]);
    expect(spend.get(first[3].id)).toMatchObject({ input: 201, output: 20 });
    expect(spend.get(first[3].id)!.cost).toBeCloseTo(0.035);
    expect(spend.get(second[3].id)!.cost).toBeCloseTo(0.5);
    // Someone wrote after the last answered prompt: a run going now is not adding to it.
    expect(promptSpend([...first, ...second, ...unanswered], true).size).toBe(2);
  });

  it("leaves out the newest prompt while a run may still add to it", () => {
    const entries = [prompt(), reply(0.01), prompt(), reply(0.02), result()];
    expect([...promptSpend(entries, true).keys()]).toEqual([entries[1].id]);
    expect([...promptSpend(entries, false).keys()]).toEqual([entries[1].id, entries[4].id]);
  });
});

describe("prompt time", () => {
  const said = (timestamp: number) => entry(CHAT_MESSAGE_KIND, { role: "user", content: "hi", timestamp });
  const answered = (timestamp: number, durationMs?: number) =>
    entry("pi.assistant", { role: "assistant", content: [], usage: usage({}), timestamp, ...(durationMs !== undefined && { durationMs }) });
  const ran = (timestamp: number, durationMs: number) =>
    entry("pi.tool-result", { role: "toolResult", toolCallId: "c", toolName: "t", content: [], timestamp, durationMs });

  it("runs from the person's message to the last reply or tool result, and says how long models and tools ran", () => {
    const first = [said(1_000), answered(1_500, 2_000), ran(6_000, 2_500), answered(6_100, 3_900)];
    // Placed together: the prompt starts at the last of them. A reply from before pi timed replies counts from its start.
    const second = [said(20_000), said(20_010), answered(20_100), ran(21_000, 800)];
    const spend = promptSpend([...first, ...second], false);
    expect(spend.get(first[3].id)!.time).toEqual({ ms: 9_000, modelMs: 5_900, toolMs: 2_500, calls: 2, tools: 1 });
    expect(spend.get(second[3].id)!.time).toEqual({ ms: 990, modelMs: 0, toolMs: 800, calls: 1, tools: 1 });
    expect(totalTime(spend.values())).toEqual({ ms: 9_990, modelMs: 5_900, toolMs: 3_300, calls: 3, tools: 2 });
    expect(describeTime(spend.get(first[3].id)!.time)).toBe("model replies 5.9s (2), tools 2.5s (1)");
  });

  it("counts from the first reply when the message has no time", () => {
    const entries = [prompt(), answered(5_000, 1_000)];
    expect(promptSpend(entries, false).get(entries[1].id)!.time.ms).toBe(1_000);
  });

  it("formats durations", () => {
    expect([0, 400, 4_240, 9_960, 42_400, 59_600, 185_000, 3_599_700, 3_840_000].map(formatDuration)).toEqual([
      "0.0s", "0.4s", "4.2s", "10s", "42s", "1m 0s", "3m 5s", "1h 0m", "1h 4m",
    ]);
  });
});

describe("chat spend", () => {
  it("sums pi's ledger by model, costliest first", () => {
    const ledger = {
      models: {
        "cloudflare/anthropic/claude-opus-5.5": usage({ input: 10, output: 5 }, 0.3),
        "cloudflare/@cf/zai-org/glm-5.3": usage({ input: 7, output: 1 }, 0.001),
      },
      tools: { run_python: usage({}) },
    } as unknown as UsageState;
    const { total, models: rows } = chatSpend(ledger);
    expect(rows.map((row) => row.model)).toEqual(["anthropic/claude-opus-5.5", "@cf/zai-org/glm-5.3"]);
    expect(total).toMatchObject({ input: 17, output: 6 });
    expect(total.cost).toBeCloseTo(0.301);
    expect(chatSpend(undefined).models).toEqual([]);
  });

  it("formats small costs to two significant digits and larger ones to the cent", () => {
    expect([0, 0.00004, 0.0042, 0.37, 0.5, 0.999, 12.4].map(formatCost)).toEqual(["$0.00", "<$0.0001", "$0.0042", "$0.37", "$0.50", "$1.00", "$12.40"]);
  });
});
