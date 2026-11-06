import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { autoCandidates } from "../worker/agent/route.ts";
import { cannotCall, tryModels, withFailuresReported, type ModelFailures } from "../worker/model-health.ts";
import { baseCatalog, catalogFrom, forgetCatalog, loadCatalog, markFailing } from "../worker/models.ts";
import { ModelCache } from "../worker/storage/model-cache.ts";
import { createAI } from "agents/models/pi-ai";
import type { Discovery } from "../worker/gateway-models.ts";
import { FakeBucket } from "./fakes.ts";

/** A reply that failed with `error`. */
const failed = (error: string): AssistantMessage => ({
  ...fauxAssistantMessage(""),
  stopReason: "error",
  errorMessage: error,
});

/** pi-ai's models over a faux provider whose models each answer as `answer` says. */
function fauxModels(answer: (id: string) => AssistantMessage) {
  const faux = fauxProvider({
    models: [{ id: "broke" }, { id: "busy" }, { id: "fine" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const targets = ["broke", "busy", "fine"].map((id) => faux.getModel(id)!);
  faux.setResponses(targets.map(() => (_context, _options, _state, model) => answer(model.id)));
  return { models, targets, provider: faux.provider.id };
}

describe("what cannot be called", () => {
  it("is no key, no credits or quota, no such model or no access", () => {
    for (const error of [
      "429 You exceeded your current quota, please check your plan and billing details. insufficient_quota",
      "402 Payment Required",
      "Error Code 402: Insufficient balance",
      "401 Incorrect API key provided",
      "The model `gpt-9` does not exist or you do not have access to it.",
      "model_not_found: no such model",
    ]) {
      expect(cannotCall(error), error).toBe(true);
    }
  });

  it("is not a rate limit, a busy or failing server, a timeout, or a request too long", () => {
    for (const error of [
      "429 Rate limit reached for requests",
      "529 Overloaded",
      "500 Internal Server Error",
      "Request timed out",
      "prompt is too long: 220000 tokens > 200000 maximum",
      "Item with id 'rs_123' not found.",
      "404 Not Found",
    ]) {
      expect(cannotCall(error), error).toBe(false);
    }
  });
});

describe("trying models", () => {
  it("marks only those that cannot be called, by the picker's id, with why", async () => {
    const { models, targets, provider } = fauxModels((id) =>
      id === "broke" ? failed("429 insufficient_quota") : id === "busy" ? failed("529 Overloaded") : fauxAssistantMessage("OK"),
    );
    const failing = await tryModels(models, targets);
    expect(Object.keys(failing)).toEqual([`${provider}/broke`]);
    expect(failing[`${provider}/broke`]).toMatchObject({
      error: "429 insufficient_quota",
      at: expect.any(Number),
    });
  });

  it("reports a model whose call fails for good, once per call, and not one that fails for a while", async () => {
    const { models, targets, provider } = fauxModels((id) => (id === "broke" ? failed("402 Payment Required") : failed("529 Overloaded")));
    const reported: [string, string][] = [];
    const reporting = withFailuresReported(models, (id, error) => reported.push([id, error]));
    const context = {
      messages: [{ role: "user" as const, content: "hi", timestamp: 0 }],
    };
    for (const model of targets) {
      const stream = reporting.streamSimple(model, context);
      for await (const _event of stream);
      await stream.result();
    }
    expect(reported).toEqual([[`${provider}/broke`, "402 Payment Required"]]);
  });
});

describe("failing models in the catalog", () => {
  const discovery = (failing: Discovery["failing"]): Discovery => ({
    checkedAt: 1,
    providers: {},
    failing,
  });

  it("say why in the picker, and Auto leaves them out", () => {
    const catalog = catalogFrom(
      discovery({
        "anthropic/claude-haiku-5.5": { error: "402 Payment Required", at: 1 },
      }),
    );
    expect(catalog.models.find((model) => model.id === "anthropic/claude-haiku-5.5")?.failing).toBe("402 Payment Required");
    expect(baseCatalog().models.find((model) => model.id === "anthropic/claude-haiku-5.5")?.failing).toBeUndefined();
    const wanted = [{ id: "anthropic/claude-opus-5.5" }, { id: "anthropic/claude-haiku-5.5" }];
    expect(
      autoCandidates(catalog.models, wanted, {
        images: false,
        contextTokens: 0,
      }).map((model) => model.id),
    ).toEqual(["anthropic/claude-opus-5.5"]);
  });

  it("are marked for every isolate as they fail, and tried afresh when the providers are next asked", async () => {
    forgetCatalog();
    const bucket = new FakeBucket();
    const binding = {
      fetch: async () => new Response("no", { status: 401 }),
      run: async () => new Response("no", { status: 500 }),
    };
    let tries = 0;
    const source = {
      cache: new ModelCache(bucket.r2),
      ai: binding,
      gateway: "gw",
      tryModels: async (): Promise<ModelFailures> => (tries++ ? {} : { "openai/gpt-5.5": { error: "insufficient_quota", at: 1 } }),
    };
    const first = await loadCatalog(source);
    expect(first.models.find((model) => model.id === "openai/gpt-5.5")?.failing).toBe("insufficient_quota");
    await markFailing(source, "anthropic/claude-haiku-5.5", "402 Payment Required");
    const kept = JSON.parse(bucket.objects.get("models/discovered.json")!) as Discovery;
    expect(Object.keys(kept.failing ?? {}).sort()).toEqual(["anthropic/claude-haiku-5.5", "openai/gpt-5.5"]);
    // Another isolate reads the marks.
    forgetCatalog();
    const read = await loadCatalog(source);
    expect(read.models.find((model) => model.id === "anthropic/claude-haiku-5.5")?.failing).toBe("402 Payment Required");
    // The next discovery tries them again: both answer now.
    bucket.objects.set("models/discovered.json", JSON.stringify({ ...kept, checkedAt: Date.now() - 2 * 60_000 }));
    forgetCatalog();
    const renewed = await loadCatalog(source, { refresh: true });
    expect(renewed.models.some((model) => model.failing)).toBe(false);
    forgetCatalog();
  });
});

describe("an error a streamed answer ends with", () => {
  it("names the provider's code and message, nested or not (patches/@earendil-works__pi-ai)", async () => {
    const answer = async (event: object) => {
      const sse = `data: ${JSON.stringify({ type: "response.created", response: { id: "r" } })}\n\ndata: ${JSON.stringify(event)}\n\n`;
      const binding = {
        run: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
        fetch: async () => new Response(""),
      };
      const ai = createAI({ binding: binding as never, gateway: "gw" });
      return (await ai.completeSimple(ai("openai/gpt-6-luna"), { messages: [{ role: "user", content: "hi", timestamp: 0 }] })).errorMessage;
    };
    expect(
      await answer({ type: "error", error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" } }),
    ).toBe("Error Code insufficient_quota: You exceeded your current quota");
    expect(await answer({ type: "error", code: "server_error", message: "The server had an error" })).toBe(
      "Error Code server_error: The server had an error",
    );
    expect(await answer({ type: "error" })).toBe('Error Code unknown: {"type":"error"}');
  });
});
