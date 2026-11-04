import { useState } from "react";
import { Icon } from "../Icon.tsx";
import { useDismiss } from "../layout.tsx";

/**
 * The small chevron after the composer's attach and dictation buttons: a menu above it with what else the composer
 * can do, so the row under the input stays a few icons wide. For now that is naming something with "@", which typing
 * "@" in the input does too. The menu closes as an action runs.
 */
export function ComposerMore({ mentionLabel, onMention }: { mentionLabel: string; onMention: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, setOpen);
  return (
    <div className="composer-more" ref={box}>
      <button
        type="button"
        className="icon-button composer-more-button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="More"
        aria-label="More"
      >
        <Icon size={14} stroke={2}>
          <path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
        </Icon>
      </button>
      {/* After the button, so Tab moves from it into the menu; CSS places the menu above it. */}
      {open && (
        <div className="composer-more-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onMention();
            }}
          >
            <span className="composer-more-glyph" aria-hidden="true">
              @
            </span>
            <span>{mentionLabel}</span>
            <kbd>@</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
