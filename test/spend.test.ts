import type { Usage } from "@earendil-works/pi-ai";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSpend, contextUse, formatCost, promptSpend, toolPickerName, totalTime } from "../src/chat/spend.ts";
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
/** `timestamp` and `durationMs`, where a test needs them. */
type Times = { timestamp?: number; durationMs?: number };
const prompt = (timestamp?: number) => entry(CHAT_MESSAGE_KIND, timestamp === undefined ? undefined : { role: "user", content: "hi", timestamp });
const reply = (cost: number, input = 100, output = 10, times: Times = {}) =>
  entry("pi.assistant", { role: "assistant", content: [], usage: usage({ input, output }, cost), ...times });
const result = (cost?: number, times: Times = {}) =>
  entry("pi.tool-result", { role: "toolResult", toolCallId: "c", toolName: "t", content: [], ...(cost !== undefined && { usage: usage({ input: 1 }, cost) }), ...times });
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

  it("counts people talking among themselves in a shared chat as no prompt", () => {
    const aside = entry(CHAT_MESSAGE_KIND);
    (aside as { data?: unknown }).data = { uid: "bob", name: "Bob", text: "nice", aside: true };
    const entries = [prompt(), reply(0.01), aside, result(0.02), reply(0.03)];
    expect([...promptSpend(entries, false).keys()]).toEqual([entries[4].id]);
    expect(promptSpend(entries, false).get(entries[4].id)!.cost).toBeCloseTo(0.06);
  });

  it("leaves out the newest prompt while a run may still add to it", () => {
    const entries = [prompt(), reply(0.01), prompt(), reply(0.02), result()];
    expect([...promptSpend(entries, true).keys()]).toEqual([entries[1].id]);
    expect([...promptSpend(entries, false).keys()]).toEqual([entries[1].id, entries[4].id]);
  });
});

describe("prompt time", () => {
  const answered = (timestamp: number, durationMs?: number) => reply(0, 0, 0, { timestamp, durationMs });
  const ran = (timestamp: number, durationMs: number) => result(undefined, { timestamp, durationMs });

  it("runs from the person's message to the last reply or tool result, and says how long models and tools ran", () => {
    const first = [prompt(1_000), answered(1_500, 2_000), ran(6_000, 2_500), answered(6_100, 3_900)];
    // Placed together, at one time. A reply from before pi timed replies counts from its start.
    const second = [prompt(20_000), prompt(20_000), answered(20_100), ran(21_000, 800)];
    const spend = promptSpend([...first, ...second], false);
    expect(spend.get(first[3].id)!.time).toEqual({ ms: 9_000, modelMs: 5_900, toolMs: 2_500, replies: 2, tools: 1, prompts: 1 });
    expect(spend.get(second[3].id)!.time).toEqual({ ms: 1_000, modelMs: 0, toolMs: 800, replies: 1, tools: 1, prompts: 1 });
    expect(totalTime(spend.values())).toEqual({ ms: 10_000, modelMs: 5_900, toolMs: 3_300, replies: 3, tools: 2, prompts: 2 });
  });

  it("starts at the newest message when an earlier one's run failed before any reply", () => {
    const entries = [prompt(1_000), prompt(600_000), answered(600_500, 1_500)];
    expect(promptSpend(entries, false).get(entries[2].id)!.time.ms).toBe(2_000);
  });

  it("counts from the first reply when the message has no time", () => {
    const entries = [prompt(), answered(5_000, 1_000)];
    expect(promptSpend(entries, false).get(entries[1].id)!.time.ms).toBe(1_000);
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

  it("splits a model's share by the effort its replies were asked at", () => {
    const answer = (model: string, cost: number, thinkingLevel?: string) =>
      entry("pi.assistant", { role: "assistant", provider: "cloudflare", model, content: [], usage: usage({ input: 10 }, cost), ...(thinkingLevel && { thinkingLevel }) });
    const ledger = {
      // Each model: its replies, and 0.05 summarizing the conversation.
      models: {
        "cloudflare/anthropic/claude-opus-5.5": usage({ input: 35 }, 0.65),
        "cloudflare/openai/gpt-5.5": usage({ input: 25 }, 0.45),
        "cloudflare/@cf/zai-org/glm-5.3": usage({ input: 10 }, 0.01),
      },
      tools: {},
    } as unknown as UsageState;
    const entries = [
      prompt(),
      answer("anthropic/claude-opus-5.5", 0.1, "high"),
      answer("anthropic/claude-opus-5.5", 0.3, "medium"),
      answer("anthropic/claude-opus-5.5", 0.2, "high"),
      answer("openai/gpt-5.5", 0.4, "high"),
      // A model that does not reason has no effort.
      answer("@cf/zai-org/glm-5.3", 0.01),
    ];
    const rows = (entries: EntryRecord[]) => chatSpend(ledger, entries).models.map(({ model, effort, input, cost }) => ({ model, effort, input, cost: +cost.toFixed(4) }));
    // At one effort, the summaries ran at it too; at several, which one is not known.
    expect(rows(entries)).toEqual([
      { model: "openai/gpt-5.5", effort: "high", input: 25, cost: 0.45 },
      { model: "anthropic/claude-opus-5.5", effort: "high", input: 20, cost: 0.3 },
      { model: "anthropic/claude-opus-5.5", effort: "medium", input: 10, cost: 0.3 },
      { model: "anthropic/claude-opus-5.5", effort: undefined, input: 5, cost: 0.05 },
      { model: "@cf/zai-org/glm-5.3", effort: undefined, input: 10, cost: 0.01 },
    ]);
    expect(chatSpend(ledger, entries).total.cost).toBeCloseTo(1.11);
    // Without the replies (the panel is closed), one row a model.
    expect(rows([]).map((row) => row.effort)).toEqual([undefined, undefined, undefined]);
    // A reloaded chat after a summary: its entries start at the summary, so the leftover's effort is not known.
    const summarized = [entry("pi.compaction", { role: "user", content: [] }), ...entries.slice(4)];
    (summarized[0] as { head?: number }).head = summarized[1].id;
    expect(rows(summarized).find((row) => row.model === "openai/gpt-5.5" && row.effort === undefined)).toEqual({ model: "openai/gpt-5.5", effort: undefined, input: 15, cost: 0.05 });
  });

  it("leaves out a leftover that is only the rounding of costs summed in another order", () => {
    const costs = [0.0563, 0.0231, 0.0874, 0.0119, 0.0652, 0.0347];
    const levels = ["high", "medium", "high", "medium", "high", "medium"];
    const ledger = { models: { "cloudflare/m": usage({ input: 60 }, costs.reduce((a, b) => a + b, 0)) }, tools: {} } as unknown as UsageState;
    const entries = costs.map((cost, i) => entry("pi.assistant", { role: "assistant", provider: "cloudflare", model: "m", content: [], usage: usage({ input: 10 }, cost), thinkingLevel: levels[i] }));
    expect(chatSpend(ledger, entries).models.map((row) => row.effort)).toEqual(["high", "medium"]);
  });

  it("formats small costs to two significant digits and larger ones to the cent", () => {
    expect([0, 0.00004, 0.0042, 0.37, 0.5, 0.999, 12.4].map(formatCost)).toEqual(["$0.00", "<$0.0001", "$0.0042", "$0.37", "$0.50", "$1.00", "$12.40"]);
  });
});

describe("Auto's spend", () => {
  /** A message sent on Auto, whose router call cost `cost`; with no router, one where the chat kept its model. */
  const routed = (cost: number, router: string | undefined = "cerebras/gpt-oss-120b") => {
    const message = prompt();
    const pick = { model: "m", thinkingLevel: "low", ms: 400, ...(router && { router: { model: router, cost, input: 1_000, output: 20 } }) };
    (message as { data?: unknown }).data = { uid: "u", name: "U", text: "hi", auto: pick };
    return message;
  };

  it("counts each router call in its prompt", () => {
    const entries = [routed(0.001), reply(0.01), routed(0, undefined), reply(0.02)];
    const spend = promptSpend(entries, false);
    expect(spend.get(entries[1].id)).toMatchObject({ input: 1_100, output: 30 });
    expect(spend.get(entries[1].id)!.cost).toBeCloseTo(0.011);
    expect(spend.get(entries[3].id)!.cost).toBeCloseTo(0.02);
  });

  it("counts the routers from pi's ledger, a row each, in the chat's total", () => {
    const ledger = {
      models: { "cloudflare/m": usage({ input: 100 }, 0.01) },
      tools: { "auto:cerebras/gpt-oss-120b": usage({ input: 2_000 }, 0.003) },
    } as unknown as UsageState;
    const { total, models: rows } = chatSpend(ledger);
    expect(total.cost).toBeCloseTo(0.013);
    expect(rows.map((row) => row.model)).toEqual(["m", "auto:cerebras/gpt-oss-120b"]);
  });
});

describe("the tool picker's spend", () => {
  it("counts in its prompt, with Auto's router", () => {
    const message = prompt();
    const picker = { model: "cloudflare-workers-ai/typesafe/jev", cost: 0.0001, input: 2_000, output: 0 };
    const auto = { model: "m", thinkingLevel: "low", ms: 400, router: { model: "cerebras/gpt-oss-120b", cost: 0.001, input: 1_000, output: 20 } };
    (message as { data?: unknown }).data = { uid: "u", name: "U", text: "hi", auto, tools: { tools: [], of: 20, picker, ms: 300 } };
    const entries = [message, reply(0.01)];
    const spend = promptSpend(entries, false);
    expect(spend.get(entries[1].id)).toMatchObject({ input: 3_100, output: 30 });
    expect(spend.get(entries[1].id)!.cost).toBeCloseTo(0.0111);
  });

  it("is named after its picker in the chat's rows", () => {
    expect(toolPickerName("cloudflare-workers-ai/typesafe/jev")).toBe("Jev");
  });
});

describe("context use", () => {
  const answered = (tokens: Partial<Usage>, provider = "anthropic", model = "claude-opus-5-5") =>
    entry("pi.assistant", { role: "assistant", content: [], provider, model, usage: usage(tokens) });

  it("is what the newest reply read and wrote, of the model that gave it", () => {
    const entries = [prompt(), answered({ input: 900, output: 50 }), prompt(), answered({ input: 10, cacheRead: 1000, cacheWrite: 200, output: 40 }), result()];
    expect(contextUse(entries)).toEqual({ tokens: 1250, model: "anthropic/claude-opus-5-5", compacted: false });
    // A provider's own total wins over the sum.
    expect(contextUse([answered({ input: 10, totalTokens: 5000 })])?.tokens).toBe(5000);
  });

  it("skips a reply that counted nothing, says when older messages were summarized since, and is nothing before a reply", () => {
    expect(contextUse([prompt(), answered({ input: 700 }), entry("pi.compaction"), prompt(), answered({})])).toEqual({
      tokens: 700,
      model: "anthropic/claude-opus-5-5",
      compacted: true,
    });
    expect(contextUse([prompt()])).toBeUndefined();
  });
});
