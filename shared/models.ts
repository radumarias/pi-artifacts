import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Where a chat's models come from, in the order the picker lists them, with the picker's group labels. */
export const VENDORS = {
  local: "Local runtime",
  anthropic: "Anthropic",
  openai: "OpenAI",
  "workers-ai": "Workers AI (free daily allowance)",
} as const;

export type Vendor = keyof typeof VENDORS;

/** The pi-ai provider a local runtime's models run under (`worker/local-models.ts`). */
export const LOCAL_PROVIDER_ID = "local";

/** How the picker and a chat's saved choice name a local model: `local/` and the runtime's id, which may have slashes. */
export const LOCAL_PREFIX = `${LOCAL_PROVIDER_ID}/`;

/**
 * The picker's id for the model a chat's agent state names. A cloud model's pi id is the picker's; a local model's is
 * the runtime's own, which the picker names with `local/` in front.
 */
export function pickerModelId(model: { provider: string; modelId: string }): string {
  return model.provider === LOCAL_PROVIDER_ID ? LOCAL_PREFIX + model.modelId : model.modelId;
}

/** A model a chat can run on, as the model picker lists it. */
export interface ModelInfo {
  /**
   * The pi-ai id a chat's agent state names: an AI Gateway specifier (anthropic/claude-opus-5.5), a Workers AI id, or
   * `local/` and a local runtime's id (local/qwen/qwen3-32b).
   */
  id: string;
  name: string;
  vendor: Vendor;
  /** The effort levels the model takes, lowest first. Empty for a model that does not reason. */
  efforts: ModelThinkingLevel[];
  /** Whether the model sees images. One that does not gets a placeholder for each image attached to a message. */
  images: boolean;
}

/** A chat's model and effort, and a user's default for new chats. */
export interface ModelChoice {
  model: string;
  thinkingLevel: ModelThinkingLevel;
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
