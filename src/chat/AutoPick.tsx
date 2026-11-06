import { memo } from "react";
import { choiceLabel } from "../../shared/models.ts";
import type { AutoPick, RouterSpend, ToolPickNote } from "../../shared/protocol.ts";
import { useCatalog } from "./ModelPicker.tsx";
import { formatCost, routerSpendOf, shortTokens, toolPickerName } from "./spend.ts";
import { stepLabel } from "./Steps.tsx";

/** Seconds, to a tenth: "2.3 s". */
const seconds = (ms: number) => `${(ms / 1_000).toFixed(1)} s`;

/**
 * "Picked by Jev in 2.3 s (its own answer 0.4 s) for $0.0001 (2k in · 0 out).": who picked, how fast (the whole step:
 * reading the chat and the models too, then the call itself), at what cost.
 */
function pickedBy(name: string, ms: number, spend: RouterSpend): string {
  const own = spend.ms !== undefined ? ` (its own answer ${seconds(spend.ms)})` : "";
  return `Picked by ${name} in ${seconds(ms)}${own} for ${formatCost(spend.cost)} (${shortTokens(routerSpendOf(spend))}).`;
}

/** A pick under a message: a tag and what was picked; its tooltip says why. A tap shows the same under it: phones have no hover. */
function PickChip({ tag, label, why, kept }: { tag: string; label: string; why: string; kept: boolean }) {
  return (
    <details className={kept ? "auto-pick kept" : "auto-pick"}>
      <summary title={why}>
        <span className="auto-pick-tag">{tag}</span>
        <span className="auto-pick-model">{label}</span>
      </summary>
      <div className="auto-pick-why">{why}</div>
    </details>
  );
}

/**
 * Under a message sent on Auto, the model and effort picked to answer it ("Auto · Claude Sonnet 5.5 · High effort"); its
 * tooltip says why, and which router picked, at what cost and in how long. When the chat kept its model (no router could
 * pick, or a reply was running), it says so, and why. Memoized: the chat re-renders on every streamed token.
 */
export const AutoPicked = memo(function AutoPicked({ pick }: { pick: AutoPick }) {
  const catalog = useCatalog();
  const info = (id: string) => catalog.models.find((model) => model.id === id);
  const label = choiceLabel(info(pick.model), pick.model, pick.thinkingLevel);
  const { router } = pick;
  const why = router
    ? [pick.reason && `Why: ${pick.reason}.`, pickedBy(info(router.model)?.name ?? toolPickerName(router.model), pick.ms, router)].filter(Boolean).join("\n")
    : `The chat kept the model it was on.\nWhy: ${pick.failed ?? "no router could pick"}`;
  return <PickChip tag="Auto" label={router ? label : `kept ${label}`} why={why} kept={!router} />;
});

/**
 * Under a message, which of the chat's MCP tools were offered to answer it ("Tools · 3 of 42"); its tooltip names them,
 * and the picker, at what cost and in how long. When the picker failed, every tool was offered; when the tools could not
 * be changed, the reply had the ones it had. Either way it says why. Memoized: the chat re-renders on every streamed token.
 */
export const ToolsPicked = memo(function ToolsPicked({ note }: { note: ToolPickNote }) {
  const { picker, failed } = note;
  if (failed) {
    const what = note.unchanged ? "The tools could not be changed, so the reply had the ones it had." : "Every tool was offered.";
    return <PickChip tag="Tools" label={note.unchanged ? "kept" : `all ${note.of}`} why={`${what}\nWhy: ${failed}`} kept />;
  }
  const why = [
    note.tools.length ? `Offered: ${note.tools.map(stepLabel).join(", ")}.` : "No MCP tool offered: the message looked like it needs none.",
    note.added && note.tools.length > 0 && "A reply was running, so these were added to the tools it had.",
    "Others load when needed.",
    picker && pickedBy(toolPickerName(picker.model), note.ms, picker),
  ]
    .filter(Boolean)
    .join("\n");
  return <PickChip tag="Tools" label={`${note.tools.length} of ${note.of}`} why={why} kept={false} />;
});
