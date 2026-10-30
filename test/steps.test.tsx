import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inputSections, liveStatus, stepHint, stepLabel, stepResults, StepsProvider, stepsLive, ToolStep } from "../src/chat/Steps.tsx";
import type { RunningTool } from "../src/chat/useChat.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const entries = [
  { id: "1", kind: "pi.assistant", model: [{ role: "assistant", content: [call("ok", "run_python", { code: "print(1)" }), call("bad", "run_bash", { script: "false" }), call("open", "files_list", {})] }] },
  { id: "2", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "ok", toolName: "run_python", content: [{ type: "text", text: "exit code 0" }], isError: false, durationMs: 1_250 }] },
  { id: "3", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "bad", toolName: "run_bash", content: [{ type: "text", text: "exit code 1" }], isError: true }] },
] as never;
const slot = (status: RunningTool["status"]): RunningTool => ({ toolCallId: "open", toolName: "files_list", output: "", status });

describe("step status", () => {
  it("follows a call without a result from written to ended", () => {
    expect(liveStatus(stepsLive([], true), "open", true)).toBe("writing");
    expect(liveStatus(stepsLive([], true), "open", false)).toBe("starting");
    expect(liveStatus(stepsLive([slot("pending")], true), "open", false)).toBe("starting");
    expect(liveStatus(stepsLive([slot("running")], true), "open", false)).toBe("running");
    // Ended without a result while the run goes on (the tool faulted), or the run ended first.
    expect(liveStatus(stepsLive([slot("stopped")], true), "open", false)).toBe("stopped");
    expect(liveStatus(stepsLive([], false), "open", false)).toBe("stopped");
  });

  it("knows which results have their call in the chat", () => {
    const { calls, results } = stepResults(entries);
    expect([...calls]).toEqual(["ok", "bad", "open"]);
    expect([...results.keys()]).toEqual(["ok", "bad"]);
  });
});

describe("step header", () => {
  it("names built-in tools by what they do, and MCP tools by server and tool", () => {
    expect(stepLabel("run_python")).toBe("Python");
    expect(stepLabel("coingecko__get_price")).toBe("coingecko › get_price");
    expect(stepLabel("something_new")).toBe("something_new");
  });

  it("hints with the first telling line of the first text argument, else the arguments", () => {
    expect(stepHint({ code: "\n# Load the sales\nimport pandas" })).toBe("# Load the sales");
    expect(stepHint({ script: "#!/bin/bash\nset -euo pipefail\nwc -l files/sales.csv" })).toBe("wc -l files/sales.csv");
    expect(stepHint({ script: "set -e" })).toBe("set -e");
    expect(stepHint({ ids: ["bitcoin"], days: 7 })).toBe('{"ids":["bitcoin"],"days":7}');
    expect(stepHint(undefined)).toBe("");
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
  const render = (id: string, tools: RunningTool[] = [], busy = false) =>
    renderToStaticMarkup(
      <StepsProvider entries={entries} tools={tools} busy={busy}>
        <ToolStep call={call(id, "run_python", { code: "print(1)" }) as never} />
      </StepsProvider>,
    );

  it("starts collapsed, with the name, a hint, the status and how long it took", () => {
    const html = render("ok");
    expect(html).toMatch(/^<details class="step done">/);
    expect(html).not.toContain("step-body");
    expect(html).toContain('<span class="step-label">Python</span><span class="step-hint">print(1)</span><span class="step-status">Done · 1.3 s</span>');
  });

  it("spins the thinking indicator's spark while the step runs", () => {
    const html = render("open", [slot("running")], true);
    expect(html).toMatch(/^<details class="step active">/);
    expect(html).toContain('<svg class="thinking-spark"');
    expect(html).toContain('<span class="step-status">Running…</span>');
  });

  it("marks a failed step, and one that stopped", () => {
    expect(render("bad")).toMatch(/^<details class="step error"><summary><span class="step-icon">✕<\/span>/);
    expect(render("open")).toMatch(/^<details class="step"><summary><span class="step-icon">■<\/span>/);
  });
});
