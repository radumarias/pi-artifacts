import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { memo, useEffect, useMemo, useState } from "react";
import { EFFORT_LABELS, VENDORS, type ModelInfo } from "../../shared/models.ts";
import { memoAsync } from "../../shared/util.ts";
import { api } from "../api.ts";

// The choices change only with a deploy, so every chat shares one fetch.
const loadCatalog = memoAsync(() => api.models());

interface Props {
  model?: string;
  thinkingLevel?: string;
  disabled: boolean;
  /** Ask for a model and effort; the chat answers with the effort the model takes, through its agent state. */
  onChange: (model: string, thinkingLevel?: string) => void;
}

/** The chat's model and, for a model that reasons, its effort. Memoized: the chat re-renders on every streamed token. */
export const ModelPicker = memo(function ModelPicker({ model, thinkingLevel, disabled, onChange }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    let live = true;
    loadCatalog().then((list) => live && setModels(list), () => {});
    return () => {
      live = false;
    };
  }, []);
  const groups = useMemo(() => Object.entries(VENDORS).map(([vendor, label]) => ({ label, models: models.filter((entry) => entry.vendor === vendor) })), [models]);

  if (!model) return null;
  const current = models.find((entry) => entry.id === model);
  return (
    <div className="model-picker">
      {/* Coming from a model that does not reason, ask for no effort: the chat picks the new model's usual one. */}
      <select aria-label="Model" value={model} disabled={disabled} onChange={(e) => onChange(e.target.value, current?.efforts.length ? thinkingLevel : undefined)}>
        {/* A deployment's default can be a model the picker does not list. */}
        {!current && <option value={model}>{model}</option>}
        {groups.map(
          (group) =>
            group.models.length > 0 && (
              <optgroup key={group.label} label={group.label}>
                {group.models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            ),
        )}
      </select>
      {current && current.efforts.length > 0 && thinkingLevel && (
        <select aria-label="Effort" value={thinkingLevel} disabled={disabled} onChange={(e) => onChange(model, e.target.value)}>
          {!current.efforts.includes(thinkingLevel as ModelThinkingLevel) && <option value={thinkingLevel}>{thinkingLevel}</option>}
          {current.efforts.map((level) => (
            <option key={level} value={level}>
              {EFFORT_LABELS[level]} effort
            </option>
          ))}
        </select>
      )}
    </div>
  );
});
