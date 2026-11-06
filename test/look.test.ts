import { describe, expect, it, vi } from "vitest";
import type { CheckReport } from "../worker/artifacts/check.ts";
import { describeReport } from "../worker/artifacts/check.ts";
import { PageLooks, pageLooks, type Look, type LookVerdict } from "../worker/artifacts/look.ts";
import type { ModelRunner } from "../worker/ai-binding.ts";

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
  return { looks: new PageLooks(look), seen };
}

describe("a look at the check's screenshot", () => {
  it("stops a page it is sure is blank, once: checked again unchanged, it is a warning", async () => {
    const { looks } = looking("blank", 0.93);
    const first = await looks.review("d1", report());
    expect(first.errors).toEqual([expect.stringMatching(/^The screenshot looks blank \(Jev, 93% sure\)\. Look at the screenshot.*check this draft again unchanged/)]);
    expect(first.look).toEqual({ by: "Jev", verdict: "blank", probability: 0.93 });
    const again = await looks.review("d1", report());
    expect(again.errors).toEqual([]);
    expect(again.warnings).toEqual(["The screenshot looks blank (Jev, 93% sure): look at the screenshot to be sure."]);
    // Another draft is stopped as the first was.
    expect((await looks.review("d2", report())).errors).toHaveLength(1);
  });

  it("only warns when unsure, or of a stuck or broken look; says nothing below even odds", async () => {
    expect(await looking("blank", 0.6).looks.review("d", report())).toMatchObject({ errors: [], warnings: [expect.stringContaining("looks blank (Jev, 60% sure)")] });
    expect(await looking("broken", 0.95).looks.review("d", report())).toMatchObject({ errors: [], warnings: [expect.stringContaining("looks broken")] });
    expect(await looking("loading", 0.95).looks.review("d", report())).toMatchObject({ errors: [], warnings: [expect.stringContaining("stuck loading")] });
    expect(await looking("error", 0.4).looks.review("d", report({ warnings: ["w"] }))).toMatchObject({ errors: [], warnings: ["w"] });
  });

  it("only warns of an error shown when a live call failed outside the page", async () => {
    const { looks } = looking("error", 0.97);
    expect((await looks.review("d", report())).errors).toHaveLength(1);
    const outside = await looks.review("e", report({ failedOutside: true }));
    expect(outside).toMatchObject({ errors: [], warnings: [expect.stringContaining("shows an error instead of content")] });
  });

  it("does not look at a check that found errors or has no screenshot", async () => {
    const { looks, seen } = looking("blank", 0.99);
    const failed = report({ errors: ["Uncaught TypeError"] });
    expect(await looks.review("d", failed)).toBe(failed);
    const unseen = report({ screenshot: "" });
    expect(await looks.review("d", unseen)).toBe(unseen);
    expect(seen).toEqual([]);
  });

  it("leaves the check as it was when the look fails or takes too long, and stops when the check is stopped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = new PageLooks(async () => {
      throw new Error("model not found");
    });
    const passed = report();
    expect(await failing.review("d", passed)).toBe(passed);
    expect(warn).toHaveBeenCalledWith("page look:", "model not found");
    const hung = new PageLooks((_shot, _text, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))), 20);
    expect(await hung.review("d", passed)).toBe(passed);
    const stopped = new AbortController();
    stopped.abort(new Error("stopped"));
    await expect(hung.review("d", passed, stopped.signal)).rejects.toThrow("stopped");
    warn.mockRestore();
  });

  it("tells the agent when it saw the page's content", async () => {
    const seen = await looking("content", 0.88).looks.review("d", report());
    expect(seen.errors).toEqual([]);
    expect(describeReport(seen)).toContain("Jev looked at the screenshot: it shows the page's content (88% sure).");
    expect(describeReport(report())).not.toContain("looked at the screenshot");
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
    const looks = pageLooks("typesafe/jev", ai)!;
    const reviewed = await looks.review("d", report({ screenshot: "AAAA", text: "Prices" }));
    expect(reviewed.look).toEqual({ by: "Jev", verdict: "blank", probability: 0.9 });
    expect(reviewed.errors).toHaveLength(1);
    expect(reviewed.usage?.input).toBe(2_000);
    expect(reviewed.usage?.cost.total).toBeGreaterThan(0);
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
    expect(await pageLooks("typesafe/jev", ai)!.review("d", passed)).toBe(passed);
    expect(warn).toHaveBeenCalledWith("page look:", expect.stringContaining("no verdict"));
    warn.mockRestore();
  });

  it("is named by CHECK_LOOK_MODEL: none when empty, and none, said in the log, for a model that is no System One model seeing images", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ai } = binding({});
    expect(pageLooks("", ai)).toBeUndefined();
    expect(pageLooks(undefined, ai)).toBeUndefined();
    expect(pageLooks(" typesafe/jev ", ai)).toBeInstanceOf(PageLooks);
    expect(pageLooks("@cf/openai/gpt-oss-120b", ai)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("@cf/openai/gpt-oss-120b is not a System One model"));
    warn.mockRestore();
  });
});
