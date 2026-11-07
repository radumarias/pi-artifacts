// Who may do what with the agents of a chat that has people in it: the chat object asks these before every change,
// and before it takes anything from a seat. In plain functions, so the tests run them.

import type { RosterEntry } from "../roster.ts";

/** The chat as these rules read it: its owner, and who is in it now. */
export interface ChatRules {
  ownerUid: string;
  isInChat(uid: string): boolean;
  /** Whether `uid` has an account of their own (the owner's second seat has none, and brings no agents). */
  hasAccount(uid: string): boolean;
}

/** Why `uid` may not bring an agent of theirs into the chat; null when they may: anyone in it, with an account. */
export function addRefusal(chat: ChatRules, uid: string): string | null {
  if (!chat.isInChat(uid)) return "You are not in this chat.";
  if (!chat.hasAccount(uid)) return "Add agents as the chat's owner.";
  return null;
}

/** Whether `uid` may take an agent out of the chat: the chat's owner, or the agent's, while in it. */
export function mayRemove(chat: ChatRules, uid: string, entry: Pick<RosterEntry, "ownerUid">): boolean {
  return chat.isInChat(uid) && (uid === chat.ownerUid || uid === entry.ownerUid);
}

/** Whether `uid` may share an agent with the people of the chat, or stop: only the agent's owner, while in it. */
export function mayShare(chat: ChatRules, uid: string, entry: Pick<RosterEntry, "ownerUid">): boolean {
  return chat.isInChat(uid) && uid === entry.ownerUid;
}

/**
 * The roster entry a seat's call is about: a member's agent (`seat`) that `uid`, still in the chat and not its owner,
 * brought in. Null for anything else, which the chat then gives nothing and takes nothing from.
 */
export function seatedEntry(chat: ChatRules, entry: RosterEntry | null, uid: string): RosterEntry | null {
  return entry?.seat !== undefined && entry.ownerUid === uid && uid !== chat.ownerUid && chat.isInChat(uid) ? entry : null;
}
