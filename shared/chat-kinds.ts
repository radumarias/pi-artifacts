import type { Person } from "./protocol.ts";

/**
 * A chat's kind: who may see it, when its agents answer, and what may leave it.
 *   private     only its owner; agents answer every message
 *   group       the people added; agents answer only when called (@name, or a reply to them)
 *   page        linked to an artifact: anyone who can open that page can join; agents only when called, with the page in context
 *   off_record  only people added by hand; agents only when called; nothing leaves the chat
 * The chat object keeps the kind and copies it to each sidebar row that lists the chat (UserDirectory). The rules are
 * functions here, so every store that takes something out of a chat (memory notes, search, routines, the feed) asks the
 * same question in code, never in a prompt.
 */
export type ChatKind = "private" | "group" | "page" | "off_record";

export const CHAT_KINDS: readonly ChatKind[] = ["private", "group", "page", "off_record"];

export function isChatKind(value: unknown): value is ChatKind {
  return typeof value === "string" && (CHAT_KINDS as readonly string[]).includes(value);
}

/** How someone came to be in a chat: an invite link, added directly by the owner, joined from the chat's page, or the owner's second seat. */
export type JoinedVia = "invite" | "added" | "page" | "seat";

export const JOINED_VIA: readonly JoinedVia[] = ["invite", "added", "page", "seat"];

export function isJoinedVia(value: unknown): value is JoinedVia {
  return typeof value === "string" && (JOINED_VIA as readonly string[]).includes(value);
}

/** A member and how they joined: what narrowing a chat reads to tell who loses access. */
export type ChatMemberVia = Person & { via: JoinedVia };

/** What the chip and the sidebar say of each kind. */
export const KIND_TEXT: Record<ChatKind, { label: string; who: string; agents: string; leaves: string }> = {
  private: { label: "Private", who: "Only you", agents: "Agents answer every message", leaves: "Memory notes, search and routines may use it" },
  group: { label: "Group", who: "The people added", agents: "Agents answer only when called", leaves: "Memory notes stay in this chat" },
  page: { label: "On a page", who: "Anyone who can open the page can join", agents: "Agents answer only when called, with the page open", leaves: "Memory notes stay in this chat" },
  off_record: { label: "Off the record", who: "Only people added by hand", agents: "Agents answer only when called", leaves: "Nothing leaves: no memory notes, search, routines or feed previews" },
};

/** Whether the chat's agents answer every message, or only those that call them. */
export function answersEveryMessage(kind: ChatKind): boolean {
  return kind === "private";
}

/**
 * What may take something out of a chat: a memory note (`scope` "chat" is one only this chat reads, "everywhere" one
 * the owner's other chats read too), a search across chats, a routine reading the chat, a preview in someone's feed.
 */
export type Leaving = { what: "memory"; scope: "chat" | "everywhere" } | { what: "search" } | { what: "routine" } | { what: "feed" };

/**
 * Whether `leaving` may take something out of a chat of these kinds. Given more than one (the kind the chat says and the
 * kind a sidebar row last heard, which can lag behind a change), the strictest wins: a chat just made off the record
 * lets nothing out even where a copy still says otherwise. No kind given lets nothing out.
 */
export function mayLeave(leaving: Leaving, ...kinds: (ChatKind | null | undefined)[]): boolean {
  if (!kinds.length) return false;
  return kinds.every((kind) => {
    if (!kind || kind === "off_record") return false;
    if (leaving.what === "memory") return kind === "private" || leaving.scope === "chat";
    return true;
  });
}

/** Whether someone who joined `via` may stay in a chat of `kind`. The owner is never a member, so always stays. */
export function mayStay(kind: ChatKind, via: JoinedVia): boolean {
  if (kind === "private") return false;
  if (kind === "page") return true;
  // A group, and off the record, keep the people someone added: by invite, directly, or the owner themselves.
  return via !== "page";
}

/** The members who lose access when the chat becomes `kind`, in the order given. */
export function losesAccess(kind: ChatKind, members: readonly ChatMemberVia[]): ChatMemberVia[] {
  return members.filter((member) => !mayStay(kind, member.via));
}

/** How widely each kind lets people in: changing to a wider one shows everyone who joins the whole history. */
const REACH: Record<ChatKind, number> = { private: 0, off_record: 1, group: 2, page: 3 };

/** Whether moving `from` → `to` lets more people in than before. */
export function widens(from: ChatKind, to: ChatKind): boolean {
  return REACH[to] > REACH[from];
}

/**
 * Whether moving `from` → `to` can shut someone out, or lets more out of the chat: the owner is asked first, with the
 * list of who loses access. Off the record → anything else is not narrowing: it lets things out, which the chip says.
 */
export function narrows(from: ChatKind, to: ChatKind): boolean {
  return from !== to && (REACH[to] < REACH[from] || to === "off_record");
}

/** The kind a chat becomes when someone joins it: a private chat with a member is a group; the others stay as they are. */
export function kindAfterJoin(kind: ChatKind): ChatKind {
  return kind === "private" ? "group" : kind;
}

/**
 * The kinds the owner may pick for a chat now: "on a page" only for a chat linked to a page (made from it with
 * Discuss), since anyone who can open that page may then join.
 */
export function kindChoices(hasPage: boolean): ChatKind[] {
  return CHAT_KINDS.filter((kind) => kind !== "page" || hasPage);
}

/** The kind of a chat that never stored one: one with members is a group, else private. */
export function legacyKind(hasMembers: boolean): ChatKind {
  return hasMembers ? "group" : "private";
}

/** A chat linked to a page: the artifact it discusses, as it was last heard of. */
export type ChatPage = {
  id: string;
  title: string;
  version: number;
};

/** Where a chat branched off from: the chat, its title then, and the transcript entry the branch carries up to. */
export type BranchedFrom = {
  chatId: string;
  title: string;
  entry: number;
  /** The first chat of the conversation, which every branch of it, and of its branches, counts against. */
  root: string;
};

/** Someone, as a transcript entry names them. A type, so pi can store it. */
type Who = { uid: string; name: string };

/**
 * A notice about the chat itself in its transcript, a display-only entry everyone sees and the model does not read:
 *   kind      the owner changed the chat's kind (`removed`: who lost access), or a join made it a group (`auto`)
 *   page      the page the chat discusses has a new version
 *   branch    someone branched off a new chat from `entry`
 *   branched  this chat is a branch of `from`; above it, the conversation it carries
 */
export const CHAT_EVENT_KIND = "chat.event";
export type ChatEventData =
  | { event: "kind"; kind: ChatKind; from: ChatKind; by?: Who; auto?: true; removed?: Who[] }
  | { event: "page"; page: ChatPage }
  | { event: "branch"; chatId: string; title: string; entry: number; by: Who }
  | { event: "branched"; from: BranchedFrom; by: Who };

/**
 * A message copied into a branch from the chat it branched off: pi's reply as its text, or an artifact card. People's
 * messages and other agents' replies are copied as the entries they were (chat.message, chat.agent).
 */
export const CHAT_COPY_KIND = "chat.copy";
export type ChatCopyData = { from: "pi"; text: string; sentAt?: number } | { from: "artifact"; artifactId: string; title: string; version: number };

/** What the model reads that the app does not show: the page a chat discusses, or the conversation a branch carries. */
export const CHAT_CONTEXT_KIND = "chat.context";
