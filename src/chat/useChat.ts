import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentState, EntryRecord } from "@earendil-works/pi-durable";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AttachmentInput } from "../../shared/attachments.ts";
import { SOCKET_NOT_A_MEMBER, type ChatClientMessage, type ChatPeopleView, type ChatServerMessage } from "../../shared/protocol.ts";
import { api } from "../api.ts";

export interface RunningTool {
  toolCallId: string;
  toolName: string;
  output: string;
}

export interface ChatState {
  entries: EntryRecord[];
  /** The assistant message being generated, if any. */
  partial?: AssistantMessage;
  tools: RunningTool[];
  busy: boolean;
  error?: string;
  /** The model and effort the chat runs on, from pi's agent state. */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
}

const initial: ChatState = { entries: [], tools: [], busy: false };

type Action = { type: "events"; events: AgentEvent[] } | { type: "error"; message?: string } | { type: "reset" };

function withAgent(state: ChatState, agent: AgentState | undefined): ChatState {
  return { ...state, model: agent?.model?.modelId, thinkingLevel: agent?.thinkingLevel };
}

function addEntry(entries: EntryRecord[], entry: EntryRecord): EntryRecord[] {
  return entries.some((e) => e.id === entry.id) ? entries : [...entries, entry];
}

/** Apply pi-durable's agent events to the view: a snapshot replaces everything, the rest are deltas on top of it. */
export function reduce(state: ChatState, action: Action): ChatState {
  if (action.type === "reset") return initial;
  if (action.type === "error") return { ...state, error: action.message };
  let next = state;
  for (const event of action.events) {
    switch (event.type) {
      case "snapshot":
        next = withAgent({ entries: [...event.entries], partial: event.generation?.message, tools: [], busy: event.run !== undefined }, event.agent);
        break;
      case "agent_changed":
        next = withAgent(next, event.agent);
        break;
      case "run_start":
        next = { ...next, busy: true, error: undefined };
        break;
      case "run_end":
        next = { ...next, busy: false, partial: undefined, tools: [] };
        break;
      case "message_start":
        // An assistant message can open with blocks already in it; later changes index into them.
        if (event.message.role === "assistant") next = { ...next, partial: { ...event.message, content: [...event.message.content] } };
        break;
      case "message_update": {
        if (!next.partial) break;
        const content = [...next.partial.content];
        for (const change of event.changes) {
          if (change.type === "message") {
            content.splice(0, content.length, ...change.message.content);
          } else if (change.type === "text_start" || change.type === "thinking_start" || change.type === "toolcall_start" || change.type === "block") {
            content[change.contentIndex] = change.block;
          } else if (change.type === "text_delta") {
            const block = content[change.contentIndex];
            if (block?.type === "text") content[change.contentIndex] = { ...block, text: block.text + change.delta };
          } else if (change.type === "thinking_delta") {
            const block = content[change.contentIndex];
            if (block?.type === "thinking") content[change.contentIndex] = { ...block, thinking: block.thinking + change.delta };
          }
        }
        next = { ...next, partial: { ...next.partial, content } };
        break;
      }
      case "message_end":
        next = { ...next, entries: addEntry(next.entries, event.entry), partial: undefined };
        break;
      case "entry_appended":
        next = { ...next, entries: addEntry(next.entries, event.entry) };
        break;
      case "tool_execution_start":
        if (!event.parentToolCallId) next = { ...next, tools: [...next.tools, { toolCallId: event.toolCallId, toolName: event.toolName, output: "" }] };
        break;
      case "tool_execution_update": {
        const out = event.output;
        if (!out) break;
        next = {
          ...next,
          tools: next.tools.map((t) => {
            if (t.toolCallId !== event.toolCallId) return t;
            if ("set" in out) return { ...t, output: out.set };
            return { ...t, output: t.output.slice(out.trimStart ?? 0) + (out.append ?? "") };
          }),
        };
        break;
      }
      case "tool_execution_end":
        next = {
          ...next,
          tools: next.tools.filter((t) => t.toolCallId !== event.toolCallId),
          entries: event.entry ? addEntry(next.entries, event.entry) : next.entries,
        };
        break;
      case "task_failed":
        next = { ...next, error: event.message };
        break;
    }
  }
  return next;
}

/**
 * True while a run waits on the model: before its first token, between tool calls, and while it thinks or writes a
 * tool call. Not while a tool runs (that shows its own spinner) or while reply text streams.
 */
export function waitingOnModel(state: ChatState): boolean {
  if (!state.busy || state.tools.length > 0) return false;
  const last = state.partial?.content.filter(Boolean).at(-1);
  return last?.type !== "text" || !last.text;
}

/**
 * The chat's WebSocket: reconnects with backoff, and every (re)connect starts from a fresh snapshot.
 * It stops for good when the user is no longer in the chat (removed, or the chat is gone).
 */
export function useChat(chatId: string) {
  const [state, dispatch] = useReducer(reduce, initial);
  const [connected, setConnected] = useState(false);
  const [people, setPeople] = useState<ChatPeopleView | null>(null);
  const [gone, setGone] = useState(false);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    dispatch({ type: "reset" });
    setPeople(null);
    setGone(false);
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Not in the chat: stop for good.
    const stop = () => {
      closed = true;
      setGone(true);
      dispatch({ type: "error", message: "You are not in this chat." });
    };

    const open = () => {
      const ws = new WebSocket(api.chatSocketUrl(chatId));
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data) as ChatServerMessage;
        if (message.type === "events") dispatch({ type: "events", events: message.events as AgentEvent[] });
        else if (message.type === "people") setPeople(message.people);
        else if (message.type === "removed") {
          stop();
          ws.close();
        } else dispatch({ type: "error", message: message.message });
      };
      ws.onclose = (event) => {
        setConnected(false);
        if (closed) return;
        if (event.code === SOCKET_NOT_A_MEMBER) return stop();
        timer = setTimeout(open, Math.min(1_000 * 2 ** attempt++, 15_000));
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket.current?.close();
    };
  }, [chatId]);

  const send = useCallback((message: ChatClientMessage) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(message));
    return true;
  }, []);
  // Stable, so the memoized model picker skips the re-render on every streamed token.
  const setModel = useCallback((model: string, thinkingLevel?: ModelThinkingLevel) => send({ type: "model", model, thinkingLevel }), [send]);

  return {
    state,
    connected,
    people,
    /** True once the chat refused this user's socket: they are not (or no longer) in it. */
    gone,
    prompt: (text: string, attachments?: AttachmentInput[]) => send({ type: "prompt", text, ...(attachments?.length && { attachments }) }),
    abort: () => send({ type: "abort" }),
    setModel,
  };
}
