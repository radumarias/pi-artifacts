import { useState, type MouseEvent } from "react";
import type { FollowKind } from "../../shared/feed.ts";
import { errorMessage } from "../../shared/util.ts";
import { Icon } from "../Icon.tsx";
import { opensElsewhere } from "../layout.tsx";
import { useFeedCounts, useFollow } from "./store.ts";

/** The sidebar's way to the feed, with how many items are unread and how many of them need the user. */
export function FeedNav({ active, navigate }: { active: boolean; navigate: (path: string) => void }) {
  const { value } = useFeedCounts();
  const unread = value?.unread ?? 0;
  const needs = value?.needsYou ?? 0;
  const go = (event: MouseEvent) => {
    if (opensElsewhere(event)) return;
    event.preventDefault();
    navigate("/feed");
  };
  return (
    <nav className="feed-nav" aria-label="Feed">
      <a href="/feed" className={["nav-item", "feed-link", active && "active", unread > 0 && "unread"].filter(Boolean).join(" ")} onClick={go}>
        <Icon size={18}>
          <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10 20a2 2 0 0 0 4 0" />
        </Icon>
        <span className="nav-title">Feed</span>
        {needs > 0 && (
          <span className="pill feed-needs" title={`${needs} waiting on you`}>
            {needs} need{needs === 1 ? "s" : ""} you
          </span>
        )}
        {unread > 0 && (
          <span className="feed-unread" aria-label={`${unread} unread`}>
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </a>
    </nav>
  );
}

/**
 * Follow a page or an agent someone else owns (an agent from the chat that shares it, `chatId`): its new versions,
 * chats or posts then reach the user's feed. "Following" stops it.
 */
export function FollowButton({ kind, id, chatId }: { kind: FollowKind; id: string; chatId?: string }) {
  const { known, following, toggle, error: loadError } = useFollow(kind, id, chatId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const click = async () => {
    setBusy(true);
    setError(null);
    try {
      await toggle();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // A failed read of the follows leaves the button off: say why.
  const shown = error ?? (known ? null : loadError);
  const what = kind === "page" ? "its new versions, and a chat about it when one starts" : "its posts";
  return (
    <>
      <button
        type="button"
        className={following ? "follow-button following" : "follow-button"}
        disabled={!known || busy}
        aria-pressed={following}
        title={following ? "Stop following" : `Follow: see ${what} in your feed`}
        onClick={() => void click()}
      >
        {following ? "Following" : "Follow"}
      </button>
      {shown && <span className="form-error follow-error">{shown}</span>}
    </>
  );
}
