import { useEffect } from "react";
import type { ChatSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { useLatest, useVisible } from "../sidebar.ts";

/**
 * The user's chats, and a `load` that reads them again (the sidebar's socket calls it when they changed). The open
 * chat (`openId`) is marked seen while the window shows it.
 */
export function useChatList(openId: string | undefined) {
  const [chats, load, setChats] = useLatest(api.chats, []);
  const visible = useVisible();
  useEffect(load, [load]);

  const unseen = chats.some((chat) => chat.id === openId && chat.unread);
  useEffect(() => {
    if (!openId || !unseen || !visible) return;
    setChats((list) => list.map((chat) => (chat.id === openId ? { ...chat, unread: undefined } : chat)));
    api.markSeen(openId).catch(() => {});
  }, [openId, unseen, visible]);

  return { chats, load };
}

/** On the right of a chat's name: its agent working, waiting for an answer, or a reply nobody here has read. */
function ChatStatusIcon({ chat, open }: { chat: ChatSummary; open: boolean }) {
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

interface ChatListProps {
  chats: ChatSummary[];
  openId: string | undefined;
  navigate: (path: string) => void;
  /** Ask to delete one of the user's own chats. */
  onDelete: (chatId: string) => void;
}

export function ChatList({ chats, openId, navigate, onDelete }: ChatListProps) {
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
