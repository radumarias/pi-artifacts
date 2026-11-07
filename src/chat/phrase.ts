import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { startsRun } from "./entries.ts";

/** How long the working line's phrase may be. */
const PHRASE_CHARS = 60;

/** `text` as a phrase: its first sentence, on one line, without the end mark, cut to PHRASE_CHARS. */
export function phraseOf(text: string): string | undefined {
  const flat = text.slice(0, 600).trim().replace(/\s+/g, " ");
  const sentence = (/^.*?[.!?:…](?=\s|$)/.exec(flat)?.[0] ?? flat).replace(/[\s.!?:…]+$/, "");
  if (!sentence) return undefined;
  return sentence.length > PHRASE_CHARS ? `${sentence.slice(0, PHRASE_CHARS - 1).trimEnd()}…` : sentence;
}

/** The phrase a message gives for its newest tool call: the text right before that call, when there is some. */
function beforeCall(message: AssistantMessage): string | undefined | null {
  const content = message.content.filter(Boolean);
  const call = content.findLastIndex((block) => block.type === "toolCall");
  if (call < 0) return null;
  for (let i = call - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type === "toolCall") break;
    if (block.type === "text" && block.text.trim()) return phraseOf(block.text);
  }
  return undefined;
}

/**
 * What the working line says a run is doing, next to its timer ("looking for this week's signups"): the assistant's
 * own text right before its newest tool call, else that call's name as `label` puts it (stepLabel). Read from what the
 * run streams (`partial`) and the newest assistant entry; never a model call of its own. Undefined before any call.
 */
export function workingPhrase(entries: readonly EntryRecord[], partial: AssistantMessage | undefined, label: (tool: string) => string): string | undefined {
  // The run's own messages: the newest entries back to the message that started it (its steps are at the end).
  const latest: (AssistantMessage | undefined)[] = [partial];
  for (let i = entries.length - 1; i >= 0 && i >= entries.length - 30; i--) {
    const { kind, model } = entries[i];
    if (startsRun(entries[i])) break;
    if (kind === "pi.assistant" && model?.[0]?.role === "assistant") latest.push(model[0]);
  }
  for (const message of latest) {
    if (message?.role !== "assistant") continue;
    const said = beforeCall(message);
    // A message with no call (text only, or one still thinking) says nothing of the steps: look at the one before.
    if (said === null) continue;
    if (said) return said;
    const call = message.content.findLast((block) => block?.type === "toolCall");
    return call?.type === "toolCall" ? label(call.name) : undefined;
  }
  return undefined;
}
