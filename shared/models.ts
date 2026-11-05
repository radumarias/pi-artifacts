import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** What the app knows of a provider beyond how to reach it (worker/gateway-models.ts). */
interface ProviderFacts {
  /** The picker's group label. */
  label: string;
  /** The provider's name in models.dev's catalog, where the build reads its prices (scripts/prices.ts); absent for those priced from their own pages. */
  modelsDev?: string;
}

/**
 * The providers the picker can list, in its order: Workers AI (no key needed), and every AI Gateway provider the app
 * knows how to list models from and talk to (worker/gateway-models.ts). A provider shows up only once AI Gateway holds a
 * key for it.
 */
export const PROVIDERS = {
  anthropic: { label: "Anthropic" },
  openai: { label: "OpenAI" },
  "google-ai-studio": { label: "Google", modelsDev: "google" },
  grok: { label: "xAI", modelsDev: "xai" },
  mistral: { label: "Mistral", modelsDev: "mistral" },
  deepseek: { label: "DeepSeek", modelsDev: "deepseek" },
  groq: { label: "Groq", modelsDev: "groq" },
  cerebras: { label: "Cerebras", modelsDev: "cerebras" },
  cohere: { label: "Cohere", modelsDev: "cohere" },
  openrouter: { label: "OpenRouter", modelsDev: "openrouter" },
  huggingface: { label: "Hugging Face", modelsDev: "huggingface" },
  "workers-ai": { label: "Workers AI (free daily allowance)" },
} satisfies Record<string, ProviderFacts>;

export type ProviderId = keyof typeof PROVIDERS;

/** A provider's group label. */
export function providerLabel(id: ProviderId): string {
  return PROVIDERS[id].label;
}

/** A model a chat can run on, as the model picker lists it. */
export interface ModelInfo {
  /**
   * What a chat's choice names: an AI Gateway catalog specifier (anthropic/claude-opus-5.5), a Workers AI id (@cf/…),
   * or `<provider>/<the provider's own id>` for a model listed live from a provider (groq/llama-3.3-70b-versatile).
   * Always the model's `modelKey`.
   */
  id: string;
  name: string;
  provider: ProviderId;
  /** The effort levels the model takes, lowest first. Empty for a model that does not reason. */
  efforts: ModelThinkingLevel[];
  /** Whether the model sees images. One that does not gets a placeholder for each image attached to a message. */
  images: boolean;
  /** Its context window, in tokens, when known. */
  contextWindow?: number;
  /** Dollars per million input and output tokens. Absent when no price is known: its replies then count as free. */
  price?: { input: number; output: number };
}

/** The picker's choices: the models, and when the providers were last asked for them (ms since the epoch). */
export interface ModelCatalog {
  models: ModelInfo[];
  checkedAt?: number;
}

/** A chat's model and effort, and a user's default for new chats, which can be Auto (AUTO_MODEL). */
export interface ModelChoice {
  model: string;
  thinkingLevel: ModelThinkingLevel;
}

/**
 * The picker's id for Auto: before each message that starts a run, a small, fast model (the deployment's ROUTER_MODEL)
 * reads the conversation and the message and picks the model and effort to answer it with (worker/agent/route.ts),
 * among the deployment's AUTO_MODELS.
 */
export const AUTO_MODEL = "auto";

/** A model Auto may pick (the deployment's AUTO_MODELS): the picker's id, and what it is best at, which the router reads. */
export interface AutoCandidate {
  id: string;
  use?: string;
}

/** The pi provider every AI Gateway catalog and Workers AI model comes through (agents/models/pi-ai's). */
export const CLOUDFLARE_PROVIDER = "cloudflare";

/**
 * The picker's id for a pi model, from its provider and id: the id alone for a Cloudflare one (whose ids already say
 * their vendor), else `<provider>/<id>`. pi keys its spend ledger `provider/id`, so a ledger key goes through here too.
 */
export function modelKey(provider: string, id: string): string {
  return provider === CLOUDFLARE_PROVIDER ? id : `${provider}/${id}`;
}

/**
 * When a chat's older messages are summarized (pi-durable's compaction, which the chat agent is opened with): above
 * `contextWindow - reserveTokens` a reply waits for a summary, and one starts in the background `backgroundTokens`
 * before that. The app's context meter shows the same point.
 */
export const COMPACTION = { reserveTokens: 16384, backgroundTokens: 32768 } as const;

/** The picker's id for a pi ledger key (`provider/id`). */
export function modelKeyOfLedger(key: string): string {
  const slash = key.indexOf("/");
  return slash < 0 ? key : modelKey(key.slice(0, slash), key.slice(slash + 1));
}

export const EFFORT_LABELS: Record<ModelThinkingLevel, string> = {
  off: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** How the app names an effort: "High effort". */
export function effortLabel(level: ModelThinkingLevel): string {
  return `${EFFORT_LABELS[level]} effort`;
}
