import { useEffect, useState } from "react";
import { SIDEBAR_CHATS_CHANGED, type ChatSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";

/** How often the sidebar's socket pings: proxies close a socket that stays quiet for long. */
const PING_MS = 30_000;
/** One prompt changes the list several times in a row (bumped, working, named, done): read it once for those. */
const LOAD_DELAY_MS = 150;

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * The user's chats, kept current by the sidebar's socket: the server says when the list changed (a chat was named,
 * bumped, or its agent started or stopped working, in any window or by anyone in a shared chat), and the list is read
 * again. The open chat (`openId`) is marked seen while the window shows it.
 */
export function useChatList(openId: string | undefined) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const visible = useVisible();

  useEffect(() => {
    // Reads can overlap: only the newest one's list is shown, so a slow older read cannot put back a stale status.
    let reads = 0;
    const read = () => {
      const n = ++reads;
      api.chats().then((list) => n === reads && setChats(list), () => {});
    };
    let loading: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      clearTimeout(loading);
      loading = setTimeout(read, LOAD_DELAY_MS);
    };
    let closed = false;
    let attempt = 0;
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const open = () => {
      ws = new WebSocket(api.sidebarSocketUrl());
      ws.onopen = () => {
        attempt = 0;
        // Whatever changed while it was closed, or before it first opened.
        load();
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), PING_MS);
      };
      ws.onmessage = (event) => {
        if (event.data === SIDEBAR_CHATS_CHANGED) load();
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (!closed) retry = setTimeout(open, Math.min(1_000 * 2 ** attempt++, 30_000));
      };
    };
    read();
    // On the next tick, as the chat's socket does: a mount undone at once opens nothing.
    retry = setTimeout(open);
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(loading);
      clearInterval(ping);
      ws?.close();
    };
  }, []);

  const unseen = chats.some((chat) => chat.id === openId && chat.unread);
  useEffect(() => {
    if (!openId || !unseen || !visible) return;
    setChats((list) => list.map((chat) => (chat.id === openId ? { ...chat, unread: undefined } : chat)));
    api.markSeen(openId).catch(() => {});
  }, [openId, unseen, visible]);

  return chats;
}

/** On the right of a chat's name: its agent working, waiting for an answer, or a reply nobody here has read. */
function ChatStatusIcon({ chat, open }: { chat: ChatSummary; open: boolean }) {
  if (chat.status === "running") return <span className="spinner chat-status" role="img" aria-label="Working" title="Working" />;
  if (chat.status === "waiting") {
    return (
      <span className="chat-status chat-waiting" role="img" aria-label="Waiting for your answer" title="Waiting for your answer">
        ?
      </span>
    );
  }
  if (chat.unread && !open) return <span className="chat-status chat-unread" role="img" aria-label="Unread" title="Unread" />;
  return null;
}

export function ChatList({ chats, openId, navigate }: { chats: ChatSummary[]; openId: string | undefined; navigate: (path: string) => void }) {
  return (
    <nav>
      {chats.map((chat) => (
        <a
          key={chat.id}
          href={`/c/${chat.id}`}
          className={["chat-link", chat.id === openId && "active", chat.unread && chat.id !== openId && "unread"].filter(Boolean).join(" ")}
          title={chat.sharedBy && `Shared by ${chat.sharedBy}`}
          onClick={(e) => {
            e.preventDefault();
            navigate(`/c/${chat.id}`);
          }}
        >
          <span className="chat-title">
            {chat.title}
            {chat.sharedBy && <small> · {chat.sharedBy}</small>}
          </span>
          <ChatStatusIcon chat={chat} open={chat.id === openId} />
        </a>
      ))}
    </nav>
  );
}
