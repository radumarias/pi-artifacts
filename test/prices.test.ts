import { createModels } from "@earendil-works/pi-ai/models";
import { createAI } from "agents/models/pi-ai";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_AGE_MS, parseAnthropic, parseOpenAI, parseWorkersAI, PRICES_FILE, readPrices, refreshPrices, SOURCES } from "../scripts/prices.ts";
import { PRICES, withCurrentPrices } from "../worker/models.ts";

// Excerpts of the vendors' Markdown price pages, in their layout as of 2026-11-03.
const ANTHROPIC = `## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Mythos 5.1 ([limited availability](https://example.com)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

## Cloud platform pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Opus 5.5 | $99 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |
`;

const OPENAI = `### Standard pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $50.00 | $1.00 | $12.50 | $25.00 | $20.00 | $75.00 | $2.00 | $25.00 | $50.00 |
| gpt-5.5 (<272K context length) | $5.00 | $30.00 | $0.50 | - | - | $10.00 | $45.00 | $1.00 | - | - |
| gpt-5.5-cyber | $12.50 | $75.00 | $1.25 | - | - | - | - | - | - | - |

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-4o | $2.50 | $10.00 | $1.25 |
| gpt-5-pro | $15.00 | $120.00 | - |

### Batch pricing data

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-4o | $1.25 | $5.00 | $0.625 |
`;

const WORKERS_AI = `| Model | Price in Tokens | Price in Neurons |
| --- | --- | --- |
| @cf/zai-org/glm-5.3 | $1.400 per M input tokens <br> $0.260 per M cached input tokens <br> $4.400 per M output tokens | 127273 neurons per M input tokens |
| @cf/openai/gpt-oss-120b | $0.350 per M input tokens <br> $0.750 per M output tokens | 31818 neurons per M input tokens |
| @cf/baai/bge-m3 | $0.012 per M input tokens | 1075 neurons per M input tokens |
`;

describe("price pages", () => {
  it("reads Anthropic's model table, with long-prompt rates as a tier", () => {
    const prices = parseAnthropic(ANTHROPIC);
    expect(prices["anthropic/claude-opus-5.5"]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(prices["anthropic/claude-mythos-5.1"]).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
    expect(prices["anthropic/claude-haiku-5.5"]).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    });
  });

  it("reads OpenAI's standard tables only, with long context as a tier and cached tokens at input price where none is given", () => {
    const prices = parseOpenAI(OPENAI);
    expect(prices["openai/gpt-6-astra"]).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
      tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
    });
    expect(prices["openai/gpt-5.5"]).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }] });
    expect(prices["openai/gpt-5.5-cyber"]?.tiers).toBeUndefined();
    // The standard price, not the batch one below it.
    expect(prices["openai/gpt-4o"]).toEqual({ input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 });
    expect(prices["openai/gpt-5-pro"]).toEqual({ input: 15, output: 120, cacheRead: 15, cacheWrite: 0 });
  });

  it("reads Workers AI's chat models and leaves out models priced by input alone", () => {
    const prices = parseWorkersAI(WORKERS_AI);
    expect(prices).toEqual({
      "@cf/zai-org/glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
      "@cf/openai/gpt-oss-120b": { input: 0.35, output: 0.75, cacheRead: 0.35, cacheWrite: 0 },
    });
  });

  it("refuses a page it cannot read, rather than guess", () => {
    expect(() => parseAnthropic("# Pricing\n\nMoved.")).toThrow(/Model pricing/);
    expect(() => parseAnthropic(ANTHROPIC.replace("$4 / MTok", "4 USD"))).toThrow(/not a price/);
    expect(() => parseOpenAI(OPENAI.replace("| gpt-4o | $2.50 |", "| gpt-4o | $2.50 | $1 |"))).toThrow(/cells/);
    expect(() => parseOpenAI("### Batch pricing data\n")).toThrow(/no prices/);
    expect(() => parseWorkersAI("| Model | Price |\n| --- | --- |\n")).toThrow(/no prices/);
  });
});

describe("price list", () => {
  const page = async (url: string) => ({ [SOURCES.anthropic]: ANTHROPIC, [SOURCES.openai]: OPENAI, [SOURCES["workers-ai"]]: WORKERS_AI })[url]!;
  const file = (checkedAt: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "prices-")), "prices.json");
    writeFileSync(path, JSON.stringify({ checkedAt, models: { "anthropic/claude-opus-5.5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } } }));
    return path;
  };

  it("leaves a list younger than a week alone, and reads the pages again once it is older", async () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    const fresh = file(new Date(now - MAX_AGE_MS + 60_000).toISOString());
    expect(await refreshPrices({ file: fresh, now, fetchPage: page })).toEqual({ refreshed: false, changes: [] });
    const stale = file(new Date(now - MAX_AGE_MS - 60_000).toISOString());
    const { refreshed, changes } = await refreshPrices({ file: stale, now, fetchPage: page });
    expect(refreshed).toBe(true);
    expect(changes).toContain('~ anthropic/claude-opus-5.5 {"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25} → {"input":4,"output":20,"cacheRead":0.2,"cacheWrite":5}');
    const written = readPrices(readFileSync(stale, "utf8"));
    expect(written.checkedAt).toBe(new Date(now).toISOString());
    expect(written.models["openai/gpt-4o"]?.input).toBe(2.5);
  });

  it("fails, and keeps the list as it was, when a page cannot be fetched or read", async () => {
    const stale = file("2026-01-01T00:00:00Z");
    const before = readFileSync(stale, "utf8");
    await expect(refreshPrices({ file: stale, fetchPage: async () => "<html>Not found</html>" })).rejects.toThrow();
    await expect(refreshPrices({ file: stale, fetchPage: async () => Promise.reject(new Error("offline")) })).rejects.toThrow(/offline/);
    expect(readFileSync(stale, "utf8")).toBe(before);
  });

  it("fails on a list file it cannot read", () => {
    expect(() => readPrices("{}")).toThrow();
    expect(() => readPrices(JSON.stringify({ checkedAt: "2026-11-03", models: { m: { input: "4", output: 20, cacheRead: 0, cacheWrite: 0 } } }))).toThrow(/bad price/);
  });

  it("ships a list that reads, and the agent's models use it", () => {
    readPrices(readFileSync(PRICES_FILE, "utf8"));
    const models = createModels();
    models.setProvider(withCurrentPrices(createAI({ binding: {} as never }).provider));
    for (const id of ["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "openai/gpt-5.5", "@cf/zai-org/glm-5.3"]) {
      expect(models.getModel("cloudflare", id)?.cost, id).toEqual(PRICES.get(id));
    }
    // The same object on every lookup: pi looks a model up several times per model call.
    expect(models.getModel("cloudflare", "openai/gpt-5.5")).toBe(models.getModel("cloudflare", "openai/gpt-5.5"));
  });
});
