import type { EntryRecord } from "@earendil-works/pi-durable";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "../../shared/attachments.ts";
import { CHAT_MESSAGE_KIND, type ChatMessageData, type QueuedMessage, type ReplyQuote } from "../../shared/protocol.ts";

/**
 * A message this window sent that the chat has not shown yet. The chat puts a message in only once it is ready (its
 * files read, the agent's tools refreshed and, on Auto, the model picked), which can take seconds; until then the
 * view shows it from here.
 */
export interface Sending {
  key: number;
  text: string;
  /** The last transcript entry when it was sent: its own comes after it. */
  after: number;
  attachments?: Attachment[];
  replyTo?: ReplyQuote;
  /** It calls the agent in a chat on Auto: the router picks the model before it goes in. */
  picking: boolean;
}

/** How long a sent message is shown before it is let go: the chat dropped it (a file it may not attach) or failed. */
export const SENDING_MS = 120_000;

/**
 * Those of `sending` the chat does not show yet. Each of `uid`'s messages that came in stands for one sent, the oldest
 * with its text: a transcript entry after the one it was sent after, or a message in the queue.
 */
export function unshown(sending: readonly Sending[], entries: readonly EntryRecord[], queued: readonly QueuedMessage[], uid: string): Sending[] {
  if (!sending.length) return [];
  const used = new Set<unknown>();
  const take = <T>(items: readonly T[], fits: (item: T) => boolean) => {
    const found = items.find((item) => !used.has(item) && fits(item));
    if (found !== undefined) used.add(found);
    return found !== undefined;
  };
  return sending.filter((sent) => {
    const mine = (data: Pick<ChatMessageData, "uid" | "text">) => data.uid === uid && data.text === sent.text;
    const placed = take(entries, (entry) => entry.id > sent.after && entry.kind === CHAT_MESSAGE_KIND && mine(entry.data as unknown as ChatMessageData));
    return !placed && !take(queued, mine);
  });
}

/**
 * The messages this window sent that the chat does not show yet (see Sending), and `add` for one just sent. One is let
 * go once it shows, when the chat reports an error, or after SENDING_MS.
 */
export function useSending(entries: readonly EntryRecord[], queued: readonly QueuedMessage[], uid: string, error: string | undefined) {
  const [sending, setSending] = useState<Sending[]>([]);
  const next = useRef(0);
  // Kept only while not shown: a message seen once is gone, also from the next comparison.
  const pending = unshown(sending, entries, queued, uid);
  const settled = pending.length !== sending.length;
  useEffect(() => {
    if (settled) setSending(pending);
  });
  // A prompt the chat refused says why, as an error: what it was about is no longer coming.
  useEffect(() => {
    if (error) setSending([]);
  }, [error]);
  const add = useCallback((message: Omit<Sending, "key">) => {
    const key = next.current++;
    setSending((list) => [...list, { ...message, key }]);
    setTimeout(() => setSending((list) => list.filter((sent) => sent.key !== key)), SENDING_MS);
  }, []);
  return { sending: pending, add };
}
