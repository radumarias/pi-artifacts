import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Reaction } from "../../shared/reactions.ts";
import { Icon } from "../Icon.tsx";
import { useDismiss } from "../layout.tsx";
import { EmojiRow, type MessageReactions } from "./Reactions.tsx";

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
};

function ActionIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <Icon size={15} box={16} stroke={1.6}>
      {ICONS[name]}
    </Icon>
  );
}

/**
 * The bar a message shows on hover (always on touch screens): react, answer, copy, and "…" with the same plus a copy
 * as Markdown. `content` is where its bubbles are, `text` what it says as plain text (Markdown for the agent's
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
  /** Beside a person's bubble, on hover, taking no room; otherwise a row of its own (under the agent's replies). */
  floating?: boolean;
}) {
  const [open, setOpen] = useState<"react" | "more" | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const box = useDismiss<HTMLDivElement>(open !== null, close);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // Low in the conversation, the menu opens above the bar rather than past its bottom edge.
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    if (!open || !box.current || !menu.current) return;
    const bottom = box.current.closest(".messages")?.getBoundingClientRect().bottom ?? window.innerHeight;
    setUp(box.current.getBoundingClientRect().bottom + menu.current.offsetHeight > bottom);
  }, [open, box]);
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
      {reactions && button("Add a reaction", "react", toggle("react"), "react")}
      {onReply && button("Reply", "reply", onReply)}
      {button(copyLabel, copied === "yes" ? "copied" : "copy", () => copy())}
      {button("More", "more", toggle("more"), "more")}
      {open && (
        <div ref={menu} id={menuId} className={up ? "message-menu up" : "message-menu"} role={open === "more" ? "menu" : undefined}>
          {reactions && <EmojiRow onPick={pick} isMine={reactions.mine} />}
          {open === "more" && (
            <>
              {onReply && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(null);
                    onReply();
                  }}
                >
                  Reply
                </button>
              )}
              <button type="button" role="menuitem" onClick={() => copy()}>
                Copy message
              </button>
              <button type="button" role="menuitem" onClick={() => copy(true)}>
                Copy message as Markdown
              </button>
            </>
          )}
        </div>
      )}
      {copied && (
        <span className="sr-only" role="status">
          {copyLabel}
        </span>
      )}
    </div>
  );
}
