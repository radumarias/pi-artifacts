import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAI } from "agents/models/pi-ai";
import { catalogFrom, listedProviders, withEffortRecorded } from "../worker/models.ts";
import { sign, ThoughtSignatures, UNSIGNED } from "../worker/thought-signatures.ts";

const GEMINI = "google-ai-studio/gemini-test";
const catalog = catalogFrom({ checkedAt: 1, providers: { "google-ai-studio": { status: "ok", models: [{ id: "gemini-test", reasoning: true }] } } });

/** Gemini's streamed answer that calls `tool`, its signature on the call (as its OpenAI-compatible API sends it). */
function callingAnswer(id: string, signature: string | undefined): Response {
  const call = {
    index: 0,
    id,
    type: "function",
    function: { name: "lookup", arguments: '{"q":"x"}' },
    ...(signature && { extra_content: { google: { thought_signature: signature } } }),
  };
  const chunks = [
    { id: "r", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] } }] },
    { id: "r", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  // Split mid-event, as the network may.
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 40));
      controller.enqueue(bytes.slice(40));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** The chat's models over a stand-in AI binding that answers with `answers`, in turn, and keeps each request body. */
function chat(...answers: (() => Response)[]) {
  const requests: { url: string; body: any }[] = [];
  const binding = {
    async fetch(url: string, init?: RequestInit) {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return answers.shift()!();
    },
  };
  const signatures = new ThoughtSignatures();
  const ai = createAI({ binding: signatures.binding(binding) as never, gateway: "gw" });
  const models = createModels();
  for (const provider of listedProviders(ai.provider, () => catalog)) models.setProvider(provider);
  return { models: signatures.models(withEffortRecorded(models)), model: catalog.model(GEMINI)!, requests };
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
    const signatures = new ThoughtSignatures();
    const calls: string[] = [];
    const binding = signatures.binding({ fetch: async (url: string) => (calls.push(url), callingAnswer("call-1", "SIG-A")), run: () => "ran" });
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
