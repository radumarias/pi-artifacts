import { describe, expect, it } from "vitest";
import { reduce, type ChatState } from "../src/chat/useChat.ts";

const empty: ChatState = { entries: [], tools: [], busy: false };
const assistant = (content: unknown[]) => ({ role: "assistant", content, api: "anthropic-messages", provider: "cloudflare", model: "m", usage: {}, stopReason: "stop", timestamp: 0 });

// Event shapes as the deployed agent streams them: an assistant message can
// open with blocks already in it, and later changes index past them.
describe("chat reducer", () => {
  it("keeps the blocks an assistant message opens with", () => {
    const state = reduce(empty, {
      type: "events",
      events: [
        { type: "message_start", message: assistant([{ type: "text", text: "I can build live" }]) },
        { type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: " dashboards." }] },
      ] as never,
    });
    expect(state.partial?.content).toEqual([{ type: "text", text: "I can build live dashboards." }]);
  });

  it("leaves no holes when a later block starts after the opening ones", () => {
    const state = reduce(empty, {
      type: "events",
      events: [
        { type: "message_start", message: assistant([{ type: "thinking", thinking: "Plan" }]) },
        { type: "message_update", usage: {}, changes: [{ type: "text_start", contentIndex: 1, block: { type: "text", text: "Done" } }] },
      ] as never,
    });
    const content = state.partial!.content;
    expect(content).toHaveLength(2);
    expect(content.every((block) => block !== undefined)).toBe(true);
  });

  it("streams a tool call's arguments into the call", () => {
    const state = reduce(empty, {
      type: "events",
      events: [
        { type: "message_start", message: assistant([{ type: "toolCall", id: "c", name: "run_python", arguments: { code: "import", files: ["sales"] } }]) },
        { type: "message_update", usage: {}, changes: [{ type: "toolcall_delta", contentIndex: 0, path: ["code"], delta: " pandas" }] },
        { type: "message_update", usage: {}, changes: [{ type: "toolcall_delta", contentIndex: 0, path: ["files", 0], delta: ".csv" }] },
      ] as never,
    });
    expect(state.partial?.content[0]).toMatchObject({ arguments: { code: "import pandas", files: ["sales.csv"] } });
  });

  it("picks up the calls running when the socket connects", () => {
    const state = reduce(empty, {
      type: "events",
      events: [
        {
          type: "snapshot",
          entries: [],
          run: { inputs: [] },
          tools: [
            { callId: "a", name: "run_python", status: "running", output: "step 1\n" },
            { callId: "b", name: "run_bash", status: "pending" },
            { callId: "c", name: "run_bash", status: "done", entry: "e1" },
            { callId: "d", name: "run_bash", status: "done" },
          ],
          agent: {},
        },
      ] as never,
    });
    expect(state.tools).toEqual([
      { toolCallId: "a", toolName: "run_python", output: "step 1\n", status: "running" },
      { toolCallId: "b", toolName: "run_bash", output: "", status: "pending" },
      // Done without a result entry: it faulted or was orphaned.
      { toolCallId: "d", toolName: "run_bash", output: "", status: "stopped" },
    ]);
  });

  it("follows a call from its start to its end, and keeps one that ended without a result as stopped", () => {
    const call = { toolName: "run_python" };
    let state = reduce(empty, { type: "events", events: [{ type: "tool_execution_start", toolCallId: "a", ...call, args: {} }] as never });
    expect(state.tools).toEqual([{ toolCallId: "a", toolName: "run_python", output: "", status: "running" }]);
    state = reduce(state, { type: "events", events: [{ type: "tool_execution_end", toolCallId: "a", ...call }] as never });
    expect(state.tools[0].status).toBe("stopped");
    const entry = { id: "r", kind: "pi.tool-result", model: [] };
    state = reduce(state, { type: "events", events: [{ type: "tool_execution_start", toolCallId: "b", ...call, args: {} }, { type: "tool_execution_end", toolCallId: "b", ...call, entry }] as never });
    expect(state.tools.map((t) => t.toolCallId)).toEqual(["a"]);
    expect(state.entries).toEqual([entry]);
    // Orphaned before it started.
    state = reduce(state, { type: "events", events: [{ type: "tool_execution_end", toolCallId: "c", ...call }] as never });
    expect(state.tools.map((t) => [t.toolCallId, t.status])).toEqual([["a", "stopped"], ["c", "stopped"]]);
  });

  it("ignores message_start for user, system and tool-result messages", () => {
    const state = reduce(empty, {
      type: "events",
      events: [
        { type: "message_start", message: { role: "user", content: "hi", timestamp: 0 } },
        { type: "message_start", message: { role: "system", content: "" } },
      ] as never,
    });
    expect(state.partial).toBeUndefined();
  });
});

describe("chat model", () => {
  it("follows the agent state from the snapshot and its changes", () => {
    const agent = (modelId: string, thinkingLevel: string) => ({ model: { provider: "cloudflare", modelId }, thinkingLevel });
    let state = reduce(empty, { type: "events", events: [{ type: "snapshot", entries: [], tools: [], agent: agent("anthropic/claude-opus-5.5", "high") }] as never });
    expect([state.model, state.thinkingLevel]).toEqual(["anthropic/claude-opus-5.5", "high"]);
    state = reduce(state, { type: "events", events: [{ type: "agent_changed", agent: agent("openai/gpt-5.5", "medium") }] as never });
    expect([state.model, state.thinkingLevel]).toEqual(["openai/gpt-5.5", "medium"]);
  });
});
