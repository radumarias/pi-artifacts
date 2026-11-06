import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { memo, useMemo, useState } from "react";
import { AUTO_LEDGER_PREFIX, effortLabel, HINT_LEDGER_PREFIX, SKILLS_LEDGER_PREFIX, type ModelInfo } from "../../shared/models.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { stepLabel } from "./Steps.tsx";
import { useDismiss } from "../layout.tsx";
import { useCatalog } from "./ModelPicker.tsx";
import { chatSpend, describeTokens, formatCost, type PromptSpend, type Share, shortTokens, type Timing } from "./spend.ts";
import { formatElapsed } from "./elapsed.ts";

/** Where the time went, for a tooltip: "model replies 48s (3), tools 31s (2)". */
function describeTime(time: Timing): string {
  const parts = [`model replies ${formatElapsed(time.modelMs)} (${time.replies})`];
  if (time.tools) parts.push(`tools ${formatElapsed(time.toolMs)} (${time.tools})`);
  return parts.join(", ");
}

/** The ledger rows of classifiers and routers that run beside the agent, by their key's prefix. */
const PICKERS = [
  [AUTO_LEDGER_PREFIX, "Auto picks"],
  [SKILLS_LEDGER_PREFIX, "Skill picks"],
  [HINT_LEDGER_PREFIX, `Spotting asks for ${AGENT_NAME}`],
] as const;

/**
 * A row's name: the model's, and the effort its replies were asked at ("Claude Opus 5.5 · High effort"); a tool's name;
 * Auto's router ("Auto picks · GPT OSS 120B"); the classifier that picks the skills shown ("Skill picks ·
 * cloudflare-workers-ai/typesafe/jev"); what told whether messages were meant for the agent ("Spotting asks for pi ·
 * typesafe/jev").
 */
function shareName(share: Share, models: ReadonlyMap<string, ModelInfo>): string {
  for (const [prefix, label] of PICKERS) {
    if (!share.model.startsWith(prefix)) continue;
    const picker = share.model.slice(prefix.length);
    return `${label} · ${models.get(picker)?.name ?? picker}`;
  }
  // Else a model's, or a tool's that reports a spend of its own (the page check's look at its screenshot).
  const name = models.get(share.model)?.name ?? stepLabel(share.model);
  return share.effort ? `${name} · ${effortLabel(share.effort)}` : name;
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
 * streamed token, the ledger and `entries` (whose replies say their effort) only when a reply lands.
 */
export const ChatCost = memo(function ChatCost({ usage, entries, time }: { usage?: UsageState; entries: readonly EntryRecord[]; time: Timing }) {
  const [open, setOpen] = useState(false);
  const catalog = useCatalog();
  const models = useMemo(() => new Map(catalog.models.map((model) => [model.id, model])), [catalog]);
  // Only the open panel splits models by effort: the button shows totals, and the entries change with every message.
  const split = open ? entries : undefined;
  const spend = useMemo(() => chatSpend(usage, split), [usage, split]);
  // A click anywhere else, or Escape, closes the panel.
  const box = useDismiss<HTMLDivElement>(open, setOpen);
  if (spend.models.length === 0) return null;
  // By id, not the catalog: a deployment's default can be a Workers AI model the picker does not list.
  const workersAi = spend.models.some((share) => share.model.startsWith("@cf/"));
  // Listed models with no known price: their replies were priced at nothing.
  const unpriced = spend.models.filter((share) => models.has(share.model) && !models.get(share.model)!.price);
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
              <li key={`${share.model} ${share.effort}`} title={describeTokens(share)}>
                <span>{shareName(share, models)}</span>
                <small>{shortTokens(share)}</small>
                <span className="cost-amount">{unpriced.includes(share) ? "unknown" : formatCost(share.cost)}</span>
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
            {unpriced.length > 0 &&
              ` No price is known for ${[...new Set(unpriced.map((share) => models.get(share.model)!.name))].join(", ")}, so the total leaves out ${unpriced.length === 1 ? "its" : "their"} replies.`}
          </small>
        </div>
      )}
    </div>
  );
});
