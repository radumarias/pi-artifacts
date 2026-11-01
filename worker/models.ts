import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { createAI } from "agents/models/pi-ai";
import { EFFORT_LABELS, LOCAL_PREFIX, LOCAL_PROVIDER_ID, VENDORS, type ModelChoice, type ModelInfo, type Vendor } from "../shared/models.ts";
import { localModels } from "./local-models.ts";

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

/**
 * What the picker offers: the models of a runtime on this machine, and the cloud's (Anthropic, OpenAI and Workers AI,
 * through AI Gateway) unless the AI binding is out of reach.
 */
export interface ModelSources {
  local: readonly Model<Api>[];
  cloud: boolean;
}

const CLOUD_ONLY: ModelSources = { local: [], cloud: true };

/** The sources the Worker's settings name: `LOCAL_MODELS_URL` (asked for its models) and `CLOUD_MODELS`. */
export async function modelSources(env: { LOCAL_MODELS_URL: string; CLOUD_MODELS: string }): Promise<ModelSources> {
  return { local: env.LOCAL_MODELS_URL ? await localModels(env.LOCAL_MODELS_URL) : [], cloud: env.CLOUD_MODELS !== "false" };
}

/**
 * A local runtime's models are `local`. Otherwise `@cf/…` ids are Workers AI's and AI Gateway catalog ids are
 * `<vendor>/<id>`. Undefined for a vendor the picker leaves out.
 */
function vendorOf(model: Model<Api>): Vendor | undefined {
  if (model.provider === LOCAL_PROVIDER_ID) return "local";
  const vendor = model.id.startsWith("@cf/") ? "workers-ai" : model.id.slice(0, model.id.indexOf("/"));
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
 * The models a chat can pick among `models` (pi-ai providers'): a local runtime's, in the runtime's order, then every
 * Anthropic and OpenAI chat model, newest first (by version, then by price, so a family's largest model leads), then
 * the Workers AI models above, in their order. A local model's id is `local/` and the runtime's id.
 */
export function chatModels(models: readonly Model<Api>[]): ModelEntry[] {
  return models
    .flatMap((model) => {
      const vendor = vendorOf(model);
      return vendor && (vendor !== "workers-ai" || WORKERS_AI_MODELS.includes(model.id)) ? [{ model, vendor }] : [];
    })
    .sort((a, b) => {
      const byVendor = VENDOR_ORDER.indexOf(a.vendor) - VENDOR_ORDER.indexOf(b.vendor);
      // Local ids carry no version to go by (qwen3-32b is not version 3.32): they keep the order the runtime lists them in.
      if (byVendor || a.vendor === "local") return byVendor;
      return (
        WORKERS_AI_MODELS.indexOf(a.model.id) - WORKERS_AI_MODELS.indexOf(b.model.id) ||
        version(b.model.id) - version(a.model.id) ||
        b.model.cost.output - a.model.cost.output ||
        a.model.name.localeCompare(b.model.name)
      );
    })
    .map(({ model, vendor }) => {
      const metadata = metadataOf(model, vendor);
      const efforts = model.reasoning ? getSupportedThinkingLevels(metadata) : [];
      const id = vendor === "local" ? LOCAL_PREFIX + model.id : model.id;
      return { info: { id, name: model.name, vendor, efforts, images: model.input.includes("image") }, metadata };
    });
}

/**
 * The first version number in a model id, as major + minor / 100: anthropic/claude-opus-5.5 → 5.05, openai/gpt-4o → 4,
 * so 4.10 sorts after 4.9. A minor version has one or two digits, so a dated snapshot (gpt-4-0613, gpt-5-2025-08-07)
 * is not read as a minor version.
 */
function version(id: string): number {
  const match = id.slice(id.indexOf("/") + 1).match(/(\d+)(?:[.-](\d{1,2})(?!\d))?/);
  return match ? Number(match[1]) + Number(match[2] ?? 0) / 100 : 0;
}

let cloudCatalog: Map<string, ModelEntry> | undefined;

/** The cloud's models ship with pi-ai, so their list is built once per isolate. Listing them never touches the AI binding. */
function cloudEntries(): Map<string, ModelEntry> {
  return (cloudCatalog ??= byId(chatModels(createAI({ binding: {} as never }).provider.getModels())));
}

function byId(entries: ModelEntry[]): Map<string, ModelEntry> {
  return new Map(entries.map((entry) => [entry.info.id, entry]));
}

/** The models `sources` offer, local ones first. */
function entries({ local, cloud }: ModelSources): Map<string, ModelEntry> {
  const remote = cloud ? cloudEntries() : new Map<string, ModelEntry>();
  return local.length ? new Map([...byId(chatModels(local)), ...remote]) : remote;
}

/** The models a chat can pick, as the picker lists them. */
export function modelCatalog(sources = CLOUD_ONLY): ModelInfo[] {
  return [...entries(sources).values()].map((entry) => entry.info);
}

/**
 * A choice from the browser, checked: a listed model, at an effort it takes. An effort it does not take moves to the
 * nearest one it does (pi-ai's rule); no effort asks for medium. Null for a model the picker does not list.
 */
export function checkModelChoice(input: { model?: unknown; thinkingLevel?: unknown }, sources = CLOUD_ONLY): ModelChoice | null {
  const entry = entries(sources).get(input.model as string);
  return entry ? choiceOf(entry, input.thinkingLevel) : null;
}

/** `entry` at `thinkingLevel`, moved to an effort it takes. */
function choiceOf(entry: ModelEntry, thinkingLevel: unknown): ModelChoice {
  const wanted = thinkingLevelOf(thinkingLevel) ?? "medium";
  return { model: entry.info.id, thinkingLevel: entry.info.efforts.length ? clampThinkingLevel(entry.metadata, wanted) : "off" };
}

/** `level` when it is one of pi's thinking levels. */
function thinkingLevelOf(level: unknown): ModelThinkingLevel | undefined {
  return typeof level === "string" && Object.hasOwn(EFFORT_LABELS, level) ? (level as ModelThinkingLevel) : undefined;
}

/**
 * The deployment's default (`MODEL` at `THINKING_LEVEL`), checked like a pick when the picker lists the model, so a
 * level the model rejects (Claude 5.5 takes no "off") moves to one it takes. A model the picker does not list is used
 * as configured, at medium when `THINKING_LEVEL` is not one of pi's levels.
 */
export function defaultModelChoice(model: string, thinkingLevel: string): ModelChoice {
  return checkModelChoice({ model, thinkingLevel }) ?? { model, thinkingLevel: thinkingLevelOf(thinkingLevel) ?? "medium" };
}

/**
 * Without the cloud's models (a local run with PI_OFFLINE=1), the deployment's default `model` is out of reach: a new
 * chat then starts on the first model listed. Null while the default is reachable, or when nothing is listed.
 */
export function offlineModelChoice(model: string, sources: ModelSources): ModelChoice | null {
  if (sources.cloud) return null;
  const listed = entries(sources);
  if (listed.has(model)) return null;
  const first = listed.values().next();
  return first.done ? null : choiceOf(first.value, undefined);
}
