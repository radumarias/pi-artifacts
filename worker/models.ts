import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { createAI } from "agents/models/pi-ai";
import { EFFORT_LABELS, VENDORS, type ModelChoice, type ModelInfo, type Vendor } from "../shared/models.ts";

/**
 * The Workers AI models the picker offers, best first. Workers AI runs on Cloudflare, within the account's free daily
 * allowance, and needs no provider key. Picked for building pages with tools: tool calling, a context of 128k tokens
 * or more (the system prompt carries the page runtime), and room to write a whole HTML page in one reply. A model
 * pi-ai no longer lists is left out.
 */
const WORKERS_AI_MODELS = [
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.3",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/qwen/qwen3.8-27b",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/openai/gpt-oss-120b",
  "@cf/google/gemma-4-26b-a4b-it",
];

const VENDOR_ORDER = Object.keys(VENDORS) as Vendor[];

/** A listed model, and the pi-ai metadata its efforts come from. */
interface ModelEntry {
  info: ModelInfo;
  metadata: Model<Api>;
}

/** `@cf/…` ids are Workers AI's; AI Gateway catalog ids are `<vendor>/<id>`. Undefined for a vendor the picker leaves out. */
function vendorOf(id: string): Vendor | undefined {
  const vendor = id.startsWith("@cf/") ? "workers-ai" : id.slice(0, id.indexOf("/"));
  return Object.hasOwn(VENDORS, vendor) ? (vendor as Vendor) : undefined;
}

/**
 * The metadata a model's efforts come from. pi-ai's gateway catalog has older thinking levels for Claude than its
 * Anthropic catalog (which knows, say, that Claude Sonnet 5.5 takes neither "off" nor "minimal"), so Claude models use
 * the Anthropic entry, found by Anthropic's spelling of the id (claude-opus-5-5 for anthropic/claude-opus-5.5).
 */
function metadataOf(model: Model<Api>, vendor: Vendor): Model<Api> {
  if (vendor !== "anthropic") return model;
  const id = model.id.slice("anthropic/".length).replaceAll(".", "-");
  return Object.hasOwn(ANTHROPIC_MODELS, id) ? (ANTHROPIC_MODELS[id as keyof typeof ANTHROPIC_MODELS] as Model<Api>) : model;
}

/**
 * The models a chat can pick among `models` (a pi-ai provider's): every Anthropic and OpenAI chat model, newest first
 * (by version, then by price, so a family's largest model leads), then the Workers AI models above, in their order.
 */
export function chatModels(models: readonly Model<Api>[]): ModelEntry[] {
  return models
    .flatMap((model) => {
      const vendor = vendorOf(model.id);
      return vendor && (vendor !== "workers-ai" || WORKERS_AI_MODELS.includes(model.id)) ? [{ model, vendor }] : [];
    })
    .sort(
      (a, b) =>
        VENDOR_ORDER.indexOf(a.vendor) - VENDOR_ORDER.indexOf(b.vendor) ||
        WORKERS_AI_MODELS.indexOf(a.model.id) - WORKERS_AI_MODELS.indexOf(b.model.id) ||
        version(b.model.id) - version(a.model.id) ||
        b.model.cost.output - a.model.cost.output ||
        a.model.name.localeCompare(b.model.name),
    )
    .map(({ model, vendor }) => {
      const metadata = metadataOf(model, vendor);
      return { info: { id: model.id, name: model.name, vendor, efforts: model.reasoning ? getSupportedThinkingLevels(metadata) : [] }, metadata };
    });
}

/**
 * The first version number in a model id: anthropic/claude-opus-5.5 → 5.5, openai/gpt-4o → 4. A minor version has one
 * or two digits, so a dated snapshot (gpt-4-0613, gpt-5-2025-08-07) is not read as 4.0613 or 5.2025.
 */
function version(id: string): number {
  const match = id.slice(id.indexOf("/") + 1).match(/\d+(?:[.-]\d{1,2}(?!\d))?/);
  return match ? Number(match[0].replace("-", ".")) : 0;
}

let catalog: Map<string, ModelEntry> | undefined;

/** The models ship with pi-ai, so the list is built once per isolate. Listing them never touches the AI binding. */
function entries(): Map<string, ModelEntry> {
  return (catalog ??= new Map(chatModels(createAI({ binding: {} as never }).provider.getModels()).map((entry) => [entry.info.id, entry])));
}

/** The models a chat can pick, as the picker lists them. */
export function modelCatalog(): ModelInfo[] {
  return [...entries().values()].map((entry) => entry.info);
}

/**
 * A choice from the browser, checked: a listed model, at an effort it takes. An effort it does not take moves to the
 * nearest one it does (pi-ai's rule); no effort asks for medium. Null for a model the picker does not list.
 */
export function checkModelChoice(input: { model?: unknown; thinkingLevel?: unknown }): ModelChoice | null {
  const entry = entries().get(input.model as string);
  if (!entry) return null;
  const level = input.thinkingLevel;
  const wanted = typeof level === "string" && Object.hasOwn(EFFORT_LABELS, level) ? (level as ModelThinkingLevel) : "medium";
  return { model: entry.info.id, thinkingLevel: entry.info.efforts.length ? clampThinkingLevel(entry.metadata, wanted) : "off" };
}

/**
 * The deployment's default (`MODEL` at `THINKING_LEVEL`), checked like a pick when the picker lists the model, so a
 * level the model rejects (Claude 5.5 takes no "off") moves to one it takes. A model the picker does not list is used
 * as configured.
 */
export function defaultModelChoice(model: string, thinkingLevel: string): ModelChoice {
  return checkModelChoice({ model, thinkingLevel }) ?? { model, thinkingLevel: thinkingLevel as ModelThinkingLevel };
}
