import { createAI } from "agents/models/pi-ai";
import { describe, expect, it } from "vitest";
import { effortFor } from "../shared/models.ts";
import { chatModels, checkModelChoice } from "../worker/models.ts";

// The real catalog, as the Worker builds it: listing models never touches the binding.
const models = chatModels(createAI({ binding: {} as never }).provider.getModels());
const byId = (id: string) => models.find((model) => model.id === id)!;

describe("model catalog", () => {
  it("lists Anthropic, then OpenAI, then the chosen Workers AI models, and nothing else", () => {
    const vendors = models.map((model) => model.vendor);
    expect([...new Set(vendors)]).toEqual(["anthropic", "openai", "workers-ai"]);
    expect(vendors).toEqual([...vendors].sort((a, b) => ["anthropic", "openai", "workers-ai"].indexOf(a) - ["anthropic", "openai", "workers-ai"].indexOf(b)));
    expect(models.filter((model) => model.vendor === "workers-ai").length).toBeGreaterThan(3);
    expect(models.some((model) => model.id === "@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe(false);
  });

  it("names models by their AI Gateway specifiers, newest and largest first", () => {
    expect(byId("anthropic/claude-opus-5.5").name).toBe("Claude Opus 5.5");
    const anthropic = models.filter((model) => model.vendor === "anthropic").map((model) => model.id);
    expect(anthropic.indexOf("anthropic/claude-opus-5.5")).toBeLessThan(anthropic.indexOf("anthropic/claude-sonnet-5.5"));
    expect(anthropic.indexOf("anthropic/claude-sonnet-5.5")).toBeLessThan(anthropic.indexOf("anthropic/claude-opus-4.8"));
    const openai = models.filter((model) => model.vendor === "openai").map((model) => model.id);
    expect(openai.indexOf("openai/gpt-5.5")).toBeLessThan(openai.indexOf("openai/gpt-4o"));
  });

  it("offers only the efforts a model takes, never off for Claude, none for a model that does not reason", () => {
    expect(byId("anthropic/claude-opus-5.5").efforts).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(byId("openai/gpt-5.5").efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(byId("openai/gpt-4o").efforts).toEqual([]);
  });
});

describe("model choice", () => {
  it("accepts a listed model at an effort it takes", () => {
    expect(checkModelChoice(models, { model: "anthropic/claude-opus-5.5", thinkingLevel: "high" })).toEqual({ model: "anthropic/claude-opus-5.5", thinkingLevel: "high" });
  });

  it("moves an effort the model does not take to medium, or the model's lowest", () => {
    expect(checkModelChoice(models, { model: "openai/gpt-5.5", thinkingLevel: "max" })?.thinkingLevel).toBe("medium");
    expect(checkModelChoice(models, { model: "anthropic/claude-sonnet-5.5", thinkingLevel: "off" })?.thinkingLevel).toBe("medium");
    expect(checkModelChoice(models, { model: "openai/gpt-4o", thinkingLevel: "high" })?.thinkingLevel).toBe("off");
    expect(effortFor({ id: "x", name: "x", vendor: "x", efforts: ["high", "max"] }, "low")).toBe("high");
  });

  it("refuses a model the picker does not list", () => {
    expect(checkModelChoice(models, { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })).toBeNull();
    expect(checkModelChoice(models, { model: "anthropic/claude-opus-5-5" })).toBeNull();
    expect(checkModelChoice(models, { model: 42 })).toBeNull();
  });
});
