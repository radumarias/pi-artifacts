// Item chips: the records a reply is built on, shown under it as chips that open the source item. They come from what
// MCP servers returned through the hub (a record's id, title and link fields), never from what the model wrote.

import type { EntryRecord } from "@earendil-works/pi-durable";
import { excerpt } from "./replies.ts";
import { isObject } from "./util.ts";

/** One record a tool result held: the server it came from, its id there, a title, and a link to it when it has one. */
export type ItemRef = { server: string; id: string; title: string; url?: string };

/** What an MCP tool's result carries for the app beside its text (worker/agent/mcp.ts). A type, so pi can store it. */
export type McpResultDetails = { items: ItemRef[] };

/** Records one tool result gives at most, and one reply shows. */
const MAX_RESULT_ITEMS = 8;
export const MAX_REPLY_ITEMS = 6;
const MAX_TITLE = 120;
const MAX_ID = 80;
/**
 * How deep in a result records are looked for, counting each object and list on the way: a list in an object in a list
 * (`{ results: [{ issues: [...] }] }`, whose records are four levels down).
 */
const MAX_DEPTH = 4;
/** How many values are looked at in one result, so a result of thousands of rows costs little. */
const MAX_VISITED = 2_000;

const ID_FIELDS = ["id", "key", "uuid", "number", "slug"];
const TITLE_FIELDS = ["title", "name", "subject", "summary", "label", "displayName", "display_name"];
const LINK_FIELDS = ["url", "html_url", "web_url", "webUrl", "permalink", "link", "href"];

/** A field's value as short text: a string or a finite number. */
function textField(record: Record<string, unknown>, fields: readonly string[], max: number): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim()) return excerpt(value, max);
  }
  return undefined;
}

/** A link field that is a web address: nothing else may open from a chip (no javascript:, data: or relative links). */
function linkField(record: Record<string, unknown>): string | undefined {
  for (const field of LINK_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.length > 2_000) continue;
    try {
      const url = new URL(value);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
    } catch {
      // Not a URL.
    }
  }
  return undefined;
}

/**
 * The records in one tool result's payload (its structured content, or its text parsed as JSON): objects with an id and
 * a title, in the order they come, at most `limit`, each once. A plain table of numbers has none.
 */
export function itemsOf(server: string, payload: unknown, limit = MAX_RESULT_ITEMS): ItemRef[] {
  const items: ItemRef[] = [];
  const seen = new Set<string>();
  let visited = 0;
  const visit = (value: unknown, depth: number): void => {
    if (items.length >= limit || visited++ > MAX_VISITED || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    const id = textField(value, ID_FIELDS, MAX_ID);
    const title = textField(value, TITLE_FIELDS, MAX_TITLE);
    if (id && title && !seen.has(id)) {
      seen.add(id);
      const url = linkField(value);
      items.push({ server, id, title, ...(url && { url }) });
      return;
    }
    for (const child of Object.values(value)) if (Array.isArray(child) || isObject(child)) visit(child, depth + 1);
  };
  visit(payload, 0);
  return items;
}

/** The items of several results together, each once (by server and id), those with a link first, at most `limit`. */
export function mergeItems(lists: readonly (readonly ItemRef[])[], limit = MAX_REPLY_ITEMS): ItemRef[] {
  const seen = new Set<string>();
  const all = lists.flat().filter((item) => {
    const key = `${item.server}\u0000${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Stable: within each group, the order the results came in.
  return [...all.filter((item) => item.url), ...all.filter((item) => !item.url)].slice(0, limit);
}

/** The items a tool result's details carry, checked: details come from storage, and only well-formed ones show. */
export function resultItems(details: unknown): ItemRef[] {
  const items = isObject(details) ? details.items : undefined;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is ItemRef =>
      isObject(item) &&
      typeof item.server === "string" &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      (item.url === undefined || (typeof item.url === "string" && /^https?:\/\//i.test(item.url))),
  );
}

/** The items one entry holds: those of a tool result that did not fail, read back from its details; none for others. */
export function entryItems(entry: Pick<EntryRecord, "kind" | "model">): ItemRef[] {
  const message = entry.model?.[0];
  return entry.kind === "pi.tool-result" && message?.role === "toolResult" && !message.isError ? resultItems(message.details) : [];
}
