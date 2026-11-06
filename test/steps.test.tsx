import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inputSections, liveStatus, shortOutput, stepHint, stepLabel, stepResults, StepRun, StepsProvider, stepsLive, thoughtLine, ThoughtStep, tookFor, ToolStep } from "../src/chat/Steps.tsx";
import { runSummary, stepRuns, streamingSteps, type StepItem } from "../src/chat/stepRuns.ts";
import type { RunningTool } from "../src/chat/useChat.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const entries = [
  { id: "1", kind: "pi.assistant", model: [{ role: "assistant", content: [call("ok", "run_python", { code: "print(1)" }), call("bad", "run_bash", { script: "false" }), call("open", "files_list", {})] }] },
  { id: "2", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "ok", toolName: "run_python", content: [{ type: "text", text: "exit code 0" }], isError: false, durationMs: 1_250 }] },
  { id: "3", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "bad", toolName: "run_bash", content: [{ type: "text", text: "exit code 1" }], isError: true }] },
  { id: "4", kind: "pi.assistant", model: [{ role: "assistant", content: [call("short", "files_list", {}), call("long", "files_list", {})] }] },
  { id: "5", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "short", toolName: "files_list", content: [{ type: "text", text: "2 files" }], isError: false, durationMs: 40 }] },
  { id: "6", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "long", toolName: "files_list", content: [{ type: "text", text: "a.csv\nb.csv" }], isError: false, durationMs: 40 }] },
] as never;
const slot = (status: RunningTool["status"]): RunningTool => ({ toolCallId: "open", toolName: "files_list", output: "", status });

describe("step status", () => {
  it("follows a call without a result from written to ended", () => {
    expect(liveStatus(stepsLive([], true), "open", true)).toBe("writing");
    expect(liveStatus(stepsLive([], true, new Set(["open"])), "open", false)).toBe("starting");
    // A call of an earlier round that never got a result, while a later run goes on.
    expect(liveStatus(stepsLive([], true), "open", false)).toBe("stopped");
    expect(liveStatus(stepsLive([slot("pending")], true), "open", false)).toBe("starting");
    expect(liveStatus(stepsLive([slot("running")], true), "open", false)).toBe("running");
    // Ended without a result while the run goes on (the tool faulted), or the run ended first.
    expect(liveStatus(stepsLive([slot("stopped")], true), "open", false)).toBe("stopped");
    expect(liveStatus(stepsLive([], false), "open", false)).toBe("stopped");
  });

  it("knows which results have their call in the chat", () => {
    const { calls, results } = stepResults(entries);
    expect([...calls]).toEqual(["ok", "bad", "open", "short", "long"]);
    expect([...results.keys()]).toEqual(["ok", "bad", "short", "long"]);
  });
});

describe("step header", () => {
  it("names built-in tools by what they do, and MCP tools by server and tool", () => {
    expect(stepLabel("run_python")).toBe("Python");
    expect(stepLabel("coingecko__get_price")).toBe("coingecko › get_price");
    expect(stepLabel("reports_beta___run")).toBe("reports_beta_ › run");
    expect(stepLabel("something_new")).toBe("something_new");
  });

  it("hints with the first telling line of the first text argument, else the arguments", () => {
    expect(stepHint("run_python", { code: "\n# Load the sales\nimport pandas" })).toBe("# Load the sales");
    expect(stepHint("run_python", { script: "#!/bin/bash\nset -euo pipefail\nwc -l files/sales.csv" })).toBe("wc -l files/sales.csv");
    expect(stepHint("run_python", { script: "set -e" })).toBe("set -e");
    expect(stepHint("run_python", { ids: ["bitcoin"], days: 7 })).toBe('{"ids":["bitcoin"],"days":7}');
    expect(stepHint("run_python", undefined)).toBe("");
    // A page check's hint is how it checks; a write's, what it writes.
    expect(stepHint("artifact_check", { html: "<!doctype html>", tests: [{}, {}], viewport: "mobile" })).toBe("Mobile · 2 tests");
    expect(stepHint("artifact_check", { draft_id: "0123456789abcdef" })).toBe("Desktop");
    expect(stepHint("artifact_write", { html: "<!doctype html>" })).toBe("New page · 15 B");
    expect(stepHint("artifact_write", { draft_id: "0123456789abcdef", edits: [{}, {}] })).toBe("2 edits to draft");
    expect(stepHint("artifact_write", { artifact_id: "a1", edits: [{}] })).toBe("1 edit to published page");
  });
});

describe("step input", () => {
  it("shows code in its own block and the other arguments as JSON", () => {
    expect(inputSections("run_python", { code: "import pandas\nprint(1)", files: ["sales.csv"] })).toEqual([
      { label: "Python", text: "import pandas\nprint(1)" },
      { label: "Arguments", text: '{\n  "files": [\n    "sales.csv"\n  ]\n}' },
    ]);
    expect(inputSections("coingecko__get_price", { ids: "bitcoin" })).toEqual([{ label: "Request", text: '{\n  "ids": "bitcoin"\n}' }]);
    expect(inputSections("mcp_discover", {})).toEqual([]);
  });
});

describe("step panel", () => {
  const render = (id: string, tools: RunningTool[] = [], busy = false, name = "run_python", args: Record<string, unknown> = { code: "print(1)" }) =>
    renderToStaticMarkup(
      <StepsProvider entries={entries} tools={tools} busy={busy}>
        <ToolStep call={call(id, name, args) as never} />
      </StepsProvider>,
    );

  it("starts collapsed, with the name, a hint, the status and how long it took", () => {
    const html = render("ok");
    expect(html).toMatch(/^<details class="step done">/);
    expect(html).not.toContain("step-body");
    expect(html).toContain('<summary class="step-line"><span class="step-icon">✓</span><span class="step-label">Python</span><span class="step-hint">print(1)</span><svg class="step-chevron"');
    expect(html).toContain('<span class="step-status">Done · 1.3s</span></summary>');
  });

  it("spins the thinking indicator's spark while the step runs", () => {
    const html = render("open", [slot("running")], true);
    expect(html).toMatch(/^<details class="step active">/);
    expect(html).toContain('<svg class="thinking-spark"');
    expect(html).toContain('<span class="step-status">Running…</span>');
  });

  it("counts how long a running step has run, from its first whole second", () => {
    const since = (ms: number) => render("open", [{ ...slot("running"), startedAt: Date.now() - ms }], true);
    expect(since(47_400)).toContain('<span class="step-status">Running…</span><span class="step-time">47s</span>');
    expect(since(125_000)).toContain('<span class="step-time">2m 5s</span>');
    // A quick call never flashes "0s".
    expect(since(300)).not.toContain("step-time");
  });

  it("says how long a finished step took the way its count read, finer under ten seconds", () => {
    expect([40, 1_250, 9_960, 47_400, 125_000].map(tookFor)).toEqual(["40ms", "1.3s", "10s", "47s", "2m 5s"]);
  });

  it("marks a failed step, and one that stopped", () => {
    expect(render("bad")).toMatch(/^<details class="step error"><summary class="step-line"><span class="step-icon">✕<\/span>/);
    expect(render("open")).toMatch(/^<details class="step"><summary class="step-line"><span class="step-icon">■<\/span>/);
  });

  it("says a call without arguments and with a one-line output on its line, with nothing to open", () => {
    const html = render("short", [], false, "files_list", {});
    expect(html).toMatch(/^<div class="step done static"><div class="step-line">/);
    expect(html).toContain('<span class="step-hint">2 files</span><span class="step-status">Done · 40ms</span>');
    expect(html).not.toContain("step-chevron");
    expect(render("long", [], false, "files_list", {})).toMatch(/^<details class="step done">/);
    // Stopped before any output: the status says it all.
    expect(render("open", [], false, "files_list", {})).toMatch(/^<div class="step static">/);
  });
});

describe("thought step", () => {
  const render = (text: string) => renderToStaticMarkup(<ThoughtStep openKey="t" text={text} />);

  it("shows a short thought whole, on a line with nothing to open", () => {
    expect(thoughtLine("  The base query\nworks.  ")).toEqual({ line: "The base query works.", whole: true });
    const html = render("The base query works.");
    expect(html).toMatch(/^<div class="step static">/);
    expect(html).toContain('<span class="step-hint prose">The base query works.</span>');
    expect(html).not.toContain("step-chevron");
  });

  it("opens a longer thought, its line the first sentence", () => {
    const long = `Base works, about 4k rows. ${"Then more detail. ".repeat(20)}`;
    expect(thoughtLine(long)).toEqual({ line: "Base works, about 4k rows.", whole: false });
    // An ellipsis is no sentence end, and neither is a stop after a word or two.
    expect(thoughtLine(`SELECT ... FROM base. Ok. ${long}`).line).toBe("SELECT ... FROM base.");
    expect(thoughtLine(`Ok. Then the base works. ${long}`).line).toBe("Ok. Then the base works.");
    // No sentence end within the short length: the head, cut by the line.
    expect(thoughtLine("x".repeat(300)).line).toBe("x".repeat(200));
    const html = render(long);
    expect(html).toMatch(/^<details class="step">/);
    expect(html).toContain('<span class="step-hint prose">Base works, about 4k rows.</span><svg class="step-chevron"');
  });

  it("takes an output as short only when it is one line", () => {
    expect(shortOutput(" 2 files \n")).toBe("2 files");
    expect(shortOutput(" ")).toBe("");
    expect(shortOutput("a\nb")).toBeUndefined();
    expect(shortOutput("x".repeat(201))).toBeUndefined();
  });
});

describe("runs of steps", () => {
  const assistant = (id: number, content: unknown[], timestamp = id) => ({ id, kind: "pi.assistant", model: [{ role: "assistant", timestamp, content }] });
  const result = (id: number, callId: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolCallId: callId, toolName: "run_bash", content: [], isError: false, ...extra }],
  });
  const thought = (thinking: string) => ({ type: "thinking", thinking });
  const text = (value: string) => ({ type: "text", text: value });
  const keys = (items: readonly StepItem[] | null | undefined) => items?.map((item) => item.key);

  it("joins the steps of a reply's messages until something shows between them", () => {
    const chat = [
      { id: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
      assistant(2, [thought("Look first."), call("a", "juyo__run_query", {})]),
      result(3, "a"),
      // Not shown: an aside does not end the run.
      { id: 4, kind: "chat.aside", data: {} },
      assistant(5, [call("b", "run_bash", { script: "ls" })]),
      result(6, "b"),
      assistant(7, [text("Found it."), call("c", "run_bash", {})]),
      result(8, "c"),
      assistant(9, [call("d", "run_bash", {})]),
    ] as never;
    const runs = stepRuns(chat);
    expect(keys(runs.byEntry.get(2)?.get(0))).toEqual(["2:0", "a", "b"]);
    expect(runs.byEntry.get(2)?.get(1)).toBeNull();
    expect(runs.byEntry.get(5)?.get(0)).toBeNull();
    // Text ends a run; the next starts at its next step, and is still open.
    expect(runs.byEntry.get(7)?.has(0)).toBe(false);
    expect(keys(runs.byEntry.get(7)?.get(1))).toEqual(["c", "d"]);
    expect(runs.open).toMatchObject({ entry: 7, index: 1 });
    // The same places again are the same objects: a message whose steps did not change is not drawn again.
    const again = stepRuns(chat, runs);
    expect(again.byEntry.get(2)).toBe(runs.byEntry.get(2));
  });

  it("ends a run at a published artifact's card, a message, and a stopped message", () => {
    const chat = [
      assistant(1, [call("p", "artifact_publish", {})]),
      result(2, "p", { toolName: "artifact_publish", details: { artifactId: "a1", version: 1 } }),
      assistant(3, [call("q", "run_bash", {})], 3),
      { id: 4, kind: "chat.message", data: { uid: "u", text: "and?" } },
      {
        ...assistant(5, [call("r", "run_bash", {})]),
        model: [{ role: "assistant", timestamp: 5, content: [call("r", "run_bash", {})], stopReason: "aborted" }],
      },
      assistant(6, [call("s", "run_bash", {})]),
    ] as never;
    const runs = stepRuns(chat);
    expect([1, 3, 5, 6].map((id) => keys(runs.byEntry.get(id)?.get(0)))).toEqual([["p"], ["q"], ["r"], ["s"]]);
  });

  it("joins a streaming reply's first steps to the run before it", () => {
    const chat = [assistant(1, [call("a", "run_bash", {})]), result(2, "a")] as never;
    const runs = stepRuns(chat);
    const streaming = { role: "assistant", timestamp: 3, content: [call("b", "run_bash", {}), text("Done."), call("c", "run_bash", {})] } as never;
    const { steps, grown } = streamingSteps(runs, streaming);
    expect(grown?.entry).toBe(1);
    expect(keys(grown?.steps.get(0))).toEqual(["a", "b"]);
    expect(grown?.steps.get(0)?.[1]).toMatchObject({ streaming: true });
    expect(steps.get(0)).toBeNull();
    expect(keys(steps.get(2))).toEqual(["c"]);
    // Text first: nothing joins.
    expect(streamingSteps(runs, { role: "assistant", timestamp: 3, content: [text("So"), call("b", "run_bash", {})] } as never).grown).toBeUndefined();
  });

  it("says what a run did in a line, by kind in the order they came", () => {
    const tool = (name: string, args: Record<string, unknown> = {}) =>
      ({ kind: "tool", key: name, call: call(name, name, args), streaming: false }) as StepItem;
    const thoughtItem = { kind: "thought", key: "t", text: "Hmm." } as StepItem;
    expect(
      runSummary([
        thoughtItem,
        tool("juyo__run_query"),
        tool("run_bash"),
        tool("juyo__list_hotels"),
        tool("run_bash"),
        tool("run_bash"),
        tool("juyo__describe"),
        tool("other__x"),
      ]),
    ).toBe("Queried juyo 3 times, ran 3 commands, queried other");
    expect(runSummary([tool("files_write"), tool("run_bash")])).toBe("Wrote a file, ran a command");
    expect(runSummary([tool("artifact_write", { html: "<p>" }), tool("artifact_check"), tool("artifact_write", { edits: [] }), tool("artifact_check")])).toBe(
      "Wrote a page, checked the page twice, edited the page",
    );
    expect(runSummary([tool("brand_new"), tool("brand_new")])).toBe("Used brand_new twice");
    expect(runSummary([thoughtItem, thoughtItem])).toBe("2 thoughts");
  });
});

describe("step run", () => {
  const items = (...ids: string[]) => ids.map((id) => ({ kind: "tool", key: id, call: call(id, "run_bash", { script: id }), streaming: false }) as StepItem);
  const render = (run: StepItem[], tools: RunningTool[] = [], busy = false) =>
    renderToStaticMarkup(
      <StepsProvider entries={entries} tools={tools} busy={busy}>
        <StepRun items={run} />
      </StepsProvider>,
    );

  it("is the step alone when it has one", () => {
    expect(render(items("ok"))).toMatch(
      /^<details class="step done"><summary class="step-line"><span class="step-icon">✓<\/span><span class="step-label">Bash<\/span>/,
    );
  });

  it("shows a summary line, how long it took and what failed, closed on its steps", () => {
    const html = render(items("ok", "short", "bad"));
    expect(html).toMatch(
      /^<details class="step step-run done"><summary class="step-line"><span class="step-icon">✓<\/span><span class="step-label">Ran 3 commands<\/span><svg class="step-chevron"/,
    );
    expect(html).toContain('<span class="step-status">Done · 1.3s</span><span class="step-time step-failed">· 1 failed</span>');
    expect(html).not.toContain("step-body");
  });

  it("spins while a step in it runs", () => {
    const html = render(items("ok", "open"), [{ ...slot("running"), startedAt: Date.now() - 5_000 }], true);
    expect(html).toMatch(/^<details class="step step-run active">/);
    expect(html).toContain('<span class="step-status">Running…</span><span class="step-time">5s</span>');
  });
});
