import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { CHAT_MESSAGE_KIND, REPLY_QUOTE_CHARS, type ChatMessageData, type ReplyQuote } from "../../shared/protocol.ts";

/**
 * What a reply quotes of the message in `entry`: a person's message, or a reply of the agent's (its text, without its
 * thoughts and tool calls). Null for anything else, or a message with no text to quote.
 */
export function replyQuote(entry: EntryRecord | undefined): ReplyQuote | null {
  if (!entry) return null;
  if (entry.kind === CHAT_MESSAGE_KIND) {
    const data = entry.data as unknown as ChatMessageData | undefined;
    const text = cut(data?.text ?? "");
    return data && text ? { id: entry.id as number, name: data.name, uid: data.uid, text } : null;
  }
  const message = entry.model?.[0];
  if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return null;
  const text = cut((message as AssistantMessage).content.flatMap((block) => (block?.type === "text" ? [block.text] : [])).join("\n\n"));
  return text ? { id: entry.id as number, name: AGENT_NAME, agent: true, text } : null;
}

/** How the model reads a reply: who and what it answers, before the text. */
export function replyLine(quote: ReplyQuote): string {
  return `[Replying to ${quote.name}: "${quote.text}"]`;
}

function cut(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > REPLY_QUOTE_CHARS ? `${trimmed.slice(0, REPLY_QUOTE_CHARS - 1)}…` : trimmed;
}
