import { useEffect, useMemo } from "react";
import type { ChatSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { useStoredState } from "../layout.tsx";
import { useLatest, useVisible } from "../sidebar.ts";

/**
 * The user's chats, and a `load` that reads them again (the sidebar's socket calls it when they changed). The open
 * chat (`openId`) is marked seen while the window shows it.
 */
export function useChatList(openId: string | undefined) {
  const [chats, load, setChats] = useLatest(api.chats, []);
  const visible = useVisible();
  useEffect(load, [load]);

  const unseen = chats.some((chat) => chat.id === openId && (chat.unread || chat.mentioned));
  useEffect(() => {
    if (!openId || !unseen || !visible) return;
    setChats((list) => list.map((chat) => (chat.id === openId ? { ...chat, unread: undefined, mentioned: undefined } : chat)));
    api.markSeen(openId).catch(() => {});
  }, [openId, unseen, visible]);

  return { chats, load };
}

/** On the right of a chat's name: a tag of the user, its agent working, waiting for an answer, or a reply nobody here has read. */
function ChatStatusIcon({ chat, open }: { chat: ChatSummary; open: boolean }) {
  if (chat.mentioned && !open) {
    return (
      <span className="nav-status chat-mentioned" role="img" aria-label="You were mentioned" title="You were mentioned">
        @
      </span>
    );
  }
  if (chat.status === "running") return <span className="spinner nav-status" role="img" aria-label="Working" title="Working" />;
  if (chat.status === "waiting") {
    return (
      <span className="nav-status chat-waiting" role="img" aria-label="Waiting for your answer" title="Waiting for your answer">
        ?
      </span>
    );
  }
  if (chat.unread && !open) return <UnreadDot label="Unread" />;
  return null;
}

/** Something new in a sidebar entry that the user has not looked at yet. */
export function UnreadDot({ label }: { label: string }) {
  return <span className="nav-status nav-unread" role="img" aria-label={label} title={label} />;
}

/** Which chats the list shows: all, only the user's own nobody else is in, or shared ones (by them, with them, or both). */
type ChatFilter = "all" | "private" | "shared" | "shared-by-me" | "shared-with-me";

/** Whether other people are in the chat: the user shared it, or someone shared it with them. */
const isShared = (chat: ChatSummary) => Boolean(chat.sharedBy || chat.shared);

const FILTERS: Record<ChatFilter, { label: string; title: string; keep: (chat: ChatSummary) => boolean }> = {
  all: { label: "All", title: "All chats", keep: () => true },
  private: { label: "Private", title: "Your chats nobody else is in", keep: (chat) => !isShared(chat) },
  shared: { label: "Shared", title: "Chats with other people in them", keep: isShared },
  "shared-by-me": { label: "By me", title: "Your chats you shared with others", keep: (chat) => Boolean(chat.shared) },
  "shared-with-me": { label: "With me", title: "Chats others shared with you", keep: (chat) => Boolean(chat.sharedBy) },
};
const CHOICES = Object.keys(FILTERS) as ChatFilter[];
const TOP: readonly ChatFilter[] = ["all", "private", "shared"];
const SHARED: readonly ChatFilter[] = ["shared", "shared-by-me", "shared-with-me"];

const isChatFilter = (value: unknown): value is ChatFilter => typeof value === "string" && Object.hasOwn(FILTERS, value);

/**
 * The chat list's filter, remembered in this browser. Until a chat is shared there is nothing to filter: then `bar` is
 * false and every chat shows. `waiting` names the choices that would show a chat the current one hides where someone
 * tagged the user, or with something unread.
 */
export function useChatFilter(chats: readonly ChatSummary[]) {
  const [stored, setFilter] = useStoredState<ChatFilter>("layout.chatFilter", "all", isChatFilter);
  return {
    setFilter,
    ...useMemo(() => {
      const bar = chats.some(isShared);
      const filter = bar ? stored : "all";
      const { keep } = FILTERS[filter];
      const hidden = chats.filter((chat) => (chat.mentioned || chat.unread) && !keep(chat));
      return {
        bar,
        filter,
        shown: chats.filter(keep),
        empty: !bar ? undefined : filter === "private" ? "No private chats." : "No shared chats here.",
        waiting: new Set(CHOICES.filter((choice) => hidden.some(FILTERS[choice].keep))),
      };
    }, [chats, stored]),
  };
}

/** Above the chat list: All, Private or Shared, and within Shared, both, by the user or with them. */
export function ChatFilterBar({ filter, setFilter, waiting }: ReturnType<typeof useChatFilter>) {
  const inShared = SHARED.includes(filter);
  const chip = (choice: ChatFilter, active: boolean, label = FILTERS[choice].label) => (
    <button
      key={choice}
      type="button"
      className={active ? "chip active" : "chip"}
      aria-pressed={active}
      title={FILTERS[choice].title}
      onClick={() => setFilter(choice)}
    >
      {label}
      {!active && waiting.has(choice) && <UnreadDot label="Has something new" />}
    </button>
  );
  return (
    <div className="chat-filter">
      <div className="chips" role="group" aria-label="Show chats">
        {TOP.map((choice) => chip(choice, choice === "shared" ? inShared : choice === filter))}
      </div>
      {inShared && (
        <div className="chips sub" role="group" aria-label="Shared chats">
          {SHARED.map((choice) => chip(choice, choice === filter, choice === "shared" ? "Both" : undefined))}
        </div>
      )}
    </div>
  );
}

interface ChatListProps {
  chats: ChatSummary[];
  openId: string | undefined;
  navigate: (path: string) => void;
  /** Ask to delete one of the user's own chats. */
  onDelete: (chatId: string) => void;
  /** What to say when there are none to show. */
  empty?: string;
}

export function ChatList({ chats, openId, navigate, onDelete, empty }: ChatListProps) {
  if (chats.length === 0 && empty) return <p className="nav-empty">{empty}</p>;
  return (
    <nav>
      {chats.map((chat) => (
        <div key={chat.id} className={chat.id === openId ? "chat-link active" : "chat-link"}>
          <a
            href={`/c/${chat.id}`}
            className={chat.unread && chat.id !== openId ? "nav-item unread" : "nav-item"}
            title={chat.sharedBy && `Shared by ${chat.sharedBy}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/c/${chat.id}`);
            }}
          >
            <span className="nav-title">
              {chat.title}
              {chat.sharedBy && <small> · {chat.sharedBy}</small>}
            </span>
            <ChatStatusIcon chat={chat} open={chat.id === openId} />
          </a>
          {/* Only the owner can delete a chat; someone it is shared with leaves it from the chat's People panel. */}
          {!chat.sharedBy && (
            <button type="button" className="chat-delete" title="Delete chat" aria-label={`Delete chat ${chat.title}`} onClick={() => onDelete(chat.id)}>
              <Icon size={15} box={24}>
                <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
              </Icon>
            </button>
          )}
        </div>
      ))}
    </nav>
  );
}
