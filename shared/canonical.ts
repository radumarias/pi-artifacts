import type { CallToolResult } from "./protocol.ts";

/**
 * JSON with object keys sorted at every level, so two inputs that differ only
 * in property order produce the same cache key.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The identity of an MCP call: equal for the same server, tool and input, whatever the input's key order. */
export function callIdentity(server: string, tool: string, input: unknown): string {
  return `${server}\u0000${tool}\u0000${canonicalJson(input ?? {})}`;
}

/** The convenience `payload` of a result: structured content, else the first text block as JSON, else that text. */
export function derivePayload(result: { content: { type: string; text?: string }[]; structuredContent?: unknown }): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = firstText(result.content);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The text of a result's first text block, if it has one. */
export function firstText(content: readonly { type: string; text?: string }[]): string | undefined {
  return content.find((block) => block.type === "text")?.text;
}

/** A result as served from a cache: stamped with when it was produced and whether a fresh one is on its way. */
export function withCache(result: CallToolResult, storedAt: number, revalidating: boolean): CallToolResult {
  return { ...result, cache: { storedAt, revalidating } };
}

/** A result without its cache stamp, as it is stored. */
export function stripCache(result: CallToolResult): CallToolResult {
  const { cache: _cache, ...rest } = result;
  return rest;
}
