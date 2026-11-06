import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PAGE_AI_LIMITS, PAGE_STORAGE_LIMITS } from "../shared/protocol.ts";
import { jsonIn } from "../shared/util.ts";
import { askPageModel, checkChanges, checkPageAiRequest, mergeValues } from "../worker/artifacts/page-features.ts";

describe("page storage", () => {
  it("puts the viewer's own values over the author's, and a removed one stays removed", () => {
    expect(mergeValues({ layout: "author", theme: "dark", hidden: "[]" }, { layout: "mine", hidden: null, extra: "1" })).toEqual({ layout: "mine", theme: "dark", extra: "1" });
  });

  it("keeps a key named like a property of every object", () => {
    expect(mergeValues({}, JSON.parse('{"__proto__":"x","a":"1"}'))).toHaveProperty("a", "1");
    expect(Object.getOwnPropertyNames(mergeValues({}, JSON.parse('{"__proto__":"x"}')))).toEqual(["__proto__"]);
  });

  it("checks what a page writes", () => {
    expect(checkChanges({ a: "1", b: null })).toEqual({ a: "1", b: null });
    expect(checkChanges(["a"])).toMatch(/Expected/);
    expect(checkChanges({ a: 1 })).toMatch(/string/);
    expect(checkChanges({ "": "x" })).toMatch(/key/);
    expect(checkChanges({ ["k".repeat(PAGE_STORAGE_LIMITS.keyChars + 1)]: "x" })).toMatch(/key/);
    expect(checkChanges({ a: "x".repeat(PAGE_STORAGE_LIMITS.valueChars + 1) })).toMatch(/value/);
  });
});

describe("page model requests", () => {
  it("takes messages ending with the user's, and caps the answer", () => {
    expect(checkPageAiRequest({ messages: [{ role: "user", content: "hi" }], maxTokens: 99_999, json: true, extra: 1 })).toEqual({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: PAGE_AI_LIMITS.maxTokens,
      json: true,
    });
    expect(checkPageAiRequest({ system: "s", messages: [{ role: "user", content: "hi" }] })).toEqual({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: PAGE_AI_LIMITS.defaultMaxTokens,
    });
  });

  it("refuses malformed or oversized requests", () => {
    expect(checkPageAiRequest(null)).toMatch(/Expected/);
    expect(checkPageAiRequest({ messages: [] })).toMatch(/messages/);
    expect(checkPageAiRequest({ messages: [{ role: "system", content: "x" }] })).toMatch(/role/);
    expect(checkPageAiRequest({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] })).toMatch(/last message/);
    expect(checkPageAiRequest({ messages: [{ role: "user", content: "x".repeat(PAGE_AI_LIMITS.chars + 1) }] })).toMatch(/characters/);
    expect(checkPageAiRequest({ messages: [{ role: "user", content: "x" }], maxTokens: 1.5 })).toMatch(/maxTokens/);
    expect(checkPageAiRequest({ system: 3, messages: [{ role: "user", content: "x" }] })).toMatch(/system/);
  });

  it("finds the JSON in a reply", () => {
    expect(jsonIn('{"order":["a"]}')).toEqual({ order: ["a"] });
    expect(jsonIn('Sure:\n```json\n{"order": ["b"]}\n```')).toEqual({ order: ["b"] });
    expect(jsonIn('Here it is: {"a": 1} hope that helps')).toEqual({ a: 1 });
    expect(jsonIn("no json here")).toBeUndefined();
  });
});

describe("askPageModel", () => {
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
  const model = (id: string, reasoning = false) => ({ id, api: "openai-completions", provider: "test", reasoning }) as unknown as Model<Api>;
  const reply = (text: string, stopReason: AssistantMessage["stopReason"] = "stop") => ({ role: "assistant", content: [{ type: "text", text }], usage, stopReason }) as unknown as AssistantMessage;
  const request = { messages: [{ role: "user" as const, content: "move revenue first" }], maxTokens: 500 };

  it("asks the next model when one fails, and gives a reasoning model room to think", async () => {
    const asked: { id: string; maxTokens?: number; system?: string }[] = [];
    const models = {
      completeSimple: async (m: Model<Api>, context: { systemPrompt?: string }, options?: { maxTokens?: number }) => {
        asked.push({ id: m.id, maxTokens: options?.maxTokens, system: context.systemPrompt });
        if (m.id === "first") throw new Error("down");
        return reply('{"order":["revenue"]}');
      },
    };
    const answer = await askPageModel(models as never, [model("first"), model("second", true)], { ...request, json: true });
    expect(answer).toMatchObject({ ok: true, json: { order: ["revenue"] }, usage });
    expect(asked.map((a) => a.id)).toEqual(["first", "second"]);
    expect(asked[1].maxTokens).toBeGreaterThan(500);
    expect(asked[1].system).toMatch(/JSON/);
  });

  it("says bad_output for a reply that is not the JSON asked for, without asking another model", async () => {
    let calls = 0;
    const models = { completeSimple: async () => (calls++, reply("I moved it for you.")) };
    const answer = await askPageModel(models as never, [model("a"), model("b")], { ...request, json: true });
    expect(answer).toMatchObject({ ok: false, error: { code: "bad_output" }, usage });
    expect(calls).toBe(1);
  });

  it("is unavailable when no model answers, or there is none", async () => {
    const models = { completeSimple: async () => reply("", "error") };
    expect(await askPageModel(models as never, [model("a")], request)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await askPageModel(models as never, [], request)).toMatchObject({ ok: false, error: { code: "unavailable", message: /no model/ } });
  });

  it("passes earlier turns on as the conversation", async () => {
    let seen: unknown;
    const models = { completeSimple: async (_m: Model<Api>, context: { messages: unknown }) => ((seen = context.messages), reply("ok")) };
    await askPageModel(models as never, [model("a")], {
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
      maxTokens: 100,
    });
    expect(seen).toMatchObject([
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "text", text: "two" }], stopReason: "stop" },
      { role: "user", content: "three" },
    ]);
  });
});
