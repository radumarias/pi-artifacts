import type { EntryRecord } from "@earendil-works/pi-durable";
import { textOf } from "./canonical.ts";
import { AGENT_NAME } from "./mentions.ts";
import { CHAT_AGENT_KIND, type ChatAgentReplyData } from "./agents.ts";
import { CHAT_MESSAGE_KIND, REPLY_QUOTE_CHARS, type ChatMessageData, type ReplyQuote } from "./protocol.ts";

/**
 * What a reply quotes of the message in `entry`: a person's message, or a reply of the agent's (its text, without its
 * thoughts and tool calls). Null for anything else, or a message with no text to quote. The same rule for the composer
 * and the chat, which quotes the message again from its transcript.
 */
export function replyQuote(entry: EntryRecord | undefined): ReplyQuote | null {
  if (!entry) return null;
  if (entry.kind === CHAT_MESSAGE_KIND) {
    const data = entry.data as unknown as ChatMessageData | undefined;
    const text = excerpt(data?.text ?? "");
    return data && text ? { id: entry.id as number, name: data.name, uid: data.uid, text } : null;
  }
  if (entry.kind === CHAT_AGENT_KIND) {
    const data = entry.data as unknown as ChatAgentReplyData | undefined;
    const text = excerpt(data?.text ?? "");
    return data && text ? { id: entry.id as number, name: data.name, agent: true, agentId: data.agentId, text } : null;
  }
  const message = entry.model?.[0];
  if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return null;
  const text = excerpt(textOf(message.content.filter(Boolean), " "));
  return text ? { id: entry.id as number, name: AGENT_NAME, agent: true, text } : null;
}

/** How the model reads a reply: who and what it answers, before the text. */
export function replyLine(quote: ReplyQuote): string {
  return `[Replying to ${quote.name}: "${quote.text}"]`;
}

/** The start of a message on one line, as a quote shows it. */
export function excerpt(text: string, max = REPLY_QUOTE_CHARS): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
