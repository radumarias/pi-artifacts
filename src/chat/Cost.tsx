import type { UsageState } from "@earendil-works/pi-durable";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useCatalog } from "./ModelPicker.tsx";
import { chatSpend, describeTokens, formatCost, type PromptSpend, shortTokens, type Timing } from "./spend.ts";
import { formatElapsed } from "./Thinking.tsx";

/** Where the time went, for a tooltip: "model replies 48s (3), tools 31s (2)". */
function describeTime(time: Timing): string {
  const parts = [`model replies ${formatElapsed(time.modelMs)} (${time.replies})`];
  if (time.tools) parts.push(`tools ${formatElapsed(time.toolMs)} (${time.tools})`);
  return parts.join(", ");
}

/** What one prompt's model calls cost and how long it took, under the agent's last reply to it. Memoized: the chat re-renders on every streamed token. */
export const PromptCost = memo(function PromptCost({ spend }: { spend: PromptSpend }) {
  const took = formatElapsed(spend.time.ms);
  return (
    <div className="prompt-cost" title={`This prompt took ${took}: ${describeTime(spend.time)}.\n${describeTokens(spend)}`}>
      {formatCost(spend.cost)} · {took} · {shortTokens(spend)}
    </div>
  );
});

/**
 * What the chat's model calls cost so far and how long its prompts took, in the header; a click opens what each
 * model's share was and where the time went. `time` is the finished prompts'. Memoized: the chat re-renders on every
 * streamed token, the ledger only when a reply lands.
 */
export const ChatCost = memo(function ChatCost({ usage, time }: { usage?: UsageState; time: Timing }) {
  const [open, setOpen] = useState(false);
  const catalog = useCatalog();
  const models = useMemo(() => new Map(catalog.map((model) => [model.id, model])), [catalog]);
  const spend = useMemo(() => chatSpend(usage), [usage]);
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
  if (spend.models.length === 0) return null;
  // By id, not the catalog: a deployment's default can be a Workers AI model the picker does not list.
  const workersAi = spend.models.some((share) => share.model.startsWith("@cf/"));
  return (
    <div className="chat-cost" ref={box}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} title={`AI cost of this chat: ${describeTokens(spend.total)}`}>
        {formatCost(spend.total.cost)}
        {time.ms > 0 && <span className="chat-time"> · {formatElapsed(time.ms)}</span>}
      </button>
      {open && (
        <div className="cost-panel" role="dialog" aria-label="AI cost and time of this chat">
          <strong>AI cost and time of this chat</strong>
          <ul>
            {spend.models.map((share) => (
              <li key={share.model} title={describeTokens(share)}>
                <span>{models.get(share.model)?.name ?? share.model}</span>
                <small>{shortTokens(share)}</small>
                <span className="cost-amount">{formatCost(share.cost)}</span>
              </li>
            ))}
            {time.ms > 0 && (
              <li className="cost-time" title="From each message to the agent's last reply to it, for every finished prompt">
                <span>Processing time</span>
                <small>
                  {time.prompts} {time.prompts === 1 ? "prompt" : "prompts"}; {describeTime(time)}
                </small>
                <span className="cost-amount">{formatElapsed(time.ms)}</span>
              </li>
            )}
          </ul>
          <small>
            At the providers' list prices, from the tokens each reply reports.
            {workersAi && " Workers AI is free up to Cloudflare's daily allowance, so its share may cost nothing."}
          </small>
        </div>
      )}
    </div>
  );
});
