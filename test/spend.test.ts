import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { createAI } from "agents/models/pi-ai";
import { describe, expect, it } from "vitest";
import { chatSpend, formatCost, promptSpend } from "../src/chat/spend.ts";
import { PRICE_UPDATES, withCurrentPrices } from "../worker/models.ts";

const provider = createAI({ binding: {} as never }).provider;
const models = createModels();
models.setProvider(withCurrentPrices(provider));
/** A model as the agent finds it: through the provider, at its current price. */
const model = (id: string) => models.getModel("cloudflare", id)!;
const usage = (tokens: Partial<Usage>): Usage => {
  const full = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...tokens };
  return full;
};

describe("model prices", () => {
  it("prices the agent's models at the vendors' current prices, per million tokens", () => {
    // Published by Anthropic, checked 2026-11-03.
    expect(model("anthropic/claude-opus-5.5").cost).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(model("anthropic/claude-sonnet-5.5").cost).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(model("anthropic/claude-haiku-5.5").cost.tiers).toEqual([{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }]);
    // pi-ai prices a reply from the model it ran on.
    const reply = usage({ input: 1_000, output: 2_000, cacheRead: 100_000, cacheWrite: 10_000 });
    expect(calculateCost(model("anthropic/claude-sonnet-5.5"), reply).total).toBeCloseTo(0.002 + 0.02 + 0.01 + 0.025);
  });

  it("updates only prices pi-ai has not caught up with", () => {
    for (const [id, update] of Object.entries(PRICE_UPDATES)) {
      const shipped = provider.getModels().find((entry) => entry.id === id);
      expect(shipped, `${id} is in pi-ai's catalog`).toBeDefined();
      // Once pi-ai has the price, the entry can go.
      expect(shipped!.cost, `pi-ai still has the old price of ${id}`).not.toMatchObject(update);
    }
  });
});

let id = 0;
const entry = (kind: string, message?: unknown): EntryRecord => ({ id: ++id, conversationId: 1, kind, ...(message !== undefined && { model: [message] }) }) as never;
const prompt = () => entry("chat.message", undefined);
const reply = (cost: number, input = 100, output = 10) =>
  entry("pi.assistant", { role: "assistant", content: [], usage: usage({ input, output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }) });
const result = () => entry("pi.tool-result", { role: "toolResult", toolCallId: "c", toolName: "t", content: [] });
const notice = () => entry("chat.people");

describe("prompt spend", () => {
  it("sums each prompt's replies under its last reply or tool result, and leaves out unanswered prompts", () => {
    const first = [prompt(), reply(0.01), result(), reply(0.02)];
    const second = [prompt(), prompt(), reply(0.5), result(), notice()];
    const unanswered = [prompt()];
    const { spend, open } = promptSpend([...first, ...second, ...unanswered]);
    expect([...spend.keys()]).toEqual([first[3].id, second[3].id]);
    expect(spend.get(first[3].id)).toMatchObject({ input: 200, output: 20 });
    expect(spend.get(first[3].id)!.cost).toBeCloseTo(0.03);
    expect(spend.get(second[3].id)!.cost).toBeCloseTo(0.5);
    // Someone wrote after the last answered prompt: no prompt is still running up costs.
    expect(open).toBeUndefined();
  });

  it("marks the newest prompt open until someone writes again", () => {
    const entries = [prompt(), reply(0.01), result()];
    expect(promptSpend(entries).open).toBe(entries[2].id);
  });
});

describe("chat spend", () => {
  it("sums pi's ledger by model, costliest first", () => {
    const ledger = {
      models: {
        "cloudflare/anthropic/claude-opus-5.5": usage({ input: 10, output: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 } }),
        "cloudflare/@cf/zai-org/glm-5.3": usage({ input: 7, output: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } }),
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
    expect([0, 0.00004, 0.0042, 0.37, 0.999, 12.4].map(formatCost)).toEqual(["$0.00", "<$0.0001", "$0.0042", "$0.37", "$1.00", "$12.40"]);
  });
});
