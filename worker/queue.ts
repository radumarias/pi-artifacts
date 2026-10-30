import type { ConversationView, InboxState } from "@earendil-works/pi-durable";
import { CHAT_MESSAGE_KIND, type ChatMessageData, type QueuedMessage } from "../shared/protocol.ts";

/** pi's built-in document of the submissions waiting for a boundary. */
const INBOX_DOC = "pi.inbox";

/**
 * The people's messages waiting in pi's inbox while a run goes, in the order pi will place them. Each is the
 * `chat.message` entry it will be placed as; queued writes and input from anywhere else are not people's messages.
 */
export function queuedMessages(view: Pick<ConversationView, "docs"> | undefined): QueuedMessage[] {
  const inbox = view?.docs[INBOX_DOC] as InboxState | undefined;
  return (inbox?.items ?? []).flatMap((item) =>
    item.mode !== "write" && item.entry?.kind === CHAT_MESSAGE_KIND ? [{ ...(item.entry.data as unknown as ChatMessageData), id: item.id }] : [],
  );
}
