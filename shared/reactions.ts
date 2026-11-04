import type { EntryRecord } from "@earendil-works/pi-durable";
import { AGENT_NAME } from "./mentions.ts";
import { CHAT_MESSAGE_KIND } from "./protocol.ts";

/**
 * The emoji anyone in a chat can react to a message with, the agent included. A fixed set: the server takes no other,
 * so a reaction is never text someone chose.
 */
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🚀", "✅", "🙏"] as const;
export type Reaction = (typeof REACTIONS)[number];

export function isReaction(value: unknown): value is Reaction {
  return (REACTIONS as readonly unknown[]).includes(value);
}

/** Who reacted, for the agent: no uid looks like it (UID_PATTERN has no "@"). */
export const AGENT_REACTOR = `@${AGENT_NAME}`;

/** The emoji the agent reacts with: all but 👀, which it shows by itself on each message that called it (ChatMessageData.summoned). */
export const AGENT_REACTIONS = REACTIONS.filter((emoji) => emoji !== "👀");

/** Whether people can react to a transcript entry: a person's message, or one of the agent's replies. */
export function isReactable(entry: Pick<EntryRecord, "kind" | "model"> | undefined): boolean {
  return entry?.kind === CHAT_MESSAGE_KIND || (entry?.kind === "pi.assistant" && entry.model?.[0]?.role === "assistant");
}

/** One entry's reactions: each emoji and who reacted with it (uids, or AGENT_REACTOR), first first. */
export type EntryReactions = Partial<Record<Reaction, string[]>>;

/**
 * A chat's reactions, by transcript entry (isReactable). Entries and emoji nobody reacted with are left out; the app
 * shows the emoji in the set's order.
 */
export type Reactions = Record<number, EntryReactions>;
