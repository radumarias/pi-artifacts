import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { THINKING_WORDS, Thinking, formatElapsed, nextWord } from "../src/chat/Thinking.tsx";
import { reduce, unansweredCalls, waitingOnModel, type ChatState } from "../src/chat/useChat.ts";

const idle: ChatState = { entries: [], tools: [], busy: false, queued: [] };
const busy: ChatState = { ...idle, busy: true };
const partial = (content: unknown[]) => ({ ...busy, partial: { role: "assistant", content } }) as unknown as ChatState;

describe("waiting on the model", () => {
  it("shows before the first token and between tool calls", () => {
    expect(waitingOnModel(busy)).toBe(true);
    expect(waitingOnModel(partial([]))).toBe(true);
  });

  it("shows while the model thinks", () => {
    expect(waitingOnModel(partial([{ type: "thinking", thinking: "Plan" }]))).toBe(true);
    // A block the stream has not filled yet.
    expect(waitingOnModel(partial([{ type: "thinking", thinking: "" }, undefined]))).toBe(true);
  });

  it("hides as soon as reply text streams, while a tool runs, and when idle", () => {
    expect(waitingOnModel(partial([{ type: "thinking", thinking: "Plan" }, { type: "text", text: "I" }]))).toBe(false);
    expect(waitingOnModel({ ...busy, tools: [{ toolCallId: "t", toolName: "run_python", output: "", status: "running" }] })).toBe(false);
    // A call that ended without a result no longer holds the indicator back.
    expect(waitingOnModel({ ...busy, tools: [{ toolCallId: "t", toolName: "run_python", output: "", status: "stopped" }] })).toBe(true);
    expect(waitingOnModel({ ...busy, busy: false })).toBe(false);
  });

  it("hides while a tool call is written or waits to start: its panel shows a spinner", () => {
    expect(waitingOnModel(partial([{ type: "text", text: "Building it." }, { type: "toolCall", id: "c", name: "artifact_publish", arguments: {} }]))).toBe(false);
    const call = { id: "a", kind: "pi.assistant", model: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c", name: "run_python", arguments: {} }] }] };
    const result = { id: "r", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c", toolName: "run_python", content: [], isError: false }] };
    expect(waitingOnModel({ ...busy, entries: [call] } as unknown as ChatState)).toBe(false);
    // Ended without a result: the model is up again.
    const stopped = [{ toolCallId: "c", toolName: "run_python", output: "", status: "stopped" }];
    expect(waitingOnModel({ ...busy, entries: [call], tools: stopped } as unknown as ChatState)).toBe(true);
    // Answered: the model is up again.
    expect(waitingOnModel({ ...busy, entries: [call, result] } as unknown as ChatState)).toBe(true);
  });

  it("waits on no call of a message that was cut off: those calls never run", () => {
    const cut = { id: "a", kind: "pi.assistant", model: [{ role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", id: "c", name: "artifact_check", arguments: {} }] }] };
    expect(unansweredCalls([cut] as unknown as ChatState["entries"])).toEqual(new Set());
    // Out of tokens while writing the page: the call never runs either.
    const long = { ...cut, model: [{ ...cut.model[0], stopReason: "length" }] };
    expect(unansweredCalls([long] as unknown as ChatState["entries"])).toEqual(new Set());
    expect(waitingOnModel({ ...busy, entries: [cut] } as unknown as ChatState)).toBe(true);
  });
});

describe("thinking indicator", () => {
  it("never repeats the word showing now", () => {
    for (const current of THINKING_WORDS) {
      for (const r of [0, 0.5, 0.999]) expect(nextWord(current, () => r)).not.toBe(current);
    }
  });

  it("announces one steady status and hides the rotating word from screen readers", () => {
    const html = renderToStaticMarkup(<Thinking since={Date.now()} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('<span class="sr-only">Working…</span>');
    expect(html).toContain('<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>');
    expect(html).toMatch(new RegExp(`<span class="thinking-word" aria-hidden="true">(${THINKING_WORDS.join("|")})</span>`));
  });
});

describe("elapsed time", () => {
  it("reads like a stopwatch", () => {
    expect([0, 999, 12_400, 59_999].map(formatElapsed)).toEqual(["0s", "0s", "12s", "59s"]);
    expect([60_000, 141_000, 150_500, 3_599_000].map(formatElapsed)).toEqual(["1m", "2m 21s", "2m 30s", "59m 59s"]);
    expect([3_600_000, 3_900_000].map(formatElapsed)).toEqual(["1h", "1h 5m"]);
    // A start stamped by a clock slightly ahead of this one.
    expect(formatElapsed(-800)).toBe("0s");
  });

  it("shows next to the status word, counting from the run's start", () => {
    const html = renderToStaticMarkup(<Thinking since={Date.now() - 141_000} />);
    expect(html).toMatch(/<span class="thinking-time" aria-hidden="true">2m 2[12]s<\/span>/);
  });

  it("starts when the run starts and stops when it ends", () => {
    const running = reduce(idle, { type: "events", at: 5_000, events: [{ type: "run_start", inputs: [] }] as never });
    expect(running.runStartedAt).toBe(5_000);
    expect(reduce(running, { type: "events", at: 9_000, events: [{ type: "run_end", inputs: [] }] as never }).runStartedAt).toBeUndefined();
  });

  it("takes a run already going on connect from the server, or else from when the snapshot came", () => {
    const snapshot = (run: boolean, runElapsedMs?: number) =>
      reduce(idle, { type: "events", at: 10_000, runElapsedMs, events: [{ type: "snapshot", entries: [], tools: [], ...(run ? { run: { inputs: [] } } : {}) }] as never });
    expect(snapshot(true, 6_000).runStartedAt).toBe(4_000);
    expect(snapshot(true).runStartedAt).toBe(10_000);
    // A negative duration never puts the start in the future.
    expect(snapshot(true, -2_000).runStartedAt).toBe(10_000);
    expect(snapshot(false, 6_000).runStartedAt).toBeUndefined();
  });

  it("keeps the start it knows when a later snapshot comes without one", () => {
    const running = reduce(idle, { type: "events", at: 5_000, events: [{ type: "run_start", inputs: [] }] as never });
    const again = reduce(running, { type: "events", at: 20_000, events: [{ type: "snapshot", entries: [], tools: [], run: { inputs: [] } }] as never });
    expect(again.runStartedAt).toBe(5_000);
  });

  it("times each running call: from its start, else the server's duration, else the start it knows, else the snapshot", () => {
    const call = { toolName: "run_python" };
    const started = reduce(busy, { type: "events", at: 5_000, events: [{ type: "tool_execution_start", toolCallId: "a", ...call, args: {} }] as never });
    expect(started.tools[0].startedAt).toBe(5_000);
    const slots = [
      { callId: "a", name: "run_python", status: "running" },
      { callId: "b", name: "run_python", status: "running" },
      { callId: "c", name: "run_python", status: "running" },
      { callId: "d", name: "run_python", status: "pending" },
    ];
    const snapshot = { type: "snapshot", entries: [], tools: slots, run: { inputs: [] } };
    const again = reduce(started, { type: "events", at: 20_000, toolsElapsedMs: { b: 3_000, c: -1 }, events: [snapshot] as never });
    expect(again.tools.map((t) => t.startedAt)).toEqual([5_000, 17_000, 20_000, undefined]);
    const fresh = reduce(idle, { type: "events", at: 20_000, events: [snapshot] as never });
    expect(fresh.tools[0].startedAt).toBe(20_000);
  });
});
