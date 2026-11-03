import type { UsageState } from "@earendil-works/pi-durable";
import { memo, useEffect, useRef, useState } from "react";
import type { ModelInfo } from "../../shared/models.ts";
import { chatSpend, describeTokens, formatCost, type Spend } from "./spend.ts";
import { loadCatalog } from "./ModelPicker.tsx";

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Tokens in and out, short: input counts what came from the cache and went into it too. */
function shortTokens(spend: Spend): string {
  return `${COMPACT.format(spend.input + spend.cacheRead + spend.cacheWrite)} in · ${COMPACT.format(spend.output)} out`;
}

/** What one prompt's model calls cost, under the agent's last reply to it. */
export function PromptCost({ spend }: { spend: Spend }) {
  return (
    <div className="prompt-cost" title={`This prompt: ${describeTokens(spend)}`}>
      {formatCost(spend.cost)} · {shortTokens(spend)}
    </div>
  );
}

/** The models' names, once the picker's list has come. */
function useModelNames(): Map<string, string> {
  const [names, setNames] = useState(new Map<string, string>());
  useEffect(() => {
    let live = true;
    loadCatalog().then(
      (list: ModelInfo[]) => live && setNames(new Map(list.map((model) => [model.id, model.name]))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return names;
}

/**
 * What the chat's model calls cost so far, in the header; a click opens what each model's share was. Memoized: the
 * chat re-renders on every streamed token, the ledger only when a reply lands.
 */
export const ChatCost = memo(function ChatCost({ usage }: { usage?: UsageState }) {
  const [open, setOpen] = useState(false);
  const names = useModelNames();
  const box = useRef<HTMLDivElement>(null);
  // A click anywhere else, or Escape, closes the panel.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => box.current?.contains(event.target as Node) || setOpen(false);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const { total, models } = chatSpend(usage);
  if (models.length === 0) return null;
  const freeTier = models.some((spend) => spend.model.startsWith("@cf/"));
  return (
    <div className="chat-cost" ref={box}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} title={`AI cost of this chat: ${describeTokens(total)}`}>
        {formatCost(total.cost)}
      </button>
      {open && (
        <div className="cost-panel" role="dialog" aria-label="AI cost of this chat">
          <strong>AI cost of this chat</strong>
          <ul>
            {models.map((spend) => (
              <li key={spend.model} title={describeTokens(spend)}>
                <span>{names.get(spend.model) ?? spend.model}</span>
                <small>{shortTokens(spend)}</small>
                <span className="cost-amount">{formatCost(spend.cost)}</span>
              </li>
            ))}
          </ul>
          <small>
            At the providers' list prices, from the tokens each reply reports.
            {freeTier && " Workers AI is free up to Cloudflare's daily allowance, so its share may cost nothing."}
          </small>
        </div>
      )}
    </div>
  );
});
