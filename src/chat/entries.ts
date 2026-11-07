import type { UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { CHAT_AGENT_KIND, CHAT_TURN_KIND, proposedBy, type ChatAgentReplyData } from "../../shared/agents.ts";
import { entryItems, mergeItems, type ItemRef } from "../../shared/items.ts";
import { CHAT_MESSAGE_KIND, CHAT_PEOPLE_KIND, publishedBy, type ChatMessageData, type ChatPeopleData } from "../../shared/protocol.ts";
import { CHAT_COPY_KIND, CHAT_EVENT_KIND, type ChatCopyData } from "../../shared/chat-kinds.ts";

/** When an entry was sent, for one that has a time: messages from before chats kept `sentAt` have only the time pi wrote them, and asides not even that. */
export function sentAt(entry: EntryRecord): number | undefined {
  if (entry.kind === CHAT_AGENT_KIND) return (entry.data as unknown as ChatAgentReplyData).endedAt;
  if (entry.kind === CHAT_COPY_KIND) {
    const data = entry.data as unknown as ChatCopyData;
    return data.from === "pi" ? data.sentAt : undefined;
  }
  const at = entry.kind === CHAT_MESSAGE_KIND ? (entry.data as unknown as ChatMessageData).sentAt : undefined;
  return at ?? entry.model?.[0]?.timestamp;
}

/**
 * Entries the app shows something for; the others (such as asides for the model) do not end an agent's reply, or start
 * one. Another agent's reply (`chat.agent`) shows as its own message.
 */
export function shown(entry: EntryRecord): boolean {
  return (
    entry.kind === CHAT_MESSAGE_KIND ||
    entry.kind === CHAT_PEOPLE_KIND ||
    entry.kind === CHAT_AGENT_KIND ||
    entry.kind === CHAT_EVENT_KIND ||
    entry.kind === CHAT_COPY_KIND ||
    entry.kind === "pi.user" ||
    isAgent(entry)
  );
}

export function isAgent(entry: EntryRecord): boolean {
  return entry.kind === "pi.assistant" || entry.kind === "pi.tool-result";
}

/** The artifact a publish's result made, which shows as a card. */
export const published = publishedBy;

/** A tool result that shows as a card of its own (a published artifact, a drafted agent), not as a step of its call. */
export const showsAsCard = (entry: EntryRecord): boolean => published(entry) !== undefined || proposedBy(entry) !== undefined;

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

const STARTS_RUN: ReadonlySet<string> = new Set(["pi.user", CHAT_MESSAGE_KIND, CHAT_TURN_KIND]);

/**
 * Whether `entry` starts a run of pi's, and so ends the reply before it: a person's message, or a turn an agent handed
 * pi. An aside does not (it can be written while pi works), nor another agent's reply posted meanwhile.
 */
export function startsRun(entry: Pick<EntryRecord, "kind" | "data">): boolean {
  return STARTS_RUN.has(entry.kind) && !(entry.kind === CHAT_MESSAGE_KIND && (entry.data as Partial<ChatMessageData> | undefined)?.aside);
}

/**
 * The item chips under each of pi's replies, by the entry they show under (its last message with text): the records its
 * MCP results held (shared/items.ts), from the tool results' details, never from its text. A reply ends where the
 * next run starts (startsRun).
 */
export function replyItems(entries: readonly EntryRecord[], previous?: ReadonlyMap<number, ItemRef[]>): ReadonlyMap<number, ItemRef[]> {
  const byEntry = new Map<number, ItemRef[]>();
  let found: ItemRef[][] = [];
  let lastText: number | undefined;
  const flush = () => {
    const items = lastText === undefined ? [] : mergeItems(found);
    // The same chips as `previous` gave keep its array, so a memoized reply does not draw again for each new entry.
    const known = lastText === undefined ? undefined : previous?.get(lastText);
    if (items.length) byEntry.set(lastText!, known && sameItems(known, items) ? known : items);
    found = [];
    lastText = undefined;
  };
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (startsRun(entry)) flush();
    else if (entry.kind === "pi.tool-result") found.push(entryItems(entry));
    else if (entry.kind === "pi.assistant" && message?.role === "assistant" && blocks(message.content).some((block) => block.type === "text" && block.text.trim()))
      lastText = entry.id as number;
  }
  flush();
  return byEntry;
}

function sameItems(a: readonly ItemRef[], b: readonly ItemRef[]): boolean {
  return a.length === b.length && a.every((item, i) => item.server === b[i].server && item.id === b[i].id && item.title === b[i].title && item.url === b[i].url);
}
