import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { autoCandidates } from "../worker/agent/route.ts";
import { cannotCall, tryModels, withFailuresReported, type ModelFailures } from "../worker/model-health.ts";
import { baseCatalog, catalogFrom, forgetCatalog, loadCatalog, markFailing } from "../worker/models.ts";
import { ModelCache } from "../worker/storage/model-cache.ts";
import { readableLine, withReadableStreamErrors } from "../worker/stream-errors.ts";
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
      "403 Forbidden",
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

describe("readable stream errors", () => {
  it("puts a nested error's code and message on the event", () => {
    const line = readableLine(
      'data: {"type":"error","sequence_number":2,"error":{"type":"insufficient_quota","code":"insufficient_quota","message":"You exceeded your current quota"}}',
    );
    expect(JSON.parse(line.slice("data: ".length))).toMatchObject({
      type: "error",
      code: "insufficient_quota",
      message: "You exceeded your current quota",
    });
  });

  it("makes the event its own message when it says nothing else, and leaves other lines alone", () => {
    const bare = JSON.parse(readableLine('data: {"type":"error"}').slice("data: ".length));
    expect(bare).toEqual({
      type: "error",
      code: "unknown",
      message: '{"type":"error"}',
    });
    const whole = 'data: {"type":"error","code":"server_error","message":"The server had an error"}';
    expect(readableLine(whole)).toBe(whole);
    for (const line of ['data: {"type":"response.output_text.delta","delta":"error"}', "event: error", "data: [DONE]"])
      expect(readableLine(line)).toBe(line);
  });

  it("rewrites the binding's streamed answers, split anywhere, and passes everything else through", async () => {
    const sse = 'data: {"type":"response.created"}\n\ndata: {"type":"error","error":{"code":"insufficient_quota","message":"No credits"}}\n\n';
    const bytes = new TextEncoder().encode(sse);
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
        controller.close();
      },
    });
    const binding = {
      logId: "abc",
      run: async () =>
        new Response(split, {
          headers: { "content-type": "text/event-stream" },
        }),
      fetch: async () => Response.json({ ok: true }),
    };
    const ai = withReadableStreamErrors(binding);
    const answer = (await ai.run()) as Response;
    const text = await answer.text();
    expect(text).toContain('"code":"insufficient_quota","message":"No credits"');
    expect(text.startsWith('data: {"type":"response.created"}\n\n')).toBe(true);
    expect(await ((await ai.fetch()) as Response).json()).toEqual({ ok: true });
    expect(ai.logId).toBe("abc");
  });
});
