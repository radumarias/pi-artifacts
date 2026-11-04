import { AGENT_NAME } from "./mentions.ts";

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

/**
 * A chat's reactions: by transcript entry (a person's message, or one of the agent's replies), each emoji and who
 * reacted with it (uids, or AGENT_REACTOR), first first. Entries and emoji nobody reacted with are left out.
 */
export type Reactions = Record<number, Partial<Record<Reaction, string[]>>>;
