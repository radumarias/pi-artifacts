import { describe, expect, it } from "vitest";
import { bindingClassifierOptions, restEnvelope } from "../worker/agent/workers-ai.ts";

const output = { model: "jev-1.14.0", answers: { meant: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10 } };

describe("a classifier's answer from the AI binding", () => {
  it("goes to pi-ai in the REST API's envelope, unless it already is in one", () => {
    expect(restEnvelope(output)).toEqual({ success: true, result: output });
    const run = { state: "Completed", result: output };
    expect(restEnvelope(run)).toEqual({ success: true, result: run });
    const enveloped = { success: true, result: run };
    expect(restEnvelope(enveloped)).toBe(enveloped);
    const failed = { success: false, errors: [{ message: "no access" }] };
    expect(restEnvelope(failed)).toBe(failed);
  });

  it("fails on an answer with no output, naming its keys but not its values", () => {
    expect(() => restEnvelope({ response: "secret text", tokens: [1] })).toThrow("no classifier output: {response: string, tokens: array}");
    expect(() => restEnvelope({ success: true, result: { id: "r1" } })).toThrow("no classifier output: {success: boolean, result: {id: string}}");
    expect(() => restEnvelope("text")).toThrow("no classifier output: string");
  });

  it("is read from a Response or a stream too", async () => {
    for (const answer of [output, Response.json(output), new Response(JSON.stringify(output)).body]) {
      const { fetch } = bindingClassifierOptions({ run: async () => answer });
      const response = await fetch!("https://api.cloudflare.com/run", { method: "POST", body: JSON.stringify({ model: "typesafe/jev", input: {} }) });
      expect(await response.json()).toEqual({ success: true, result: output });
    }
  });

  it("hands a failed Response to pi-ai as it is", async () => {
    const failed = new Response("upstream down", { status: 503 });
    const { fetch } = bindingClassifierOptions({ run: async () => failed });
    expect(await fetch!("https://api.cloudflare.com/run", { method: "POST", body: JSON.stringify({ model: "typesafe/jev", input: {} }) })).toBe(failed);
  });
});
