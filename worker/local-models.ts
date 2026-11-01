import type { Api, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { LOCAL_PROVIDER_ID } from "../shared/models.ts";
import { errorMessage } from "../shared/util.ts";

/*
 * Models from an OpenAI-compatible runtime on this machine (LM Studio, Ollama, llama.cpp's server, vLLM), for local
 * development: `LOCAL_MODELS_URL=http://localhost:1234/v1 pnpm dev`. The runtime says which models it has
 * (`GET /models`); the agent talks to them with chat completions. They run under the provider `LOCAL_PROVIDER_ID`
 * and the picker names them `LOCAL_PREFIX` and the runtime's id (`shared/models.ts`).
 */

type LocalModel = Model<"openai-completions">;

/** A runtime that does not say how long a model's context is gets these. */
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

/** How long a list of the runtime's models is used before asking again: loading a model shows up within this. */
const LIST_TTL_MS = 15_000;

/** One entry of `GET /models`. Context lengths are extensions some runtimes add: vLLM, LM Studio, OpenRouter's shape. */
interface ListedModel {
  id?: unknown;
  max_model_len?: unknown;
  max_context_length?: unknown;
  context_length?: unknown;
}

let listed: { url: string; at: number; models: Promise<LocalModel[]> } | undefined;

/**
 * The chat models the runtime at `url` serves, asked again after a few seconds. Empty, and logged, when it does not
 * answer: the picker then just has no local models until it does.
 */
export function localModels(url: string): Promise<LocalModel[]> {
  const now = Date.now();
  if (listed?.url !== url || now - listed.at > LIST_TTL_MS) listed = { url, at: now, models: fetchLocalModels(url) };
  return listed.models;
}

async function fetchLocalModels(url: string): Promise<LocalModel[]> {
  try {
    const response = await fetch(`${url}/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: ListedModel[] };
    return (body.data ?? []).flatMap((entry) => (typeof entry.id === "string" && !/embed/i.test(entry.id) ? [localModel(url, entry.id, entry)] : []));
  } catch (error) {
    console.error(`local models (${url}):`, errorMessage(error));
    return [];
  }
}

/**
 * A runtime model as pi-ai sees it. Local runtimes take neither OpenAI's `developer` role nor `store`, and want
 * `max_tokens`; whether a model reasons or sees images they do not say, so it is taken to do neither.
 */
export function localModel(url: string, id: string, listing: ListedModel = {}): LocalModel {
  const context = [listing.max_model_len, listing.max_context_length, listing.context_length].find((value) => typeof value === "number" && value > 0) as number | undefined;
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: LOCAL_PROVIDER_ID,
    baseUrl: url,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: context ?? DEFAULT_CONTEXT,
    maxTokens: Math.min(DEFAULT_MAX_TOKENS, context ?? DEFAULT_MAX_TOKENS),
    compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
  };
}

/** The pi-ai provider for `models`. Local runtimes need no key, but the OpenAI client insists on one, so it gets a stand-in. */
export function localProvider(url: string, models: readonly Model<Api>[]): Provider {
  return createProvider({
    id: LOCAL_PROVIDER_ID,
    name: "Local runtime",
    baseUrl: url,
    auth: { apiKey: { name: "Local runtime (no key)", resolve: async () => ({ auth: { apiKey: LOCAL_PROVIDER_ID } }) } },
    models,
    api: openAICompletionsApi(),
  });
}
