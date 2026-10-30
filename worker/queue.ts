import { InboxDoc, type AgentEvent, type ConversationView, type InboxState } from "@earendil-works/pi-durable";
import { CHAT_MESSAGE_KIND, type ChatMessageData, type QueuedMessage } from "../shared/protocol.ts";

/**
 * The ids of the inbox items a batch of events leaves queued, in pi's order: from its last snapshot or inbox update.
 * Undefined when the batch does not change the inbox.
 */
export function inboxIds(batch: readonly AgentEvent[]): number[] | undefined {
  const last = batch.findLast((event) => event.type === "snapshot" || event.type === "inbox_update");
  if (!last) return undefined;
  return (last.type === "snapshot" ? last.inbox : last.items).map((item) => item.id);
}

/**
 * The people's messages among `ids`, in that order, from the inbox in `view`. Each is the `chat.message` entry it will
 * be placed as; other input is not a person's message, and an id no longer in the inbox (placed since) is left out.
 */
export function queuedMessages(view: Pick<ConversationView, "docs">, ids: readonly number[]): QueuedMessage[] {
  const inbox = view.docs[InboxDoc.definition.kind] as InboxState | undefined;
  const waiting = new Map(
    (inbox?.items ?? []).flatMap((item) =>
      item.entry?.kind === CHAT_MESSAGE_KIND ? [[item.id as number, { ...(item.entry.data as unknown as ChatMessageData), id: item.id }] as const] : [],
    ),
  );
  return ids.flatMap((id) => waiting.get(id) ?? []);
}
