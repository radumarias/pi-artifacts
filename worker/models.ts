import { getSupportedThinkingLevels, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { effortFor, type ModelChoice, type ModelInfo, type ThinkingLevel } from "../shared/models.ts";

/** Where a chat's models come from, in the order the picker lists them. */
const VENDORS = ["anthropic", "openai", "workers-ai"];

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

/** `@cf/…` ids are Workers AI's; AI Gateway catalog ids are `<vendor>/<id>`. */
function vendorOf(id: string): string {
  return id.startsWith("@cf/") ? "workers-ai" : id.slice(0, id.indexOf("/"));
}

/**
 * The models a chat can pick among `models` (a pi-ai provider's): every Anthropic and OpenAI chat model, newest first
 * (by version, then by price, so a family's largest model leads), then the Workers AI models above, in their order.
 */
export function chatModels(models: readonly Model<Api>[]): ModelInfo[] {
  const listed = models.flatMap((model) => {
    const vendor = vendorOf(model.id);
    if (!VENDORS.includes(vendor) || (vendor === "workers-ai" && !WORKERS_AI_MODELS.includes(model.id))) return [];
    return [{ model, info: { id: model.id, name: model.name, vendor, efforts: efforts(model, vendor) } }];
  });
  listed.sort(
    (a, b) =>
      VENDORS.indexOf(a.info.vendor) - VENDORS.indexOf(b.info.vendor) ||
      WORKERS_AI_MODELS.indexOf(a.model.id) - WORKERS_AI_MODELS.indexOf(b.model.id) ||
      version(b.model.id) - version(a.model.id) ||
      b.model.cost.output - a.model.cost.output ||
      a.info.name.localeCompare(b.info.name),
  );
  return listed.map((entry) => entry.info);
}

function efforts(model: Model<Api>, vendor: string): ThinkingLevel[] {
  if (!model.reasoning) return [];
  // Current Claude models reject pi's "off" (thinking: disabled).
  return getSupportedThinkingLevels(model).filter((level) => !(vendor === "anthropic" && level === "off"));
}

/** The first version number in a model id: anthropic/claude-opus-5.5 → 5.5, openai/gpt-4o → 4. */
function version(id: string): number {
  const match = id.slice(id.indexOf("/") + 1).match(/\d+(?:[.-]\d+)?/);
  return match ? Number(match[0].replace("-", ".")) : 0;
}

let catalog: ModelInfo[] | undefined;

/** The models a chat can pick. They ship with pi-ai, so the list is built once per isolate. */
export function modelCatalog(provider: () => Provider): ModelInfo[] {
  return (catalog ??= chatModels(provider().getModels()));
}

/** A choice from the browser, checked: a listed model, at an effort it takes. Null for anything else. */
export function checkModelChoice(models: readonly ModelInfo[], input: { model?: unknown; thinkingLevel?: unknown }): ModelChoice | null {
  const model = models.find((entry) => entry.id === input.model);
  if (!model) return null;
  return { model: model.id, thinkingLevel: effortFor(model, typeof input.thinkingLevel === "string" ? input.thinkingLevel : undefined) };
}
