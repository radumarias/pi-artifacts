// The models' prices, kept in worker/prices.json for the Worker to price replies with: Anthropic's, OpenAI's and
// Workers AI's from their own price pages, and every other AI Gateway provider's from models.dev (the catalog pi-ai's
// own model data comes from). A build asks Cloudflare which providers the gateway holds keys for, and prices their
// models; it refreshes the file once it is a week old or when those providers change, and fails rather than ship
// prices it could not read. `node --experimental-strip-types scripts/prices.ts` (pnpm prices) refreshes it now.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Plugin } from "vite";
import { PROVIDERS } from "../shared/models.ts";

/** Dollars per million tokens, as pi-ai's model `cost` has them. A tier applies to prompts over `inputTokensAbove`. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: (Omit<Price, "tiers"> & { inputTokensAbove: number })[];
}

export interface PriceList {
  /** When the pages were read, ISO 8601. */
  checkedAt: string;
  /** The AI Gateway providers priced from models.dev, as the gateway names them. Absent in a list from before them. */
  providers?: string[];
  /**
   * By the model picker's id: an AI Gateway catalog id (anthropic/claude-opus-5.5, openai/gpt-5.5), a Workers AI id
   * (@cf/zai-org/glm-5.3), or `<gateway provider>/<the provider's id>` (google-ai-studio/gemini-2.5-flash).
   */
  models: Record<string, Price>;
}

export const PRICES_FILE = new URL("../worker/prices.json", import.meta.url);
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** The pages, in Markdown: each vendor serves one next to its HTML page. */
export const SOURCES = {
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing.md",
  openai: "https://developers.openai.com/api/docs/pricing.md",
  "workers-ai": "https://developers.cloudflare.com/workers-ai/platform/pricing/index.md",
} as const;

/** Every provider's models and prices, as JSON: the source of the providers without a price page read above. */
export const MODELS_DEV = "https://models.dev/api.json";

/** The AI Gateway providers priced from models.dev, by gateway name, with models.dev's name for each. */
export const MODELS_DEV_PROVIDERS: Record<string, string> = {
  "google-ai-studio": "google",
  grok: "xai",
  mistral: "mistral",
  deepseek: "deepseek",
  groq: "groq",
  cerebras: "cerebras",
  cohere: "cohere",
  openrouter: "openrouter",
  huggingface: "huggingface",
};

// Every provider the app can list models from (shared/models.ts) has a price source here.
for (const provider of Object.keys(PROVIDERS)) {
  if (!["anthropic", "openai", "workers-ai"].includes(provider) && !MODELS_DEV_PROVIDERS[provider]) throw new Error(`No price source for ${provider}`);
}

/** The AI Gateway the deployment uses (AI_GATEWAY_ID in cloudflare.config.ts). */
export const AI_GATEWAY = process.env.AI_GATEWAY_ID ?? "pi-artifacts";

class PriceError extends Error {}

/** `$4`, `$0.125 / MTok`, `$2 / MTok<sup>3</sup>` → 4, 0.125, 2. `-` (not offered) → `none`. Anything else is an error. */
function dollars(cell: string, where: string, none?: number): number {
  const text = cell.replace(/<sup>.*?<\/sup>/g, "").trim();
  if (text === "-" && none !== undefined) return none;
  const match = text.match(/^\$(\d+(?:\.\d+)?)(?:\s*\/\s*MTok)?$/);
  if (!match) throw new PriceError(`${where}: "${cell.trim()}" is not a price`);
  return Number(match[1]);
}

/** The rows of the Markdown tables in `md`, as trimmed cells, without header and separator rows. */
function rows(md: string): string[][] {
  return md
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*:?-{3}/.test(line))
    .map((line) => line.slice(1, line.lastIndexOf("|")).split("|").map((cell) => cell.trim()))
    .filter((cells) => cells[0] !== "Model");
}

/** The text from `heading` to the next heading of the same level or above, for each time it appears. */
function sections(md: string, heading: RegExp): string[] {
  const lines = md.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!heading.test(lines[i])) continue;
    const level = lines[i].match(/^#+/)![0].length;
    let end = i + 1;
    while (end < lines.length && !(lines[end].match(/^#+ /) && lines[end].match(/^#+/)![0].length <= level)) end++;
    found.push(lines.slice(i + 1, end).join("\n"));
  }
  return found;
}

function nonEmpty(models: Record<string, Price>, vendor: string): Record<string, Price> {
  if (Object.keys(models).length === 0) throw new PriceError(`${vendor}: no prices found; has the page changed?`);
  return models;
}

/**
 * Anthropic's "Model pricing" table: base input, 5-minute cache writes, 1-hour cache writes, cache hits, output. pi-ai
 * prices 1-hour writes as twice the input, which the table agrees with. A model priced higher for long prompts has a
 * second row, "(for prompts over 100,000 tokens)".
 */
export function parseAnthropic(md: string): Record<string, Price> {
  const [table] = sections(md, /^## Model pricing\s*$/);
  if (!table) throw new PriceError("anthropic: no Model pricing section");
  const models: Record<string, Price> = {};
  for (const cells of rows(table)) {
    if (cells.length !== 6) throw new PriceError(`anthropic: a row with ${cells.length} cells: ${cells[0]}`);
    const over = cells[0].match(/\(for prompts over ([\d,]+) tokens\)/);
    const name = cells[0].replace(/\s*\(.*$/, "").trim();
    const id = `anthropic/${name.toLowerCase().replace(/\s+/g, "-")}`;
    const where = `anthropic: ${name}`;
    const price = { input: dollars(cells[1], where), output: dollars(cells[5], where), cacheRead: dollars(cells[4], where), cacheWrite: dollars(cells[2], where) };
    if (!over) {
      models[id] = { ...models[id], ...price };
      continue;
    }
    if (!models[id]) throw new PriceError(`${where}: a long-prompt row before its base row`);
    (models[id].tiers ??= []).push({ inputTokensAbove: Number(over[1].replaceAll(",", "")), ...price });
  }
  return nonEmpty(models, "anthropic");
}

/**
 * OpenAI's "Standard pricing data" tables (not Batch, Flex or the faster tiers). Either short and long context
 * columns (input, output, cached input, 30-minute write, 12-hour write, each twice), or input, output and cached
 * input; `-` where a model offers no such price. A model's long context starts at the length its name gives, `gpt-5.5 (<272K context length)`, else 272K.
 */
export function parseOpenAI(md: string): Record<string, Price> {
  const models: Record<string, Price> = {};
  for (const table of sections(md, /^### Standard pricing data\s*$/)) {
    for (const cells of rows(table)) {
      const name = cells[0].replace(/\s*\(.*$/, "").trim();
      const id = `openai/${name}`;
      const where = `openai: ${name}`;
      if (models[id]) continue;
      // No cached price: the model caches nothing, so any cached token is priced as input. No write price: writes are free.
      const price = (at: number, writes: boolean) => {
        const input = dollars(cells[at], where);
        return { input, output: dollars(cells[at + 1], where), cacheRead: dollars(cells[at + 2], where, input), cacheWrite: writes ? dollars(cells[at + 3], where, 0) : 0 };
      };
      if (cells.length === 4) {
        models[id] = price(1, false);
      } else if (cells.length === 11) {
        models[id] = price(1, true);
        const limit = cells[0].match(/<(\d+)K context/);
        if (cells[6] !== "-") models[id].tiers = [{ inputTokensAbove: limit ? Number(limit[1]) * 1000 : 272_000, ...price(6, true) }];
      } else {
        throw new PriceError(`${where}: a row with ${cells.length} cells`);
      }
    }
  }
  return nonEmpty(models, "openai");
}

/** Cloudflare's Workers AI per-model table: "$0.440 per M input tokens <br> $0.014 per M cached input tokens <br> …". */
export function parseWorkersAI(md: string): Record<string, Price> {
  const models: Record<string, Price> = {};
  for (const cells of rows(md)) {
    if (!cells[0].startsWith("@cf/") || !/per M (input|output) tokens/.test(cells[1] ?? "")) continue;
    const rate = (kind: string) => {
      const match = cells[1].match(new RegExp(`\\$(\\d+(?:\\.\\d+)?) per M ${kind} tokens`));
      return match ? Number(match[1]) : undefined;
    };
    const input = rate("input");
    const output = rate("output");
    if (input === undefined) throw new PriceError(`workers-ai: ${cells[0]}: no input price in "${cells[1]}"`);
    // Embedding and other models priced by input alone: not chat models.
    if (output === undefined) continue;
    // No cached price: the model caches nothing, so any cached token is priced as input.
    models[cells[0]] = { input, output, cacheRead: rate("cached input") ?? input, cacheWrite: 0 };
  }
  return nonEmpty(models, "workers-ai");
}

/** A models.dev price, or undefined for one that is not a number of dollars. */
function modelsDevPrice(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The prices of `providers`' chat models (those that call tools) in models.dev's catalog, keyed as the picker names
 * them: `<gateway provider>/<model id>`. A tier by context length is a long-prompt price, as pi-ai has it. A provider
 * models.dev does not have fails: its page or its name has changed.
 */
export function parseModelsDev(json: string, providers: readonly string[]): Record<string, Price> {
  const catalog = JSON.parse(json) as Record<string, { models?: Record<string, { tool_call?: boolean; cost?: Record<string, unknown> }> }>;
  const models: Record<string, Price> = {};
  for (const provider of providers) {
    const listed = catalog[MODELS_DEV_PROVIDERS[provider]]?.models;
    if (!listed) throw new PriceError(`models.dev: no ${MODELS_DEV_PROVIDERS[provider]} models`);
    for (const [id, model] of Object.entries(listed)) {
      const price = (cost: Record<string, unknown> = {}) => {
        const [input, output] = [modelsDevPrice(cost.input), modelsDevPrice(cost.output)];
        // No cached price: the model caches nothing, so any cached token is priced as input. No write price: writes are free.
        return input === undefined || output === undefined ? undefined : { input, output, cacheRead: modelsDevPrice(cost.cache_read) ?? input, cacheWrite: modelsDevPrice(cost.cache_write) ?? 0 };
      };
      const base = model.tool_call === false ? undefined : price(model.cost);
      if (!base) continue;
      const tiers = (Array.isArray(model.cost?.tiers) ? (model.cost.tiers as Record<string, unknown>[]) : []).flatMap((tier) => {
        const at = tier.tier as { type?: string; size?: unknown } | undefined;
        const tierPrice = price(tier);
        return at?.type === "context" && typeof at.size === "number" && tierPrice ? [{ inputTokensAbove: at.size, ...tierPrice }] : [];
      });
      models[`${provider}/${id}`] = tiers.length ? { ...base, tiers } : base;
    }
  }
  return models;
}

const PARSERS = { anthropic: parseAnthropic, openai: parseOpenAI, "workers-ai": parseWorkersAI } as const;

/**
 * Read every page and parse it, and models.dev for `providers`; any source that cannot be fetched or read fails the
 * whole refresh.
 */
export async function fetchPrices(fetchPage: (url: string) => Promise<string> = fetchText, providers: readonly string[] = []): Promise<Record<string, Price>> {
  const parts = await Promise.all([
    ...Object.entries(SOURCES).map(async ([vendor, url]) => PARSERS[vendor as keyof typeof SOURCES](await fetchPage(url))),
    providers.length ? fetchPage(MODELS_DEV).then((json) => parseModelsDev(json, providers)) : {},
  ]);
  return Object.fromEntries(parts.flatMap((part) => Object.entries(part)).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The AI Gateway providers the deployment's gateway holds keys for (and the app can list models from), asked of
 * Cloudflare with the `cf` CLI as signed in for the deploy. Undefined when it cannot tell (not signed in, offline): then
 * every provider is priced.
 */
export function keyedProviders(gateway = AI_GATEWAY): string[] | undefined {
  const cf = new URL("../node_modules/.bin/cf", import.meta.url).pathname;
  const run = spawnSync(cf, ["ai-gateway", "gateways", "providers", "list", "--gateway-id", gateway, "--per-page", "100"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (run.status !== 0) return undefined;
  return providersIn(run.stdout);
}

/** The providers named in `cf ai-gateway gateways providers list`'s output (JSON: a list, or the API's envelope). */
export function providersIn(output: string): string[] | undefined {
  const start = output.search(/[[{]/);
  if (start < 0) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(output.slice(start));
  } catch {
    return undefined;
  }
  const list = Array.isArray(body) ? body : (body as { result?: unknown })?.result;
  if (!Array.isArray(list)) return undefined;
  const names = list.map((item: Record<string, unknown>) => item?.provider_slug ?? item?.providerSlug ?? item?.provider);
  return [...new Set(names.filter((name): name is string => typeof name === "string" && Object.hasOwn(MODELS_DEV_PROVIDERS, name)))].sort();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new PriceError(`${url}: HTTP ${response.status}`);
  return response.text();
}

/** The price list as worker/prices.json has it, checked: a file that does not read as one fails. */
export function readPrices(text: string): PriceList {
  const list = JSON.parse(text) as PriceList;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const valid = (price: Price) => number(price.input) && number(price.output) && number(price.cacheRead) && number(price.cacheWrite);
  if (Number.isNaN(Date.parse(list.checkedAt)) || !list.models || Object.keys(list.models).length === 0) throw new PriceError("worker/prices.json: no checkedAt or no models");
  for (const [id, price] of Object.entries(list.models)) {
    if (!valid(price) || !(price.tiers ?? []).every((tier) => valid(tier) && number(tier.inputTokensAbove))) throw new PriceError(`worker/prices.json: ${id} has a bad price`);
  }
  return list;
}

/** What changed between two lists, one line per model, for the build log. */
export function describeChanges(before: Record<string, Price>, after: Record<string, Price>): string[] {
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return ids.flatMap((id) => {
    const [was, now] = [JSON.stringify(before[id]), JSON.stringify(after[id])];
    if (was === now) return [];
    return [!before[id] ? `+ ${id} ${now}` : !after[id] ? `- ${id}` : `~ ${id} ${was} → ${now}`];
  });
}

/** Every provider priced from models.dev: what a build prices when it cannot tell which ones the gateway has keys for. */
export const ALL_PROVIDERS = Object.keys(MODELS_DEV_PROVIDERS).sort();

/**
 * Refresh worker/prices.json when it is older than a week, when it prices other providers than `providers` (or
 * `force`), and return what changed. Without `providers` (no one could tell which have keys), the ones the file prices
 * stay, so a build that is not signed in does not undo the last signed-in one. Throws when the file cannot be read, or when it is due and a source cannot be
 * fetched or parsed: the build then fails instead of using prices that may be wrong.
 */
export async function refreshPrices({
  file = PRICES_FILE,
  force = false,
  now = Date.now(),
  providers: wanted,
  fetchPage,
}: { file?: URL | string; force?: boolean; now?: number; providers?: readonly string[]; fetchPage?: (url: string) => Promise<string> } = {}) {
  // A first run (forced) starts the file; a build without it fails.
  const current: PriceList = force && !existsSync(file) ? { checkedAt: new Date(0).toISOString(), models: {} } : readPrices(readFileSync(file, "utf8"));
  const providers = [...(wanted ?? current.providers ?? ALL_PROVIDERS)].sort();
  const sameProviders = JSON.stringify(current.providers ?? []) === JSON.stringify(providers);
  if (!force && sameProviders && now - Date.parse(current.checkedAt) < MAX_AGE_MS) return { refreshed: false, changes: [] as string[] };
  const models = await fetchPrices(fetchPage, providers);
  const next: PriceList = { checkedAt: new Date(now).toISOString(), providers, models };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return { refreshed: true, changes: describeChanges(current.models, models) };
}

/** The build step: once per build (Vite builds the app and the Worker), before anything is bundled. */
export function pricesPlugin(): Plugin {
  let run: ReturnType<typeof refreshPrices> | undefined;
  return {
    name: "pi-artifacts:prices",
    apply: "build",
    async buildStart() {
      const keyed = process.env.PI_OFFLINE === "1" ? undefined : keyedProviders();
      this.info(
        keyed
          ? `AI Gateway ${AI_GATEWAY} holds keys for: ${keyed.length ? keyed.join(", ") : "no provider beyond Anthropic and OpenAI"}.`
          : `Could not ask Cloudflare which providers AI Gateway ${AI_GATEWAY} holds keys for (sign in with cf auth login): pricing the providers worker/prices.json prices.`,
      );
      const { refreshed, changes } = await (run ??= refreshPrices({ providers: keyed }));
      if (!refreshed) return;
      this.info(`Read the prices into worker/prices.json: ${changes.length ? `\n${changes.join("\n")}` : "no changes"}`);
      // Even with no changes: the new date keeps the next builds from reading the pages again.
      this.warn("worker/prices.json was refreshed: commit it, so the repository has the prices this build uses.");
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const keyed = keyedProviders();
  console.log(keyed ? `AI Gateway ${AI_GATEWAY} holds keys for: ${keyed.join(", ") || "no provider beyond Anthropic and OpenAI"}.` : "Could not ask Cloudflare which providers have keys: pricing the ones the file prices, else all.");
  const { changes } = await refreshPrices({ force: true, providers: keyed });
  console.log(changes.length ? changes.join("\n") : "No price changes.");
}
