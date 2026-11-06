import type { Api, Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { CEREBRAS_MODELS } from "@earendil-works/pi-ai/providers/cerebras.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { GROQ_MODELS } from "@earendil-works/pi-ai/providers/groq.models";
import { HUGGINGFACE_MODELS } from "@earendil-works/pi-ai/providers/huggingface.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import type { ProviderId } from "../shared/models.ts";
import { errorMessage, isObject, text, type Json } from "../shared/util.ts";

type ModelCost = Model<Api>["cost"];

/** A provider AI Gateway reaches with a key it holds (Workers AI needs none). */
export type GatewayProviderId = Exclude<ProviderId, "workers-ai">;

/** A model as a provider's own list describes it: its id, and whatever else the list says. */
export interface ListedModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  images?: boolean;
  reasoning?: boolean;
  /** Dollars per million tokens, when the list prices its models (OpenRouter, Hugging Face). */
  cost?: ModelCost;
}

/**
 * What one provider's list said when last asked. "no-key": AI Gateway holds no key for it (the provider refused the
 * request). "failed": the list could not be read; the models from the last good read stay.
 */
export interface ProviderListing {
  status: "ok" | "no-key" | "failed";
  models: ListedModel[];
  /** Why the last read failed. */
  error?: string;
}

/** Every provider's listing, and when they were asked. Stored as is (worker/storage/model-cache.ts). */
export interface Discovery {
  checkedAt: number;
  providers: Partial<Record<GatewayProviderId, ProviderListing>>;
}

/** How pi-ai talks to a provider's models through AI Gateway: the wire, and the vendor URL it is routed by. */
interface Wire {
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  baseUrl: string;
}

/** One provider the app lists models from: where its list is, how to read it, and how to reach its models. */
export interface GatewayProvider {
  /** The list's path under the provider's AI Gateway path: what follows the vendor's own host. */
  list: string;
  /**
   * For a provider whose list answers without a key (OpenRouter's is public): a path under the same place that needs
   * one, so a gateway with no key for it does not list its models.
   */
  keyCheck?: string;
  headers?: Record<string, string>;
  /** The models in the list's body that can run a chat (stream text and call tools). */
  parse(body: unknown): ListedModel[];
  /** pi-ai's own catalog of the vendor, by the vendor's ids: names, limits, efforts and prices for the models it knows. */
  known: Record<string, Model<Api>>;
  /** How to reach a model whose own pi-ai wire AI Gateway does not route for pi (or that pi-ai does not know). */
  wire: Wire;
}

// A lenient view of the JSON the lists send: every field may be missing.
const array = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/**
 * A list of models under `field` of the body, each named by `idOf` (its `id` by default), read by `read`: what it says
 * of the model, or undefined to leave the model out.
 */
const listOf =
  (field: string, read: (item: Json, id: string) => Omit<ListedModel, "id"> | undefined, idOf = (item: Json) => text(item.id)) =>
  (body: unknown): ListedModel[] =>
    array((body as Json)?.[field]).flatMap((item) => {
      const id = idOf(item);
      const listed = id && read(item, id);
      return listed ? [{ id: id!, ...listed }] : [];
    });

/** An OpenAI-style list, `{ data: [{ id, context_window? }] }`, keeping the models `keep` accepts. */
const idList = (keep: (id: string, item: Json) => boolean = () => true) =>
  listOf("data", (item, id) => (keep(id, item) ? { contextWindow: count(item.context_window) ?? count(item.context_length) } : undefined));

/** A dated snapshot's suffix: claude-haiku-4-5-20251001, gpt-4o-2024-08-06. */
export const SNAPSHOT = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
/** Ids of models that do not chat in text: speech, images, video, embeddings, moderation, retrieval. */
const NOT_CHAT =
  /audio|realtime|tts|transcribe|whisper|speech|image|imagine|video|embed|moderation|guard|search|davinci|babbage|dall-e|sora|aqa|live|robotics|orpheus|playai|distil/i;

/** `parse`, leaving out a dated snapshot whose plain name the list also has; one listed only by its date stays. */
const withoutTwinSnapshots =
  (parse: (body: unknown) => ListedModel[]) =>
  (body: unknown): ListedModel[] => {
    const models = parse(body);
    const ids = new Set(models.map((model) => model.id));
    return models.filter((model) => !SNAPSHOT.test(model.id) || !ids.has(model.id.replace(SNAPSHOT, "")));
  };

/** A price: a number, or a number in a string, not below zero. */
const dollars = (value: unknown): number | undefined => {
  const price = typeof value === "string" && value ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(price) && price >= 0 ? price : undefined;
};

/** Dollars per million tokens from a price per token, as OpenRouter's list gives it ("0.000003"). */
const perMillion = (value: unknown): number | undefined => {
  const price = dollars(value);
  // Rounded to a millionth of a dollar, so 0.000003 * 1e6 is 3 and not 2.9999999999999996.
  return price === undefined ? undefined : Math.round(price * 1e12) / 1e6;
};

/** A cost from an input and an output price, when the list gives both. */
const costOf = (input: number | undefined, output: number | undefined, cacheRead = 0, cacheWrite = 0): ModelCost | undefined =>
  input === undefined || output === undefined ? undefined : { input, output, cacheRead, cacheWrite };

/**
 * The providers, by their AI Gateway names. Their lists come through the gateway, which adds the key it holds, so the
 * app holds none. Each reads only what its vendor documents for its own list.
 */
export const GATEWAY_PROVIDERS: Record<GatewayProviderId, GatewayProvider> = {
  anthropic: {
    list: "v1/models?limit=1000",
    headers: { "anthropic-version": "2023-06-01" },
    // Anthropic lists many models only by their dated ids (claude-haiku-4-5-20251001).
    parse: withoutTwinSnapshots(listOf("data", (item) => ({ name: text(item.display_name), images: true }))),
    known: ANTHROPIC_MODELS as Record<string, Model<Api>>,
    wire: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  },
  openai: {
    list: "v1/models",
    // OpenAI lists every model the key may use, chat or not: keep the GPT and o-series chat models (not the
    // completions-only -instruct ones).
    parse: idList((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/instruct/.test(id) && !NOT_CHAT.test(id) && !SNAPSHOT.test(id)),
    known: OPENAI_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  },
  "google-ai-studio": {
    list: "v1beta/models?pageSize=1000",
    parse: listOf(
      "models",
      (item, id) =>
        id.startsWith("gemini") && !NOT_CHAT.test(id) && strings(item.supportedGenerationMethods).includes("generateContent")
          ? {
              name: text(item.displayName),
              contextWindow: count(item.inputTokenLimit),
              maxTokens: count(item.outputTokenLimit),
              reasoning: item.thinking === true,
              images: true,
            }
          : undefined,
      (item) => text(item.name)?.replace(/^models\//, ""),
    ),
    known: GOOGLE_MODELS as Record<string, Model<Api>>,
    // pi-ai speaks Gemini's own API, which AI Gateway does not route for pi: Gemini's OpenAI-compatible one instead
    // (whose thought signatures and errors worker/gemini.ts carries over).
    wire: { api: "openai-completions", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  },
  grok: {
    list: "v1/models",
    parse: idList((id) => !NOT_CHAT.test(id)),
    known: XAI_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-completions", baseUrl: "https://api.x.ai/v1" },
  },
  mistral: {
    list: "v1/models",
    parse: listOf("data", (item) => {
      const can = (item.capabilities ?? {}) as Json;
      if (item.deprecation || can.completion_chat !== true || can.function_calling !== true) return undefined;
      return { name: text(item.name), contextWindow: count(item.max_context_length), images: can.vision === true };
    }),
    known: MISTRAL_MODELS as Record<string, Model<Api>>,
    // pi-ai speaks Mistral's Conversations API, which AI Gateway does not route for pi: its chat completions instead.
    wire: { api: "openai-completions", baseUrl: "https://api.mistral.ai/v1" },
  },
  deepseek: {
    list: "models",
    parse: idList(),
    known: DEEPSEEK_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-completions", baseUrl: "https://api.deepseek.com" },
  },
  groq: {
    list: "models",
    parse: idList((id, item) => item.active !== false && !NOT_CHAT.test(id)),
    known: GROQ_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
  },
  cerebras: {
    list: "v1/models",
    parse: idList(),
    known: CEREBRAS_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" },
  },
  cohere: {
    list: "v1/models?endpoint=chat&page_size=1000",
    parse: listOf(
      "models",
      (item) => {
        const features = strings(item.features);
        if (!strings(item.endpoints).includes("chat") || !features.includes("tools")) return undefined;
        return { contextWindow: count(item.context_length), images: item.supports_vision === true || features.includes("vision") };
      },
      (item) => text(item.name),
    ),
    known: {},
    // Cohere's OpenAI-compatible API.
    wire: { api: "openai-completions", baseUrl: "https://api.cohere.ai/compatibility/v1" },
  },
  openrouter: {
    list: "v1/models",
    // The key's own details: 401 without one.
    keyCheck: "v1/key",
    parse: listOf("data", (item) => {
      const parameters = strings(item.supported_parameters);
      if (!parameters.includes("tools")) return undefined;
      const pricing = (item.pricing ?? {}) as Json;
      return {
        name: text(item.name),
        contextWindow: count(item.context_length),
        maxTokens: count(((item.top_provider ?? {}) as Json).max_completion_tokens),
        images: strings(((item.architecture ?? {}) as Json).input_modalities).includes("image"),
        reasoning: parameters.includes("reasoning"),
        cost: costOf(perMillion(pricing.prompt), perMillion(pricing.completion), perMillion(pricing.input_cache_read), perMillion(pricing.input_cache_write)),
      };
    }),
    known: OPENROUTER_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  },
  huggingface: {
    list: "v1/models",
    parse: listOf("data", (item) => {
      // The router picks one of the model's providers per request: list it when one that is up calls tools.
      const provider = array(item.providers).find((provider) => provider.status !== "error" && provider.supports_tools === true);
      if (!provider) return undefined;
      // Already in dollars per million tokens.
      const pricing = (provider.pricing ?? {}) as Json;
      return { contextWindow: count(provider.context_length), cost: costOf(dollars(pricing.input), dollars(pricing.output)) };
    }),
    known: HUGGINGFACE_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-completions", baseUrl: "https://router.huggingface.co/v1" },
  },
};

/** The wires agents/models/pi-ai routes through AI Gateway: a pi-ai model on any other runs on its provider's `wire`. */
export const ROUTED_APIS: ReadonlySet<string> = new Set<Wire["api"]>(["anthropic-messages", "openai-completions", "openai-responses"]);

/** The AI binding's way to AI Gateway's provider paths (agents/models/pi-ai sends its own requests the same way). */
export interface GatewayFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** Where AI Gateway is: the AI binding, the gateway's id, and the alias of the provider keys to use, when not "default". */
export interface GatewayOptions {
  ai: GatewayFetcher;
  gateway: string;
  byokAlias?: string;
}

/** A request to a provider's `path` through AI Gateway, with the deployment's key for it, unlogged. */
export function gatewayFetch(
  options: GatewayOptions,
  provider: string,
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers, "cf-aig-collect-log": "false" };
  if (options.byokAlias) headers["cf-aig-byok-alias"] = options.byokAlias;
  return options.ai.fetch(`https://workers-binding.ai/ai-gateway/gateways/${encodeURIComponent(options.gateway)}/${provider}/${path}`, { ...init, headers });
}

export interface DiscoverOptions extends GatewayOptions {
  /** The last discovery: a provider whose list cannot be read now keeps the models it had. */
  previous?: Discovery | null;
}

/** How long one provider's list may take. */
const LIST_TIMEOUT_MS = 10_000;

/** A request the provider refused for want of a key: no key in AI Gateway for it, or none that works. */
function refused(status: number, body: string): boolean {
  // Google answers a missing or bad key with 400 API_KEY_INVALID.
  return status === 401 || status === 403 || (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body));
}

/** Read one provider's list through AI Gateway. */
async function listProvider(id: GatewayProviderId, options: DiscoverOptions): Promise<ProviderListing> {
  const provider = GATEWAY_PROVIDERS[id];
  const get = (path: string) => gatewayFetch(options, id, path, { method: "GET", headers: provider.headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  try {
    const [response, check] = await Promise.all([get(provider.list), provider.keyCheck && get(provider.keyCheck)]);
    for (const answer of check ? [check, response] : [response]) {
      if (answer.ok) continue;
      const body = await answer.text().catch(() => "");
      if (refused(answer.status, body)) return { status: "no-key", models: [] };
      return { status: "failed", models: [], error: `HTTP ${answer.status}: ${body.slice(0, 200)}` };
    }
    return { status: "ok", models: provider.parse(await response.json()) };
  } catch (error) {
    return { status: "failed", models: [], error: errorMessage(error) };
  }
}

/**
 * Ask every provider for its models, through AI Gateway, all at once. A provider whose list comes back has a key
 * there; one that refuses has none. A list that cannot be read keeps the models of the last good read.
 */
export async function discoverModels(options: DiscoverOptions): Promise<Discovery> {
  const ids = Object.keys(GATEWAY_PROVIDERS) as GatewayProviderId[];
  const listings = await Promise.all(ids.map((id) => listProvider(id, options)));
  const providers: Discovery["providers"] = {};
  ids.forEach((id, i) => {
    const listing = listings[i];
    const before = options.previous?.providers[id];
    providers[id] = listing.status === "failed" && before?.models.length ? { ...listing, models: before.models } : listing;
    if (listing.status === "failed") console.error(`models: could not list ${id}:`, listing.error);
  });
  return { checkedAt: Date.now(), providers };
}
