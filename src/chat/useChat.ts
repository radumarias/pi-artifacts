import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentState, EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AttachmentInput } from "../../shared/attachments.ts";
import { SOCKET_NOT_A_MEMBER, type ChatClientMessage, type ChatPeopleView, type ChatServerMessage, type Presence, type QueuedMessage } from "../../shared/protocol.ts";
import { api } from "../api.ts";

/** A call of the current round: waiting its turn, running, or ended without a result (it faulted, or was orphaned). */
export interface RunningTool {
  toolCallId: string;
  toolName: string;
  output: string;
  status: "pending" | "running" | "stopped";
}

export interface ChatState {
  entries: EntryRecord[];
  /** The assistant message being generated, if any. */
  partial?: AssistantMessage;
  tools: RunningTool[];
  busy: boolean;
  /** When the current run started, in epoch ms: for the elapsed time on the working indicator. */
  runStartedAt?: number;
  error?: string;
  /** Messages sent while the agent was busy, oldest first: they wait their turn in pi's inbox. */
  queued: QueuedMessage[];
  /** The model and effort the chat runs on, from pi's agent state. */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
}

const initial: ChatState = { entries: [], tools: [], busy: false, queued: [] };

type Action =
  /**
   * `at`: when the batch arrived. `runElapsedMs`: how long the snapshot's run had gone, from the server. `queued`: the
   * messages waiting after the batch, when it changed them; in the same action, so one moves from queued to placed at once.
   */
  | { type: "events"; events: AgentEvent[]; at: number; runElapsedMs?: number; queued?: QueuedMessage[] }
  | { type: "error"; message?: string }
  | { type: "reset" };

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
      case "snapshot": {
        const busy = event.run !== undefined;
        // A duration from the server, applied to this clock: the two clocks need not agree. Without one (the server
        // could not tell), a snapshot after an overflow keeps the start already known.
        const started = action.runElapsedMs === undefined ? next.runStartedAt : action.at - Math.max(0, action.runElapsedMs);
        next = withAgent(
          {
            entries: [...event.entries],
            partial: event.generation?.message,
            // The round's unfinished calls when the socket (re)connected, with the output they have so far.
            // A slot done without a result entry faulted or was orphaned: it stays in the round as stopped.
            tools: event.tools
              .filter((t) => t.status !== "done" || t.entry === undefined)
              .map((t) => ({ toolCallId: t.callId, toolName: t.name, output: t.output ?? "", status: t.status === "done" ? "stopped" : t.status })),
            busy,
            runStartedAt: busy ? (started ?? action.at) : undefined,
            queued: next.queued,
          },
          event.agent,
        );
        break;
      }
      case "agent_changed":
        next = withAgent(next, event.agent);
        break;
      case "run_start":
        next = { ...next, busy: true, runStartedAt: action.at, error: undefined };
        break;
      case "run_end":
        next = { ...next, busy: false, runStartedAt: undefined, partial: undefined, tools: [] };
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
          } else if (change.type === "toolcall_delta") {
            // A tool call's arguments as the model writes them, so its panel shows the code as it comes.
            const block = content[change.contentIndex];
            if (block?.type === "toolCall") content[change.contentIndex] = { ...block, arguments: appendAt(block.arguments, change.path, change.delta) as JsonObject };
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
      case "tool_execution_start": {
        if (event.parentToolCallId) break;
        const tool: RunningTool = { toolCallId: event.toolCallId, toolName: event.toolName, output: "", status: "running" };
        next = { ...next, tools: [...next.tools.filter((t) => t.toolCallId !== event.toolCallId), tool] };
        break;
      }
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
      case "tool_execution_end": {
        if (event.entry) {
          next = { ...next, tools: next.tools.filter((t) => t.toolCallId !== event.toolCallId), entries: addEntry(next.entries, event.entry) };
          break;
        }
        if (event.parentToolCallId) break;
        // Without a result entry the call faulted or was orphaned, maybe before it started: it stays in the round as stopped.
        const stopped: RunningTool = { toolCallId: event.toolCallId, toolName: event.toolName, output: "", status: "stopped" };
        next = next.tools.some((t) => t.toolCallId === event.toolCallId)
          ? { ...next, tools: next.tools.map((t) => (t.toolCallId === event.toolCallId ? { ...t, status: "stopped" } : t)) }
          : { ...next, tools: [...next.tools, stopped] };
        break;
      }
      case "task_failed":
        next = { ...next, error: event.message };
        break;
    }
  }
  return action.queued ? { ...next, queued: action.queued } : next;
}

/** `value` with `delta` appended to the string at `path`, copying only what is on the way there. */
function appendAt(value: unknown, path: readonly (string | number)[], delta: string): unknown {
  if (path.length === 0) return (typeof value === "string" ? value : "") + delta;
  const [key, ...rest] = path;
  const copy = (Array.isArray(value) ? [...value] : { ...(value as object) }) as Record<string | number, unknown>;
  copy[key] = appendAt(copy[key], rest, delta);
  return copy;
}

/** The tool calls of the newest assistant entry that have no result yet: the round's calls still to come. */
export function unansweredCalls(entries: readonly EntryRecord[]): Set<string> {
  const answered = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i].model?.[0];
    if (message?.role === "toolResult") answered.add(message.toolCallId);
    else if (message?.role === "assistant") {
      return new Set(message.content.flatMap((block) => (block?.type === "toolCall" && !answered.has(block.id) ? [block.id] : [])));
    } else if (message) break;
  }
  return new Set();
}

/**
 * True while a run waits on the model: before its first token, between tool calls, and while it thinks. Not while
 * it writes a tool call or the call runs (the call's panel shows its own spinner), or while reply text streams.
 */
export function waitingOnModel(state: ChatState): boolean {
  if (!state.busy || state.tools.some((t) => t.status !== "stopped")) return false;
  if (!state.partial) {
    // A call that ended without a result is not one the run still waits on.
    const stopped = new Set(state.tools.map((t) => t.toolCallId));
    return [...unansweredCalls(state.entries)].every((id) => stopped.has(id));
  }
  const last = state.partial.content.filter(Boolean).at(-1);
  if (last?.type === "toolCall") return false;
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
  const [online, setOnline] = useState<Presence[]>([]);
  const [gone, setGone] = useState(false);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    dispatch({ type: "reset" });
    setPeople(null);
    setOnline([]);
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
        if (message.type === "events") dispatch({ type: "events", events: message.events as AgentEvent[], at: Date.now(), runElapsedMs: message.runElapsedMs, queued: message.queued });
        else if (message.type === "people") setPeople(message.people);
        else if (message.type === "presence") setOnline(message.online);
        else if (message.type === "removed") {
          stop();
          ws.close();
        } else dispatch({ type: "error", message: message.message });
      };
      ws.onclose = (event) => {
        setConnected(false);
        // Who is here is unknown until the next socket hears it again.
        setOnline([]);
        if (closed) return;
        if (event.code === SOCKET_NOT_A_MEMBER) return stop();
        timer = setTimeout(open, Math.min(1_000 * 2 ** attempt++, 15_000));
      };
    };
    // On the next tick: a mount that is undone at once (React's strict mode does that in development) opens no socket,
    // which the chat would count as a window someone has open until the connection timed out.
    timer = setTimeout(open);
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
    /** Who has the chat open right now, and in how many windows. */
    online,
    /** True once the chat refused this user's socket: they are not (or no longer) in it. */
    gone,
    prompt: (text: string, attachments?: AttachmentInput[]) => send({ type: "prompt", text, ...(attachments?.length && { attachments }) }),
    abort: () => send({ type: "abort" }),
    setModel,
  };
}
