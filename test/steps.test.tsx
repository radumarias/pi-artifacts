import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inputSections, stepHint, stepLabel, stepStatus, StepsContext, stepsView, ToolStep } from "../src/chat/Steps.tsx";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const entries = [
  { id: "1", kind: "pi.assistant", model: [{ role: "assistant", content: [call("ok", "run_python", { code: "print(1)" }), call("bad", "run_bash", { script: "false" }), call("open", "files_list", {})] }] },
  { id: "2", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "ok", toolName: "run_python", content: [{ type: "text", text: "exit code 0" }], isError: false, durationMs: 1_250 }] },
  { id: "3", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "bad", toolName: "run_bash", content: [{ type: "text", text: "exit code 1" }], isError: true }] },
] as never;

describe("step status", () => {
  it("follows the call from written to finished", () => {
    const running = stepsView(entries, [{ toolCallId: "open", toolName: "files_list", output: "" }], true, new Set());
    expect(stepStatus(running, "ok", false)).toBe("done");
    expect(stepStatus(running, "bad", false)).toBe("error");
    expect(stepStatus(running, "open", false)).toBe("running");
    const waiting = stepsView(entries, [], true, new Set());
    expect(stepStatus(waiting, "open", true)).toBe("writing");
    expect(stepStatus(waiting, "open", false)).toBe("starting");
    // The run ended without a result: stopped, or the tool faulted.
    expect(stepStatus(stepsView(entries, [], false, new Set()), "open", false)).toBe("stopped");
  });

  it("knows which results have their call in the chat", () => {
    const view = stepsView(entries, [], false, new Set());
    expect([...view.calls]).toEqual(["ok", "bad", "open"]);
    expect([...view.results.keys()]).toEqual(["ok", "bad"]);
  });
});

describe("step header", () => {
  it("names built-in tools by what they do, and MCP tools by server and tool", () => {
    expect(stepLabel("run_python")).toBe("Python");
    expect(stepLabel("coingecko__get_price")).toBe("coingecko › get_price");
    expect(stepLabel("something_new")).toBe("something_new");
  });

  it("hints with the first line of the first text argument, else the arguments", () => {
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
  const render = (id: string, tools = [] as never[], busy = false) =>
    renderToStaticMarkup(
      <StepsContext value={stepsView(entries, tools, busy, new Set())}>
        <ToolStep id={id} name="run_python" call={call(id, "run_python", { code: "print(1)" }) as never} />
      </StepsContext>,
    );

  it("starts collapsed, with the name, a hint, the status and how long it took", () => {
    const html = render("ok");
    expect(html).toMatch(/^<details class="step done">/);
    expect(html).not.toContain("step-body");
    expect(html).toContain('<span class="step-label">Python</span><span class="step-hint">print(1)</span><span class="step-status">Done · 1.3 s</span>');
  });

  it("spins the thinking indicator's spark while the step runs", () => {
    const html = render("open", [{ toolCallId: "open", toolName: "run_python", output: "" }] as never[], true);
    expect(html).toMatch(/^<details class="step active">/);
    expect(html).toContain('<svg class="thinking-spark"');
    expect(html).toContain('<span class="step-status">Running…</span>');
  });

  it("marks a failed step", () => {
    expect(render("bad")).toMatch(/^<details class="step error"><summary><span class="step-icon">✕<\/span>/);
  });
});
