import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type Models, type ModelThinkingLevel, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAI } from "agents/models/pi-ai";
import {
  AUTO_MODEL,
  EFFORT_LABELS,
  modelKey,
  PROVIDERS,
  providerLabel,
  type ModelCatalog,
  type ModelChoice,
  type AutoCandidate,
  type ModelInfo,
  type ModelSetting,
  type ProviderId,
} from "../shared/models.ts";
import { clip, errorMessage } from "../shared/util.ts";
import { discoverModels, GATEWAY_PROVIDERS, ROUTED_APIS, SNAPSHOT, type Discovery, type GatewayFetcher, type GatewayOptions, type GatewayProviderId, type ListedModel } from "./gateway-models.ts";
import { GeminiCompat } from "./gemini.ts";
import { MAX_FAILURE_CHARS, tryModels, type ModelFailures } from "./model-health.ts";
import prices from "./prices.json";
import { tapStream } from "./streams.ts";
import type { ModelCache } from "./storage/model-cache.ts";

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

const PROVIDER_ORDER = Object.keys(PROVIDERS) as ProviderId[];

type ModelCost = Model<Api>["cost"];

/**
 * The vendors' own prices, by model id, read from their price pages into worker/prices.json by scripts/prices.ts: a
 * build refreshes the file once it is a week old, and fails if it cannot read the pages. They replace pi-ai's prices,
 * which are as old as the pi-ai release the app ships with; a model the pages do not list keeps pi-ai's. pi-ai prices
 * every model reply from its model's `cost` when the reply comes in, and stores that price with the reply, so a change
 * prices replies from then on and leaves earlier ones as they were charged.
 */
export const PRICES: ReadonlyMap<string, ModelCost> = new Map(Object.entries((prices as { models: Record<string, ModelCost> }).models));

/** Each model's copy at its current price, made once: pi looks a model up several times per model call. */
const priced = new WeakMap<object, object>();

/** `model` at its current price: the vendor's, else pi-ai's. */
function withCurrentPrice<T extends { id: string; cost: ModelCost }>(model: T): T {
  const cost = PRICES.get(model.id);
  if (!cost) return model;
  let copy = priced.get(model) as T | undefined;
  if (!copy) priced.set(model, (copy = { ...model, cost }));
  return copy;
}

/**
 * `provider` with its models at their current prices. The agent finds the models it runs on through its provider, and
 * the picker lists the same ones, so every price the app reads goes through here.
 */
export function withCurrentPrices(provider: Provider): Provider {
  return {
    ...provider,
    getModels: () => provider.getModels().map(withCurrentPrice),
    getAllModels: () => (provider.getAllModels?.() ?? provider.getModels()).map(withCurrentPrice),
  };
}

/**
 * `models`, with each reply of a model that reasons marked with the effort it was asked at: pi-ai's `thinkingLevel` on
 * the message, which only pi's own agent loop sets, and pi-durable does not (until it does, this stands in). The chat's
 * cost panel shows it next to the model. A request that asks for no reasoning is "off". The partials it streams are
 * marked too: pi-durable keeps the last one as the reply when a run is cut off. Replies fetched later (`fetchDeferred`,
 * which this app does not use) are not marked.
 */
export function withEffortRecorded(models: Models): Models {
  const streamSimple = models.streamSimple.bind(models);
  // completeSimple (the calls that summarize a long conversation) goes through streamSimple too.
  models.streamSimple = (model, context, options) => {
    const stream = streamSimple(model, context, options);
    const effort = model.reasoning ? (options?.reasoning ?? "off") : undefined;
    if (!effort) return stream;
    return tapStream(
      stream,
      (event) => {
        if ("partial" in event) event.partial.thinkingLevel ??= effort;
      },
      (message) => {
        message.thinkingLevel ??= effort;
      },
    );
  };
  return models;
}

/** A listed model: what the picker shows, the model a chat runs, and the pi-ai metadata its efforts come from. */
interface ModelEntry {
  info: ModelInfo;
  model: Model<Api>;
  metadata: Model<Api>;
}

/** `@cf/…` ids are Workers AI's; AI Gateway catalog ids are `<vendor>/<id>`. Undefined for a vendor the catalog leaves out. */
function providerOf(id: string): "anthropic" | "openai" | "workers-ai" | undefined {
  const vendor = id.startsWith("@cf/") ? "workers-ai" : id.slice(0, id.indexOf("/"));
  return vendor === "anthropic" || vendor === "openai" || vendor === "workers-ai" ? vendor : undefined;
}

/**
 * The metadata a model's efforts come from. pi-ai's gateway catalog has older thinking levels for Claude than its
 * Anthropic catalog (which knows, say, that Claude Sonnet 5.5 takes neither "off" nor "minimal"), so Claude models use
 * the Anthropic entry, found by Anthropic's spelling of the id (claude-opus-5-5 for anthropic/claude-opus-5.5).
 */
function metadataOf(model: Model<Api>, provider: ProviderId): Model<Api> {
  if (provider !== "anthropic") return model;
  const id = model.id.slice("anthropic/".length).replaceAll(".", "-");
  return Object.hasOwn(ANTHROPIC_MODELS, id) ? (ANTHROPIC_MODELS[id as keyof typeof ANTHROPIC_MODELS] as Model<Api>) : model;
}

/** The picker's view of a model. */
function infoOf(model: Model<Api>, metadata: Model<Api>, provider: ProviderId, id: string, isPriced: boolean): ModelInfo {
  return {
    id,
    name: model.name,
    provider,
    efforts: model.reasoning ? getSupportedThinkingLevels(metadata) : [],
    images: model.input.includes("image"),
    contextWindow: model.contextWindow,
    ...(isPriced && { price: { input: model.cost.input, output: model.cost.output } }),
  };
}

/**
 * The models a chat can pick among `models` (a pi-ai Cloudflare provider's) without asking AI Gateway: every Anthropic
 * and OpenAI model in its gateway catalog, newest first (by version, then by price, so a family's largest model leads),
 * then the Workers AI models above, in their order.
 */
export function chatModels(models: readonly Model<Api>[]): ModelEntry[] {
  return models.flatMap((model) => {
    const provider = providerOf(model.id);
    if (!provider || (provider === "workers-ai" && !WORKERS_AI_MODELS.includes(model.id))) return [];
    const metadata = metadataOf(model, provider);
    return [{ info: infoOf(model, metadata, provider, model.id, true), model, metadata }];
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

/** Providers whose lists are long and mix many vendors' models: listed by name, which starts with the vendor's. */
const BY_NAME = new Set<ProviderId>(["openrouter", "huggingface"]);

/**
 * The picker's order: by provider; Workers AI's in their chosen order; a long mixed list by name; otherwise newest first
 * (by version, then by price, so a family's largest model leads), then by name.
 */
function byPickerOrder(a: ModelEntry, b: ModelEntry): number {
  const [x, y] = [a.info, b.info];
  return (
    PROVIDER_ORDER.indexOf(x.provider) - PROVIDER_ORDER.indexOf(y.provider) ||
    WORKERS_AI_MODELS.indexOf(x.id) - WORKERS_AI_MODELS.indexOf(y.id) ||
    (BY_NAME.has(x.provider) ? x.name.localeCompare(y.name) : 0) ||
    version(y.id) - version(x.id) ||
    (y.price?.output ?? 0) - (x.price?.output ?? 0) ||
    x.name.localeCompare(y.name)
  );
}

/** The efforts a model routed through an OpenAI-compatible API takes when pi-ai does not say: the three every such API takes. */
const BASIC_EFFORTS: ThinkingLevelMap = { off: null, minimal: null, xhigh: null, max: null };
const NO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** What a model pi-ai does not know gets when its provider's list does not say (agents/models/pi-ai's own defaults). */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * The AI Gateway catalog's id for a vendor's own: Anthropic's dated snapshot is its model, and its dashes between
 * version numbers become dots (claude-haiku-4-5-20251001 → anthropic/claude-haiku-4.5).
 */
function catalogId(provider: GatewayProviderId, id: string): string {
  return `${provider}/${provider === "anthropic" ? id.replace(SNAPSHOT, "").replace(/(\d)-(\d)(?!\d)/g, "$1.$2") : id}`;
}

/**
 * A model a provider listed, as pi-ai runs it through AI Gateway: under the provider's AI Gateway name, with the
 * vendor's own id (what the request carries). pi-ai's own metadata where it knows the model, else what the list says,
 * else safe defaults. Its price: the list's, else the build's, else pi-ai's; with none of those it costs nothing and
 * the picker says its price is not known.
 */
function listedModel(provider: GatewayProviderId, listed: ListedModel): { model: Model<Api>; isPriced: boolean } {
  const spec = GATEWAY_PROVIDERS[provider];
  const known = Object.hasOwn(spec.known, listed.id) ? spec.known[listed.id] : undefined;
  // pi-ai's own wire for the model, when AI Gateway routes it for pi; else the provider's.
  const own = known && ROUTED_APIS.has(known.api);
  const { api, baseUrl } = own ? known : spec.wire;
  const reasoning = known?.reasoning ?? listed.reasoning ?? false;
  // A live list's price (OpenRouter's, Hugging Face's) is the newest; the build's (worker/prices.json) is at most a week old.
  const cost = listed.cost ?? PRICES.get(catalogId(provider, listed.id)) ?? known?.cost;
  const thinkingLevelMap = (own && known.thinkingLevelMap) || (reasoning && api === "openai-completions" ? BASIC_EFFORTS : undefined);
  const model: Model<Api> = {
    id: listed.id,
    name: known?.name ?? listed.name ?? listed.id,
    api,
    provider,
    baseUrl,
    reasoning,
    input: known?.input ?? (listed.images ? ["text", "image"] : ["text"]),
    cost: cost ?? NO_COST,
    contextWindow: known?.contextWindow ?? listed.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: known?.maxTokens ?? listed.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(thinkingLevelMap && { thinkingLevelMap }),
    ...(own && known.compat && { compat: known.compat }),
  };
  return { model, isPriced: cost !== undefined };
}

/** A provider's own model's entry: run on its provider's path through AI Gateway, under `<provider>/<id>`. */
function ownEntry(provider: GatewayProviderId, listed: ListedModel): ModelEntry {
  const { model, isPriced } = listedModel(provider, listed);
  return { info: infoOf(model, model, provider, modelKey(provider, model.id), isPriced), model, metadata: model };
}

/** The models a chat can pick, the deployment's providers' (as last discovered) and Workers AI's. */
export class Catalog {
  readonly checkedAt: number | undefined;
  readonly #entries = new Map<string, ModelEntry>();
  /** Each provider's own models (those not in AI Gateway's catalog), for the chat's pi providers. */
  readonly #listed = new Map<GatewayProviderId, Model<Api>[]>();

  constructor(base: readonly ModelEntry[], discovery: Discovery | null) {
    this.checkedAt = discovery?.checkedAt;
    const byCatalogId = new Map(base.map((entry) => [entry.info.id, entry]));
    const entries = new Map<string, ModelEntry>();
    for (const provider of PROVIDER_ORDER) {
      const listed = provider === "workers-ai" ? undefined : discovery?.providers[provider]?.models;
      // A provider with no models listed (Workers AI, and before or without a list) shows what AI Gateway's catalog
      // has of it: Anthropic and OpenAI can be reached without a key of the deployment's own (unified billing).
      if (!listed?.length) {
        for (const entry of base) if (entry.info.provider === provider) entries.set(entry.info.id, entry);
        continue;
      }
      for (const model of listed) {
        const entry = byCatalogId.get(catalogId(provider as GatewayProviderId, model.id)) ?? ownEntry(provider as GatewayProviderId, model);
        if (!entries.has(entry.info.id)) entries.set(entry.info.id, entry);
      }
    }
    const failing = discovery?.failing ?? {};
    for (const entry of [...entries.values()].sort(byPickerOrder)) {
      const failure = Object.hasOwn(failing, entry.info.id) ? failing[entry.info.id] : undefined;
      this.#entries.set(entry.info.id, failure ? { ...entry, info: { ...entry.info, failing: failure.error } } : entry);
      const { provider } = entry.model;
      if (!Object.hasOwn(GATEWAY_PROVIDERS, provider)) continue;
      const own = this.#listed.get(provider as GatewayProviderId);
      if (own) own.push(entry.model);
      else this.#listed.set(provider as GatewayProviderId, [entry.model]);
    }
  }

  /** The picker's list. */
  get models(): ModelInfo[] {
    return [...this.#entries.values()].map((entry) => entry.info);
  }

  toJSON(): ModelCatalog {
    return { models: this.models, checkedAt: this.checkedAt };
  }

  /** The listed model the picker calls `id`, as pi names it: provider and id. */
  model(id: string): Model<Api> | undefined {
    return this.#entries.get(id)?.model;
  }

  /** A provider's own models: those it listed that AI Gateway's catalog does not have. */
  listed(provider: GatewayProviderId): Model<Api>[] {
    return this.#listed.get(provider) ?? [];
  }

  /**
   * A choice from the browser, checked: a listed model, at an effort it takes. An effort it does not take moves to the
   * nearest one it does (pi-ai's rule); no effort asks for medium. Null for a model the picker does not list.
   */
  check(input: { model?: unknown; thinkingLevel?: unknown }): ModelChoice | null {
    const entry = typeof input.model === "string" ? this.#entries.get(input.model) : undefined;
    if (!entry) return null;
    const wanted = thinkingLevelOf(input.thinkingLevel) ?? "medium";
    return { model: entry.info.id, thinkingLevel: entry.info.efforts.length ? clampThinkingLevel(entry.metadata, wanted) : "off" };
  }
}

let base: ModelEntry[] | undefined;

/** AI Gateway's catalog and the Workers AI models, which ship with pi-ai: built once per isolate, without the AI binding. */
function baseEntries(): ModelEntry[] {
  return (base ??= chatModels(withCurrentPrices(createAI({ binding: {} as never }).provider).getModels()));
}

let fallback: Catalog | undefined;

/** The catalog before any provider was asked: AI Gateway's Anthropic and OpenAI models, and Workers AI's. */
export function baseCatalog(): Catalog {
  return (fallback ??= new Catalog(baseEntries(), null));
}

/** The catalog from a discovery. */
export function catalogFrom(discovery: Discovery | null): Catalog {
  return discovery ? new Catalog(baseEntries(), discovery) : baseCatalog();
}

/** `level` when it is one of pi's thinking levels. */
export function thinkingLevelOf(level: unknown): ModelThinkingLevel | undefined {
  return typeof level === "string" && Object.hasOwn(EFFORT_LABELS, level) ? (level as ModelThinkingLevel) : undefined;
}

/** A setting from the browser or a user's saved default, checked: Auto, or a model as `Catalog.check` checks it. */
export function checkSetting(catalog: Catalog, input: { model?: unknown; thinkingLevel?: unknown }): ModelSetting | null {
  return input.model === AUTO_MODEL ? { model: AUTO_MODEL } : catalog.check(input);
}

/**
 * What a new chat starts on: its user's last pick (`saved`), else Auto when the deployment names a router
 * (`ROUTER_MODEL`, a comma-separated list, read as routersFrom reads it), else null, the deployment's default.
 */
export function startingSetting(saved: ModelSetting | null, routers: string): ModelSetting | null {
  return saved ?? (routers.split(",").some((id) => id.trim()) ? { model: AUTO_MODEL } : null);
}

/**
 * The deployment's default (`MODEL` at `THINKING_LEVEL`), checked like a pick when AI Gateway's catalog or Workers AI
 * has the model, so a level the model rejects (Claude 5.5 takes no "off") moves to one it takes. Any other model is
 * used as configured, at medium when `THINKING_LEVEL` is not one of pi's levels.
 */
export function defaultModelChoice(model: string, thinkingLevel: string): ModelChoice {
  return baseCatalog().check({ model, thinkingLevel }) ?? { model, thinkingLevel: thinkingLevelOf(thinkingLevel) ?? "medium" };
}

/**
 * The pi providers of the providers' own models, for a chat's model registry: one per AI Gateway provider, named as
 * AI Gateway names it, each with the models the current catalog lists for it. They stream as `cloudflare` (agents'
 * Cloudflare provider) does, which routes each model to AI Gateway by its vendor URL.
 */
export function listedProviders(cloudflare: Provider, catalog: () => Catalog): Provider[] {
  return (Object.keys(GATEWAY_PROVIDERS) as GatewayProviderId[]).map((id) => ({
    ...cloudflare,
    id,
    name: providerLabel(id),
    getModels: () => catalog().listed(id),
    getAllModels: () => catalog().listed(id),
  }));
}

/** How long a discovery stands before the providers are asked again (in the background: the old one serves meanwhile). */
const FRESH_MS = 60 * 60_000;
/** How soon someone may ask the providers again by hand. */
const MIN_REFRESH_MS = 60_000;
/** How long an isolate keeps the catalog before reading the shared copy again, which another isolate may have renewed. */
const REREAD_MS = 5 * 60_000;

/** The AI binding, and the gateway and key alias the chats use. */
export interface CatalogSource extends GatewayOptions {
  cache: ModelCache;
  /** Keeps a background refresh alive after the response (the Worker's waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Tries the models that must answer (Auto's) after each discovery: those that cannot be called, with why. */
  tryModels?: (catalog: Catalog) => Promise<ModelFailures>;
}

/** What a Worker or chat object reaches AI Gateway with: the AI binding, the gateway's id, and the key alias. */
interface GatewayEnv {
  AI: NonNullable<Parameters<typeof createAI>[0]["binding"]>;
  AI_GATEWAY_ID: string;
  AI_BYOK_ALIAS?: string;
}

/** agents/models/pi-ai over the deployment's AI Gateway, with Gemini's answers read by `gemini`. */
export function gatewayAI(env: GatewayEnv, gemini: GeminiCompat) {
  return createAI({ binding: gemini.binding(env.AI), gateway: env.AI_GATEWAY_ID, byokAlias: env.AI_BYOK_ALIAS || undefined });
}

/** Where a Worker or chat object finds the catalog, from its environment. */
export function catalogSource(env: GatewayEnv & { AUTO_MODELS?: unknown }, cache: ModelCache, waitUntil?: (promise: Promise<unknown>) => void): CatalogSource {
  const auto = (env.AUTO_MODELS as AutoCandidate[] | undefined)?.map(({ id }) => id) ?? [];
  return {
    cache,
    ai: env.AI as unknown as GatewayFetcher,
    gateway: env.AI_GATEWAY_ID,
    byokAlias: env.AI_BYOK_ALIAS || undefined,
    waitUntil,
    ...(auto.length && {
      tryModels: (catalog: Catalog) => {
        const gemini = new GeminiCompat();
        const targets = auto.flatMap((id) => catalog.model(id) ?? []);
        return tryModels(piModels(gatewayAI(env, gemini).provider, gemini, () => catalog), targets);
      },
    }),
  };
}

/** The isolate's catalog, and when it was read. */
let held: { catalog: Catalog; discovery: Discovery | null; readAt: number } | undefined;

/** The catalog this isolate holds, without waiting: the base one until a discovery was read. */
export function currentCatalog(): Catalog {
  return held?.catalog ?? baseCatalog();
}

/** When a discovery's newest failure was marked: a mark made since it was held makes it another one. */
function markedAt(discovery: Discovery | null | undefined): number {
  return Math.max(0, ...Object.values(discovery?.failing ?? {}).map((failure) => failure.at));
}

/** Hold a discovery, building its catalog only when it is not the one already held. */
function hold(discovery: Discovery | null): Catalog {
  const readAt = Date.now();
  if (held && held.discovery?.checkedAt === discovery?.checkedAt && markedAt(held.discovery) === markedAt(discovery)) {
    held.readAt = readAt;
    return held.catalog;
  }
  const catalog = catalogFrom(discovery);
  held = { catalog, discovery, readAt };
  return catalog;
}

/** The read and the ask in flight, which concurrent callers share. */
let reading: Promise<Discovery | null> | undefined;
let discovering: Promise<Catalog> | undefined;

/** The shared copy, read once however many ask at the same time. */
function readCached(cache: ModelCache): Promise<Discovery | null> {
  return (reading ??= cache
    .read()
    .catch((error: unknown) => {
      console.error("models: could not read the last discovery:", errorMessage(error));
      return null;
    })
    .finally(() => {
      reading = undefined;
    }));
}

/**
 * Ask the providers, keep the answer for every isolate, and hold it here. `previous` (the last discovery read, else
 * the one held) gives a provider whose list cannot be read now the models it had.
 */
function rediscover(source: CatalogSource, previous: Discovery | null | undefined): Promise<Catalog> {
  return (discovering ??= (async () => {
    const before = previous ?? held?.discovery;
    // The marks stand until the models are tried again, after the lists are kept: no one waits on the tries.
    const discovery = { ...(await discoverModels({ ai: source.ai, gateway: source.gateway, byokAlias: source.byokAlias, previous: before })), failing: before?.failing };
    await source.cache.write(discovery).catch((error: unknown) => console.error("models: could not keep the discovery:", errorMessage(error)));
    const catalog = hold(discovery);
    if (!source.tryModels) return catalog;
    const trying = retry(source, discovery, catalog);
    // In the background where the Worker can keep it alive; else (tests) waited on.
    if (!source.waitUntil) return await trying;
    source.waitUntil(trying);
    return catalog;
  })().finally(() => {
    discovering = undefined;
  }));
}

/**
 * Try the models that must answer, on `catalog` (that of `discovery`), and keep what they say for every isolate: afresh,
 * so a model that answers again loses its mark. The catalog with the new marks; never throws: a try that fails keeps the
 * marks as they were.
 */
async function retry(source: CatalogSource, discovery: Discovery, catalog: Catalog): Promise<Catalog> {
  try {
    const failing = await source.tryModels!(catalog);
    for (const [id, failure] of Object.entries(failing)) console.error(`models: ${id} cannot be called:`, failure.error);
    const tried = { ...discovery, failing };
    await source.cache.write(tried);
    return hold(tried);
  } catch (error) {
    console.error("models: could not try the Auto models:", errorMessage(error));
    return catalog;
  }
}

/**
 * The models a chat can pick: the providers' lists as last asked (kept in R2 for every isolate), and Workers AI's. The
 * first call with no discovery anywhere asks the providers and waits; later, a discovery older than FRESH_MS is renewed
 * in the background while the old one serves. `refresh` asks again now, unless the last ask was under a minute ago.
 */
export async function loadCatalog(source: CatalogSource, { refresh = false } = {}): Promise<Catalog> {
  if (held && !refresh && Date.now() - held.readAt < REREAD_MS) return held.catalog;
  const discovery = await readCached(source.cache);
  const age = discovery ? Date.now() - discovery.checkedAt : Infinity;
  if (!discovery || (refresh && age >= MIN_REFRESH_MS)) {
    try {
      return await rediscover(source, discovery);
    } catch (error) {
      console.error("models: could not ask the providers:", errorMessage(error));
      return hold(discovery);
    }
  }
  const catalog = hold(discovery);
  if (age >= FRESH_MS) {
    const renew = rediscover(source, discovery).catch((error: unknown) => console.error("models: could not ask the providers:", errorMessage(error)));
    source.waitUntil?.(renew);
  }
  return catalog;
}

/**
 * Mark a model that failed a call for a reason that will not pass on its own (worker/model-health.ts cannotCall), for
 * every isolate, until the providers are next asked: Auto leaves it out meanwhile. Not marked when there is no
 * discovery to keep the mark in (nothing was asked yet). Never throws: a mark that cannot be kept is logged.
 */
export async function markFailing(source: CatalogSource, id: string, error: string): Promise<void> {
  try {
    console.error(`models: ${id} cannot be called:`, error);
    // Marked already, here: every call to a model with no credits fails, and one mark is enough.
    if (held?.discovery?.failing?.[id]) return;
    const discovery = (await readCached(source.cache)) ?? held?.discovery;
    if (!discovery || discovery.failing?.[id]) return;
    const marked: Discovery = { ...discovery, failing: { ...discovery.failing, [id]: { error: clip(error, MAX_FAILURE_CHARS), at: Date.now() } } };
    await source.cache.write(marked);
    hold(marked);
  } catch (caught) {
    console.error("models: could not mark a failing model:", errorMessage(caught));
  }
}

/** Forget what this isolate holds (tests). */
export function forgetCatalog(): void {
  held = undefined;
}

/**
 * pi-ai's models, through the chat's AI Gateway, at the vendors' current prices, each reply marked with its effort and
 * Gemini's tool calls signed: AI Gateway's catalog and Workers AI's through `provider`, and the models the providers list
 * (as this isolate's catalog has them now) through one pi provider each.
 */
export function piModels(provider: Provider, gemini: GeminiCompat, catalog: () => Catalog = currentCatalog) {
  const models = createModels();
  models.setProvider(withCurrentPrices(provider));
  for (const listed of listedProviders(provider, catalog)) models.setProvider(listed);
  return gemini.models(withEffortRecorded(models));
}
