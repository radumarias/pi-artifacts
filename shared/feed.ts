// Follows and the feed: one list per person of what came in for them across their chats, pages and agents. A follow
// is of a page or an agent someone else owns: new chats on that page, its new versions and that agent's posts reach the
// follower's feed without anyone adding them. The feed also holds what needs the person (a question an agent asked
// them, an assumption to confirm, an approval waiting) and how their own agents' runs went. Off-the-record chats never
// reach it (mayLeave in shared/chat-kinds.ts).

import type { ChatAgentView } from "./agents.ts";
import type { PendingActionView } from "./limits.ts";
import type { EndedRunStatus, RunStatus } from "./runs.ts";

/** One follow among a person's, as the app names it: two people's agents can share an id, and whose it is tells them apart. */
export const followKey = (follow: { kind: string; id: string; ownerUid?: string }) => `${follow.kind}:${follow.id}:${follow.ownerUid ?? ""}`;

/**
 * The follow of a page, or of `ownerUid`'s agent, by its key (followKey): a follow of an agent belongs to the chat it
 * was made from and shows from any chat that shares it; only that person's, as agent ids are unique only per person.
 */
export function findFollow(follows: readonly FollowView[], target: Pick<FollowView, "kind" | "id" | "ownerUid">): FollowView | undefined {
  const key = followKey(target);
  return follows.find((follow) => followKey(follow) === key);
}

/** What can be followed: a page (an artifact) or an agent, someone else's either way. */
export type FollowKind = "page" | "agent";

export const FOLLOW_KINDS: readonly FollowKind[] = ["page", "agent"];

export function isFollowKind(value: unknown): value is FollowKind {
  return typeof value === "string" && (FOLLOW_KINDS as readonly string[]).includes(value);
}

/** The most pages and agents one person follows, and the most followers one page or agent keeps. */
export const MAX_FOLLOWS = 200;
export const MAX_FOLLOWERS = 500;

/** A follow, as its follower's list shows it: never who owns the target (an artifact's page does not say either). */
export interface FollowView {
  kind: FollowKind;
  id: string;
  /** The page's title, or the agent's "@name", as they were when last heard of. */
  title: string;
  /** For an agent: the chat it is shared in, where its follower may open it. */
  chatId?: string;
  /** For an agent: whose it is, as the chat that shares it shows (agent ids are unique only per person). */
  ownerUid?: string;
  at: number;
}

/**
 * What a feed item is about:
 *   tag           someone tagged this person in a chat, or added them to one
 *   agent_post    an agent this person follows posted a report
 *   approval      an action of one of their agents waits for their approval
 *   assumption    an agent drafted for them guessed some of its fields: confirm them
 *   question      an agent asked them something in a chat
 *   page_version  a page they follow has a new version
 *   page_chat     a page they follow has a chat now, which they may join
 *   run           one of their own agents' runs ended: sent, not today, failed, or waiting for a sign-in
 */
export type FeedKind = "tag" | "agent_post" | "approval" | "assumption" | "question" | "page_version" | "page_chat" | "run";

/** Where opening an item goes: a chat, a page (a version of it), a page's chat (joined on the way), an agent's page. */
export type FeedOpen =
  | { to: "chat"; chatId: string }
  | { to: "page"; artifactId: string }
  | { to: "discuss"; artifactId: string }
  | { to: "agent"; agentId: string; chatId?: string; tab?: string };

/** Who an item comes from: a person by name, or an agent, shown with its badge. */
export interface FeedFrom {
  name: string;
  agent?: Pick<ChatAgentView, "id" | "name" | "avatar" | "color">;
}

/** An item from an agent: its @name, with its badge. */
export function agentFrom({ id, name, avatar, color }: Pick<ChatAgentView, "id" | "name" | "avatar" | "color">): FeedFrom {
  return { name: `@${name}`, agent: { id, name, avatar, color } };
}

/** An item as the code that adds it gives it (UserDirectory.addFeed). */
export interface FeedInput {
  kind: FeedKind;
  /**
   * What the item is, unique in one person's feed: the same event added twice (a retry, a run that went on after a
   * restart) is one item, and a newer state of it (a run that signed in and then sent) replaces the older one.
   */
  ref: string;
  at: number;
  /** The line it shows: "Maria mentioned you in Signups", "Weekly signups has version 5". */
  title: string;
  /** What it says, when there is more to read: the post, the message's start, the question. */
  text?: string;
  from?: FeedFrom;
  open: FeedOpen;
  /**
   * The chat it came from, with its kind as the sender knows it: the feed refuses it when that chat is off the record,
   * and marks it read once the person has seen the chat.
   */
  chat?: { id: string; kind: string };
  /**
   * It waits on the person: an answer, an approval, a sign-in. "Needs you" lists it until it is resolved, read or not:
   * true until the code that added it resolves it (UserDirectory.resolveFeed), "reply" until the person next writes in
   * its chat (a question is answered so). The kinds in NEEDS_YOU wait so without saying it.
   */
  needsYou?: boolean | "reply";
  /** A run's item: how the run ended. */
  status?: RunStatus;
  /** Shown as read from the start: a quiet run (not today) is in the feed, but nothing to look at. */
  quiet?: boolean;
  /** The receiver's own agent it is about (its run, its draft): deleting that agent takes the item along. */
  aboutAgent?: string;
  /** An approval's action, as it was held: the feed decides it from there (Approve, Decline). */
  action?: FeedAction;
}

/**
 * An approval's action as its feed item keeps it: what deciding it there takes, and once decided how it ended (its
 * result's start), so the resolved item still says so. Not its call's input, which can be large and stays in the chat
 * (the item's text has the call in one line).
 */
export type FeedAction = Pick<PendingActionView, "id" | "chatId" | "kind" | "status" | "expiresAt" | "result" | "decidedAt">;

/** How an approval's action ended, as its feed item keeps it. */
export type FeedActionEnd = Pick<FeedAction, "status" | "result" | "decidedAt">;

/** How much of an ended action's result its feed item keeps. */
export const MAX_FEED_RESULT = 300;

/** An item in the feed, as the app lists it. */
export interface FeedItem {
  id: number;
  kind: FeedKind;
  at: number;
  title: string;
  text?: string;
  from?: FeedFrom;
  open: FeedOpen;
  status?: RunStatus;
  read?: true;
  needsYou?: true;
  /** An approval's action, as it was held: while the item needs the person, they decide it in the feed. */
  action?: FeedAction;
}

/** GET /api/feed: the newest items (filtered as asked), how many are unread, and how many still wait on the person. */
export interface FeedList {
  items: FeedItem[];
  unread: number;
  needsYou: number;
}

/**
 * The kinds that always wait on the person, beside items marked so (a run waiting for a sign-in): a question until they
 * write in its chat again, the others until what they ask is done (an approval decided, an agent's guesses confirmed).
 */
export const NEEDS_YOU: Partial<Record<FeedKind, true | "reply">> = { approval: true, assumption: true, question: "reply" };

/** The most items one feed keeps; the oldest go first, read ones before unread. */
export const MAX_FEED_ITEMS = 500;
/** How many items one read of the feed returns. */
export const FEED_PAGE = 100;
/** The longest title and text an item keeps. */
export const MAX_FEED_TITLE = 200;
export const MAX_FEED_TEXT = 2_000;

/** The path in the app an item opens. */
export function feedPath(open: FeedOpen): string {
  switch (open.to) {
    case "chat":
      return `/c/${open.chatId}`;
    case "page":
    case "discuss":
      return `/a/${open.artifactId}`;
    case "agent": {
      const query = new URLSearchParams({ ...(open.tab && { tab: open.tab }), ...(open.chatId && { chat: open.chatId }) }).toString();
      return `/agents/${open.agentId}${query ? `?${query}` : ""}`;
    }
  }
}

/** A run's item in its owner's feed: one per run, its newer state replacing the older. */
export const runFeedRef = (agentId: string, dueAt: number) => `run:${agentId}:${dueAt}`;

/** A run's end in words, after the agent's name: what its feed item says. */
export const RUN_FEED_TEXT: Record<EndedRunStatus, string> = {
  sent: "sent its report",
  not_today: "had nothing to report",
  failed: "failed",
  needs_sign_in: "is waiting for you to sign in",
};
