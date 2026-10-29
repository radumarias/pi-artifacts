import { describe, expect, it } from "vitest";
import { checkModelChoice, defaultModelChoice, modelCatalog } from "../worker/models.ts";

// The real catalog, as the Worker builds it from pi-ai.
const models = modelCatalog();
const byId = (id: string) => models.find((model) => model.id === id)!;
const order = ["anthropic", "openai", "workers-ai"];

describe("model catalog", () => {
  it("lists Anthropic, then OpenAI, then the chosen Workers AI models, and nothing else", () => {
    const vendors = models.map((model) => model.vendor);
    expect([...new Set(vendors)]).toEqual(order);
    expect(vendors).toEqual([...vendors].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
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

  it("offers only the efforts a model takes, from Anthropic's own metadata for Claude, none for a model that does not reason", () => {
    expect(byId("anthropic/claude-opus-5.5").efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(byId("anthropic/claude-sonnet-5.5").efforts).not.toContain("off");
    expect(byId("openai/gpt-5.5").efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(byId("openai/gpt-4o").efforts).toEqual([]);
  });
});

describe("model choice", () => {
  it("accepts a listed model at an effort it takes", () => {
    expect(checkModelChoice({ model: "anthropic/claude-opus-5.5", thinkingLevel: "high" })).toEqual({ model: "anthropic/claude-opus-5.5", thinkingLevel: "high" });
  });

  it("moves an effort the model does not take to the nearest one it does, and no effort to medium", () => {
    expect(checkModelChoice({ model: "openai/gpt-5.5", thinkingLevel: "max" })?.thinkingLevel).toBe("xhigh");
    expect(checkModelChoice({ model: "anthropic/claude-sonnet-5.5", thinkingLevel: "off" })?.thinkingLevel).toBe("low");
    expect(checkModelChoice({ model: "anthropic/claude-sonnet-5.5" })?.thinkingLevel).toBe("medium");
    expect(checkModelChoice({ model: "anthropic/claude-sonnet-5.5", thinkingLevel: "toString" })?.thinkingLevel).toBe("medium");
    expect(checkModelChoice({ model: "openai/gpt-4o", thinkingLevel: "high" })?.thinkingLevel).toBe("off");
  });

  it("refuses a model the picker does not list", () => {
    expect(checkModelChoice({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })).toBeNull();
    expect(checkModelChoice({ model: "anthropic/claude-opus-5-5" })).toBeNull();
    expect(checkModelChoice({ model: 42 })).toBeNull();
  });
});

describe("default model", () => {
  it("checks the deployment's default like a pick when listed, and keeps an unlisted one as configured", () => {
    expect(defaultModelChoice("anthropic/claude-opus-5.5", "off")).toEqual({ model: "anthropic/claude-opus-5.5", thinkingLevel: "low" });
    expect(defaultModelChoice("anthropic/claude-opus-5.5", "high")).toEqual({ model: "anthropic/claude-opus-5.5", thinkingLevel: "high" });
    expect(defaultModelChoice("@cf/meta/llama-3.3-70b-instruct-fp8-fast", "high")).toEqual({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", thinkingLevel: "high" });
    expect(defaultModelChoice("@cf/meta/llama-3.3-70b-instruct-fp8-fast", "hgih").thinkingLevel).toBe("medium");
  });
});
