import { memo, useState } from "react";
import { choiceLabel } from "../../shared/models.ts";
import type { AutoPick } from "../../shared/protocol.ts";
import { useCatalog } from "./ModelPicker.tsx";
import { autoSpendOf, formatCost, shortTokens } from "./spend.ts";

/**
 * Under a message sent on Auto, the model and effort picked to answer it ("Auto · Claude Sonnet 5.5 · High effort"); its
 * tooltip says why, and which router picked, at what cost and in how long. When no router could pick, it says the chat
 * kept its model, and why. A tap shows the same under it. Memoized: the chat re-renders on every streamed token.
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
    : `The router could not pick, so the chat kept the model it was on.${pick.failed ? `\nWhy: ${pick.failed}` : ""}`;
  // A tap shows the tooltip's text under it too: phones have no hover.
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={router ? "auto-pick" : "auto-pick kept"} title={why} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="auto-pick-tag">Auto</span>
        <span className="auto-pick-model">{router ? label : `kept ${label}`}</span>
      </button>
      {open && <div className="auto-pick-why">{why}</div>}
    </>
  );
});
