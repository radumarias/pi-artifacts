import { createModels } from "@earendil-works/pi-ai/models";
import { createServer, type Server } from "node:http";
import { text } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localModel, localModels, localProvider } from "../worker/local-models.ts";
import { checkModelChoice, modelCatalog, modelSources, offlineModelChoice } from "../worker/models.ts";
import { listen } from "./fakes.ts";

// A stand-in for LM Studio, Ollama or llama.cpp's server: the OpenAI-compatible routes the Worker uses.
let server: Server;
let url: string;
const requests: { path: string; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const body = request.method === "POST" ? JSON.parse(await text(request)) : {};
    requests.push({ path: request.url ?? "", body });
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        object: "list",
        data: [
          { id: "qwen/qwen3-32b", object: "model", max_context_length: 32768 },
          { id: "gemma-4-26b", object: "model" },
          { id: "text-embedding-nomic-embed-text-v1.5", object: "model" },
        ],
      }));
      return;
    }
    if (request.url === "/v1/chat/completions") {
      response.setHeader("content-type", "text/event-stream");
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.end(`${chunk({ role: "assistant", content: "Hello " }, null)}${chunk({ content: "there" }, "stop")}data: [DONE]\n\n`);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  url = `${await listen(server)}/v1`;
});

afterAll(() => server.close());

describe("local runtime models", () => {
  it("lists the runtime's chat models, leaving out embedding models, with the context length it reports", async () => {
    const models = await localModels(url);
    expect(models.map((model) => model.id)).toEqual(["qwen/qwen3-32b", "gemma-4-26b"]);
    expect(models[0]).toMatchObject({ provider: "local", baseUrl: url, contextWindow: 32768, maxTokens: 16384, reasoning: false });
    expect(models[1]?.contextWindow).toBe(128_000);
  });

  it("lists none, without failing, when the runtime does not answer", async () => {
    expect(await localModels("http://127.0.0.1:9/v1")).toEqual([]);
  });

  it("puts them first in the picker as local/<id>, in the runtime's order, with no efforts, and the cloud's after them", async () => {
    const catalog = modelCatalog(await modelSources({ LOCAL_MODELS_URL: url, CLOUD_MODELS: "true" }));
    expect(catalog.slice(0, 2)).toEqual([
      { id: "local/qwen/qwen3-32b", name: "qwen/qwen3-32b", vendor: "local", efforts: [], images: false },
      { id: "local/gemma-4-26b", name: "gemma-4-26b", vendor: "local", efforts: [], images: false },
    ]);
    expect(catalog.some((model) => model.id === "anthropic/claude-opus-5.5")).toBe(true);
  });

  it("lists only the local models without the cloud's, and starts new chats on the first of them", async () => {
    const sources = await modelSources({ LOCAL_MODELS_URL: url, CLOUD_MODELS: "false" });
    expect(modelCatalog(sources).map((model) => model.vendor)).toEqual(["local", "local"]);
    expect(checkModelChoice({ model: "anthropic/claude-opus-5.5" }, sources)).toBeNull();
    expect(checkModelChoice({ model: "local/qwen/qwen3-32b", thinkingLevel: "high" }, sources)).toEqual({ model: "local/qwen/qwen3-32b", thinkingLevel: "off" });
    expect(offlineModelChoice("anthropic/claude-opus-5.5", sources)).toEqual({ model: "local/qwen/qwen3-32b", thinkingLevel: "off" });
    expect(offlineModelChoice("local/gemma-4-26b", sources)).toBeNull();
    expect(offlineModelChoice("anthropic/claude-opus-5.5", { ...sources, cloud: true })).toBeNull();
  });

  it("runs a model through chat completions, without OpenAI's developer role or store, and with a stand-in key", async () => {
    const models = createModels();
    const model = localModel(url, "qwen/qwen3-32b");
    models.setProvider(localProvider(url, [model]));
    expect(models.getModel("local", "qwen/qwen3-32b")).toBeDefined();
    const reply = await models.completeSimple(model, { systemPrompt: "Be brief.", messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] });
    expect(reply.errorMessage).toBeUndefined();
    expect(reply.content).toEqual([{ type: "text", text: "Hello there" }]);
    const sent = requests.findLast((request) => request.path === "/v1/chat/completions")!.body;
    expect(sent.model).toBe("qwen/qwen3-32b");
    expect(sent.store).toBeUndefined();
    expect((sent.messages as { role: string }[])[0]?.role).toBe("system");
    expect(sent.max_completion_tokens).toBeUndefined();
  });
});
