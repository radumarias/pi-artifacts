import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  LiveDoc,
  SystemEntry,
  ToolResultEntry,
  type AgentEvent,
  type ContextEdit,
  type Conversation,
  type EntryRecord,
  type Harness,
  type LiveState,
  type Submission,
  type TaskId,
} from "@earendil-works/pi-durable";
import { MEMORY_FORGET_TOOL, MEMORY_RECALL_TOOL } from "../../shared/memory.ts";

/** The entry that leaves a conversation's earlier prompts out of its context (see freshPrompt). */
const MEMORY_FRESH_KIND = "chat.memory-fresh";

/** Who a left-out text is for: the model (its context once the chat has more readers), or the people's sockets. */
type Audience = "model" | "shown";

/**
 * What a memory_recall or memory_forget result says once it is left out (the latter quoted the note it forgot): to the
 * model, why and what to do; on others' screens, only who sees it (in a chat that was always shared too).
 */
const LEFT_OUT: Readonly<Record<string, Readonly<Record<Audience, string>>>> = {
  [MEMORY_RECALL_TOOL]: {
    model: "(The notes this call found are left out: more people read this chat now. Call it again for those you may read.)",
    shown: "(Notes this call found are shown only to the chat's owner.)",
  },
  [MEMORY_FORGET_TOOL]: {
    model: "(What this call said is left out: more people read this chat now.)",
    shown: "(What this call said is shown only to the chat's owner.)",
  },
};

/** `message` with what it says put in place of one that says it is left out, if it is a memory_recall or memory_forget result. */
function leftOutResult(message: Message | undefined, audience: Audience): ToolResultMessage | undefined {
  if (message?.role !== "toolResult") return undefined;
  const leftOut = LEFT_OUT[message.toolName]?.[audience];
  return leftOut ? { ...message, content: [{ type: "text", text: leftOut }], details: undefined } : undefined;
}

/**
 * `entry` with a memory_recall or memory_forget result in it left out, and a compaction's summary (which may have kept
 * the notes); the same entry when it holds neither.
 */
function withoutNoteResult(entry: EntryRecord): EntryRecord {
  const [first, ...rest] = entry.model ?? [];
  if (!first) return entry;
  // A summary is the whole of its entry's model, as leaveOutNotes replaces it.
  if (CompactionEntry.is(entry)) return { ...entry, model: [leftOutSummary(first.timestamp, "shown")] };
  const left = leftOutResult(first, "shown");
  return left ? { ...entry, model: [left, ...rest] } : entry;
}

/** `entries` with withoutNoteResult applied, the same array when none changed. */
function withoutNoteResultsIn(entries: readonly EntryRecord[]): readonly EntryRecord[] {
  const shown = entries.map(withoutNoteResult);
  return shown.some((entry, index) => entry !== entries[index]) ? shown : entries;
}

/** A memory tool's call with its output and details left out; any other call as it is. */
function blankCall<Call extends { output?: unknown; details?: unknown }>(call: Call, toolName: string): Call {
  return LEFT_OUT[toolName] ? { ...call, output: undefined, details: undefined } : call;
}

/**
 * What a socket of someone other than the owner gets of `event`: what memory_recall found, what memory_forget said and
 * what a compaction summarized left out, in the transcript's entries, in a result's message as it starts and in a
 * call's running output. They may hold the owner's own notes, read in this chat before others were in it (from any of
 * the owner's chats). Every event type is named, so a new one fails the typecheck until it is placed here (as in
 * withoutSystemPrompt).
 */
export function withoutNoteResults(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "snapshot": {
      const entries = withoutNoteResultsIn(event.entries);
      const tools = event.tools.some((slot) => LEFT_OUT[slot.name]) ? event.tools.map((slot) => blankCall(slot, slot.name)) : event.tools;
      return entries === event.entries && tools === event.tools ? event : { ...event, entries, tools };
    }
    // An entry's message starts whole, before its entry lands (a result, a compaction's summary). The app reads only an
    // assistant's as it starts; any other arrives again with its entry, as above: none is sent here.
    case "message_start":
      return event.message.role === "assistant" ? event : { ...event, message: { ...event.message, content: [], details: undefined } as Message };
    case "message_end":
    case "entry_appended": {
      const entry = withoutNoteResult(event.entry);
      return entry === event.entry ? event : { ...event, entry };
    }
    case "tool_execution_end":
      if (!LEFT_OUT[event.toolName]) return event;
      return {
        ...event,
        ...(event.entry && { entry: withoutNoteResult(event.entry) }),
        ...(event.result && { result: { ...event.result, structuredOutput: undefined, details: undefined } }),
      };
    case "tool_execution_update":
      return blankCall(event, event.toolName);
    case "agent_changed":
    case "run_start":
    case "run_end":
    case "turn_start":
    case "turn_end":
    case "message_update":
    case "tool_execution_start":
    case "inbox_update":
    case "submission":
    case "auto_retry_start":
    case "auto_retry_end":
    case "deferred_poll":
    case "usage_changed":
    case "task_failed":
    case "compaction_start":
    case "compaction_end":
      return event;
    default:
      return event satisfies never;
  }
}

/** How a compaction's summary is asked to be placed: its write's request id starts with it. */
const SUMMARY_REQUEST = "compaction:";

/** What a summary of the conversation says once it is left out, as LEFT_OUT. */
const SUMMARY_LEFT_OUT: Readonly<Record<Audience, string>> = {
  model: "(A summary of the earlier conversation is left out here: more people read this chat now.)",
  shown: "(A summary of the earlier conversation is shown only to the chat's owner.)",
};

/** How a compaction's summary starts in the model's context (pi-durable's CompactionTask; test/memory-prompt.test.ts checks it). */
const SUMMARY_START = "The conversation history before this point was compacted into the following summary:";

/** Whether `message` is a compaction's summary, as the model reads it. */
function isSummary(message: Message): boolean {
  if (message.role !== "user") return false;
  const first = typeof message.content === "string" ? message.content : message.content.find((part) => part.type === "text")?.text;
  return first?.startsWith(SUMMARY_START) === true;
}

/** A compaction's summary put in place of one that says it is left out. */
const leftOutSummary = (timestamp: number, audience: Audience): Message => ({ role: "user", content: SUMMARY_LEFT_OUT[audience], timestamp });

/** `messages` with every compaction summary among them put in place of one that says it is left out. */
export function withoutSummaries(messages: readonly Message[]): Message[] {
  return messages.map((message) => (isSummary(message) ? leftOutSummary(message.timestamp, "model") : message));
}

/**
 * Edits that leave the owner's notes out of the model's context: every prompt entry (`pi.system`) of `entries`
 * omitted, every memory_recall (and memory_forget) result put in place of one that says so (its call stays answered),
 * and a summary of the conversation before it (a compaction, which may have kept the notes) too.
 */
function leaveOutNotes(entries: readonly EntryRecord[]): ContextEdit[] {
  return entries.flatMap((entry): ContextEdit[] => {
    if (SystemEntry.is(entry)) return [{ target: entry.id, action: "omit" }];
    if (CompactionEntry.is(entry) && entry.model?.length)
      return [{ target: entry.id, action: "replace", messages: [leftOutSummary(Date.now(), "model")] }];
    const result = ToolResultEntry.is(entry) ? leftOutResult(entry.model?.[0], "model") : undefined;
    return result ? [{ target: entry.id, action: "replace", messages: [result] }] : [];
  });
}

/** The harness calls freshPrompt stops a compaction with. */
type Compactions = Pick<Harness, "inspect" | "abortTask" | "abortSubmission" | "waitForTask">;

/** How many times freshPrompt looks again for a compaction that read the notes before it gives up (the next turn tries again). */
const MAX_LOOKS = 5;

/**
 * Make `conversation`'s next model request carry no note it read so far: its prompt starts afresh (every earlier
 * prompt entry left out, so the planner finds none and writes all of the sections and tools again, as they are
 * then), and what memory_recall found is left out. The transcript keeps them; no model reads them. Resolves once those
 * edits are written: they are placed at once when the conversation is idle, else at its next step.
 *
 * Until they are placed, a compaction may summarize the context as it was, notes included, and place its summary after
 * them. So `done` looks again once they are in, and again after each look that found one: a compaction the
 * conversation runs on its own is stopped, its summary too if it waits to be placed (a later one compacts again); one a
 * turn waits for cannot be (the turn would fail), and is waited for; and every summary placed since the first look is
 * left out too, as is a memory tool's result that landed after the context was read. True once a look finds none;
 * false when MAX_LOOKS were not enough. Until then the caller has each request leave summaries out (withoutSummaries).
 */
export async function freshPrompt(
  conversation: Pick<Conversation, "id" | "context" | "submit" | "viewState">,
  harness: Compactions,
): Promise<{ done: Promise<boolean> }> {
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const seen = new Set(view.entries.map((entry) => entry.id));
  const written = await leaveOut(conversation, view.entries);
  return { done: lookAgain(conversation, harness, seen, written) };
}

async function lookAgain(
  conversation: Pick<Conversation, "id" | "context" | "submit" | "viewState">,
  harness: Compactions,
  seen: Set<EntryRecord["id"]>,
  written: Submission | undefined,
): Promise<boolean> {
  for (let look = 0; look < MAX_LOOKS; look++) {
    await written?.wait(BACKGROUND_CONTEXT);
    const waited = await stopCompactions(conversation, harness);
    await Promise.allSettled(waited.map((taskId) => harness.waitForTask(taskId, BACKGROUND_CONTEXT)));
    // A compaction placed since, and a memory tool's result that landed after the context was read (its call was
    // answered as someone joined): neither is in the edits yet.
    const late = (await conversation.context(BACKGROUND_CONTEXT)).entries.filter(
      (entry) =>
        !seen.has(entry.id) && (CompactionEntry.is(entry) || (ToolResultEntry.is(entry) && leftOutResult(entry.model?.[0], "model") !== undefined)),
    );
    if (!late.length && !waited.length) return true;
    for (const entry of late) seen.add(entry.id);
    written = await leaveOut(conversation, late);
  }
  return false;
}

/**
 * Stop the conversation's compactions that it runs on its own, and the summaries waiting to be placed; the ids of those
 * a turn waits for, which cannot be stopped.
 */
async function stopCompactions(conversation: Pick<Conversation, "id" | "viewState">, harness: Compactions): Promise<TaskId[]> {
  const live = await conversation.viewState(BACKGROUND_CONTEXT);
  let compactions: LiveState["compactions"];
  try {
    compactions = (live.value.docs[LiveDoc.definition.kind] as LiveState | undefined)?.compactions;
  } finally {
    live.dispose();
  }
  await Promise.all(compactions?.filter((each) => !each.blocking).map((each) => harness.abortTask(each.taskId, BACKGROUND_CONTEXT)) ?? []);
  // After the tasks: one that finished meanwhile has its summary waiting here, or placed already (the caller's look).
  const { submissions } = await harness.inspect(BACKGROUND_CONTEXT);
  await Promise.all(
    submissions
      .filter(
        (each) =>
          each.conversationId === conversation.id && each.type === "write" && each.status === "queued" && each.requestId?.startsWith(SUMMARY_REQUEST),
      )
      .map((each) => harness.abortSubmission(each.id, BACKGROUND_CONTEXT, conversation.id)),
  );
  return compactions?.filter((each) => each.blocking).map((each) => each.taskId) ?? [];
}

/** Write the edits that leave the notes of `entries` out, if any. */
async function leaveOut(conversation: Pick<Conversation, "submit">, entries: readonly EntryRecord[]): Promise<Submission | undefined> {
  const edits = leaveOutNotes(entries);
  return edits.length ? conversation.submit({ type: "write", entry: { kind: MEMORY_FRESH_KIND, edits } }, BACKGROUND_CONTEXT) : undefined;
}
