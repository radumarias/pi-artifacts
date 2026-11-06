import { memo, useCallback, useId, useMemo, useState, type KeyboardEvent } from "react";
import { searchWords } from "../../shared/util.ts";
import { Icon } from "../Icon.tsx";
import { useDismiss } from "../layout.tsx";
import type { Recalled } from "./history.ts";
import { sentLabel } from "./SentTime.tsx";

/**
 * The small chevron after the composer's attach and dictation buttons: a menu above it with what else the composer
 * can do, so the row under the input stays a few icons wide. Naming something with "@", which typing "@" in the input
 * does too, and bringing back one of the viewer's earlier messages (`history`, newest first) to send again or edit,
 * which Up in an empty input does too. The menu closes as an action runs. `compact`: on a phone, which has no keyboard
 * shortcut to show, and a keyboard that would cover the list.
 */
export function ComposerMore({
  mentionLabel,
  onMention,
  history,
  onRecall,
  compact,
}: {
  mentionLabel: string;
  onMention: () => void;
  history: readonly Recalled[];
  /** The same function from one render to the next, so the open list does not draw again as a reply streams in. */
  onRecall: (message: Recalled) => void;
  compact: boolean;
}) {
  // The menu, or in its place the list of earlier messages.
  const [open, setOpen] = useState<"menu" | "history" | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const box = useDismiss<HTMLDivElement>(open !== null, close);
  const menu = useId();
  const back = useCallback(() => setOpen("menu"), []);
  const pick = useCallback(
    (message: Recalled) => {
      close();
      onRecall(message);
    },
    [close, onRecall],
  );
  return (
    <div className="composer-more" ref={box}>
      <button
        type="button"
        className="icon-button composer-more-button"
        onClick={() => setOpen(open ? null : "menu")}
        aria-expanded={open !== null}
        aria-controls={open ? menu : undefined}
        title="More"
        aria-label="More"
      >
        <Icon size={14} stroke={2}>
          <path d="m6 9 6 6 6-6" />
        </Icon>
      </button>
      {/* After the button, so Tab moves from it into the menu; CSS places the menu above it. */}
      {open === "menu" && (
        <div className="composer-more-menu" id={menu}>
          <button
            type="button"
            onClick={() => {
              close();
              onMention();
            }}
          >
            <span className="composer-more-glyph" aria-hidden="true">
              @
            </span>
            <span>{mentionLabel}</span>
          </button>
          <button type="button" onClick={() => setOpen("history")} disabled={history.length === 0}>
            <span className="composer-more-glyph" aria-hidden="true">
              <HistoryIcon />
            </span>
            <span>{history.length ? "Your earlier messages" : "No earlier messages yet"}</span>
            {/* The shortcut, where there is a keyboard to press it on. */}
            {history.length > 0 && !compact && <kbd title="Up in an empty message box">↑</kbd>}
          </button>
        </div>
      )}
      {open === "history" && <History id={menu} history={history} compact={compact} onBack={back} onPick={pick} />}
    </div>
  );
}

/** A clock with an arrow going back round it: earlier messages. */
const HistoryIcon = () => (
  <Icon size={16} stroke={2}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 8v4l3 2" />
  </Icon>
);

/**
 * The viewer's earlier messages, newest first, each with when it was sent, and a box to search them. Up and Down move
 * between the box and the messages, Enter or a click picks one. Not focused on a phone (`compact`): the keyboard would
 * cover the list.
 */
const History = memo(function History({
  id,
  history,
  compact,
  onBack,
  onPick,
}: {
  id: string;
  history: readonly Recalled[];
  compact: boolean;
  onBack: () => void;
  onPick: (message: Recalled) => void;
}) {
  const [query, setQuery] = useState("");
  // Lowercased once, not on every key typed in the search box.
  const lower = useMemo(() => history.map((message) => message.text.toLowerCase()), [history]);
  const found = useMemo(() => {
    const words = searchWords(query);
    return words.length ? history.filter((_, i) => words.every((word) => lower[i].includes(word))) : history;
  }, [history, lower, query]);
  // Read once as the list opens: it is open for moments, not long enough for "now" to go stale.
  const [now] = useState(Date.now);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const stops = [...event.currentTarget.querySelectorAll<HTMLElement>("input, .composer-history-item")];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next = stops[Math.min(Math.max(at + (event.key === "ArrowDown" ? 1 : -1), 0), stops.length - 1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  return (
    <div className="composer-more-menu composer-history" id={id} onKeyDown={onKeyDown}>
      <div className="composer-history-head">
        {/* On a phone focus goes here rather than to the search box, so it stays in the list without the keyboard. */}
        <button type="button" className="icon-button" onClick={onBack} title="Back" aria-label="Back" autoFocus={compact}>
          <Icon size={16} stroke={2}>
            <path d="m15 6-6 6 6 6" />
          </Icon>
        </button>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Not while an IME is composing (Enter then confirms the text). Always taken: the box is in the composer's
            // form, where an Enter left alone would send the draft.
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (found.length) onPick(found[0]);
          }}
          placeholder="Search your messages"
          aria-label="Search your earlier messages"
          autoFocus={!compact}
        />
      </div>
      <div className="composer-history-list" role="list" aria-label="Your earlier messages, newest first">
        {found.length === 0 ? (
          <div className="mention-empty">No message of yours matches.</div>
        ) : (
          found.map((message) => (
            <div key={message.id} role="listitem">
              <button type="button" className="composer-history-item" onClick={() => onPick(message)} title="Put it in the message box">
                <span className="composer-history-text">{message.text}</span>
                {message.sentAt !== undefined && <small>{sentLabel(message.sentAt, now)}</small>}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
});
