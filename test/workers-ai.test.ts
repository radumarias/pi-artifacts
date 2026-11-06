import { describe, expect, it } from "vitest";
import { bindingClassifierOptions, classifierOutput } from "../worker/agent/workers-ai.ts";

const output = { model: "jev-1.14.0", answers: { meant: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10 } };

describe("a classifier's answer from the AI binding", () => {
  it("is read alone, in the REST API's envelope, in a run record, or both", () => {
    expect(classifierOutput(output)).toBe(output);
    expect(classifierOutput({ success: true, result: output })).toBe(output);
    expect(classifierOutput({ state: "Completed", result: output })).toBe(output);
    expect(classifierOutput({ success: true, result: { state: "Completed", result: output } })).toBe(output);
    expect(classifierOutput({ result: output })).toBe(output);
  });

  it("fails on an error, a run not done, or no output, naming the answer's keys but not its values", () => {
    expect(() => classifierOutput({ success: false, errors: [{ message: "no access" }] })).toThrow(/Workers AI error: .*no access/);
    expect(() => classifierOutput({ success: true, result: { state: "Queued", id: "r1" } })).toThrow("did not complete (state: Queued)");
    expect(() => classifierOutput({ response: "secret text", tokens: [1] })).toThrow("no classifier output: {response: string, tokens: array}");
    expect(() => classifierOutput("text")).toThrow("no classifier output: string");
  });

  it("goes back to pi-ai in the REST API's envelope, also from a Response or JSON text", async () => {
    for (const answer of [output, Response.json({ success: true, result: output }), JSON.stringify(output)]) {
      const { fetch } = bindingClassifierOptions({ run: async () => answer });
      const response = await fetch!("https://api.cloudflare.com/run", { method: "POST", body: JSON.stringify({ model: "typesafe/jev", input: {} }) });
      expect(await response.json()).toEqual({ success: true, result: output });
    }
  });
});
