import type { Api, AssistantMessage, Context, Model, Models, Usage } from "@earendil-works/pi-ai";
import { textOf } from "../../shared/canonical.ts";
import { PAGE_AI_LIMITS, PAGE_STORAGE_LIMITS, type PageAiRequest, type PageError } from "../../shared/protocol.ts";
import { clip, errorMessage } from "../../shared/util.ts";

// The parts of a page's saved values and model calls that need no Worker: checks, merging, the model call itself.
// The routes are in page-routes.ts.

/** The values a page sees: the author's, then the viewer's own over them (a null removes one of the author's). */
export function mergeValues(defaults: Record<string, string | null>, own: Record<string, string | null>): Record<string, string> {
  // A Map, so a key such as "__proto__" is a key like any other.
  const values = new Map<string, string>();
  for (const [key, value] of [...Object.entries(defaults), ...Object.entries(own)]) {
    if (value === null) values.delete(key);
    else values.set(key, value);
  }
  return Object.fromEntries(values);
}

/** The changes a page sent, checked: keys and values within PAGE_STORAGE_LIMITS, null for a removed key. */
export function checkChanges(changes: unknown): Record<string, string | null> | string {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return "Expected {changes: {key: value or null}}.";
  const entries = Object.entries(changes);
  if (entries.length > PAGE_STORAGE_LIMITS.keys) return `A write changes at most ${PAGE_STORAGE_LIMITS.keys} keys.`;
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > PAGE_STORAGE_LIMITS.keyChars) return `A key is 1 to ${PAGE_STORAGE_LIMITS.keyChars} characters.`;
    if (value !== null && typeof value !== "string") return "A value is a string, or null to remove it.";
    if (typeof value === "string" && value.length > PAGE_STORAGE_LIMITS.valueChars) return `A value is at most ${PAGE_STORAGE_LIMITS.valueChars} characters.`;
  }
  return Object.fromEntries(entries) as Record<string, string | null>;
}

/**
 * A page's model (pi.use("ai")): one answer from a small, fast model, for something a viewer typed into the page, such
 * as "move revenue to the top" answered with the page's new layout as JSON. No tools, no web and nothing kept between
 * calls; the page sends what the model needs to know each time. The viewer who typed pays: the call counts against
 * their own daily allowance (PAGE_AI_DAILY_USD), not the page author's.
 */

/** Room a model that reasons gets beyond the answer's own tokens: its reasoning counts against the same limit. */
const REASONING_TOKENS = 2_000;
const JSON_INSTRUCTION = "Reply with one JSON value and nothing else: no prose, no Markdown fence.";

/** The request a page sent, checked; a string says what is wrong with it. */
export function checkPageAiRequest(body: unknown): PageAiRequest | string {
  if (!body || typeof body !== "object") return "Expected { system?, messages, maxTokens?, json? }.";
  const { system, messages, maxTokens, json } = body as Record<string, unknown>;
  if (system !== undefined && typeof system !== "string") return "system must be a string.";
  if (typeof system === "string" && system.length > PAGE_AI_LIMITS.systemChars) return `system is at most ${PAGE_AI_LIMITS.systemChars} characters.`;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > PAGE_AI_LIMITS.messages) {
    return `messages must hold 1 to ${PAGE_AI_LIMITS.messages} messages.`;
  }
  let chars = 0;
  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
      return 'Each message is { role: "user" | "assistant", content: string }.';
    }
    chars += message.content.length;
  }
  if (messages[messages.length - 1].role !== "user") return "The last message must be the user's.";
  if (chars > PAGE_AI_LIMITS.chars) return `The messages hold at most ${PAGE_AI_LIMITS.chars} characters.`;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1)) return "maxTokens must be a positive whole number.";
  return {
    ...(typeof system === "string" && system && { system }),
    messages: messages.map(({ role, content }) => ({ role, content })),
    maxTokens: Math.min((maxTokens as number | undefined) ?? PAGE_AI_LIMITS.defaultMaxTokens, PAGE_AI_LIMITS.maxTokens),
    ...(json === true && { json: true }),
  };
}

/** What a page's model answered, and what it cost. */
export type PageAiAnswer = { ok: true; text: string; json?: unknown; model: string; usage: Usage } | { ok: false; error: PageError; usage?: Usage };

/**
 * Ask the first of `candidates` that answers. A model that fails passes the request to the next one; a reply that
 * is not the JSON asked for is `bad_output` (it was answered and paid for, so no other model is asked).
 */
export async function askPageModel(models: Pick<Models, "completeSimple">, candidates: readonly Model<Api>[], request: PageAiRequest): Promise<PageAiAnswer> {
  const failures: string[] = [];
  for (const model of candidates) {
    let reply: AssistantMessage;
    try {
      reply = await models.completeSimple(model, context(model, request), {
        maxTokens: (request.maxTokens ?? PAGE_AI_LIMITS.defaultMaxTokens) + (model.reasoning ? REASONING_TOKENS : 0),
        ...(model.reasoning && { reasoning: "low" as const }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      failures.push(`${model.id}: ${errorMessage(error)}`);
      continue;
    }
    if (reply.stopReason !== "stop" && reply.stopReason !== "length") {
      failures.push(`${model.id}: ${reply.errorMessage ?? reply.stopReason}`);
      continue;
    }
    const text = textOf(reply.content, "").trim();
    if (!request.json) return { ok: true, text, model: model.id, usage: reply.usage };
    const json = jsonIn(text);
    if (json === undefined) return { ok: false, error: { code: "bad_output", message: `The model did not answer with JSON: ${clip(text, 200)}` }, usage: reply.usage };
    return { ok: true, text, json, model: model.id, usage: reply.usage };
  }
  if (failures.length) console.error("page ai:", failures.join("; "));
  return { ok: false, error: { code: "unavailable", message: candidates.length ? "The model did not answer; try again in a moment." : "This app has no model for pages." } };
}

function context(model: Model<Api>, request: PageAiRequest): Context {
  const timestamp = Date.now();
  const system = [request.system, request.json && JSON_INSTRUCTION].filter(Boolean).join("\n\n");
  return {
    ...(system && { systemPrompt: system }),
    messages: request.messages.map(({ role, content }) =>
      role === "user"
        ? { role, content, timestamp }
        : {
            role,
            content: [{ type: "text", text: content }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp,
          },
    ),
  };
}

/** The JSON value a reply holds: all of it, else a fenced block, else from its first bracket to its last. */
export function jsonIn(text: string): unknown {
  const attempts = [text, /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]];
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));
  for (const attempt of attempts) {
    if (attempt === undefined) continue;
    try {
      return JSON.parse(attempt.trim());
    } catch {}
  }
  return undefined;
}
