import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * The providers the picker can list, in its order, with their group labels: Workers AI (no key needed), and every AI
 * Gateway provider the app knows how to list models from and talk to (worker/gateway-models.ts). A provider shows up
 * only once AI Gateway holds a key for it.
 */
export const PROVIDERS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "google-ai-studio": "Google",
  grok: "xAI",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  groq: "Groq",
  cerebras: "Cerebras",
  cohere: "Cohere",
  openrouter: "OpenRouter",
  huggingface: "Hugging Face",
  "workers-ai": "Workers AI (free daily allowance)",
} as const;

export type ProviderId = keyof typeof PROVIDERS;

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

/** A chat's model and effort, and a user's default for new chats. */
export interface ModelChoice {
  model: string;
  thinkingLevel: ModelThinkingLevel;
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
