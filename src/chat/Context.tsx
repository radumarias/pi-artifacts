import type { EntryRecord } from "@earendil-works/pi-durable";
import { memo, useMemo, useState } from "react";
import { useDismiss } from "../layout.tsx";
import { useCatalog } from "./ModelPicker.tsx";
import { COMPACTION, compactionPoint } from "../../shared/models.ts";
import { COMPACT, contextUse, COUNT } from "./spend.ts";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * How full the model's context is, after the model picker: a ring that fills as the conversation grows, and a click
 * opens the numbers, which model they are of and when older messages get summarized. Nothing before the first reply,
 * or for a model whose window is unknown. Memoized: the chat re-renders on every streamed token.
 */
export const ContextMeter = memo(function ContextMeter({ entries, model }: { entries: readonly EntryRecord[]; model?: string }) {
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, setOpen);
  const catalog = useCatalog();
  const use = useMemo(() => contextUse(entries), [entries]);
  if (!use) return null;
  // The chosen model's window, which the next reply runs in and is summarized against; else the one that replied's.
  const info = catalog.models.find((entry) => entry.id === model) ?? catalog.models.find((entry) => entry.id === use.model);
  const full = info?.contextWindow;
  if (!full) return null;
  // What a chat holds before a reply waits for a summary (CONTEXT_BUDGET, or less in a small window), plus that
  // reply's room: the ring is full there, not at a 1M window the chat never reaches.
  const size = Math.min(full, compactionPoint(full) + COMPACTION.reserveTokens);
  const share = Math.min(1, use.tokens / size);
  const percent = Math.round(share * 100);
  const compactAt = Math.max(0, compactionPoint(full) - COMPACTION.backgroundTokens);
  // Near the summary point, unless one was just made (the next reply starts from less). A window smaller than the
  // compaction margins has no such point (compactAt 0): only the share says how full it is.
  const nearCompaction = compactAt > 0 ? use.tokens >= compactAt : share >= 0.9;
  const level = nearCompaction && !use.compacted ? "full" : share >= 0.6 ? "high" : "";
  return (
    <div className={`context-meter ${level}`} ref={box}>
      <button
        type="button"
        className="icon-button context-ring"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={`Context: ${COMPACT.format(use.tokens)} of ${COMPACT.format(size)} tokens (${percent}%)`}
        aria-label={`Context ${percent}% full`}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="track" cx="9" cy="9" r={RADIUS} />
          <circle className="fill" cx="9" cy="9" r={RADIUS} strokeDasharray={`${share * CIRCUMFERENCE} ${CIRCUMFERENCE}`} transform="rotate(-90 9 9)" />
        </svg>
      </button>
      {open && (
        <div className="context-panel" role="dialog" aria-label="Context window">
          <div className="context-head">
            <strong>Context window</strong>
            <span>{percent}%</span>
          </div>
          <div className="context-bar" aria-hidden="true">
            <span style={{ width: `${share * 100}%` }} />
          </div>
          <span>
            {COUNT.format(use.tokens)} of {COUNT.format(size)} tokens
          </span>
          <small>
            {size < full ? `What this chat keeps of ${info.name}'s ${COMPACT.format(full)} window` : `${info.name}'s window`}, filled as of the latest reply.
            Each message, reply and tool result adds to it.
            {use.compacted
              ? " Older messages were just summarized, so the next reply starts from less."
              : compactAt > 0 && ` Past about ${COMPACT.format(compactAt)}, older messages are summarized automatically and the latest kept as they are.`}
          </small>
        </div>
      )}
    </div>
  );
});
