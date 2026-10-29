import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ThinkingLevel = ModelThinkingLevel;

/** A model a chat can run on, as the model picker lists it. */
export interface ModelInfo {
  /** The pi-ai AI Gateway specifier, e.g. anthropic/claude-opus-5.5: what a chat's agent state names. */
  id: string;
  name: string;
  vendor: string;
  /** The effort levels the model takes, lowest first. Empty for a model that does not reason. */
  efforts: ThinkingLevel[];
}

/** A chat's model and effort, and a user's default for new chats. */
export interface ModelChoice {
  model: string;
  thinkingLevel: ThinkingLevel;
}

export const EFFORT_LABELS: Record<ThinkingLevel, string> = {
  off: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** The effort to run `model` at when `wanted` is asked for: `wanted` if the model takes it, else medium, else its lowest. */
export function effortFor(model: ModelInfo, wanted: string | undefined): ThinkingLevel {
  if (model.efforts.length === 0) return "off";
  if (model.efforts.includes(wanted as ThinkingLevel)) return wanted as ThinkingLevel;
  return model.efforts.includes("medium") ? "medium" : model.efforts[0];
}
