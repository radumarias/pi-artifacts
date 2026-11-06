import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { checkDraft, publishDraft, writeDraft, type PublishScope } from "../worker/agent/publish.ts";
import type { CheckReport } from "../worker/artifacts/check.ts";
import { findingsIn, MAX_FINDINGS, modelReviewer, numberedPage, withReview, type PageReview } from "../worker/artifacts/review.ts";
import type { McpHub } from "../worker/mcp/hub.ts";
import type { ArtifactStore } from "../worker/storage/artifacts.ts";
import { ChatDrafts } from "../worker/storage/drafts.ts";
import { FakeBucket } from "./fakes.ts";

const usage = {
  input: 1000,
  output: 200,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0005 },
};
const model = (id: string) => ({ id, api: "openai-completions", provider: "test", reasoning: false }) as unknown as Model<Api>;
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], usage, stopReason: "stop" }) as unknown as AssistantMessage;

const report = (errors: string[] = []): CheckReport => ({
  errors,
  warnings: [],
  calls: [],
  tests: [],
  text: "",
  screenshot: "",
  thumb: "",
  width: 1280,
  height: 800,
});

describe("numberedPage", () => {
  it("numbers each line, cuts a line of data, and leaves out the rest of a page too long to review", () => {
    expect(numberedPage("<p>\n</p>")).toBe("1| <p>\n2| </p>");
    const data = `const rows = ${JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ i })))};`;
    expect(numberedPage(data)).toMatch(/^1\| const rows = .{380,} …\(\d+ more characters\)$/);
    const long = Array.from({ length: 2_000 }, () => "x".repeat(300)).join("\n");
    const shown = numberedPage(long);
    expect(shown.length).toBeLessThan(70_000);
    expect(shown).toMatch(/left out: the page is too long to review whole\)$/);
  });
});

describe("findingsIn", () => {
  it("keeps the well-formed findings, the ones to fix first, at most MAX_FINDINGS", () => {
    const findings = findingsIn({
      findings: [
        { severity: "suggest", kind: "simplify", line: 3, problem: "Two render functions do the same.", fix: "Keep one." },
        { severity: "fix", kind: "security", line: 12, problem: "MCP text goes into innerHTML.", fix: "Use textContent." },
        { severity: "fix", kind: "made-up", problem: "  Throws when data is empty. ", line: 2.5 },
        { severity: "fix", problem: "" },
        "not a finding",
      ],
    });
    expect(findings).toEqual([
      { severity: "fix", kind: "security", line: 12, problem: "MCP text goes into innerHTML.", fix: "Use textContent." },
      { severity: "fix", kind: "bug", problem: "Throws when data is empty." },
      { severity: "suggest", kind: "simplify", line: 3, problem: "Two render functions do the same.", fix: "Keep one." },
    ]);
    expect(findingsIn([])).toEqual([]);
    expect(findingsIn({ findings: Array.from({ length: 20 }, () => ({ severity: "fix", kind: "bug", problem: "p" })) })).toHaveLength(MAX_FINDINGS);
    expect(() => findingsIn({ ok: true })).toThrow("no findings list");
  });
});

describe("withReview", () => {
  it("adds the findings to fix as errors and the suggestions as warnings", () => {
    const review: PageReview = {
      findings: [
        { severity: "fix", kind: "security", line: 12, problem: "MCP text goes into innerHTML.", fix: "Use textContent." },
        { severity: "suggest", kind: "performance", problem: "Re-renders the whole table every tick." },
      ],
      usage,
      ms: 10,
    };
    const reviewed = withReview(report(["TypeError"]), review);
    expect(reviewed.errors).toEqual(["TypeError", "Code review (security, line 12): MCP text goes into innerHTML. Fix: Use textContent."]);
    expect(reviewed.warnings).toEqual(["Code review suggestion (performance): Re-renders the whole table every tick."]);
    const none = report();
    expect(withReview(none, { findings: [], usage, ms: 1 })).toBe(none);
  });
});

describe("modelReviewer", () => {
  it("asks the next model when one fails, and says who answered and what both cost", async () => {
    const asked: string[] = [];
    let page = "";
    const models = {
      completeSimple: async (m: Model<Api>, context: { messages: { content: string }[] }) => {
        asked.push(m.id);
        page = context.messages[0].content;
        if (m.id === "first") return { ...reply(""), stopReason: "error", errorMessage: "down" } as AssistantMessage;
        return reply('{"findings": [{"severity": "fix", "kind": "bug", "line": 1, "problem": "Never renders."}]}');
      },
    };
    const review = await modelReviewer(models as never, [model("first"), model("second")])("<div id=app></div>");
    expect(asked).toEqual(["first", "second"]);
    expect(page).toBe("<page>\n1| <div id=app></div>\n</page>");
    expect(review).toMatchObject({ by: "test/second", findings: [{ severity: "fix", kind: "bug", line: 1, problem: "Never renders." }] });
    expect(review.usage.input).toBe(2000);
    expect(review.failed).toBeUndefined();
  });

  it("fails, without throwing, when no model answers in time or the answer has no findings", async () => {
    const slow = {
      completeSimple: (_m: Model<Api>, _c: unknown, options: { signal: AbortSignal }) =>
        new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    expect(await modelReviewer(slow as never, [model("a")], 50)("<p>")).toMatchObject({ findings: [], failed: "no answer in 0.05 s" });
    const odd = { completeSimple: async () => reply('{"verdict": "fine"}') };
    expect(await modelReviewer(odd as never, [model("a")])("<p>")).toMatchObject({ findings: [], failed: expect.stringContaining("no findings list") });
  });

  it("asks the next model when one answers without a findings list", async () => {
    const asked: string[] = [];
    const models = {
      completeSimple: async (m: Model<Api>) => (asked.push(m.id), reply(m.id === "first" ? '{"verdict": "fine"}' : '{"findings": []}')),
    };
    const review = await modelReviewer(models as never, [model("first"), model("second")])("<p>");
    expect(asked).toEqual(["first", "second"]);
    expect(review).toMatchObject({ by: "test/second", findings: [] });
    expect(review.failed).toBeUndefined();
    expect(review.usage.input).toBe(2000);
  });

  it("throws once the check is stopped", async () => {
    const stop = new AbortController();
    const models = {
      completeSimple: (_m: Model<Api>, _c: unknown, options: { signal: AbortSignal }) =>
        new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    const reviewing = modelReviewer(models as never, [model("a")])("<p>", stop.signal);
    stop.abort(new Error("Stopped."));
    await expect(reviewing).rejects.toThrow("Stopped.");
  });
});

describe("a check with a code review", () => {
  /** A chat whose browser finds nothing wrong and whose reviewer answers with `findings` for the page it reads. */
  function chat(review: (html: string) => Omit<PageReview, "usage" | "ms">) {
    const reviewed: string[] = [];
    const versions: string[] = [];
    const drafts = new ChatDrafts(new FakeBucket().r2, "ada", "0123456789abcdef", new ArrayBuffer(32));
    const scope: PublishScope = {
      uid: "ada",
      chatId: "0123456789abcdef",
      hub: { servers: () => [] } as unknown as McpHub,
      artifacts: {
        publishVersion: async (input: { title: string; html: string }) => (
          versions.push(input.html),
          { id: "a1", title: input.title, latest: versions.length, updatedAt: 0 }
        ),
      } as unknown as ArtifactStore,
      onPublished: async () => {},
      checkPage: async () => report(),
      chatArtifacts: async () => [],
      drafts: async () => drafts,
      skillSets: async () => new Map(),
      readSkillFile: async () => null,
      publishUnchecked: false,
      review: async () => async (html) => (reviewed.push(html), { ...review(html), usage, ms: 5 }),
    };
    return { scope, reviewed, versions, drafts };
  }
  const unsafe = "<div id=out></div><script>out.innerHTML = data.name</script>";
  const safe = "<div id=out></div><script>out.textContent = data.name</script>";
  const xss = { severity: "fix" as const, kind: "security" as const, line: 1, problem: "MCP text goes into innerHTML.", fix: "Use textContent." };

  it("stops a page the review found something to fix in; its fix is checked without another review and published", async () => {
    const { scope, reviewed, versions, drafts } = chat((html) => ({ findings: html.includes("innerHTML") ? [xss] : [] }));
    const first = await writeDraft(scope, { html: unsafe });
    const checked = await checkDraft(scope, first.id, {});
    expect(checked.report?.errors).toEqual([expect.stringContaining("Code review (security, line 1)")]);
    expect(checked.review?.findings).toEqual([xss]);
    expect(await drafts.get(first.id)).toMatchObject({ errors: 1, reviewed: true });
    await expect(publishDraft(scope, { title: "Out", draftId: first.id })).rejects.toThrow("found 1 error");

    const fixed = await writeDraft(scope, { draftId: first.id, edits: [{ old: "innerHTML", new: "textContent" }] });
    expect(fixed).toMatchObject({ html: safe, reviewed: true, errors: null });
    const again = await checkDraft(scope, fixed.id, {});
    expect(again).toMatchObject({ draft: { errors: 0 }, review: undefined });
    await publishDraft(scope, { title: "Out", draftId: fixed.id });
    expect(versions).toEqual([safe]);
    expect(reviewed).toEqual([unsafe]);
  });

  it("lets a draft the review stopped pass when it is checked again unchanged: the reviewer can be wrong", async () => {
    const { scope, reviewed } = chat(() => ({ findings: [xss] }));
    const { id } = await writeDraft(scope, { html: unsafe });
    expect((await checkDraft(scope, id, {})).draft.errors).toBe(1);
    expect((await checkDraft(scope, id, {})).draft.errors).toBe(0);
    expect(reviewed).toHaveLength(1);
  });

  it("reviews a new page, and a change to a published one, again; a suggestion is a warning only", async () => {
    const suggestion = { severity: "suggest" as const, kind: "simplify" as const, problem: "Two render functions do the same." };
    const { scope, reviewed } = chat(() => ({ findings: [suggestion] }));
    const one = await writeDraft(scope, { html: safe });
    expect((await checkDraft(scope, one.id, {})).draft).toMatchObject({ errors: 0, warnings: 1 });
    const two = await writeDraft(scope, { html: "<p>another page</p>" });
    await checkDraft(scope, two.id, {});
    expect(reviewed).toEqual([safe, "<p>another page</p>"]);
  });

  it("goes on without the review when it failed, and does not try it again for the page", async () => {
    const { scope, reviewed, drafts } = chat(() => ({ findings: [], failed: "no answer in 45 s" }));
    const { id } = await writeDraft(scope, { html: safe });
    const checked = await checkDraft(scope, id, {});
    expect(checked).toMatchObject({ draft: { errors: 0 }, review: { failed: "no answer in 45 s" } });
    expect(await drafts.get(id)).toMatchObject({ reviewed: true });
    await checkDraft(scope, id, {});
    expect(reviewed).toHaveLength(1);
  });

  it("publishes without a review where a page no browser checked is checked by its publish", async () => {
    const { scope, reviewed, versions } = chat(() => ({ findings: [xss] }));
    scope.publishUnchecked = true;
    const { id } = await writeDraft(scope, { html: unsafe });
    await publishDraft(scope, { title: "Out", draftId: id });
    expect(versions).toEqual([unsafe]);
    expect(reviewed).toEqual([]);
  });

  it("stops the review of a page no browser could check, and reviews it on its first check that runs", async () => {
    const { BrowserUnavailable } = await import("../worker/artifacts/browser.ts");
    const { scope, drafts } = chat(() => ({ findings: [xss] }));
    let stopped = false;
    let browser = false;
    scope.checkPage = async () => {
      if (!browser) throw new BrowserUnavailable("no browser");
      return report();
    };
    scope.review = async () => (_html, signal) =>
      new Promise((resolve, reject) => {
        if (browser) return resolve({ findings: [xss], usage, ms: 1 });
        signal?.addEventListener("abort", () => ((stopped = true), reject(new Error("stopped"))));
      });
    const { id } = await writeDraft(scope, { html: unsafe });
    expect(await checkDraft(scope, id, {})).toMatchObject({ unchecked: "no browser", review: undefined });
    expect(stopped).toBe(true);
    expect((await drafts.get(id))?.reviewed).toBeUndefined();
    browser = true;
    expect((await checkDraft(scope, id, {})).draft).toMatchObject({ errors: 1, reviewed: true });
  });

  it("checks without a review when the deployment has no reviewer", async () => {
    const { scope } = chat(() => ({ findings: [xss] }));
    scope.review = async () => undefined;
    const { id } = await writeDraft(scope, { html: unsafe });
    expect(await checkDraft(scope, id, {})).toMatchObject({ draft: { errors: 0 }, review: undefined });
  });
});
