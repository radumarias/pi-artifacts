import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  LiveDoc,
  SystemEntry,
  ToolResultEntry,
  type ContextEdit,
  type Conversation,
  type EntryRecord,
  type Harness,
  type LiveState,
  type Submission,
} from "@earendil-works/pi-durable";
import { MEMORY_FORGET_TOOL, MEMORY_RECALL_TOOL } from "../../shared/memory.ts";

/** The entry that leaves a conversation's earlier prompts out of its context (see freshPrompt). */
const MEMORY_FRESH_KIND = "chat.memory-fresh";

/** What a memory_recall or memory_forget result says once it is left out (the latter quoted the note it forgot). */
const LEFT_OUT: Readonly<Record<string, string>> = {
  [MEMORY_RECALL_TOOL]: "(The notes this call found are left out: more people read this chat now. Call it again for those you may read.)",
  [MEMORY_FORGET_TOOL]: "(What this call said is left out: more people read this chat now.)",
};

/** How a compaction's summary is asked to be placed: its write's request id starts with it. */
const SUMMARY_REQUEST = "compaction:";

/** What a summary of the conversation says once it is left out. */
const SUMMARY_LEFT_OUT = "(A summary of the earlier conversation is left out here: more people read this chat now.)";

/** How a compaction's summary starts in the model's context (pi-durable's CompactionTask; test/memory-prompt.test.ts checks it). */
const SUMMARY_START = "The conversation history before this point was compacted into the following summary:";

/** `messages` with every compaction summary among them put in place of one that says it is left out. */
export function withoutSummaries(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const first = typeof message.content === "string" ? message.content : message.content.find((part) => part.type === "text")?.text;
    return first?.startsWith(SUMMARY_START) ? { ...message, content: SUMMARY_LEFT_OUT } : message;
  });
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
      return [{ target: entry.id, action: "replace", messages: [{ role: "user", content: SUMMARY_LEFT_OUT, timestamp: Date.now() }] }];
    const result = ToolResultEntry.is(entry) ? (entry.model?.[0] as ToolResultMessage | undefined) : undefined;
    const leftOut = result?.role === "toolResult" ? LEFT_OUT[result.toolName] : undefined;
    if (!result || !leftOut) return [];
    return [{ target: entry.id, action: "replace", messages: [{ ...result, content: [{ type: "text", text: leftOut }] }] }];
  });
}

/** The harness calls freshPrompt stops a compaction with. */
export type Compactions = Pick<Harness, "inspect" | "abortTask" | "abortSubmission" | "waitForTask">;

/**
 * Make `conversation`'s next model request carry no note it read so far: its prompt starts afresh (every earlier
 * prompt entry left out, so the planner finds none and writes all of the sections and tools again, as they are
 * then), and what memory_recall found is left out. The transcript keeps them; no model reads them. Placed at once when
 * the conversation is idle, else at its next step.
 *
 * A compaction going now summarizes the context as it was, notes included, and its summary would come in after these
 * edits. One the conversation runs on its own is stopped, its summary too if it waits to be placed (a later one
 * compacts again), and a summary placed meanwhile is left out as well. One a turn waits for cannot be stopped (the
 * turn would fail): `compacting` resolves once it has placed its summary, and then freshPrompt is due again (until
 * its edits are in, withoutSummaries leaves the summary out of each request). `placed`: resolves once they are.
 */
export async function freshPrompt(
  conversation: Pick<Conversation, "id" | "context" | "submit" | "viewState">,
  harness: Compactions,
): Promise<{ compacting?: Promise<unknown>; placed: Promise<unknown> }> {
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const writes = [await leaveOut(conversation, view.entries)];
  const live = await conversation.viewState(BACKGROUND_CONTEXT);
  let compactions: LiveState["compactions"];
  try {
    compactions = (live.value.docs[LiveDoc.definition.kind] as LiveState | undefined)?.compactions;
  } finally {
    live.dispose();
  }
  await Promise.all(compactions?.filter((each) => !each.blocking).map((each) => harness.abortTask(each.taskId, BACKGROUND_CONTEXT)) ?? []);
  // After the tasks: one that finished meanwhile has its summary waiting here, or placed already (below).
  const { submissions } = await harness.inspect(BACKGROUND_CONTEXT);
  await Promise.all(
    submissions
      .filter(
        (each) =>
          each.conversationId === conversation.id && each.type === "write" && each.status === "queued" && each.requestId?.startsWith(SUMMARY_REQUEST),
      )
      .map((each) => harness.abortSubmission(each.id, BACKGROUND_CONTEXT, conversation.id)),
  );
  const seen = new Set(view.entries.map((entry) => entry.id));
  const late = (await conversation.context(BACKGROUND_CONTEXT)).entries.filter((entry) => !seen.has(entry.id) && CompactionEntry.is(entry));
  writes.push(await leaveOut(conversation, late));
  const placed = Promise.all(writes.map((write) => write?.wait(BACKGROUND_CONTEXT)));
  const waited = compactions?.filter((each) => each.blocking) ?? [];
  if (!waited.length) return { placed };
  return { compacting: Promise.allSettled(waited.map((each) => harness.waitForTask(each.taskId, BACKGROUND_CONTEXT))), placed };
}

/** Write the edits that leave the notes of `entries` out, if any. */
async function leaveOut(conversation: Pick<Conversation, "submit">, entries: readonly EntryRecord[]): Promise<Submission | undefined> {
  const edits = leaveOutNotes(entries);
  return edits.length ? conversation.submit({ type: "write", entry: { kind: MEMORY_FRESH_KIND, edits } }, BACKGROUND_CONTEXT) : undefined;
}
