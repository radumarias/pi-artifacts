import { calendarDay } from "./SentTime.tsx";
import { CHAT_KINDS, KIND_TEXT } from "../../shared/chat-kinds.ts";
import type { ChatSummary } from "../../shared/protocol.ts";

/** How the chat list groups the chats below the pinned and unread ones: not at all, by when they were last active, or by kind. */
export type ChatGrouping = "none" | "date" | "kind";

export const GROUPINGS: Record<ChatGrouping, string> = { none: "No groups", date: "By date", kind: "By kind" };

export function isGrouping(value: unknown): value is ChatGrouping {
  return typeof value === "string" && Object.hasOwn(GROUPINGS, value);
}

/** One run of the chat list under a heading (none for a list with only one run). */
export interface ChatGroup {
  key: string;
  label?: string;
  chats: ChatSummary[];
}

/** Whether something in the chat waits for the user: a reply or message they have not seen, or a tag. */
export const hasUnread = (chat: ChatSummary) => Boolean(chat.unread || chat.mentioned);

const DAY_MS = 24 * 60 * 60_000;

/** The heading a chat goes under by date: how many calendar days before `now` it was last active (as the transcript counts them). */
function dateGroup(at: number, now: number): { key: string; label: string } {
  const days = Math.round((calendarDay(now) - calendarDay(at)) / DAY_MS);
  if (days <= 0) return { key: "today", label: "Today" };
  if (days === 1) return { key: "yesterday", label: "Yesterday" };
  if (days <= 7) return { key: "week", label: "Previous 7 days" };
  if (days <= 30) return { key: "month", label: "Previous 30 days" };
  return { key: "older", label: "Older" };
}

/**
 * The chat list as the sidebar shows it: the user's pinned chats on top, in the order they pinned them; then, with
 * `unreadFirst`, every chat with something unread, most recent first; then the rest, most recent first, in `groupBy`'s
 * groups. Closed chats are left out (`closed` lists them), except the open one (`openId`), so the list says where the
 * user is. `chats` come most recent first, as the server lists them.
 */
export function orderChats(
  chats: readonly ChatSummary[],
  { unreadFirst, groupBy }: { unreadFirst: boolean; groupBy: ChatGrouping },
  openId: string | undefined,
  now = Date.now(),
): { groups: ChatGroup[]; closed: ChatSummary[] } {
  const listed = chats.filter((chat) => !chat.closed || chat.id === openId);
  const closed = chats.filter((chat) => chat.closed && chat.id !== openId);
  const pinned = listed.filter((chat) => chat.pinnedAt).sort((a, b) => a.pinnedAt! - b.pinnedAt!);
  const unpinned = listed.filter((chat) => !chat.pinnedAt);
  const unread = unreadFirst ? unpinned.filter(hasUnread) : [];
  const rest = unreadFirst ? unpinned.filter((chat) => !hasUnread(chat)) : unpinned;
  const groups: ChatGroup[] = [];
  if (pinned.length) groups.push({ key: "pinned", label: "Pinned", chats: pinned });
  if (unread.length) groups.push({ key: "unread", label: "Unread", chats: unread });
  if (groupBy === "date") {
    for (const chat of rest) {
      const { key, label } = dateGroup(chat.updatedAt, now);
      const group = groups.find((g) => g.key === key);
      if (group) group.chats.push(chat);
      else groups.push({ key, label, chats: [chat] });
    }
  } else if (groupBy === "kind") {
    for (const kind of CHAT_KINDS) {
      const ofKind = rest.filter((chat) => chat.kind === kind);
      if (ofKind.length) groups.push({ key: kind, label: KIND_TEXT[kind].label, chats: ofKind });
    }
  } else if (rest.length) {
    // Under a heading only when there are others above it.
    groups.push({ key: "all", ...(groups.length && { label: "Chats" }), chats: rest });
  }
  return { groups, closed };
}
