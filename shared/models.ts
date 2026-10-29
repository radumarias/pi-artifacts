import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Where a chat's models come from, in the order the picker lists them, with the picker's group labels. */
export const VENDORS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "workers-ai": "Workers AI (free daily allowance)",
};

/** A model a chat can run on, as the model picker lists it. */
export interface ModelInfo {
  /** The pi-ai id a chat's agent state names: an AI Gateway specifier (anthropic/claude-opus-5.5) or a Workers AI id. */
  id: string;
  name: string;
  /** A key of VENDORS. */
  vendor: string;
  /** The effort levels the model takes, lowest first. Empty for a model that does not reason. */
  efforts: ModelThinkingLevel[];
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
