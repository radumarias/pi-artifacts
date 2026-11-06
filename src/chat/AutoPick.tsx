import { memo } from "react";
import { choiceLabel } from "../../shared/models.ts";
import type { AutoPick, ToolPickNote } from "../../shared/protocol.ts";
import { useCatalog } from "./ModelPicker.tsx";
import { autoSpendOf, formatCost, routerSpendOf, shortTokens, toolPickerName } from "./spend.ts";
import { stepLabel } from "./Steps.tsx";

/**
 * Under a message sent on Auto, the model and effort picked to answer it ("Auto · Claude Sonnet 5.5 · High effort"); its
 * tooltip says why, and which router picked, at what cost and in how long. When the chat kept its model (no router could
 * pick, or a reply was running), it says so, and why. A tap shows the same under it. Memoized: the chat re-renders on every streamed token.
 */
export const AutoPicked = memo(function AutoPicked({ pick }: { pick: AutoPick }) {
  const catalog = useCatalog();
  const info = (id: string) => catalog.models.find((model) => model.id === id);
  const label = choiceLabel(info(pick.model), pick.model, pick.thinkingLevel);
  const { router } = pick;
  const why = router
    ? [
        pick.reason && `Why: ${pick.reason}.`,
        `Picked by ${info(router.model)?.name ?? router.model} in ${(pick.ms / 1_000).toFixed(1)} s for ${formatCost(router.cost)} (${shortTokens(autoSpendOf(pick))}).`,
      ]
        .filter(Boolean)
        .join("\n")
    : `The chat kept the model it was on.\nWhy: ${pick.failed ?? "no router could pick"}`;
  // A tap shows the tooltip's text under it too: phones have no hover.
  return (
    <details className={router ? "auto-pick" : "auto-pick kept"}>
      <summary title={why}>
        <span className="auto-pick-tag">Auto</span>
        <span className="auto-pick-model">{router ? label : `kept ${label}`}</span>
      </summary>
      <div className="auto-pick-why">{why}</div>
    </details>
  );
});

/**
 * Under a message, which of the chat's MCP tools were offered to answer it ("Tools · 3 of 42"); its tooltip names them,
 * and the picker, at what cost and in how long. When the picker failed, every tool was offered, and it says why. A tap
 * shows the same under it. Memoized: the chat re-renders on every streamed token.
 */
export const ToolsPicked = memo(function ToolsPicked({ note }: { note: ToolPickNote }) {
  const { picker, failed } = note;
  const names = note.tools.map(stepLabel).join(", ");
  let why: string;
  let label: string;
  if (failed) {
    // No picker: it failed, and every tool was offered. With one: its picks could not be offered, so the reply kept the tools it had.
    why = `${picker ? "The picked tools could not be offered, so the reply had the tools it had." : "Every tool was offered."}\nWhy: ${failed}`;
    label = picker ? "kept" : `all ${note.of}`;
  } else {
    why = [
      note.tools.length ? `Offered: ${names}.` : "No MCP tool offered: the message looked like it needs none.",
      note.added && "A reply was running, so these were added to the tools it had.",
      "Others load when needed.",
      picker &&
        `Picked by ${toolPickerName(picker.model)} in ${(note.ms / 1_000).toFixed(1)} s for ${formatCost(picker.cost)} (${shortTokens(routerSpendOf(picker))}).`,
    ]
      .filter(Boolean)
      .join("\n");
    label = `${note.tools.length} of ${note.of}`;
  }
  return (
    <details className={failed ? "auto-pick kept" : "auto-pick"}>
      <summary title={why}>
        <span className="auto-pick-tag">Tools</span>
        <span className="auto-pick-model">{label}</span>
      </summary>
      <div className="auto-pick-why">{why}</div>
    </details>
  );
});
