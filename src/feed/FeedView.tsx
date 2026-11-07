import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { feedPath, followKey, type FeedItem, type FeedKind, type FeedList, type FollowView } from "../../shared/feed.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { ActionDecision } from "../chat/ActionCard.tsx";
import { UnreadDot } from "../chat/ChatList.tsx";
import { AgentAvatar, Avatar } from "../chat/people.tsx";
import { sentLabel } from "../chat/SentTime.tsx";
import { Icon } from "../Icon.tsx";
import { isBoolean, MenuButton, opensElsewhere, useStoredState } from "../layout.tsx";
import { putFeedCounts, putFollows, reloadFeed, useFeedCounts, useFollows } from "./store.ts";

/** What each kind says in its small label, beside the time. */
const KIND_LABEL: Record<FeedKind, string> = {
  tag: "Mention",
  agent_post: "Post",
  approval: "Approval",
  assumption: "To confirm",
  question: "Question",
  page_version: "New version",
  page_chat: "Page chat",
  run: "Run",
};

/**
 * The feed: one list of what came in for the user across their chats, pages and agents (shared/feed.ts), newest first.
 * "Needs you" keeps the items that wait on them (questions, guesses to confirm, approvals, a run waiting for a
 * sign-in), and the Unread switch the ones they have not opened. Opening an item marks it read; below the list, what
 * they follow, with a way to stop.
 */
export function FeedView({ navigate, onMenu }: { navigate: (path: string) => void; onMenu?: () => void }) {
  const [needsYou, setNeedsYou] = useStoredState("feed.needsYou", false, isBoolean);
  const [unread, setUnread] = useStoredState("feed.unread", false, isBoolean);
  const [list, setList] = useState<FeedList | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The counts' version moves whenever the sidebar's socket says the feed changed: the list is read again then.
  const { version } = useFeedCounts();
  useEffect(() => {
    let current = true;
    api.feed({ unread, needsYou }).then(
      (next) => current && (setList(next), setError(null)),
      (e: unknown) => current && setError(errorMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [unread, needsYou, version]);

  const mark = useCallback(async (ids: readonly number[] | "all", read = true) => {
    // Shown at once; the counts it answers with move the version, and this list is read again.
    setList((shown) => shown && { ...shown, items: shown.items.map((item) => (ids === "all" || ids.includes(item.id) ? withRead(item, read) : item)) });
    try {
      putFeedCounts(await api.markFeed(ids, read));
    } catch (e) {
      setError(errorMessage(e));
      void reloadFeed();
    }
  }, []);

  const open = async (item: FeedItem, event: MouseEvent) => {
    if (!item.read) void mark([item.id]);
    if (opensElsewhere(event)) return;
    event.preventDefault();
    if (item.open.to === "discuss") {
      // Joining the page's chat is what opening it means: the page's own chat, as Discuss on the page does.
      try {
        const found = await api.discuss(item.open.artifactId);
        if ("chatId" in found) return navigate(`/c/${found.chatId}`);
      } catch (e) {
        return setError(errorMessage(e));
      }
    }
    // A page opens on its own, as the sidebar's artifacts do.
    if (item.open.to === "page" || item.open.to === "discuss") window.open(feedPath(item.open), "_blank", "noopener");
    else navigate(feedPath(item.open));
  };

  const items = list?.items ?? [];
  return (
    <div className="feed-page">
      <header className="feed-head">
        {onMenu && <MenuButton onClick={onMenu} />}
        <h2>Feed</h2>
        <div className="feed-tabs" role="tablist" aria-label="Which items">
          <button type="button" role="tab" aria-selected={!needsYou} className={!needsYou ? "feed-tab active" : "feed-tab"} onClick={() => setNeedsYou(false)}>
            Everything
          </button>
          <button type="button" role="tab" aria-selected={needsYou} className={needsYou ? "feed-tab active" : "feed-tab"} onClick={() => setNeedsYou(true)}>
            Needs you{list && list.needsYou > 0 && <span className="feed-count">{list.needsYou}</span>}
          </button>
        </div>
        <label className="feed-switch">
          <input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} />
          Unread
        </label>
        <button type="button" className="link-button feed-all-read" disabled={!list?.unread} onClick={() => void mark("all")}>
          Mark all read
        </button>
      </header>
      {error && <p className="form-error">{error}</p>}
      {list && !items.length && (
        <p className="feed-empty">
          {needsYou
            ? "Nothing waits on you."
            : unread
              ? "You have read everything."
              : "Nothing here yet. Mentions, your agents' runs, and what you follow show up here."}
        </p>
      )}
      <ul className="feed-list">
        {items.map((item) => (
          <FeedRow key={item.id} item={item} onOpen={(event) => void open(item, event)} onMark={(read) => void mark([item.id], read)} />
        ))}
      </ul>
      <Following />
    </div>
  );
}

function withRead(item: FeedItem, read: boolean): FeedItem {
  const { read: _read, ...rest } = item;
  return read ? { ...rest, read: true } : rest;
}

/** One item: who or what it is from, what happened, its text, when; and a way to mark it read or unread. */
function FeedRow({ item, onOpen, onMark }: { item: FeedItem; onOpen: (event: MouseEvent) => void; onMark: (read: boolean) => void }) {
  const [now] = useState(Date.now);
  const [more, setMore] = useState(false);
  const long = (item.text?.length ?? 0) > 280;
  const classes = ["feed-item", !item.read && "unread", item.needsYou && "needs", item.status && `run-${item.status}`].filter(Boolean).join(" ");
  return (
    <li className={classes}>
      <FeedIcon item={item} />
      <div className="feed-body">
        <a href={feedPath(item.open)} className="feed-title" onClick={onOpen}>
          {item.title}
        </a>
        {item.text && <p className={long && !more ? "feed-text clamped" : "feed-text"}>{item.text}</p>}
        {long && (
          <button type="button" className="link-button feed-more" onClick={() => setMore(!more)}>
            {more ? "Show less" : "Show more"}
          </button>
        )}
        {item.action && <ActionDecision action={item.action} waiting={item.needsYou === true} />}
        <div className="feed-meta">
          <span className={item.needsYou ? "pill feed-kind needs" : "pill feed-kind"}>
            {item.needsYou && item.kind === "run" ? "Needs you" : KIND_LABEL[item.kind]}
          </span>
          <time dateTime={new Date(item.at).toISOString()}>{sentLabel(item.at, now)}</time>
        </div>
      </div>
      <div className="feed-side">
        {!item.read && <UnreadDot label="Unread" />}
        <button
          type="button"
          className="icon-button feed-mark"
          title={item.read ? "Mark unread" : "Mark read"}
          aria-label={item.read ? "Mark unread" : "Mark read"}
          onClick={() => onMark(!item.read)}
        >
          <Icon size={16}>{item.read ? <circle cx="12" cy="12" r="4" /> : <path d="M5 12.5l4.5 4.5L19 7.5" />}</Icon>
        </button>
      </div>
    </li>
  );
}

/** An agent's badge, a person's initial, or an icon for what the item is about. */
function FeedIcon({ item }: { item: FeedItem }) {
  if (item.from?.agent) return <AgentAvatar badge={item.from.agent} />;
  if (item.from) return <Avatar name={item.from.name} tint={0} />;
  return (
    <span className="avatar feed-icon" aria-hidden="true">
      <Icon size={16}>
        {item.kind === "page_chat" ? (
          <path d="M5 6h14v9H9l-4 3z" />
        ) : (
          <>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M4 9h16M9 9v11" />
          </>
        )}
      </Icon>
    </span>
  );
}

/** What the user follows: each page and agent, with a way to stop. */
function Following() {
  const { value: follows, error } = useFollows();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (!follows?.length && !error) {
    return (
      <section className="feed-following">
        <h3>Following</h3>
        <p className="feed-empty">Follow a page from its page, or an agent shared in a chat from its page, to see its new versions and posts here.</p>
      </section>
    );
  }
  const stop = async (follow: FollowView) => {
    setBusy(followKey(follow));
    setFailed(null);
    try {
      putFollows(await api.unfollow(follow));
    } catch (e) {
      setFailed(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="feed-following">
      <h3>
        Following <small>{follows?.length ?? 0}</small>
      </h3>
      {(error || failed) && <p className="form-error">{failed ?? error}</p>}
      <ul>
        {(follows ?? []).map((follow) => (
          <li key={followKey(follow)}>
            <a
              href={feedPath(follow.kind === "page" ? { to: "page", artifactId: follow.id } : { to: "agent", agentId: follow.id, ...(follow.chatId && { chatId: follow.chatId }) })}
              target={follow.kind === "page" ? "_blank" : undefined}
              rel="noreferrer"
            >
              {follow.title}
            </a>
            <small>{follow.kind === "page" ? "page" : "agent"}</small>
            <button type="button" disabled={busy === followKey(follow)} onClick={() => void stop(follow)}>
              Unfollow
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
