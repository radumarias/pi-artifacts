import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Reaction } from "../../shared/reactions.ts";
import { Icon } from "../Icon.tsx";
import { useDismiss } from "../layout.tsx";
import { Compact, useLongPress } from "./gestures.ts";
import { EmojiRow, type MessageReactions } from "./Reactions.tsx";
import { BranchOff, EntryOf } from "./ChatKinds.tsx";

/**
 * Put a message on the clipboard as rich text, as it shows (`html`), and as plain text (`text`, Markdown for the agent's
 * replies) for wherever rich text does not paste. Browsers without ClipboardItem get the plain text alone.
 */
export async function copyRich(html: string, text: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard.write) return navigator.clipboard.writeText(text);
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([text], { type: "text/plain" }),
    }),
  ]);
}

/** The rendered message bubbles under `root`, as one piece of HTML: what a copy pastes as rich text. */
export function bubblesHtml(root: HTMLElement | null): string {
  if (!root) return "";
  return [...root.querySelectorAll(".bubble")].map((bubble) => `<div>${bubble.innerHTML}</div>`).join("");
}

const ICONS = {
  react: (
    <>
      <path d="M13.5 7.5a5.5 5.5 0 1 1-4-5.3" />
      <path d="M5.8 9.6a2.6 2.6 0 0 0 4.4 0M6 6.5h.01M10 6.5h.01M12.5 1.5v4M10.5 3.5h4" />
    </>
  ),
  reply: <path d="M6.5 4 2.5 8l4 4M3 8h6.5a4 4 0 0 1 4 4v1" />,
  copy: <path d="M5.5 5.5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />,
  copied: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />,
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.4} />,
  markdown: <path d="M2.5 4.5h11v7h-11ZM4.5 9.5v-3l1.5 2 1.5-2v3M10.5 6.5v3M9.3 8.3l1.2 1.2 1.2-1.2" />,
  select: <path d="M3.5 3.5h9M3.5 6.5h9M3.5 9.5h5M11 9v4.5M9.5 13.5h3M9.5 9h3" />,
  branch: <path d="M5 2.5v11M5 9.5c0-3 6-2 6-5.5M11 2.5v2" />,
};

function ActionIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <Icon size={15} box={16} stroke={1.6}>
      {ICONS[name]}
    </Icon>
  );
}

/**
 * The bar a message shows on hover: react, copy, answer, and "…" with the same plus a copy as Markdown. Compact
 * (phones, narrow windows) it has no bar: a long press on the message opens the same in a menu (PressMenu). `content` is where its bubbles are, `text` what it says as plain text (Markdown for the agent's
 * replies), `reactions` its reactions, for a message that takes them.
 */
export function MessageActions({
  content,
  text,
  reactions,
  onReply,
  floating = false,
}: {
  content: RefObject<HTMLElement | null>;
  text: string;
  reactions: MessageReactions | null;
  onReply?: () => void;
  /** Over the top corner of a person's bubble, on hover, taking no room; otherwise a row of its own (under the agent's replies). */
  floating?: boolean;
}) {
  const [open, setOpenAs] = useState<"react" | "more" | null>(null);
  // Where the menu goes past the conversation's edges, which moves it: "up" above the bar, "end" or "start" to the
  // bar's other side. Measured afresh each time it opens, before it is painted.
  const [place, setPlace] = useState<string | null>(null);
  const setOpen = useCallback((next: "react" | "more" | null) => {
    setPlace(null);
    setOpenAs(next);
  }, []);
  const close = useCallback(() => setOpen(null), [setOpen]);
  const box = useDismiss<HTMLDivElement>(open !== null, close);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useLayoutEffect(() => {
    if (!open || place !== null || !box.current || !menu.current) return;
    const area = box.current.closest(".messages")?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const rect = menu.current.getBoundingClientRect();
    setPlace([rect.bottom > area.bottom && "up", rect.right > area.right ? "end" : rect.left < area.left && "start"].filter(Boolean).join(" "));
  }, [open, place, box]);
  const compact = useContext(Compact);
  // Where the message was long-pressed (or right-clicked), while its menu is open.
  const [pressedAt, setPressedAt] = useState<{ x: number; y: number } | null>(null);
  useLongPress(content, compact, (x, y) => setPressedAt({ x, y }));
  const unpress = useCallback(() => setPressedAt(null), []);
  // A window widened past compact while the menu was open closes it, so it does not come back when it narrows again.
  useEffect(() => {
    if (!compact) setPressedAt(null);
  }, [compact]);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (asMarkdown = false) => {
    setOpen(null);
    (asMarkdown ? navigator.clipboard.writeText(text) : copyRich(bubblesHtml(content.current), text)).then(
      () => setCopied("yes"),
      () => setCopied("failed"),
    );
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1_500);
  };
  const pick = (emoji: Reaction) => {
    setOpen(null);
    reactions?.toggle(emoji);
  };
  const copyLabel = copied === "yes" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy";
  // A message in the transcript (not one streaming in) can start a branch: a new chat carrying the conversation up to it.
  const branchOff = useContext(BranchOff);
  const entry = useContext(EntryOf);
  // What "…" holds, and the long-press menu with "Select text" too.
  const actions: MenuAction[] = [
    ...(onReply ? [{ icon: "reply", label: "Reply", run: onReply } as const] : []),
    ...(text
      ? ([
          { icon: "copy", label: "Copy message", run: () => copy() },
          { icon: "markdown", label: "Copy as Markdown", run: () => copy(true) },
        ] as const)
      : []),
    ...(branchOff && entry !== undefined ? [{ icon: "branch", label: "Branch off from here", run: () => branchOff(entry) } as const] : []),
  ];
  const status = copied && <span role="status">{copyLabel}</span>;
  if (compact) {
    return (
      <>
        {pressedAt &&
          createPortal(
            <PressMenu
              at={pressedAt}
              content={content}
              reactions={reactions}
              onPick={pick}
              onClose={unpress}
              actions={text ? [...actions, { icon: "select", label: "Select text", run: () => selectText(content.current) }] : actions}
            />,
            document.body,
          )}
        {status && createPortal(<div className="press-toast">{status}</div>, document.body)}
      </>
    );
  }
  const button = (label: string, icon: keyof typeof ICONS, onClick: () => void, opens?: "react" | "more"): ReactNode => (
    <button
      type="button"
      className="icon-button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-expanded={opens && open === opens}
      aria-controls={opens && open === opens ? menuId : undefined}
    >
      <ActionIcon name={icon} />
    </button>
  );
  const toggle = (which: "react" | "more") => () => setOpen(open === which ? null : which);
  return (
    <div ref={box} className={["message-actions", floating && "floating", open && "open"].filter(Boolean).join(" ")}>
      <div className="message-tools">
        {reactions && button("Add a reaction", "react", toggle("react"), "react")}
        {text && button(copyLabel, copied === "yes" ? "copied" : "copy", () => copy())}
        {onReply && button("Reply", "reply", onReply)}
        {button("More", "more", toggle("more"), "more")}
      </div>
      {open && (
        <div ref={menu} id={menuId} className={place ? `message-menu ${place}` : "message-menu"} role={open === "more" ? "menu" : undefined}>
          {reactions && <EmojiRow onPick={pick} isMine={reactions.mine} />}
          {open === "more" &&
            actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(null);
                  action.run();
                }}
              >
                {action.label}
              </button>
            ))}
        </div>
      )}
      {status && <span className="sr-only">{status}</span>}
    </div>
  );
}

type MenuAction = { icon: keyof typeof ICONS; label: string; run: () => void };

/**
 * A message's menu on a phone, once it is long-pressed: the emoji to react with above the message, its actions under
 * it. A tap anywhere else, or Escape, closes it.
 */
function PressMenu({
  at,
  content,
  reactions,
  actions,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  content: RefObject<HTMLElement | null>;
  reactions: MessageReactions | null;
  actions: MenuAction[];
  onPick: (emoji: Reaction) => void;
  onClose: () => void;
}) {
  const emoji = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Measured before it is painted: the emoji above the message and the menu under it, so the message stays in view;
  // around the finger instead for a message too tall for that. Both kept on screen, never on top of each other.
  useLayoutEffect(() => {
    const gap = 8;
    const edge = 12;
    const emojiH = emoji.current?.offsetHeight ?? 0;
    const menuH = menu.current?.offsetHeight ?? 0;
    const rect = content.current?.getBoundingClientRect();
    const fits = rect && rect.height + emojiH + menuH + 4 * gap < window.innerHeight;
    const [above, below] = fits ? [rect.top, rect.bottom] : [at.y - 16, at.y + 16];
    // No room under it (a message low on the screen): the menu above it, and the emoji above the menu.
    const under = below + gap + menuH <= window.innerHeight - edge;
    let menuTop = under ? below + gap : Math.max(edge, above - gap - menuH);
    const emojiTop = Math.max(edge, (under ? above : menuTop) - gap - emojiH);
    if (emojiH && emojiTop + emojiH + gap > menuTop) menuTop = emojiTop + emojiH + gap;
    if (emoji.current) emoji.current.style.top = `${emojiTop}px`;
    if (menu.current) menu.current.style.top = `${Math.min(menuTop, window.innerHeight - edge - menuH)}px`;
  }, [at, content]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    // For a keyboard (the menu key); no ring for a finger.
    menu.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="press-layer" onClick={onClose}>
      {reactions && (
        <div ref={emoji} className="press-emoji" onClick={(event) => event.stopPropagation()}>
          <EmojiRow
            onPick={(picked) => {
              onClose();
              onPick(picked);
            }}
            isMine={reactions.mine}
          />
        </div>
      )}
      <div ref={menu} className="press-menu" role="menu" onClick={(event) => event.stopPropagation()}>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              action.run();
            }}
          >
            <ActionIcon name={action.icon} />
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Select all the text of the message at `root`, for the phone's own handles to narrow; the message takes selection
 * (which phones otherwise leave off messages, for the long press) until it is let go.
 */
function selectText(root: HTMLElement | null): void {
  const bubbles = root?.querySelectorAll(".bubble");
  const selection = getSelection();
  if (!root || !bubbles?.length || !selection) return;
  root.classList.add("selecting");
  const range = document.createRange();
  range.setStartBefore(bubbles[0]);
  range.setEndAfter(bubbles[bubbles.length - 1]);
  selection.removeAllRanges();
  selection.addRange(range);
  const done = () => {
    if (!selection.isCollapsed && selection.rangeCount && root.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
    root.classList.remove("selecting");
    document.removeEventListener("selectionchange", done);
  };
  document.addEventListener("selectionchange", done);
}
