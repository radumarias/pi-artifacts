import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAI } from "agents/models/pi-ai";
import { discoverModels, type Discovery } from "../worker/gateway-models.ts";
import { baseCatalog, catalogFrom, defaultModelChoice, forgetCatalog, listedProviders, loadCatalog, PRICES, withEffortRecorded } from "../worker/models.ts";
import { ModelCache } from "../worker/storage/model-cache.ts";
import { modelKeyOfLedger } from "../shared/models.ts";
import { FakeBucket } from "./fakes.ts";

// The catalog before any provider was asked, as the Worker builds it from pi-ai.
const models = baseCatalog().models;
const byId = (id: string) => models.find((model) => model.id === id)!;
const order = ["anthropic", "openai", "workers-ai"];
const check = (input: { model?: unknown; thinkingLevel?: unknown }) => baseCatalog().check(input);

describe("model catalog", () => {
  it("lists Anthropic, then OpenAI, then the chosen Workers AI models, and nothing else", () => {
    const providers = models.map((model) => model.provider);
    expect([...new Set(providers)]).toEqual(order);
    expect(providers).toEqual([...providers].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(models.filter((model) => model.provider === "workers-ai").length).toBeGreaterThan(3);
    expect(models.some((model) => model.id === "@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe(false);
  });

  it("names models by their AI Gateway specifiers, newest and largest first", () => {
    expect(byId("anthropic/claude-opus-5.5").name).toBe("Claude Opus 5.5");
    const anthropic = models.filter((model) => model.provider === "anthropic").map((model) => model.id);
    expect(anthropic.indexOf("anthropic/claude-opus-5.5")).toBeLessThan(anthropic.indexOf("anthropic/claude-sonnet-5.5"));
    expect(anthropic.indexOf("anthropic/claude-sonnet-5.5")).toBeLessThan(anthropic.indexOf("anthropic/claude-opus-4.8"));
    const openai = models.filter((model) => model.provider === "openai").map((model) => model.id);
    expect(openai.indexOf("openai/gpt-5.5")).toBeLessThan(openai.indexOf("openai/gpt-4o"));
  });

  it("offers only the efforts a model takes, from Anthropic's own metadata for Claude, none for a model that does not reason", () => {
    expect(byId("anthropic/claude-opus-5.5").efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(byId("anthropic/claude-sonnet-5.5").efforts).not.toContain("off");
    expect(byId("openai/gpt-5.5").efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(byId("openai/gpt-4o").efforts).toEqual([]);
  });

  it("says which models see images, how much they take in, and their price", () => {
    expect(byId("anthropic/claude-opus-5.5").images).toBe(true);
    expect(byId("openai/gpt-5.5").images).toBe(true);
    expect(byId("@cf/openai/gpt-oss-120b").images).toBe(false);
    expect(byId("anthropic/claude-opus-5.5").contextWindow).toBeGreaterThan(100_000);
    const price = PRICES.get("anthropic/claude-opus-5.5")!;
    expect(byId("anthropic/claude-opus-5.5").price).toEqual({ input: price.input, output: price.output });
  });
});

describe("model choice", () => {
  it("accepts a listed model at an effort it takes", () => {
    expect(check({ model: "anthropic/claude-opus-5.5", thinkingLevel: "high" })).toEqual({ model: "anthropic/claude-opus-5.5", thinkingLevel: "high" });
  });

  it("moves an effort the model does not take to the nearest one it does, and no effort to medium", () => {
    expect(check({ model: "openai/gpt-5.5", thinkingLevel: "max" })?.thinkingLevel).toBe("xhigh");
    expect(check({ model: "anthropic/claude-sonnet-5.5", thinkingLevel: "off" })?.thinkingLevel).toBe("low");
    expect(check({ model: "anthropic/claude-sonnet-5.5" })?.thinkingLevel).toBe("medium");
    expect(check({ model: "anthropic/claude-sonnet-5.5", thinkingLevel: "toString" })?.thinkingLevel).toBe("medium");
    expect(check({ model: "openai/gpt-4o", thinkingLevel: "high" })?.thinkingLevel).toBe("off");
  });

  it("refuses a model the picker does not list", () => {
    expect(check({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })).toBeNull();
    expect(check({ model: "anthropic/claude-opus-5-5" })).toBeNull();
    expect(check({ model: "groq/llama-3.3-70b-versatile" })).toBeNull();
    expect(check({ model: 42 })).toBeNull();
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

/** What each provider's list says, in its own format, as of 2026-11. */
const LISTS: Record<string, unknown> = {
  anthropic: {
    data: [
      { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
      { id: "claude-haiku-4-5-20251001" },
      { id: "claude-nova-6", display_name: "Claude Nova 6" },
      { id: "claude-nova-6-20261001" },
    ],
  },
  openai: { data: [{ id: "gpt-5.5" }, { id: "gpt-4o-2024-08-06" }, { id: "text-embedding-3-large" }, { id: "gpt-realtime-2.1" }, { id: "whisper-1" }] },
  "google-ai-studio": {
    models: [
      { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent"], thinking: true },
      { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-9-ultra", displayName: "Gemini 9 Ultra", inputTokenLimit: 2000000, supportedGenerationMethods: ["generateContent"], thinking: true },
    ],
  },
  groq: {
    data: [
      { id: "llama-3.3-70b-versatile", active: true, context_window: 131072 },
      { id: "moonshotai/kimi-k2-instruct", active: true, context_window: 131072 },
      { id: "whisper-large-v3", active: true },
      { id: "old-model", active: false },
    ],
  },
  openrouter: {
    data: [
      {
        id: "acme/rocket-1",
        name: "Acme: Rocket 1",
        context_length: 200000,
        pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
        architecture: { input_modalities: ["text", "image"] },
        supported_parameters: ["tools", "reasoning"],
        top_provider: { max_completion_tokens: 64000 },
      },
      { id: "acme/no-tools", supported_parameters: ["temperature"] },
    ],
  },
};

/** An AI binding whose gateway answers each provider's list as LISTS has it; a provider not there has no key (401). */
function gatewayBinding(lists = LISTS, calls: { url: string; headers: Headers }[] = []) {
  return {
    calls,
    async fetch(url: string, init?: RequestInit) {
      calls.push({ url, headers: new Headers(init?.headers) });
      const provider = new URL(url).pathname.split("/")[4];
      if (provider === "mistral") return new Response("upstream down", { status: 502 });
      return Object.hasOwn(lists, provider) ? Response.json(lists[provider]) : new Response('{"error":"no key"}', { status: 401 });
    },
  };
}

describe("model discovery", () => {
  it("asks each provider for its models through AI Gateway, with the key alias, and tells which have keys", async () => {
    const binding = gatewayBinding();
    const discovery = await discoverModels({ ai: binding, gateway: "pi gw", byokAlias: "team" });
    const anthropic = binding.calls.find((call) => call.url.includes("/anthropic/"))!;
    expect(anthropic.url).toBe("https://workers-binding.ai/ai-gateway/gateways/pi%20gw/anthropic/v1/models?limit=1000");
    expect(anthropic.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(anthropic.headers.get("cf-aig-byok-alias")).toBe("team");
    expect(binding.calls.find((call) => call.url.includes("/groq/"))!.url).toMatch(/\/groq\/models$/);
    expect(discovery.providers.groq).toEqual({
      status: "ok",
      models: [
        { id: "llama-3.3-70b-versatile", contextWindow: 131072 },
        { id: "moonshotai/kimi-k2-instruct", contextWindow: 131072 },
      ],
    });
    expect(discovery.providers.deepseek?.status).toBe("no-key");
    expect(discovery.providers.mistral?.status).toBe("failed");
    expect(discovery.providers.openai?.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
    // A dated snapshot goes when its plain name is listed too; one listed only by its date stays.
    expect(discovery.providers.anthropic?.models.map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-nova-6"]);
    expect(discovery.providers.openrouter?.models).toEqual([
      { id: "acme/rocket-1", name: "Acme: Rocket 1", contextWindow: 200000, maxTokens: 64000, images: true, reasoning: true, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } },
    ]);
  });

  it("leaves out a provider whose list is public when AI Gateway holds no key for it", async () => {
    const binding = gatewayBinding();
    const fetch = binding.fetch.bind(binding);
    // OpenRouter's list answers anyone; the key's own details answer only with a key.
    binding.fetch = async (url, init) => (url.endsWith("/openrouter/v1/key") ? new Response('{"error":"no key"}', { status: 401 }) : fetch(url, init));
    const discovery = await discoverModels({ ai: binding, gateway: "gw" });
    expect(discovery.providers.openrouter).toEqual({ status: "no-key", models: [] });
    expect(binding.calls.some((call) => call.url.endsWith("/openrouter/v1/models"))).toBe(true);
  });

  it("keeps a provider's last models when its list cannot be read now", async () => {
    const previous: Discovery = { checkedAt: 1, providers: { mistral: { status: "ok", models: [{ id: "mistral-large-latest" }] } } };
    const discovery = await discoverModels({ ai: gatewayBinding(), gateway: "gw", previous });
    expect(discovery.providers.mistral).toMatchObject({ status: "failed", models: [{ id: "mistral-large-latest" }] });
  });
});

describe("catalog from a discovery", () => {
  const discovered = () => discoverModels({ ai: gatewayBinding(), gateway: "gw" });

  it("lists the providers with keys, by provider, with AI Gateway's catalog models where it has them", async () => {
    const catalog = catalogFrom(await discovered());
    const ids = catalog.models.map((model) => model.id);
    expect([...new Set(catalog.models.map((model) => model.provider))]).toEqual(["anthropic", "openai", "google-ai-studio", "groq", "openrouter", "workers-ai"]);
    // Anthropic's own spelling, found in the gateway's catalog; a model it does not have goes to Anthropic directly.
    expect(ids).toContain("anthropic/claude-opus-5.5");
    expect(ids).toContain("anthropic/claude-nova-6");
    expect(ids).not.toContain("anthropic/claude-sonnet-5.5");
    // A model Anthropic lists only by its dated id is the gateway catalog's, when the catalog has it.
    if (baseCatalog().models.some((model) => model.id === "anthropic/claude-haiku-4.5")) expect(ids).toContain("anthropic/claude-haiku-4.5");
    expect(ids.some((id) => id.startsWith("anthropic/claude-haiku-4"))).toBe(true);
    expect(ids.filter((id) => id.startsWith("openai/"))).toEqual(["openai/gpt-5.5"]);
    expect(ids).toContain("groq/llama-3.3-70b-versatile");
    expect(ids).toContain("google-ai-studio/gemini-2.5-flash");
    expect(ids).not.toContain("google-ai-studio/gemini-embedding-001");
  });

  it("prices a model from its list, else the build's prices, else pi-ai's, and says when no price is known", async () => {
    const catalog = catalogFrom(await discovered());
    const info = (id: string) => catalog.models.find((model) => model.id === id)!;
    expect(info("openrouter/acme/rocket-1").price).toEqual({ input: 3, output: 15 });
    const flash = PRICES.get("google-ai-studio/gemini-2.5-flash");
    if (flash) expect(info("google-ai-studio/gemini-2.5-flash").price).toEqual({ input: flash.input, output: flash.output });
    else expect(info("google-ai-studio/gemini-2.5-flash").price).toBeDefined();
    expect(info("google-ai-studio/gemini-9-ultra").price).toBeUndefined();
    expect(catalog.model("google-ai-studio/gemini-9-ultra")?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("names a provider's own model so pi finds it, and checks a pick of it", async () => {
    const catalog = catalogFrom(await discovered());
    const model = catalog.model("groq/llama-3.3-70b-versatile")!;
    expect(model).toMatchObject({ provider: "groq", id: "llama-3.3-70b-versatile", api: "openai-completions" });
    expect(modelKeyOfLedger(`${model.provider}/${model.id}`)).toBe("groq/llama-3.3-70b-versatile");
    expect(modelKeyOfLedger("cloudflare/anthropic/claude-opus-5.5")).toBe("anthropic/claude-opus-5.5");
    expect(catalog.check({ model: "groq/llama-3.3-70b-versatile", thinkingLevel: "high" })).toEqual({ model: "groq/llama-3.3-70b-versatile", thinkingLevel: "off" });
    // Gemini through its OpenAI-compatible API: the three efforts that API takes.
    expect(catalog.models.find((info) => info.id === "google-ai-studio/gemini-2.5-flash")?.efforts).toEqual(["low", "medium", "high"]);
    expect(catalog.check({ model: "google-ai-studio/gemini-2.5-flash", thinkingLevel: "max" })?.thinkingLevel).toBe("high");
  });

  it("keeps Anthropic's and OpenAI's catalog models when their lists could not be read", () => {
    const catalog = catalogFrom({ checkedAt: 1, providers: { anthropic: { status: "failed", models: [] }, openai: { status: "no-key", models: [] } } });
    expect(catalog.models.map((model) => model.id)).toEqual(baseCatalog().models.map((model) => model.id));
  });

  it("routes a provider's own model to its AI Gateway provider path, with the vendor's id", async () => {
    const catalog = catalogFrom(await discovered());
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const binding = {
      async fetch(url: string, init?: RequestInit) {
        sent.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response("no", { status: 500 });
      },
      run: async () => new Response("no", { status: 500 }),
    };
    const ai = createAI({ binding: binding as never, gateway: "gw" });
    const registry = createModels();
    registry.setProvider(ai.provider);
    for (const provider of listedProviders(ai.provider, () => catalog)) registry.setProvider(provider);
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
    for (const [id, path, wire] of [
      ["groq/llama-3.3-70b-versatile", "/groq/chat/completions", "llama-3.3-70b-versatile"],
      ["google-ai-studio/gemini-2.5-flash", "/google-ai-studio/v1beta/openai/chat/completions", "gemini-2.5-flash"],
      ["openrouter/acme/rocket-1", "/openrouter/v1/chat/completions", "acme/rocket-1"],
      ["anthropic/claude-nova-6", "/anthropic/v1/messages", "claude-nova-6"],
    ] as const) {
      const model = catalog.model(id)!;
      expect(registry.getModel(model.provider, model.id), id).toBe(model);
      await registry.streamSimple(model, context).result();
      expect(sent.at(-1)?.url, id).toBe(`https://workers-binding.ai/ai-gateway/gateways/gw${path}`);
      expect(sent.at(-1)?.body.model, id).toBe(wire);
    }
  });
});

describe("catalog loading", () => {
  const source = (bucket: FakeBucket, binding = gatewayBinding()) => ({ cache: new ModelCache(bucket.r2), ai: binding, gateway: "gw" });

  it("asks the providers once, keeps the answer for every isolate, and serves it from there", async () => {
    forgetCatalog();
    const bucket = new FakeBucket();
    const binding = gatewayBinding();
    const first = await loadCatalog(source(bucket, binding));
    expect(first.models.some((model) => model.id === "groq/llama-3.3-70b-versatile")).toBe(true);
    expect(bucket.objects.has("models/discovered.json")).toBe(true);
    const asked = binding.calls.length;
    // Another isolate: reads the kept discovery, asks no provider.
    forgetCatalog();
    const other = gatewayBinding();
    const second = await loadCatalog(source(bucket, other));
    expect(other.calls).toHaveLength(0);
    expect(second.models.map((model) => model.id)).toEqual(first.models.map((model) => model.id));
    // Asking again by hand within a minute gives the same answer without asking.
    await loadCatalog(source(bucket, other), { refresh: true });
    expect(other.calls).toHaveLength(0);
    expect(asked).toBeGreaterThan(0);
  });

  it("renews an old discovery in the background, serving the old one meanwhile", async () => {
    forgetCatalog();
    const bucket = new FakeBucket();
    const old: Discovery = { checkedAt: Date.now() - 2 * 60 * 60_000, providers: {} };
    bucket.objects.set("models/discovered.json", JSON.stringify(old));
    const binding = gatewayBinding();
    let renewal: Promise<unknown> | undefined;
    const catalog = await loadCatalog({ ...source(bucket, binding), waitUntil: (promise) => (renewal = promise) });
    expect(catalog.checkedAt).toBe(old.checkedAt);
    await renewal;
    expect(JSON.parse(bucket.objects.get("models/discovered.json")!).checkedAt).toBeGreaterThan(old.checkedAt);
    forgetCatalog();
  });
});

describe("effort per reply", () => {
  /** Real pi-ai models over a stand-in provider that answers with `replies`, in turn. */
  const answering = (...replies: AssistantMessage[]) => answeringAs(true, ...replies);
  const answeringAs = (reasoning: boolean, ...replies: AssistantMessage[]) => {
    const faux = fauxProvider({ models: [{ id: "m", reasoning }] });
    faux.setResponses(replies);
    const models = createModels();
    models.setProvider(faux.provider);
    return { models: withEffortRecorded(models), model: faux.getModel() };
  };
  const context = { messages: [] };

  it("marks each reply with the effort it was asked at, and one asked for no reasoning as off", async () => {
    const { models, model } = answering(fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c"));
    expect((await models.streamSimple(model, context, { reasoning: "high" }).result()).thinkingLevel).toBe("high");
    // Summaries of a long conversation come through completeSimple.
    expect((await models.completeSimple(model, context, { reasoning: "low" })).thinkingLevel).toBe("low");
    expect((await models.completeSimple(model, context)).thinkingLevel).toBe("off");
  });

  it("marks the partials too, which a cut-off run keeps as its reply", async () => {
    const { models, model } = answering(fauxAssistantMessage("a"));
    const levels: unknown[] = [];
    for await (const event of models.streamSimple(model, context, { reasoning: "high" })) if ("partial" in event) levels.push(event.partial.thinkingLevel);
    expect(levels.length).toBeGreaterThan(0);
    expect(new Set(levels)).toEqual(new Set(["high"]));
  });

  it("marks no effort on a model that does not reason", async () => {
    const { models, model } = answeringAs(false, fauxAssistantMessage("a"));
    expect((await models.streamSimple(model, context, { reasoning: "high" }).result()).thinkingLevel).toBeUndefined();
  });

  it("keeps an effort the reply already says", async () => {
    const { models, model } = answering({ ...fauxAssistantMessage("a"), thinkingLevel: "medium" });
    expect((await models.streamSimple(model, context, { reasoning: "high" }).result()).thinkingLevel).toBe("medium");
  });
});
