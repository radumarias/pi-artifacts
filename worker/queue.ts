import { InboxDoc, type AgentEvent, type ConversationView, type InboxItem, type InboxState, type SubmissionId } from "@earendil-works/pi-durable";
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
  const waiting = new Map(peopleMessages(view).map((message) => [message.id, message]));
  return ids.flatMap((id) => waiting.get(id) ?? []);
}

/** The ids of the messages `uid` has waiting in the inbox in `view`, oldest first. */
export function queuedIdsOf(view: Pick<ConversationView, "docs">, uid: string): SubmissionId[] {
  return peopleMessages(view)
    .filter((message) => message.uid === uid)
    .map((message) => message.id as SubmissionId);
}

/** Every person's message waiting in the inbox in `view`, oldest first. */
function peopleMessages(view: Pick<ConversationView, "docs">): QueuedMessage[] {
  const inbox = view.docs[InboxDoc.definition.kind] as InboxState | undefined;
  return (inbox?.items ?? []).flatMap((item: InboxItem) =>
    item.entry?.kind === CHAT_MESSAGE_KIND ? [{ ...(item.entry.data as unknown as ChatMessageData), id: item.id as number }] : [],
  );
}
