import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { itemsOf, MAX_REPLY_ITEMS, mergeItems, resultItems } from "../shared/items.ts";
import { replyItems } from "../src/chat/entries.ts";

describe("item chips from tool results", () => {
  it("takes records with an id and a title, and a web link when they have one", () => {
    const payload = {
      total: 2,
      results: [
        { id: 41, title: "Signups by region", url: "https://reports.example/41", rows: [{ region: "North", n: 12 }] },
        { key: "OPS-7", summary: "  Week 34\\n spike  ", html_url: "javascript:alert(1)" },
        { region: "West", n: 3 },
      ],
    };
    expect(itemsOf("reports", payload)).toEqual([
      { server: "reports", id: "41", title: "Signups by region", url: "https://reports.example/41" },
      { server: "reports", id: "OPS-7", title: "Week 34\\n spike" },
    ]);
  });

  it("finds none in a table of numbers or in text, and keeps to the limit and the depth", () => {
    expect(itemsOf("db", [{ day: 1, n: 4 }, { day: 2, n: 9 }])).toEqual([]);
    expect(itemsOf("db", "41 rows")).toEqual([]);
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}` }));
    expect(itemsOf("db", many, 3).map((item) => item.id)).toEqual(["r0", "r1", "r2"]);
    expect(itemsOf("db", { a: { b: { c: { d: [{ id: "deep", title: "Too deep" }] } } } })).toEqual([]);
    // A list in an object in a list is as deep as records are looked for.
    expect(itemsOf("db", { results: [{ issues: [{ id: "A-1", title: "Nested" }] }] })).toEqual([{ server: "db", id: "A-1", title: "Nested" }]);
    // One record a result names twice shows once; a link with a password never shows.
    expect(itemsOf("db", [{ id: 1, title: "A", url: "https://u:p@x.example/" }, { id: 1, title: "A again" }])).toEqual([{ server: "db", id: "1", title: "A" }]);
  });

  it("merges a reply's results: each record once, those with a link first, at most MAX_REPLY_ITEMS", () => {
    const a = { server: "s", id: "1", title: "One" };
    const b = { server: "s", id: "2", title: "Two", url: "https://x.example/2" };
    const c = { server: "t", id: "1", title: "Other server's one" };
    expect(mergeItems([[a, b], [b, c]])).toEqual([b, a, c]);
    const lots = Array.from({ length: 20 }, (_, i) => ({ server: "s", id: String(i), title: `T${i}` }));
    expect(mergeItems([lots])).toHaveLength(MAX_REPLY_ITEMS);
  });

  it("reads only well-formed items back from a result's details", () => {
    expect(resultItems(undefined)).toEqual([]);
    expect(resultItems({ saved: ["a.txt"] })).toEqual([]);
    expect(resultItems({ items: [{ server: "s", id: "1", title: "Ok" }, { server: "s", id: 2, title: "No" }, { server: "s", id: "3", title: "Bad", url: "data:text/html,x" }] })).toEqual([
      { server: "s", id: "1", title: "Ok" },
    ]);
  });
});

const message = (id: number, kind: string, data: object, model?: object[]) => ({ id, conversationId: 1, kind, data, model }) as unknown as EntryRecord;
const person = (id: number, text: string, aside = false) =>
  message(id, "chat.message", { uid: "ana", name: "Ana", text, ...(aside && { aside: true }) }, aside ? undefined : [{ role: "user", content: text, timestamp: 0 }]);
const assistant = (id: number, content: object[]) => message(id, "pi.assistant", {}, [{ role: "assistant", content, stopReason: "stop", timestamp: 0 }]);
const result = (id: number, items: object[], isError = false) =>
  message(id, "pi.tool-result", {}, [{ role: "toolResult", toolCallId: `c${id}`, toolName: "desk__search", content: [], details: { items }, isError, timestamp: 0 }]);

describe("item chips under pi's replies", () => {
  it("puts a reply's records under its last message with text, not across a person's message", () => {
    const one = { server: "desk", id: "1", title: "One" };
    const two = { server: "desk", id: "2", title: "Two" };
    const entries = [
      person(1, "@pi tickets?"),
      assistant(2, [{ type: "text", text: "Looking." }, { type: "toolCall", id: "c3", name: "desk__search", arguments: {} }]),
      result(3, [one]),
      // An aside written while pi works does not end its reply.
      person(4, "thanks", true),
      result(5, [{ server: "desk", id: "9", title: "Failed" }], true),
      assistant(6, [{ type: "text", text: "Ticket one." }]),
      person(7, "@pi and now?"),
      result(8, [two]),
      assistant(9, [{ type: "toolCall", id: "c10", name: "x", arguments: {} }]),
    ];
    expect([...replyItems(entries)]).toEqual([[6, [one]]]);
    expect([...replyItems([...entries, assistant(10, [{ type: "text", text: "Two." }])])]).toEqual([
      [6, [one]],
      [10, [two]],
    ]);
  });
});
