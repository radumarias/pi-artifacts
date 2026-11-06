import { describe, expect, it, vi } from "vitest";
import type { ModelRunner } from "../worker/agent/workers-ai.ts";
import { describeReport, type CheckReport } from "../worker/artifacts/check.ts";
import { lookFrom, reviewLook, type Look, type LookVerdict } from "../worker/artifacts/look.ts";

const report = (more: Partial<CheckReport> = {}): CheckReport => ({
  errors: [],
  warnings: [],
  calls: [],
  tests: [],
  text: "BTC 64,000",
  screenshot: "SHOT",
  thumb: "",
  width: 1280,
  height: 800,
  ...more,
});

/** A look that answers `verdict` this sure, and the screenshots it was shown. */
function looking(verdict: LookVerdict, probability: number) {
  const seen: string[] = [];
  const look: Look = async (screenshot) => {
    seen.push(screenshot);
    return { look: { by: "Jev", verdict, probability } };
  };
  return { look, seen, review: async (checked: CheckReport) => (await reviewLook(look, checked)).report };
}

describe("a look at the check's screenshot", () => {
  it("stops a page it is sure is blank, saying why for the draft to keep; stopped before, it is not asked again and warns", async () => {
    const { look, seen } = looking("blank", 0.93);
    const first = await reviewLook(look, report());
    expect(first.report.errors).toEqual([
      expect.stringMatching(/^The screenshot looks blank \(Jev, 93% sure\)\. Look at the screenshot.*check this draft again unchanged/),
    ]);
    expect(first.report.look).toEqual({ by: "Jev", verdict: "blank", probability: 0.93 });
    expect(first.stopped).toBe("The screenshot looks blank (Jev, 93% sure)");
    const again = await reviewLook(look, report(), { stoppedBefore: first.stopped });
    expect(again.report.errors).toEqual([]);
    expect(again.report.warnings).toEqual(["The screenshot looks blank (Jev, 93% sure), on its check before: look at the screenshot to be sure."]);
    expect(again.stopped).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("only warns when unsure, or of a stuck or broken look; says nothing below even odds", async () => {
    expect(await looking("blank", 0.6).review(report())).toMatchObject({ errors: [], warnings: [expect.stringContaining("looks blank (Jev, 60% sure)")] });
    expect(await looking("broken", 0.95).review(report())).toMatchObject({ errors: [], warnings: [expect.stringContaining("looks broken")] });
    expect(await looking("loading", 0.95).review(report())).toMatchObject({ errors: [], warnings: [expect.stringContaining("stuck loading")] });
    expect(await looking("error", 0.4).review(report({ warnings: ["w"] }))).toMatchObject({ errors: [], warnings: ["w"] });
  });

  it("only warns of an error shown when a live call failed outside the page", async () => {
    const { review } = looking("error", 0.97);
    expect((await review(report())).errors).toHaveLength(1);
    const outside = await review(report({ failedOutside: true }));
    expect(outside).toMatchObject({ errors: [], warnings: [expect.stringContaining("shows an error instead of content")] });
  });

  it("does not look at a check that found errors or has no screenshot", async () => {
    const { review, seen } = looking("blank", 0.99);
    const failed = report({ errors: ["Uncaught TypeError"] });
    expect(await review(failed)).toBe(failed);
    const unseen = report({ screenshot: "" });
    expect(await review(unseen)).toBe(unseen);
    expect(seen).toEqual([]);
  });

  it("leaves the check as it was when the look fails or takes too long, ending the call, and stops when the check is stopped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const passed = report();
    const failing = await reviewLook(async () => {
      throw new Error("model not found");
    }, passed);
    expect(failing.report).toBe(passed);
    expect(warn).toHaveBeenCalledWith("page look:", "model not found");
    const signals: AbortSignal[] = [];
    const hung: Look = (_shot, _text, signal) => (signals.push(signal), new Promise<never>(() => {}));
    expect((await reviewLook(hung, passed, { timeoutMs: 20 })).report).toBe(passed);
    expect(warn).toHaveBeenCalledWith("page look:", "no answer in 0.02 s");
    expect(signals[0].aborted).toBe(true);
    const stopped = new AbortController();
    stopped.abort(new Error("stopped"));
    await expect(reviewLook(hung, passed, { signal: stopped.signal })).rejects.toThrow("stopped");
    expect(signals[1].aborted).toBe(true);
    warn.mockRestore();
  });

  it("tells the agent when it saw the page's content", async () => {
    const seen = await looking("content", 0.88).review(report());
    expect(seen.errors).toEqual([]);
    expect(describeReport(seen)).toContain("Jev looked at the screenshot: it shows the page's content (88% sure).");
    expect(describeReport(report())).not.toContain("looked at the screenshot");
    expect(describeReport(await looking("content", 0.3).review(report()))).not.toContain("looked at the screenshot");
  });
});

describe("Jev on Workers AI", () => {
  /** A stand-in AI binding that answers `answer` in a third-party model's run record, and the runs it was asked for. */
  function binding(answer: object) {
    const runs: { model: string; input: Record<string, unknown>; signal?: AbortSignal }[] = [];
    const ai: ModelRunner = {
      run: async (model, input, options) => {
        runs.push({ model, input: input as Record<string, unknown>, signal: options?.signal });
        return { state: "Completed", result: { answers: { shows: answer }, usage: { input_tokens: 2_000 } } };
      },
    };
    return { ai, runs };
  }

  it("is shown the screenshot as a JPEG with the visible text, and its answer and spend come back", async () => {
    const { ai, runs } = binding({ type: "choice", choice: "blank", probabilities: { content: 0.05, blank: 0.9, error: 0.05 }, confidence: 0.9 });
    const { report: reviewed, usage } = await reviewLook(lookFrom("typesafe/jev", ai)!, report({ screenshot: "AAAA", text: "Prices" }));
    expect(reviewed.look).toEqual({ by: "Jev", verdict: "blank", probability: 0.9 });
    expect(reviewed.errors).toHaveLength(1);
    expect(usage?.input).toBe(2_000);
    expect(usage?.cost.total).toBeGreaterThan(0);
    expect(runs).toHaveLength(1);
    const [{ model, input, signal }] = runs;
    expect(model).toBe("typesafe/jev");
    expect(input.assets).toEqual({ "<image-1>": { type: "image", format: "jpeg", data_base64: "AAAA" } });
    expect(input.state).toEqual(["<image-1>", { visibleText: "Prices" }]);
    expect(Object.keys((input.questions as { shows: { criteria: object } }).shows.criteria)).toEqual(["content", "blank", "error", "loading", "broken"]);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("fails, so the check goes on without it, for an answer that is no verdict", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ai } = binding({ type: "choice", choice: "pretty", probabilities: { pretty: 1 }, confidence: 1 });
    const passed = report();
    const failed = await reviewLook(lookFrom("typesafe/jev", ai)!, passed);
    expect(failed.report).toBe(passed);
    // Billed all the same: its spend still counts.
    expect(failed.usage?.input).toBe(2_000);
    expect(warn).toHaveBeenCalledWith("page look:", expect.stringContaining("no verdict"));
    warn.mockRestore();
  });

  it("is named by CHECK_LOOK_MODEL: none when empty, and none, said in the log, for a model that is no System One model seeing images", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ai } = binding({});
    expect(lookFrom("", ai)).toBeUndefined();
    expect(lookFrom(undefined, ai)).toBeUndefined();
    expect(lookFrom(" typesafe/jev ", ai)).toBeTypeOf("function");
    expect(lookFrom("@cf/openai/gpt-oss-120b", ai)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("@cf/openai/gpt-oss-120b is not a System One model"));
    warn.mockRestore();
  });
});
