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
import { errorMessage } from "../shared/util.ts";

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
  headers?: Record<string, string>;
  /** The models in the list's body that can run a chat (stream text and call tools). */
  parse(body: unknown): ListedModel[];
  /** pi-ai's own catalog of the vendor, by the vendor's ids: names, limits, efforts and prices for the models it knows. */
  known: Record<string, Model<Api>>;
  /** How to reach a model pi-ai does not know, and with `always`, every model: pi-ai's own wire for it is one AI Gateway does not route. */
  wire: Wire & { always?: boolean };
}

// A lenient view of the JSON the lists send: every field may be missing.
type Json = Record<string, unknown>;
const array = (value: unknown): Json[] => (Array.isArray(value) ? value.filter((item): item is Json => typeof item === "object" && item !== null) : []);
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** An OpenAI-style list, `{ data: [{ id }] }`, keeping the ids `keep` accepts. */
const idList =
  (keep: (id: string, item: Json) => boolean = () => true) =>
  (body: unknown): ListedModel[] =>
    array((body as Json)?.data).flatMap((item) => {
      const id = text(item.id);
      return id && keep(id, item) ? [{ id, contextWindow: count(item.context_window) ?? count(item.context_length) }] : [];
    });

/** A dated snapshot of a model also listed by its plain name: claude-haiku-4-5-20251001, gpt-4o-2024-08-06. */
const SNAPSHOT = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
/** Ids of models that do not chat in text: speech, images, video, embeddings, moderation, retrieval. */
const NOT_CHAT =
  /audio|realtime|tts|transcribe|whisper|speech|image|imagine|video|embed|moderation|guard|search|instruct|davinci|babbage|dall-e|sora|aqa|live|robotics|orpheus|playai|distil/i;

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

/**
 * The providers, by their AI Gateway names. Their lists come through the gateway, which adds the key it holds, so the
 * app holds none. Each reads only what its vendor documents for its own list.
 */
export const GATEWAY_PROVIDERS: Record<GatewayProviderId, GatewayProvider> = {
  anthropic: {
    list: "v1/models?limit=1000",
    headers: { "anthropic-version": "2023-06-01" },
    parse: (body) =>
      array((body as Json)?.data).flatMap((item) => {
        const id = text(item.id);
        return id && !SNAPSHOT.test(id) ? [{ id, name: text(item.display_name), images: true }] : [];
      }),
    known: ANTHROPIC_MODELS as Record<string, Model<Api>>,
    wire: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  },
  openai: {
    list: "v1/models",
    // OpenAI lists every model the key may use, chat or not: keep the GPT and o-series chat models.
    parse: idList((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !NOT_CHAT.test(id) && !SNAPSHOT.test(id)),
    known: OPENAI_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  },
  "google-ai-studio": {
    list: "v1beta/models?pageSize=1000",
    parse: (body) =>
      array((body as Json)?.models).flatMap((item) => {
        const id = text(item.name)?.replace(/^models\//, "");
        if (!id?.startsWith("gemini") || NOT_CHAT.test(id) || !strings(item.supportedGenerationMethods).includes("generateContent")) return [];
        return [
          {
            id,
            name: text(item.displayName),
            contextWindow: count(item.inputTokenLimit),
            maxTokens: count(item.outputTokenLimit),
            reasoning: item.thinking === true,
            images: true,
          },
        ];
      }),
    known: GOOGLE_MODELS as Record<string, Model<Api>>,
    // pi-ai speaks Gemini's own API, which AI Gateway does not route for pi: use Gemini's OpenAI-compatible one.
    wire: { api: "openai-completions", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", always: true },
  },
  grok: {
    list: "v1/models",
    parse: idList((id) => !NOT_CHAT.test(id)),
    known: XAI_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-completions", baseUrl: "https://api.x.ai/v1" },
  },
  mistral: {
    list: "v1/models",
    parse: (body) =>
      array((body as Json)?.data).flatMap((item) => {
        const id = text(item.id);
        const can = (item.capabilities ?? {}) as Json;
        if (!id || item.deprecation || can.completion_chat !== true || can.function_calling !== true) return [];
        return [{ id, name: text(item.name), contextWindow: count(item.max_context_length), images: can.vision === true }];
      }),
    known: MISTRAL_MODELS as Record<string, Model<Api>>,
    // pi-ai speaks Mistral's Conversations API, which AI Gateway does not route for pi: use its chat completions.
    wire: { api: "openai-completions", baseUrl: "https://api.mistral.ai/v1", always: true },
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
    parse: (body) =>
      array((body as Json)?.models).flatMap((item) => {
        const id = text(item.name);
        const features = strings(item.features);
        if (!id || !strings(item.endpoints).includes("chat") || !features.includes("tools")) return [];
        return [{ id, contextWindow: count(item.context_length), images: item.supports_vision === true || features.includes("vision") }];
      }),
    known: {},
    // Cohere's OpenAI-compatible API.
    wire: { api: "openai-completions", baseUrl: "https://api.cohere.ai/compatibility/v1" },
  },
  openrouter: {
    list: "v1/models",
    parse: (body) =>
      array((body as Json)?.data).flatMap((item) => {
        const id = text(item.id);
        if (!id || !strings(item.supported_parameters).includes("tools")) return [];
        const pricing = (item.pricing ?? {}) as Json;
        const [input, output] = [perMillion(pricing.prompt), perMillion(pricing.completion)];
        const architecture = (item.architecture ?? {}) as Json;
        return [
          {
            id,
            name: text(item.name),
            contextWindow: count(item.context_length),
            maxTokens: count(((item.top_provider ?? {}) as Json).max_completion_tokens),
            images: strings(architecture.input_modalities).includes("image"),
            reasoning: strings(item.supported_parameters).includes("reasoning"),
            cost:
              input === undefined || output === undefined
                ? undefined
                : { input, output, cacheRead: perMillion(pricing.input_cache_read) ?? 0, cacheWrite: perMillion(pricing.input_cache_write) ?? 0 },
          },
        ];
      }),
    known: OPENROUTER_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", always: true },
  },
  huggingface: {
    list: "v1/models",
    parse: (body) =>
      array((body as Json)?.data).flatMap((item) => {
        const id = text(item.id);
        // The router picks one of the model's providers per request: list it when one that is up calls tools.
        const providers = array(item.providers).filter((provider) => provider.status !== "error" && provider.supports_tools === true);
        if (!id || !providers.length) return [];
        const pricing = (providers[0].pricing ?? {}) as Json;
        // Already in dollars per million tokens.
        const [input, output] = [dollars(pricing.input), dollars(pricing.output)];
        return [
          {
            id,
            contextWindow: count(providers[0].context_length),
            cost: input === undefined || output === undefined ? undefined : { input, output, cacheRead: 0, cacheWrite: 0 },
          },
        ];
      }),
    known: HUGGINGFACE_MODELS as Record<string, Model<Api>>,
    wire: { api: "openai-completions", baseUrl: "https://router.huggingface.co/v1" },
  },
};

/** The AI binding's way to AI Gateway's provider paths (agents/models/pi-ai sends its own requests the same way). */
interface GatewayFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface DiscoverOptions {
  ai: unknown;
  gateway: string;
  /** The alias of the provider keys to use, when not "default". */
  byokAlias?: string;
  /** The last discovery: a provider whose list cannot be read now keeps the models it had. */
  previous?: Discovery | null;
  timeoutMs?: number;
}

/** A request the provider refused for want of a key: no key in AI Gateway for it, or none that works. */
function refused(status: number, body: string): boolean {
  // Google answers a missing or bad key with 400 API_KEY_INVALID.
  return status === 401 || status === 403 || (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body));
}

/** Read one provider's list through AI Gateway. */
async function listProvider(id: GatewayProviderId, options: DiscoverOptions): Promise<ProviderListing> {
  const provider = GATEWAY_PROVIDERS[id];
  const headers: Record<string, string> = { ...provider.headers, "cf-aig-collect-log": "false" };
  if (options.byokAlias) headers["cf-aig-byok-alias"] = options.byokAlias;
  try {
    const response = await (options.ai as GatewayFetcher).fetch(
      `https://workers-binding.ai/ai-gateway/gateways/${encodeURIComponent(options.gateway)}/${id}/${provider.list}`,
      { method: "GET", headers, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (refused(response.status, body)) return { status: "no-key", models: [] };
      return { status: "failed", models: [], error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
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
