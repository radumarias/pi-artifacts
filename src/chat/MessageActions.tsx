import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "../Icon.tsx";

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

/**
 * The buttons a message shows on hover (always on touch screens): copy it, and answer it. `content` is where its
 * bubbles are, `text` what it says as plain text.
 */
export function MessageActions({
  content,
  text,
  onReply,
  floating = false,
}: {
  content: RefObject<HTMLElement | null>;
  text: string;
  onReply?: () => void;
  /** Beside a person's bubble, on hover, taking no room; otherwise a row of its own (under the agent's replies). */
  floating?: boolean;
}) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    copyRich(bubblesHtml(content.current), text).then(
      () => setCopied("yes"),
      () => setCopied("failed"),
    );
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1_500);
  };
  const copyLabel = copied === "yes" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy";
  return (
    <div className={floating ? "message-actions floating" : "message-actions"}>
      <button type="button" className="icon-button" onClick={copy} title={copyLabel} aria-label={copyLabel}>
        <Icon size={15} box={16} stroke={1.6}>
          {copied === "yes" ? (
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
          ) : (
            <path d="M5.5 5.5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />
          )}
        </Icon>
      </button>
      {onReply && (
        <button type="button" className="icon-button" onClick={onReply} title="Reply" aria-label="Reply">
          <Icon size={15} box={16} stroke={1.6}>
            <path d="M6.5 4 2.5 8l4 4M3 8h6.5a4 4 0 0 1 4 4v1" />
          </Icon>
        </button>
      )}
      {copied && (
        <span className="sr-only" role="status">
          {copyLabel}
        </span>
      )}
    </div>
  );
}
