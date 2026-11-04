import { useCallback, useEffect, useState } from "react";
import type { MentionNotice } from "../../shared/protocol.ts";
import { Icon } from "../Icon.tsx";
import { useVisible } from "../sidebar.ts";

/** How long a tag shows in the app once the window is in view. */
const TOAST_MS = 8_000;
/** Tags shown at once; older ones make room. */
const MAX_TOASTS = 3;

const supported = typeof window !== "undefined" && "Notification" in window;

/** Whether the browser may show notifications: asked once, from a click (browsers require one). */
export function useNotificationPermission(): [NotificationPermission | "unsupported", () => void] {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(supported ? Notification.permission : "unsupported");
  const ask = useCallback(() => {
    if (!supported) return;
    void Notification.requestPermission().then(setPermission, () => setPermission(Notification.permission));
  }, []);
  return [permission, ask];
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

  const onMention = useCallback(
    (notice: MentionNotice) => {
      const focused = document.visibilityState === "visible" && document.hasFocus();
      if (focused && notice.chatId === chatId) return;
      setToasts((list) => [...list.filter((t) => !(t.chatId === notice.chatId && t.at === notice.at)), notice].slice(-MAX_TOASTS));
      if (focused || !supported || Notification.permission !== "granted") return;
      try {
        const shown = new Notification(`${notice.from} mentioned you`, {
          body: [notice.title, notice.text].filter(Boolean).join("\n"),
          tag: `mention:${notice.chatId}:${notice.at}`,
        });
        shown.onclick = () => {
          window.focus();
          navigate(`/c/${notice.chatId}`);
          shown.close();
        };
      } catch {
        // Some browsers (Android Chrome) show notifications only from a service worker: the app's own notice stays.
      }
    },
    [chatId, navigate],
  );

  const dismiss = useCallback((notice: MentionNotice) => setToasts((list) => list.filter((t) => t !== notice)), []);

  // Opening the chat a tag is from is seeing it.
  useEffect(() => setToasts((list) => (list.some((t) => t.chatId === chatId) ? list.filter((t) => t.chatId !== chatId) : list)), [chatId]);
  // Each goes a while after the window is in view, so one that came in while the user was away waits for them.
  const oldest = toasts[0];
  useEffect(() => {
    if (!oldest || !visible) return;
    const timer = setTimeout(() => dismiss(oldest), TOAST_MS);
    return () => clearTimeout(timer);
  }, [oldest, visible, dismiss]);

  return { toasts, onMention, dismiss };
}

/** The tags of the user, in a corner of the app: a click opens the chat. */
export function MentionToasts({ toasts, dismiss, navigate }: ReturnType<typeof useMentionNotices> & { navigate: (path: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((notice) => (
        <div key={`${notice.chatId}:${notice.at}`} className="toast">
          <button
            type="button"
            className="toast-body"
            onClick={() => {
              dismiss(notice);
              navigate(`/c/${notice.chatId}`);
            }}
          >
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
  );
}

/** In a shared chat's header: ask the browser to show tags while the app is in the background. Gone once answered. */
export function NotifyButton() {
  const [permission, ask] = useNotificationPermission();
  if (permission !== "default") return null;
  return (
    <button
      type="button"
      className="icon-button notify-button"
      onClick={ask}
      title="Notify me in the browser when someone mentions me"
      aria-label="Turn on notifications"
    >
      <Icon size={16} box={24}>
        <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9M10 19a2 2 0 0 0 4 0" />
      </Icon>
    </button>
  );
}
