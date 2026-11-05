/**
 * The system prompts a user writes: their own, for all their chats, and one chat's, which adds to it. Both come after
 * the built-in prompt (worker/agent/prompt.ts), which they never replace.
 */

/** The longest system prompt a user or a chat can have, in characters: it is in every model request. */
export const MAX_SYSTEM_PROMPT = 8_000;

/** A chat's system prompt as someone in the chat reads it: only its owner may change it. */
export interface ChatSystemPrompt {
  text: string;
  editable: boolean;
}

/** `value` as a system prompt to save, trimmed (empty clears it), or why it cannot be one. */
export function checkSystemPrompt(value: unknown): { text: string } | { error: string } {
  if (typeof value !== "string") return { error: "Expected {text: string}." };
  const text = value.trim();
  if (text.length > MAX_SYSTEM_PROMPT) return { error: `A system prompt can be at most ${MAX_SYSTEM_PROMPT.toLocaleString("en")} characters.` };
  return { text };
}
