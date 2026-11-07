import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_CHAT_TITLE, type ChatSummary } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { isBoolean, useDismiss, useStoredState } from "../layout.tsx";
import { AgentAvatar } from "./people.tsx";
import { useLatest, useVisible } from "../sidebar.ts";
import { GROUPINGS, hasUnread, isGrouping, orderChats, type ChatGrouping } from "./chat-order.ts";

/**
 * The user's chats, and a `load` that reads them again (the sidebar's socket calls it when they changed). The open
 * chat (`openId`) is marked seen while the window shows it. `newSince`: when the user had last seen the open chat, as
 * marking it seen answers when they open it, or come back to the window, with something unread in it; what came after is new.
 */
export function useChatList(openId: string | undefined) {
  const [chats, load, setChats] = useLatest(api.chats, []);
  const visible = useVisible();
  useEffect(load, [load]);

  const [newSince, setNewSince] = useState<{ chatId: string; at: number } | null>(null);
  // Whether the next look at the open chat starts a new visit, which may move the "New" line: true when another chat
  // opens or the window is hidden. Something that comes in while the user is looking is not new to them.
  const visiting = useRef(true);
  useEffect(() => {
    visiting.current = true;
    setNewSince(null);
  }, [openId]);
  useEffect(() => {
    if (!visible) visiting.current = true;
  }, [visible]);
  // Leaving the chat, or hiding the window, ends the visit: what the user watched come in (a reply as it streamed)
  // is not new when they come back.
  useEffect(() => {
    if (!openId || !visible) return;
    return () => void api.leftChat(openId).catch(() => {});
  }, [openId, visible]);

  const open = chats.find((chat) => chat.id === openId);
  const listed = open !== undefined;
  const unseen = Boolean(open?.unread || open?.mentioned);
  useEffect(() => {
    if (!openId || !listed || !visible) return;
    const arrived = visiting.current;
    visiting.current = false;
    // On arriving, ask even when the list shows nothing unread: it can be behind (its socket reconnects only after the
    // window shows again, and loads lag), and the server knows whether something came in.
    if (!unseen && !arrived) return;
    if (unseen) setChats((list) => list.map((chat) => (chat.id === openId ? { ...chat, unread: undefined, mentioned: undefined } : chat)));
    api
      .markSeen(openId)
      .then(({ seenAt }) => arrived && seenAt && setNewSince({ chatId: openId, at: seenAt }))
      .catch(() => {});
  }, [openId, listed, unseen, visible]);

  return { chats, load, newSince: newSince && newSince.chatId === openId ? newSince.at : undefined };
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
export const isShared = (chat: ChatSummary) => Boolean(chat.sharedBy || chat.shared);

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
 * false and every chat shows. The open chat (`openId`) always shows, so the list says where the user is. `waiting` names the choices that would show a chat the current one hides where someone
 * tagged the user, or with something unread.
 */
export function useChatFilter(chats: readonly ChatSummary[], openId: string | undefined) {
  const [stored, setFilter] = useStoredState<ChatFilter>("layout.chatFilter", "all", isChatFilter);
  return {
    setFilter,
    ...useMemo(() => {
      const bar = chats.some(isShared);
      const filter = bar ? stored : "all";
      const { keep } = FILTERS[filter];
      // A closed chat waits for nothing until someone tags the user in it, which opens it again.
      const hidden = chats.filter((chat) => (chat.mentioned || chat.unread) && !chat.closed && !keep(chat) && chat.id !== openId);
      return {
        bar,
        filter,
        shown: chats.filter((chat) => keep(chat) || chat.id === openId),
        empty: !bar ? undefined : filter === "private" ? "No private chats." : "No shared chats here.",
        waiting: new Set(CHOICES.filter((choice) => hidden.some(FILTERS[choice].keep))),
      };
    }, [chats, stored, openId]),
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

/** How the list is ordered, remembered in this browser: unread chats on top, and how the rest are grouped. */
export function useChatOrder() {
  const [unreadFirst, setUnreadFirst] = useStoredState("layout.unreadFirst", true, isBoolean);
  const [groupBy, setGroupBy] = useStoredState<ChatGrouping>("layout.chatGrouping", "none", isGrouping);
  return { unreadFirst, setUnreadFirst, groupBy, setGroupBy };
}

/** The "Chats" heading, with what orders the list beside it. */
export function ChatsHeading({ order }: { order: ReturnType<typeof useChatOrder> }) {
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, setOpen);
  return (
    <div className="chats-heading" ref={box}>
      <h3>Chats</h3>
      <button type="button" className="icon-button chats-order" aria-expanded={open} title="Order the chats" aria-label="Order the chats" onClick={() => setOpen(!open)}>
        <Icon size={14} box={16} stroke={1.6}>
          <path d="M3 4.5h10M5 8h6M7 11.5h2" />
        </Icon>
      </button>
      {open && (
        <div className="row-menu" role="group" aria-label="Order the chats">
          <label>
            <input type="checkbox" checked={order.unreadFirst} onChange={(e) => order.setUnreadFirst(e.target.checked)} /> Unread first
          </label>
          {(Object.keys(GROUPINGS) as ChatGrouping[]).map((grouping) => (
            <label key={grouping}>
              <input type="radio" name="chat-grouping" checked={order.groupBy === grouping} onChange={() => order.setGroupBy(grouping)} /> {GROUPINGS[grouping]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

interface ChatListProps {
  chats: ChatSummary[];
  openId: string | undefined;
  /** The signed-in user: someone a chat is shared with leaves it as themselves. */
  uid: string;
  order: ReturnType<typeof useChatOrder>;
  navigate: (path: string) => void;
  /** Ask to delete one of the user's own chats. */
  onDelete: (chatId: string) => void;
  /** What to say when there are none to show. */
  empty?: string;
}

/**
 * The chats, pinned ones first, then (if the user wants) those with something unread, then the rest in the groups they
 * picked (chat-order.ts). Each has its own menu of what the user changes for themselves: pin, rename, copy its link,
 * mark it unread, close it, and leave a chat someone shared, or delete one of their own. Closed chats wait at the end.
 */
export function ChatList({ chats, openId, uid, order, navigate, onDelete, empty }: ChatListProps) {
  const [showClosed, setShowClosed] = useState(false);
  const { unreadFirst, groupBy } = order;
  const { groups, closed } = useMemo(() => orderChats(chats, { unreadFirst, groupBy }, openId), [chats, unreadFirst, groupBy, openId]);
  if (chats.length === 0 && empty) return <p className="nav-empty">{empty}</p>;
  const row = (chat: ChatSummary) => <ChatRow key={chat.id} chat={chat} open={chat.id === openId} uid={uid} navigate={navigate} onDelete={onDelete} />;
  return (
    <nav>
      {groups.map((group) => (
        <div key={group.key} className="chat-group">
          {group.label && <h4 className="nav-group">{group.label}</h4>}
          {group.chats.map(row)}
        </div>
      ))}
      {closed.length > 0 && (
        <>
          <button type="button" className="closed-toggle" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? "Hide closed chats" : `Closed chats (${closed.length})`}
          </button>
          {showClosed && <div className="chat-group closed">{closed.map(row)}</div>}
        </>
      )}
    </nav>
  );
}

function ChatRow({ chat, open, uid, navigate, onDelete }: { chat: ChatSummary; open: boolean; uid: string } & Pick<ChatListProps, "navigate" | "onDelete">) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useDismiss<HTMLDivElement>(menu, setMenu);
  const change = (patch: Parameters<typeof api.changeChatRow>[1]) => {
    setMenu(false);
    // The sidebar's socket brings the list back changed.
    api.changeChatRow(chat.id, patch).catch((e: unknown) => alert(`Could not change the chat: ${errorMessage(e)}`));
  };
  const copyLink = () => {
    navigator.clipboard.writeText(`${location.origin}/c/${chat.id}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
    setMenu(false);
  };
  const leave = async () => {
    setMenu(false);
    if (!confirm(`Leave "${chat.title}"? You lose it until someone adds you again.`)) return;
    try {
      await api.removeMember(chat.id, uid);
      if (open) navigate("/");
    } catch (e) {
      alert(`Could not leave the chat: ${errorMessage(e)}`);
    }
  };
  const unread = hasUnread(chat) && !open;
  return (
    <div ref={box} className={["chat-link", open && "active", menu && "menu-open"].filter(Boolean).join(" ")}>
      {renaming ? (
        <RenameChat chat={chat} onDone={(title) => (setRenaming(false), title !== undefined && change({ title }))} />
      ) : (
        <a
          href={`/c/${chat.id}`}
          className={chat.unread && !open ? "nav-item unread" : "nav-item"}
          title={chat.sharedBy && `Shared by ${chat.sharedBy}`}
          onClick={(e) => {
            e.preventDefault();
            navigate(`/c/${chat.id}`);
          }}
        >
          {chat.pinnedAt && <span className="nav-pin" aria-label="Pinned" title="Pinned" />}
          {chat.agent ? (
            // An agent's own chat shows like a contact's: its badge, its name and its last post.
            <span className="nav-title nav-contact">
              <AgentAvatar badge={chat.agent} />
              <span className="nav-contact-text">
                <span>@{chat.agent.name}</span>
                {chat.agent.preview && <small>{chat.agent.preview}</small>}
              </span>
            </span>
          ) : (
            <span className="nav-title">
              {chat.title}
              {chat.sharedBy && <small> · {chat.sharedBy}</small>}
            </span>
          )}
          {copied ? <small className="nav-copied">Copied</small> : <ChatStatusIcon chat={chat} open={open} />}
        </a>
      )}
      {!renaming && (
        <button type="button" className="chat-more" title="More" aria-label={`More for ${chat.title}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <Icon size={15} box={16} stroke={2.4}>
            <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
          </Icon>
        </button>
      )}
      {menu && (
        <div className="row-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => change({ pinned: !chat.pinnedAt })}>
            {chat.pinnedAt ? "Unpin" : "Pin"}
          </button>
          <button type="button" role="menuitem" onClick={() => (setMenu(false), setRenaming(true))}>
            Rename
          </button>
          <button type="button" role="menuitem" onClick={copyLink}>
            Copy link
          </button>
          {!unread && !open && (
            <button type="button" role="menuitem" onClick={() => change({ unread: true })}>
              Mark unread
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => change({ closed: !chat.closed })} title={chat.closed ? undefined : "Hide it until someone tags you in it"}>
            {chat.closed ? "Reopen" : "Close"}
          </button>
          {chat.sharedBy ? (
            <button type="button" role="menuitem" className="danger-item" onClick={() => void leave()}>
              Leave
            </button>
          ) : (
            <button type="button" role="menuitem" className="danger-item" onClick={() => (setMenu(false), onDelete(chat.id))}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The chat's name as an input, for the user's own name for it: Enter keeps it (empty goes back to the chat's own), Escape lets go. */
function RenameChat({ chat, onDone }: { chat: ChatSummary; onDone: (title?: string) => void }) {
  const [title, setTitle] = useState(chat.title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const save = () => onDone(title.trim() === chat.title ? undefined : title.trim());
  return (
    <input
      ref={input}
      className="chat-rename"
      value={title}
      maxLength={MAX_CHAT_TITLE}
      aria-label="Your name for this chat"
      onChange={(e) => setTitle(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
    />
  );
}
