import { useEffect } from "react";
import type { ChatSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
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

export function ChatList({ chats, openId, navigate }: { chats: ChatSummary[]; openId: string | undefined; navigate: (path: string) => void }) {
  return (
    <nav>
      {chats.map((chat) => (
        <a
          key={chat.id}
          href={`/c/${chat.id}`}
          className={["nav-item", chat.id === openId && "active", chat.unread && chat.id !== openId && "unread"].filter(Boolean).join(" ")}
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
      ))}
    </nav>
  );
}
