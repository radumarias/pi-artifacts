import { useCallback, useEffect, useRef, useState } from "react";
import { signInNoticeText, type McpSignInView, type SignInNotice } from "../shared/sign-ins.ts";
import { errorMessage } from "../shared/util.ts";
import { api } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { showNotification } from "./push.ts";
import { useVisible } from "./sidebar.ts";

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * A notice about a sign-in, as the sidebar's socket hears it: while the window is hidden or in the background, and the
 * browser may, it shows as the system's notification too (the sidebar's banner shows it in the app). Its tag is the
 * push's, so the browser shows one.
 */
export function useSignInAlerts(reload: () => void) {
  const visible = useVisible();
  return useCallback(
    (notice: SignInNotice) => {
      reload();
      if ((visible && document.hasFocus()) || typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const { title, body } = signInNoticeText(notice);
      void showNotification(title, {
        body,
        tag: `sign-in:${notice.server}`,
        // Where the page may not show it (the service worker does), a click opens the sign-in, as the push's does.
        url: notice.link,
        onClick: () => window.open(notice.link, "_blank", "noopener"),
      });
    },
    [visible, reload],
  );
}

/**
 * In the sidebar, above the chats: each sign-in that needs the user (a run is waiting, or it runs out in a few days),
 * with its sign-in link. It stays until they sign in, or dismiss it.
 */
export function SignInNotices({ list, onChange }: { list: McpSignInView[]; onChange: (list: McpSignInView[]) => void }) {
  const shown = list.filter((item) => item.notice);
  if (shown.length === 0) return null;
  return (
    <div className="sign-in-notices" role="status">
      {shown.map((item) => {
        const { title, body } = signInNoticeText({ server: item.server, kind: item.notice!, endsAt: item.endsAt, what: item.waiting });
        return (
          <div key={item.server} className={`sign-in-notice ${item.notice}`}>
            <KeyIcon />
            <div className="sign-in-notice-body">
              <strong>{title}</strong>
              <span>{body}</span>
              <a className="button primary" href={item.link} target="_blank" rel="noopener">
                Sign in
              </a>
            </div>
            <button
              type="button"
              className="icon-button"
              title="Dismiss"
              aria-label={`Dismiss the notice about ${item.server}`}
              onClick={() => api.dismissSignInNotice(item.server).then(onChange, () => {})}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * From the account menu: the user's sign-ins to servers that sign in each user, each with when they signed in and when
 * it is counted to run out. Disconnect forgets the stored sign-in (its tokens), so nothing of theirs reaches that server
 * until they sign in again.
 */
export function SignInsDialog({
  list,
  onChange,
  onClose,
}: {
  list: McpSignInView[];
  onChange: (list: McpSignInView[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => dialog.current?.showModal(), []);

  const disconnect = async (server: string) => {
    setBusy(server);
    setError(null);
    try {
      onChange(await api.disconnect(server));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <dialog ref={dialog} className="confirm-dialog sign-ins-dialog" onClose={onClose}>
      <h2>Sign-ins</h2>
      <p className="prompt-about">
        Servers you sign in to yourself. Your chats, and your agents' scheduled runs, use these sign-ins as you. They are kept encrypted.
      </p>
      <ul className="sign-ins">
        {list.map((item) => (
          <li key={item.server}>
            <div className="sign-in-text">
              <strong>{item.server}</strong>
              <small>
                {item.signedIn
                  ? item.signedInAt
                    ? `Signed in ${day(item.signedInAt)} · runs out about ${day(item.endsAt!)}`
                    : "Signed in"
                  : "Not signed in"}
                {item.usedByRuns && " · used by scheduled runs"}
              </small>
            </div>
            {item.signedIn ? (
              <button type="button" disabled={busy !== null} onClick={() => void disconnect(item.server)}>
                {busy === item.server ? "Disconnecting…" : "Disconnect"}
              </button>
            ) : (
              <a className="button" href={item.link} target="_blank" rel="noopener">
                Sign in
              </a>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
      <div className="confirm-actions">
        <button type="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}

export function KeyIcon({ size = 18 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l3 3M14 9l2 2" />
    </Icon>
  );
}
