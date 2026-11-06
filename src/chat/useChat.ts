import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentState, EntryRecord, JsonObject, UsageState } from "@earendil-works/pi-durable";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AttachmentInput } from "../../shared/attachments.ts";
import type { MentionInput } from "../../shared/mentions.ts";
import { modelKey } from "../../shared/models.ts";
import { SOCKET_NOT_A_MEMBER, SOCKET_PING, type ChatClientMessage, type ChatPeopleView, type ChatServerMessage, type Presence, type QueuedMessage } from "../../shared/protocol.ts";
import type { EntryReactions, Reaction, Reactions } from "../../shared/reactions.ts";
import { api, keepAlive } from "../api.ts";

/** A call of the current round: waiting its turn, running, or ended without a result (it faulted, or was orphaned). */
export interface RunningTool {
  toolCallId: string;
  toolName: string;
  output: string;
  status: "pending" | "running" | "stopped";
  /** When it started running, by this browser's clock: for the time on its step while it runs. */
  startedAt?: number;
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
  /** pi's ledger of what the chat's model calls used and cost, by model. */
  usage?: UsageState;
}

const initial: ChatState = { entries: [], tools: [], busy: false, queued: [] };

type Action =
  /**
   * `at`: when the batch arrived. `runElapsedMs`: how long the snapshot's run had gone, from the server; `toolsElapsedMs`,
   * its running calls, by call id. `queued`: the messages waiting after the batch, when it changed them; in the same
   * action, so one moves from queued to placed at once.
   */
  | (Omit<Extract<ChatServerMessage, { type: "events" }>, "events"> & { events: AgentEvent[]; at: number })
  | { type: "error"; message?: string }
  | { type: "reset" };

function withAgent(state: ChatState, agent: AgentState | undefined): ChatState {
  // The picker's id: a provider's own model is named with its provider.
  const model = agent?.model && modelKey(agent.model.provider, agent.model.modelId);
  return { ...state, model, thinkingLevel: agent?.thinkingLevel };
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
        const started = startFrom(action.at, action.runElapsedMs, next.runStartedAt);
        const known = next.tools;
        const runningSince = (id: string) => known.find((t) => t.toolCallId === id && t.status === "running")?.startedAt;
        next = withAgent(
          {
            entries: [...event.entries],
            partial: event.generation?.message,
            // The round's unfinished calls when the socket (re)connected, with the output they have so far.
            // A slot done without a result entry faulted or was orphaned: it stays in the round as stopped.
            tools: event.tools
              .filter((t) => t.status !== "done" || t.entry === undefined)
              .map((t) => ({
                toolCallId: t.callId,
                toolName: t.name,
                output: t.output ?? "",
                status: t.status === "done" ? "stopped" : t.status,
                // A call still running from before the socket (re)connected counts on from where it was, else from now.
                startedAt:
                  t.status === "running" ? (startFrom(action.at, action.toolsElapsedMs?.[t.callId], runningSince(t.callId)) ?? action.at) : undefined,
              })),
            busy,
            runStartedAt: busy ? (started ?? action.at) : undefined,
            queued: next.queued,
            usage: event.usage,
          },
          event.agent,
        );
        break;
      }
      case "agent_changed":
        next = withAgent(next, event.agent);
        break;
      case "usage_changed":
        next = { ...next, usage: event.usage };
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
        const tool: RunningTool = { toolCallId: event.toolCallId, toolName: event.toolName, output: "", status: "running", startedAt: action.at };
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

/**
 * When something a snapshot reports started: by the server's duration, applied to this clock (the two clocks need not
 * agree), else the start already `known`.
 */
function startFrom(at: number, elapsedMs: number | undefined, known: number | undefined): number | undefined {
  return elapsedMs === undefined ? known : at - Math.max(0, elapsedMs);
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
      // Only a message that stopped to use tools has its calls run; one cut off (stopped, a broken stream, out of
      // tokens) never does, so none of its calls is waited on.
      if (message.stopReason !== "toolUse") return new Set();
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

/** Why the chat's socket stopped for good. */
const STOPPED = { removed: "You are not in this chat.", deleted: "This chat was deleted." };

/**
 * The chat's WebSocket: reconnects with backoff, and every (re)connect starts from a fresh snapshot.
 * It stops for good when the user is no longer in the chat (removed, or the chat is gone).
 */
export function useChat(chatId: string) {
  const [state, dispatch] = useReducer(reduce, initial);
  const [connected, setConnected] = useState(false);
  const [people, setPeople] = useState<ChatPeopleView | null>(null);
  const [online, setOnline] = useState<Presence[]>([]);
  const [reactions, setReactions] = useState<Reactions>({});
  const [auto, setAuto] = useState(false);
  // The viewer's messages that did not call the agent but look meant for it: under each the app offers to call it.
  const [hints, setHints] = useState<ReadonlySet<number>>(NO_HINTS);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    dispatch({ type: "reset" });
    setPeople(null);
    setReactions({});
    setOnline([]);
    setAuto(false);
    setHints(NO_HINTS);
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Not in the chat: stop for good.
    const stop = (why = STOPPED.removed) => {
      closed = true;
      dispatch({ type: "error", message: why });
    };

    const open = () => {
      const ws = new WebSocket(api.chatSocketUrl(chatId));
      socket.current = ws;
      ws.onopen = () => {
        setConnected(true);
        // A reconnect would also send the whole conversation again.
        keepAlive(ws);
      };
      ws.onmessage = (event) => {
        if (event.data === SOCKET_PING.response) return;
        const message = JSON.parse(event.data) as ChatServerMessage;
        // Backoff resets only once the conversation came: a chat that closes every socket before its snapshot (an attach
        // that stalls) is retried ever more slowly, not every few seconds.
        if (message.type === "events") {
          attempt = 0;
          dispatch({ ...message, events: message.events as AgentEvent[], at: Date.now() });
        } else if (message.type === "people") setPeople(message.people);
        else if (message.type === "reactions") setReactions((known) => keepSame(known, message.reactions));
        else if (message.type === "reacted") setReactions((known) => withEntry(known, message.entry, message.reactions));
        else if (message.type === "presence") setOnline(message.online);
        else if (message.type === "auto") setAuto(message.on);
        else if (message.type === "callHint") setHints((known) => new Set(known).add(message.entry));
        else if (message.type === "removed" || message.type === "deleted") {
          stop(STOPPED[message.type]);
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
  const prompt = useCallback(
    (text: string, attachments?: AttachmentInput[], mentions?: MentionInput[], replyTo?: number) =>
      send({
        type: "prompt",
        text,
        ...(attachments?.length && { attachments }),
        ...(mentions?.length && { mentions }),
        ...(replyTo !== undefined && { replyTo }),
      }),
    [send],
  );
  // Stable, so the memoized model picker skips the re-render on every streamed token.
  const setModel = useCallback((model: string, thinkingLevel?: ModelThinkingLevel) => send({ type: "model", model, thinkingLevel }), [send]);
  const react = useCallback((entry: number, emoji: Reaction, on: boolean) => send({ type: "react", entry, emoji, on }), [send]);
  const dropHint = useCallback(
    (entry: number) =>
      setHints((known) => {
        if (!known.has(entry)) return known;
        const next = new Set(known);
        next.delete(entry);
        return next;
      }),
    [],
  );

  return {
    state,
    connected,
    people,
    /** Who has the chat open right now, and in how many windows. */
    online,
    prompt,
    abort: () => send({ type: "abort" }),
    setModel,
    /** Whether the chat is on Auto: a router picks the model and effort for each message. */
    auto,
    /** Everyone's reactions, by transcript entry; each entry's object stays the same until its reactions change. */
    reactions,
    react,
    /** The viewer's messages that look meant for the agent though they did not call it, by transcript entry. */
    hints,
    /** Stop offering to call the agent on a message: it was called, or the viewer said no. */
    dropHint,
  };
}

const NO_HINTS: ReadonlySet<number> = new Set();

/**
 * `next`, keeping `known`'s object for each entry whose reactions are the same: a socket is sent all of them again on
 * every wake of the chat, and only a changed entry should draw its message again.
 */
function keepSame(known: Reactions, next: Reactions): Reactions {
  const kept: Reactions = {};
  for (const [entry, reactions] of Object.entries(next) as unknown as [number, EntryReactions][]) {
    const before = known[entry];
    kept[entry] = before && JSON.stringify(before) === JSON.stringify(reactions) ? before : reactions;
  }
  return kept;
}

/** `known` with one entry's reactions replaced (dropped once it has none); every other entry keeps its object. */
function withEntry(known: Reactions, entry: number, reactions: EntryReactions): Reactions {
  const { [entry]: _before, ...rest } = known;
  return Object.keys(reactions).length ? { ...rest, [entry]: reactions } : rest;
}
