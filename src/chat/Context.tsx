import type { EntryRecord } from "@earendil-works/pi-durable";
import { memo, useMemo, useState } from "react";
import { useDismiss } from "../layout.tsx";
import { useCatalog } from "./ModelPicker.tsx";
import { COMPACTION } from "../../shared/models.ts";
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
  // The window of the model that replied; one the catalog does not list (a deployment's default) takes the chosen one's.
  const info = catalog.models.find((entry) => entry.id === use.model) ?? catalog.models.find((entry) => entry.id === model);
  const size = info?.contextWindow;
  if (!size) return null;
  const share = Math.min(1, use.tokens / size);
  const percent = Math.round(share * 100);
  const compactAt = Math.max(0, size - COMPACTION.reserveTokens - COMPACTION.backgroundTokens);
  const level = use.tokens >= compactAt ? "full" : share >= 0.6 ? "high" : "";
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
            {info.name}, as of its latest reply. Each message, reply and tool result adds to it.
            {use.compacted
              ? " Older messages were just summarized, so the next reply starts from less."
              : compactAt > 0 && ` Past about ${COMPACT.format(compactAt)}, older messages are summarized automatically and the latest kept as they are.`}
          </small>
        </div>
      )}
    </div>
  );
});
