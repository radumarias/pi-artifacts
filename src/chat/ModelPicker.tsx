import { useEffect, useState } from "react";
import { EFFORT_LABELS, type ModelInfo, type ThinkingLevel } from "../../shared/models.ts";
import { api } from "../api.ts";

const VENDOR_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "workers-ai": "Workers AI (free daily allowance)",
};

// The choices ship with the Worker's pi-ai, so every chat shares one fetch.
let catalog: Promise<ModelInfo[]> | undefined;
function loadCatalog(): Promise<ModelInfo[]> {
  return (catalog ??= api.models().catch((error) => {
    catalog = undefined;
    throw error;
  }));
}

interface Props {
  model?: string;
  thinkingLevel?: string;
  disabled: boolean;
  /** Ask for a model and effort; the chat answers with the effort the model takes, through its agent state. */
  onChange: (model: string, thinkingLevel?: string) => void;
}

/** The chat's model and, for a model that reasons, its effort. */
export function ModelPicker({ model, thinkingLevel, disabled, onChange }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    let live = true;
    loadCatalog().then((list) => live && setModels(list), () => {});
    return () => {
      live = false;
    };
  }, []);

  if (!model) return null;
  const current = models.find((entry) => entry.id === model);
  const vendors = [...new Set(models.map((entry) => entry.vendor))];
  return (
    <div className="model-picker">
      {/* Coming from a model that does not reason, ask for no effort: the chat picks the new model's usual one. */}
      <select aria-label="Model" value={model} disabled={disabled} onChange={(e) => onChange(e.target.value, current?.efforts.length ? thinkingLevel : undefined)}>
        {/* A deployment's default can be a model the picker does not list. */}
        {!current && <option value={model}>{model}</option>}
        {vendors.map((vendor) => (
          <optgroup key={vendor} label={VENDOR_LABELS[vendor] ?? vendor}>
            {models
              .filter((entry) => entry.vendor === vendor)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {current && current.efforts.length > 0 && thinkingLevel && (
        <select aria-label="Effort" value={thinkingLevel} disabled={disabled} onChange={(e) => onChange(model, e.target.value)}>
          {!current.efforts.includes(thinkingLevel as ThinkingLevel) && <option value={thinkingLevel}>{thinkingLevel}</option>}
          {current.efforts.map((level) => (
            <option key={level} value={level}>
              {EFFORT_LABELS[level]} effort
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
