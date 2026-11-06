import type { UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { CHAT_AGENT_KIND, type ChatAgentReplyData } from "../../shared/agents.ts";
import { CHAT_MESSAGE_KIND, CHAT_PEOPLE_KIND, publishedBy, type ChatMessageData, type ChatPeopleData } from "../../shared/protocol.ts";

/** When an entry was sent, for one that has a time: messages from before chats kept `sentAt` have only the time pi wrote them, and asides not even that. */
export function sentAt(entry: EntryRecord): number | undefined {
  if (entry.kind === CHAT_AGENT_KIND) return (entry.data as unknown as ChatAgentReplyData).endedAt;
  const at = entry.kind === CHAT_MESSAGE_KIND ? (entry.data as unknown as ChatMessageData).sentAt : undefined;
  return at ?? entry.model?.[0]?.timestamp;
}

/**
 * Entries the app shows something for; the others (such as asides for the model) do not end an agent's reply, or start
 * one. Another agent's reply (`chat.agent`) shows as its own message.
 */
export function shown(entry: EntryRecord): boolean {
  return entry.kind === CHAT_MESSAGE_KIND || entry.kind === CHAT_PEOPLE_KIND || entry.kind === CHAT_AGENT_KIND || entry.kind === "pi.user" || isAgent(entry);
}

export function isAgent(entry: EntryRecord): boolean {
  return entry.kind === "pi.assistant" || entry.kind === "pi.tool-result";
}

/** The artifact a publish's result made, which shows as a card. */
export const published = publishedBy;

/** Whether the viewer `uid` wrote the entry, or caused it (joined, left). A plain `pi.user` entry is the owner's (`isOwner`). */
export function byViewer(entry: EntryRecord, uid: string, isOwner: boolean): boolean {
  if (entry.kind === "pi.user") return isOwner;
  if (entry.kind === CHAT_MESSAGE_KIND) return (entry.data as unknown as ChatMessageData).uid === uid;
  if (entry.kind === CHAT_PEOPLE_KIND) return (entry.data as unknown as ChatPeopleData).uid === uid;
  return false;
}

/**
 * The entry the "New" line goes over: the first one shown that someone else (a person, or the agent) sent after the
 * viewer last saw the chat (`seenAt`). None when nothing is new, or when everything is (there is nothing read above it).
 */
export function firstNew(entries: readonly EntryRecord[], seenAt: number, uid: string, isOwner: boolean): number | undefined {
  let before = false;
  for (const entry of entries) {
    if (!shown(entry)) continue;
    const at = sentAt(entry);
    if (at !== undefined && at > seenAt && !byViewer(entry, uid, isOwner)) return before ? (entry.id as number) : undefined;
    before = true;
  }
  return undefined;
}

/**
 * The hinted messages (`hints`, entries the agent was not called on but that look meant for it) still worth calling it
 * on: those it has not run since. A run after one (its reply, or a message that called it) read the message already.
 */
export function openHints(hints: ReadonlySet<number>, entries: readonly EntryRecord[]): ReadonlySet<number> {
  if (!hints.size) return hints;
  const called = entries.findLast(
    (entry) => isAgent(entry) || (entry.kind === CHAT_MESSAGE_KIND && (entry.data as unknown as ChatMessageData).summoned === true),
  );
  const after = called === undefined ? -1 : (called.id as number);
  return new Set([...hints].filter((id) => id > after));
}

/** A message's blocks, skipping any slot a stream has not filled yet. */
export function blocks<T>(content: string | readonly (T | undefined | null)[]): T[] {
  return typeof content === "string" ? [] : content.filter((b): b is T => b != null);
}

/** A person's message as pi stored it, as text: its text blocks, without the images. */
export function userText(message: UserMessage): string {
  return typeof message.content === "string"
    ? message.content
    : blocks(message.content)
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
}
