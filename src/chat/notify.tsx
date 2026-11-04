import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { MentionNotice } from "../../shared/protocol.ts";
import { Icon } from "../Icon.tsx";
import { useStoredState } from "../layout.tsx";
import { useVisible } from "../sidebar.ts";

/** How long a tag shows in the app once the window is in view. */
const TOAST_MS = 8_000;
/** Tags shown at once; older ones make room. */
const MAX_TOASTS = 3;
/** After "Not now", how long before the app asks again. */
const ASK_AGAIN_MS = 3 * 24 * 60 * 60 * 1000;

const supported = typeof window !== "undefined" && "Notification" in window;
type Permission = NotificationPermission | "unsupported";

/**
 * Whether the browser may show notifications, one value for every part of the app that asks: the card, the bell. It
 * follows a change made in the browser's site settings too, where the browser reports one (Permissions API).
 */
const permissionStore = (() => {
  const listeners = new Set<() => void>();
  let current: Permission = supported ? Notification.permission : "unsupported";
  const set = (next: Permission) => {
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  };
  if (supported) {
    navigator.permissions
      ?.query({ name: "notifications" })
      .then((status) => status.addEventListener("change", () => set(Notification.permission)))
      .catch(() => {});
  }
  return {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Asked from a click: browsers ask the user only then. */
    ask() {
      if (!supported) return;
      void Notification.requestPermission().then(set, () => set(Notification.permission));
    },
  };
})();

function useNotificationPermission(): [Permission, () => void] {
  return [useSyncExternalStore(permissionStore.subscribe, permissionStore.get), permissionStore.ask];
}

/**
 * Tags of the user in a shared chat, as the sidebar's socket hears them (MentionNotice). One in the chat the user is
 * looking at needs nothing: they see it come in. Any other shows in the app, and, while the window is hidden or in the
 * background and the browser may, as a notification, which a click brings back to the chat. Every open window hears
 * it; the notification's tag makes the browser show it once.
 */
export function useMentionNotices(chatId: string | undefined, navigate: (path: string) => void) {
  const [toasts, setToasts] = useState<MentionNotice[]>([]);
  const visible = useVisible();
  const dismiss = useCallback((notice: MentionNotice) => setToasts((list) => list.filter((t) => t.chatId !== notice.chatId || t.at !== notice.at)), []);
  /** Go to the chat a notice is from. */
  const open = useCallback(
    (notice: MentionNotice) => {
      dismiss(notice);
      navigate(`/c/${notice.chatId}`);
    },
    [dismiss, navigate],
  );

  const onMention = useCallback(
    (notice: MentionNotice) => {
      const focused = visible && document.hasFocus();
      // The chat on screen shows the message itself, focused or not.
      if (visible && notice.chatId === chatId) return;
      setToasts((list) => [...list.filter((t) => !(t.chatId === notice.chatId && t.at === notice.at)), notice].slice(-MAX_TOASTS));
      if (focused || !supported || Notification.permission !== "granted") return;
      try {
        const shown = new Notification(`${notice.from} mentioned you`, {
          body: [notice.title, notice.text].filter(Boolean).join("\n"),
          tag: `mention:${notice.chatId}:${notice.at}`,
        });
        shown.onclick = () => {
          window.focus();
          open(notice);
          shown.close();
        };
      } catch {
        // Some browsers (Android Chrome) show notifications only from a service worker: the app's own notice stays.
      }
    },
    [chatId, visible, open],
  );

  // Opening the chat a tag is from is seeing it.
  useEffect(() => setToasts((list) => (list.some((t) => t.chatId === chatId) ? list.filter((t) => t.chatId !== chatId) : list)), [chatId]);
  // Each goes a while after the window is in view, so one that came in while the user was away waits for them.
  const oldest = toasts[0];
  useEffect(() => {
    if (!oldest || !visible) return;
    const timer = setTimeout(() => dismiss(oldest), TOAST_MS);
    return () => clearTimeout(timer);
  }, [oldest, visible, dismiss]);

  return { toasts, onMention, dismiss, open };
}

/**
 * The tags of the user, in a corner of the app: a click opens the chat. Above them, while the browser has not been
 * answered and the user has a shared chat (`asking`), a card asks to show tags as the system's notifications, so one
 * reaches them in another tab or app; "Not now" puts it off for a few days.
 */
export function MentionToasts({ toasts, dismiss, open, asking }: ReturnType<typeof useMentionNotices> & { asking: boolean }) {
  const [permission, ask] = useNotificationPermission();
  const [askedAt, setAskedAt] = useStoredState<number>("notify.notNowAt", 0, (value): value is number => typeof value === "number");
  const [now] = useState(Date.now);
  const askCard = asking && permission === "default" && now - askedAt > ASK_AGAIN_MS;
  if (toasts.length === 0 && !askCard) return null;
  return (
    <div className="toasts">
      {askCard && (
        <div className="toast notify-ask">
          <BellIcon />
          <div className="toast-body">
            <strong>Get notified when someone mentions you</strong>
            <span className="toast-text">Your browser shows it even while you are in another tab or app.</span>
            <div className="notify-ask-actions">
              <button type="button" className="primary" onClick={ask}>
                Turn on notifications
              </button>
              <button type="button" onClick={() => setAskedAt(Date.now())}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Read out as they come; the card above, with its buttons, is not a status. */}
      <div className="toast-list" role="status" aria-live="polite">
        {toasts.map((notice) => (
          <div key={`${notice.chatId}:${notice.at}`} className="toast">
            <button type="button" className="toast-body" onClick={() => open(notice)}>
              <strong>
                <span className="toast-at" aria-hidden="true">
                  @
                </span>
                {notice.from} mentioned you
              </strong>
              {notice.title && <small>{notice.title}</small>}
              {notice.text && <span className="toast-text">{notice.text}</span>}
            </button>
            <button type="button" className="icon-button" onClick={() => dismiss(notice)} title="Dismiss" aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function BellIcon({ off = false }: { off?: boolean }) {
  return (
    <Icon size={16} box={24}>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9M10 19a2 2 0 0 0 4 0" />
      {off && <path d="M3 3l18 18" />}
    </Icon>
  );
}

/**
 * In a shared chat's header: whether tags reach the user as the browser's notifications. Unanswered, it stands out and
 * asks; blocked, it says where to allow them; allowed (or no such thing in this browser), it is gone.
 */
export function NotifyButton() {
  const [permission, ask] = useNotificationPermission();
  if (permission === "default") {
    return (
      <button
        type="button"
        className="icon-button notify-button ask"
        onClick={ask}
        title="Notify me when someone mentions me, even in another tab"
        aria-label="Turn on notifications"
      >
        <BellIcon />
      </button>
    );
  }
  if (permission === "denied") {
    return (
      <span
        className="notify-button off"
        title="Notifications are blocked for this site: allow them in the browser's site settings to hear about mentions in another tab"
        role="img"
        aria-label="Notifications blocked"
      >
        <BellIcon off />
      </span>
    );
  }
  return null;
}
