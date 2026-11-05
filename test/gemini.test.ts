import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAI } from "agents/models/pi-ai";
import { catalogFrom, listedProviders, withEffortRecorded } from "../worker/models.ts";
import { GeminiCompat, showThoughts, sign, UNSIGNED } from "../worker/gemini.ts";

const GEMINI = "google-ai-studio/gemini-test";
const catalog = catalogFrom({ checkedAt: 1, providers: { "google-ai-studio": { status: "ok", models: [{ id: "gemini-test", reasoning: true }] } } });

/** A streamed answer of `chunks`, sent in small pieces that split lines and characters, as the network may. */
function streamed(chunks: object[]): Response {
  const bytes = new TextEncoder().encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Gemini's streamed answer that calls `tool`, its signature on the call (as its OpenAI-compatible API sends it). */
function callingAnswer(id: string, signature: string | undefined): Response {
  const call = {
    index: 0,
    id,
    type: "function",
    function: { name: "lookup", arguments: '{"q":"x"}' },
    ...(signature && { extra_content: { google: { thought_signature: signature } } }),
  };
  return streamed([
    { id: "r", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] } }] },
    { id: "r", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
}

/** Gemini's streamed answer of `deltas` (each a chunk's `choices[0].delta`). */
const answerOf = (...deltas: object[]): Response =>
  streamed([...deltas.map((delta) => ({ id: "r", choices: [{ index: 0, delta }] })), { id: "r", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);

/** The chat's models over a stand-in AI binding that answers with `answers`, in turn, and keeps each request body. */
function chat(...answers: (() => Response)[]) {
  const requests: { url: string; body: any }[] = [];
  const binding = {
    async fetch(url: string, init?: RequestInit) {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return answers.shift()!();
    },
  };
  const gemini = new GeminiCompat();
  const ai = createAI({ binding: gemini.binding(binding) as never, gateway: "gw" });
  const models = createModels();
  for (const provider of listedProviders(ai.provider, () => catalog)) models.setProvider(provider);
  return { models: gemini.models(withEffortRecorded(models)), model: catalog.model(GEMINI)!, requests };
}

const user: Message = { role: "user", content: "look it up", timestamp: 1 };
const resultOf = (call: string): Message => ({
  role: "toolResult",
  toolCallId: call,
  toolName: "lookup",
  content: [{ type: "text", text: "found" }],
  isError: false,
  timestamp: 3,
});
const toolCalls = (body: any) => body.messages.filter((message: any) => message.role === "assistant").flatMap((message: any) => message.tool_calls);

describe("Gemini's thought signatures", () => {
  it("keeps a tool call's signature in the reply and sends it back with the next request", async () => {
    const { models, model, requests } = chat(
      () => callingAnswer("call-1", "SIG-A"),
      () => callingAnswer("call-2", "SIG-B"),
    );
    const reply = await models.streamSimple(model, { messages: [user] }, { reasoning: "medium" }).result();
    expect(requests[0].url).toMatch(/\/google-ai-studio\/v1beta\/openai\/chat\/completions$/);
    expect(reply.stopReason).toBe("toolUse");
    expect(reply.content).toMatchObject([{ type: "toolCall", id: "call-1", thoughtSignature: "SIG-A" }]);

    // pi stores the reply as JSON, and sends it back after the tool's result.
    const stored = JSON.parse(JSON.stringify(reply)) as AssistantMessage;
    const context: Context = { messages: [user, stored, resultOf("call-1")] };
    // Read event by event this time, as pi's agent loop does.
    const events = [];
    for await (const event of models.streamSimple(model, context, { reasoning: "medium" })) events.push(event);
    expect(toolCalls(requests[1].body)).toMatchObject([{ id: "call-1", extra_content: { google: { thought_signature: "SIG-A" } } }]);
    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.message.content).toMatchObject([{ id: "call-2", thoughtSignature: "SIG-B" }]);
  });

  it("keeps a signature sent in a later chunk than its call's id", async () => {
    const chunks = [
      {
        id: "r",
        choices: [
          { index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "" } }] } },
        ],
      },
      {
        id: "r",
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' }, extra_content: { google: { thought_signature: "SIG-A" } } }] } },
        ],
      },
      { id: "r", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const { models, model } = chat(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const reply = await models.streamSimple(model, { messages: [user] }).result();
    expect(reply.content).toMatchObject([{ type: "toolCall", id: "call-1", thoughtSignature: "SIG-A" }]);
  });

  it("gives a tool call another model made Google's placeholder", async () => {
    const { models, model, requests } = chat(() => callingAnswer("call-2", "SIG-B"));
    const other: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "toolu_1", name: "lookup", arguments: { q: "x" }, thoughtSignature: "theirs" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-5-5",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2,
    };
    await models.streamSimple(model, { messages: [user, other, resultOf("toolu_1")] }).result();
    expect(toolCalls(requests[0].body)).toMatchObject([{ extra_content: { google: { thought_signature: UNSIGNED } } }]);
  });

  it("shows Gemini's own error instead of the bare status", async () => {
    const error = [{ error: { code: 400, message: "Function call is missing a thought_signature in functionCall parts.", status: "INVALID_ARGUMENT" } }];
    const { models, model } = chat(() => Response.json(error, { status: 400 }));
    const reply = await models.streamSimple(model, { messages: [user] }).result();
    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toContain("missing a thought_signature");
  });

  it("leaves other models' requests and answers alone", async () => {
    const gemini = new GeminiCompat();
    const calls: string[] = [];
    const binding = gemini.binding({ fetch: async (url: string) => (calls.push(url), callingAnswer("call-1", "SIG-A")), run: () => "ran" });
    const response = await binding.fetch("https://workers-binding.ai/ai-gateway/gateways/gw/openai/v1/chat/completions");
    expect(await response.text()).toContain("SIG-A");
    expect(binding.run()).toBe("ran");
    expect(calls).toHaveLength(1);
  });

  it("signs only a step's first call when Gemini signed none (it signs one call per step)", () => {
    const payload = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
        { role: "assistant", tool_calls: [{ id: "c" }, { id: "d" }] },
      ],
    };
    sign(payload, new Map([["c", "SIG-C"]]));
    expect(payload.messages.map((message) => message.tool_calls.map((call: any) => call.extra_content?.google.thought_signature))).toEqual([
      [UNSIGNED, undefined],
      ["SIG-C", undefined],
    ]);
  });
});

describe("Gemini's thought summaries", () => {
  const thought = (content: string) => ({ content, extra_content: { google: { thought: true } } });

  it("asks for them, with the effort in thinking_config instead of reasoning_effort", async () => {
    const { models, model, requests } = chat(() => answerOf({ content: "hi" }));
    await models.streamSimple(model, { messages: [user] }, { reasoning: "high" }).result();
    expect(requests[0].body.reasoning_effort).toBeUndefined();
    expect(requests[0].body.extra_body).toEqual({ google: { thinking_config: { thinking_budget: 24_576, include_thoughts: true } } });
  });

  it("gives Gemini 3 a thinking level, and an alias that may name Gemini 2.5 a budget", () => {
    const pro = { reasoning_effort: "low" };
    showThoughts(pro, "gemini-3-pro-preview");
    expect(pro).toEqual({ extra_body: { google: { thinking_config: { thinking_level: "low", include_thoughts: true } } } });
    const alias = { reasoning_effort: "low" };
    showThoughts(alias, "gemini-flash-latest");
    expect(alias).toEqual({ extra_body: { google: { thinking_config: { thinking_budget: 1_024, include_thoughts: true } } } });
  });

  it("gives Gemini 2.5 a thinking budget, and leaves a request without an effort it maps alone", () => {
    const flash = { model: "gemini-2.5-flash", reasoning_effort: "medium", messages: [] };
    showThoughts(flash, "gemini-2.5-flash");
    expect(flash).toEqual({
      model: "gemini-2.5-flash",
      messages: [],
      extra_body: { google: { thinking_config: { thinking_budget: 8_192, include_thoughts: true } } },
    });
    const off = { reasoning_effort: "none" };
    showThoughts(off, "gemini-2.5-flash");
    expect(off).toEqual({ reasoning_effort: "none" });
    const plain = { messages: [] };
    showThoughts(plain, "gemini-2.0-flash");
    expect(plain).toEqual({ messages: [] });
  });

  it("shows flagged summaries as thinking, not as the reply's text", async () => {
    const { models, model } = chat(() => answerOf(thought("**Planning**\n\nI will "), thought("look it up."), { content: "Here it is." }));
    const reply = await models.streamSimple(model, { messages: [user] }, { reasoning: "high" }).result();
    expect(reply.stopReason).toBe("stop");
    expect(reply.content).toMatchObject([
      { type: "thinking", thinking: "**Planning**\n\nI will look it up." },
      { type: "text", text: "Here it is." },
    ]);
  });

  it("reads summaries in <thought> tags that close in a later chunk, or that the network split", async () => {
    const { models, model } = chat(() =>
      answerOf({ content: "<thought>Weighing " }, { content: "it" }, { content: " up.</thought>Done." }, { content: " <thought> stays text" }),
    );
    const reply = await models.streamSimple(model, { messages: [user] }, { reasoning: "low" }).result();
    expect(reply.content).toMatchObject([
      { type: "thinking", thinking: "Weighing it up." },
      { type: "text", text: "Done. <thought> stays text" },
    ]);
    const split = chat(() => answerOf({ content: "<tho" }, { content: "ught>Hmm.</th" }, { content: "ought>Yes." }));
    const told = await split.models.streamSimple(split.model, { messages: [user] }, { reasoning: "low" }).result();
    expect(told.content).toMatchObject([
      { type: "thinking", thinking: "Hmm." },
      { type: "text", text: "Yes." },
    ]);
    const tagLike = chat(() => answerOf({ content: "<t" }, { content: "able>" }));
    const table = await tagLike.models.streamSimple(tagLike.model, { messages: [user] }, { reasoning: "low" }).result();
    expect(table.content).toMatchObject([{ type: "text", text: "<table>" }]);
    const later = chat(() => answerOf({ content: "Hi. " }, { content: "<thought>x</thought>" }));
    const said = await later.models.streamSimple(later.model, { messages: [user] }, { reasoning: "low" }).result();
    expect(said.content).toMatchObject([{ type: "text", text: "Hi. <thought>x</thought>" }]);
  });

  it("does not send them back to Gemini", async () => {
    const { models, model, requests } = chat(
      () => answerOf(thought("Thinking."), { content: "Hello." }),
      () => answerOf({ content: "Again." }),
    );
    const reply = await models.streamSimple(model, { messages: [user] }, { reasoning: "high" }).result();
    const context: Context = { messages: [user, reply, { role: "user", content: "and?", timestamp: 4 }] };
    await models.streamSimple(model, context, { reasoning: "high" }).result();
    const assistant = requests[1].body.messages.find((message: any) => message.role === "assistant");
    expect(assistant).toMatchObject({ content: "Hello." });
    expect(assistant.reasoning_content).toBeUndefined();
  });
});
