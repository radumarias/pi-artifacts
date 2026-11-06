import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { published, shown } from "./entries.ts";

/** One step of the agent's: a tool call, or a thought. `key` stays the same once a streamed message lands. */
export type StepItem = { kind: "tool"; key: string; call: ToolCall; streaming: boolean } | { kind: "thought"; key: string; text: string };

/**
 * Where an agent message's steps show, by block index: the run of steps that starts at that block (all of them, also
 * those of later messages), or `null` for a step an earlier block's run already holds.
 */
export type MessageSteps = ReadonlyMap<number, readonly StepItem[] | null>;

/** The runs of steps in a conversation, by message, and where the one still open at its end starts. */
export interface StepRuns {
  byEntry: ReadonlyMap<number, MessageSteps>;
  open?: { entry: number; index: number };
}

/** A run still taking steps: the message and block it shows at, and its steps so far. */
interface OpenRun {
  entry: number;
  index: number;
  items: StepItem[];
}

/** Whether a message ended in an error or was stopped: a line saying so shows after it. */
export function endedEarly(message: AssistantMessage): boolean {
  return message.stopReason === "error" || message.stopReason === "aborted";
}

/** A message's block as a step, or nothing for text (and for a thought with nothing to show). */
function stepItem(message: AssistantMessage, block: AssistantMessage["content"][number] | undefined, i: number, streaming: boolean): StepItem | undefined {
  if (block?.type === "toolCall") return { kind: "tool", key: block.id, call: block, streaming };
  // By the block's own index, which stays the same once the message lands, so an opened thought stays open.
  if (block?.type === "thinking" && !block.redacted && block.thinking.trim()) return { kind: "thought", key: `${message.timestamp}:${i}`, text: block.thinking };
  return undefined;
}

/**
 * Places a message's steps: in `run` (whose items it adds to) while it lasts, else in a run from that step on. Its text
 * ends a run, and so does its end when it ended early. Returns its places, and the run still open after it.
 */
function placeSteps(message: AssistantMessage, entry: number, streaming: boolean, run: OpenRun | undefined): [MessageSteps, OpenRun | undefined] {
  const places = new Map<number, readonly StepItem[] | null>();
  message.content.forEach((block, i) => {
    const item = stepItem(message, block, i, streaming);
    if (!item) {
      if (block?.type === "text" && block.text) run = undefined;
    } else if (run) {
      run.items.push(item);
      places.set(i, null);
    } else {
      run = { entry, index: i, items: [item] };
      places.set(i, run.items);
    }
  });
  return [places, endedEarly(message) ? undefined : run];
}

/**
 * Groups the agent's steps into runs: the steps one after the other with nothing shown between them (text, a message,
 * an artifact card, or what the chat draws over an entry in `breaks`: a day, the "New" line), across the messages of a
 * reply. Each run shows where its first step is. A message that places the same steps as in `prev` keeps its places
 * from it, so it is not drawn again.
 */
export function stepRuns(entries: readonly EntryRecord[], breaks: ReadonlySet<number>, prev?: StepRuns): StepRuns {
  const byEntry = new Map<number, MessageSteps>();
  const calls = new Set<string>();
  let run: OpenRun | undefined;
  for (const entry of entries) {
    if (!shown(entry)) continue;
    const id = entry.id as number;
    if (breaks.has(id)) run = undefined;
    const message = entry.model?.[0];
    if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      for (const block of message.content) if (block?.type === "toolCall") calls.add(block.id);
      let places: MessageSteps;
      [places, run] = placeSteps(message, id, false, run);
      if (places.size) byEntry.set(id, places);
    } else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
      // A result shows as a step of its call, except a published artifact (a card) and one whose call is not in the chat.
      if (published(entry) || !calls.has((message as ToolResultMessage).toolCallId)) run = undefined;
    } else run = undefined;
  }
  // Only now: a run takes the steps of later messages too.
  for (const [id, places] of byEntry) {
    const was = prev?.byEntry.get(id);
    if (was && sameSteps(was, places)) byEntry.set(id, was);
  }
  return { byEntry, open: run && { entry: run.entry, index: run.index } };
}

/** The streaming message's steps, and the open run before it once its first steps joined it. */
export interface StreamingSteps {
  steps: MessageSteps;
  /** The places of the open run's message, the run longer by the streaming message's first steps. */
  grown?: { entry: number; steps: MessageSteps };
}

/**
 * The streaming message's steps: those up to its first text join the run still open before it. `prev`, the last
 * chunk's, keeps the grown run's places while its steps stay the same, so its message is not drawn again for each chunk.
 */
export function streamingSteps(runs: StepRuns, message: AssistantMessage, prev?: StreamingSteps): StreamingSteps {
  const head = runs.open && runs.byEntry.get(runs.open.entry);
  const before = runs.open && head?.get(runs.open.index);
  const run = runs.open && before ? { ...runs.open, items: [...before] } : undefined;
  const [steps] = placeSteps(message, -1, true, run);
  if (!run || !head || run.items.length === before!.length) return { steps };
  const grown = { entry: run.entry, steps: new Map(head).set(run.index, run.items) };
  return { steps, grown: prev?.grown?.entry === grown.entry && sameSteps(prev.grown.steps, grown.steps) ? prev.grown : grown };
}

/** Whether two places of a message's steps place the same steps. */
function sameSteps(prev: MessageSteps, next: MessageSteps): boolean {
  if (prev.size !== next.size) return false;
  for (const [i, items] of next) {
    const was = prev.get(i);
    if (was === items) continue;
    if (!was || !items || was.length !== items.length) return false;
    if (items.some((item, j) => !sameItem(was[j], item))) return false;
  }
  return true;
}

function sameItem(a: StepItem, b: StepItem): boolean {
  if (a.kind === "tool" && b.kind === "tool") return a.call === b.call && a.streaming === b.streaming;
  return a.kind === "thought" && b.kind === "thought" && a.key === b.key && a.text === b.text;
}
