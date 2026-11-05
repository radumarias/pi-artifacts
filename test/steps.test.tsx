import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inputSections, liveStatus, shortOutput, stepHint, stepLabel, stepResults, StepsProvider, stepsLive, thoughtLine, ThoughtStep, ToolStep } from "../src/chat/Steps.tsx";
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
    expect(inputSections("coingecko__get_price", { ids: "bitcoin" })).toEqual([{ label: "Input", text: '{\n  "ids": "bitcoin"\n}' }]);
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
    expect(html).toContain('<span class="step-status">Done · 1.3 s</span></summary>');
  });

  it("spins the thinking indicator's spark while the step runs", () => {
    const html = render("open", [slot("running")], true);
    expect(html).toMatch(/^<details class="step active">/);
    expect(html).toContain('<svg class="thinking-spark"');
    expect(html).toContain('<span class="step-status">Running…</span>');
  });

  it("counts how long a running step has run, from its first whole second", () => {
    const since = (ms: number) => render("open", [{ ...slot("running"), startedAt: Date.now() - ms }], true);
    expect(since(47_400)).toContain('<span class="step-status">Running…<span class="step-time"> 47s</span></span>');
    expect(since(125_000)).toContain('<span class="step-time"> 2m 5s</span>');
    // A quick call never flashes "0s".
    expect(since(300)).toContain('<span class="step-status">Running…</span>');
  });

  it("marks a failed step, and one that stopped", () => {
    expect(render("bad")).toMatch(/^<details class="step error"><summary class="step-line"><span class="step-icon">✕<\/span>/);
    expect(render("open")).toMatch(/^<details class="step"><summary class="step-line"><span class="step-icon">■<\/span>/);
  });

  it("says a call without arguments and with a one-line output on its line, with nothing to open", () => {
    const html = render("short", [], false, "files_list", {});
    expect(html).toMatch(/^<div class="step done static"><div class="step-line">/);
    expect(html).toContain('<span class="step-hint">2 files</span><span class="step-status">Done · 40 ms</span>');
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
