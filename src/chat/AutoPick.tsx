import { memo } from "react";
import { effortLabel } from "../../shared/models.ts";
import type { AutoPick } from "../../shared/protocol.ts";
import { useCatalog } from "./ModelPicker.tsx";
import { formatCost } from "./spend.ts";

/**
 * Under a message sent on Auto, the model and effort picked to answer it ("Auto · Claude Sonnet 5.5 · High effort"); its
 * tooltip says why, and which router picked, at what cost and in how long. When the router could not pick, it says the
 * chat kept its model. Memoized: the chat re-renders on every streamed token.
 */
export const AutoPicked = memo(function AutoPicked({ pick }: { pick: AutoPick }) {
  const catalog = useCatalog();
  const nameOf = (id: string) => catalog.models.find((model) => model.id === id)?.name ?? id;
  const efforts = catalog.models.find((model) => model.id === pick.model)?.efforts;
  // A model that does not reason has no effort to show; an unlisted one shows what it ran at.
  const effort = efforts?.length === 0 ? undefined : effortLabel(pick.thinkingLevel);
  const label = [nameOf(pick.model), effort].filter(Boolean).join(" · ");
  const why = pick.kept
    ? "The router did not answer in time, so the chat kept the model it was on."
    : [
        pick.reason && `Why: ${pick.reason}.`,
        pick.router &&
          `Picked by ${nameOf(pick.router)} in ${(pick.ms / 1_000).toFixed(1)} s${pick.cost !== undefined ? ` for ${formatCost(pick.cost)}` : ""}${
            pick.input !== undefined ? ` (${pick.input} in · ${pick.output ?? 0} out tokens)` : ""
          }.`,
      ]
        .filter(Boolean)
        .join("\n");
  return (
    <div className={pick.kept ? "auto-pick kept" : "auto-pick"} title={why}>
      <span className="auto-pick-tag">Auto</span>
      <span className="auto-pick-model">{pick.kept ? `kept ${label}` : label}</span>
    </div>
  );
});
