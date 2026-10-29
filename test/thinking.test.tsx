import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { THINKING_WORDS, Thinking, nextWord } from "../src/chat/Thinking.tsx";
import { waitingOnModel, type ChatState } from "../src/chat/useChat.ts";

const busy: ChatState = { entries: [], tools: [], busy: true };
const partial = (content: unknown[]) => ({ ...busy, partial: { role: "assistant", content } }) as unknown as ChatState;

describe("waiting on the model", () => {
  it("shows before the first token and between tool calls", () => {
    expect(waitingOnModel(busy)).toBe(true);
    expect(waitingOnModel(partial([]))).toBe(true);
  });

  it("shows while the model thinks or writes a tool call", () => {
    expect(waitingOnModel(partial([{ type: "thinking", thinking: "Plan" }]))).toBe(true);
    expect(waitingOnModel(partial([{ type: "text", text: "Building it." }, { type: "toolCall", name: "publish", arguments: {} }]))).toBe(true);
    // A block the stream has not filled yet.
    expect(waitingOnModel(partial([{ type: "thinking", thinking: "" }, undefined]))).toBe(true);
  });

  it("hides as soon as reply text streams, while a tool runs, and when idle", () => {
    expect(waitingOnModel(partial([{ type: "thinking", thinking: "Plan" }, { type: "text", text: "I" }]))).toBe(false);
    expect(waitingOnModel({ ...busy, tools: [{ toolCallId: "t", toolName: "run_python", output: "" }] })).toBe(false);
    expect(waitingOnModel({ ...busy, busy: false })).toBe(false);
  });
});

describe("thinking indicator", () => {
  it("never repeats the word showing now", () => {
    for (const current of THINKING_WORDS) {
      for (const r of [0, 0.5, 0.999]) expect(nextWord(current, () => r)).not.toBe(current);
    }
  });

  it("announces one steady status and hides the rotating word from screen readers", () => {
    const html = renderToStaticMarkup(<Thinking />);
    expect(html).toContain('role="status"');
    expect(html).toContain('<span class="sr-only">Working…</span>');
    expect(html).toContain('<svg class="thinking-spark" viewBox="0 0 24 24" aria-hidden="true">');
    expect(html.match(/<line /g)).toHaveLength(6);
    expect(html).toMatch(new RegExp(`<span class="thinking-word" aria-hidden="true">(${THINKING_WORDS.join("|")})</span>`));
  });
});
