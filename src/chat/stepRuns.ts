import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { CHECK_TOOL, DRAFTS_TOOL, MCP_DISCOVER_TOOL, MCP_TOOL_SEPARATOR, PUBLISH_TOOL, WRITE_TOOL } from "../../shared/protocol.ts";
import { plural } from "../../shared/util.ts";
import { published, shown } from "./entries.ts";

/** One step of the agent's: a tool call, or a thought. `key` stays the same once a streamed message lands. */
export type StepItem = { kind: "tool"; key: string; call: ToolCall; streaming: boolean } | { kind: "thought"; key: string; text: string };

/**
 * Where an agent message's steps show, by block index: the run of steps that starts at that block (all of them, also
 * those of later messages), or `null` for a step an earlier block's run already holds.
 */
export type MessageSteps = ReadonlyMap<number, readonly StepItem[] | null>;

/** A message's block as a step, or nothing for text (and for a thought with nothing to show). */
export function stepItem(
  message: AssistantMessage,
  block: AssistantMessage["content"][number] | undefined,
  i: number,
  streaming: boolean,
): StepItem | undefined {
  if (block?.type === "toolCall") return { kind: "tool", key: block.id, call: block, streaming };
  // By the block's own index, which stays the same once the message lands, so an opened thought stays open.
  if (block?.type === "thinking" && !block.redacted && block.thinking.trim())
    return { kind: "thought", key: `${message.timestamp}:${i}`, text: block.thinking };
  return undefined;
}

/** The runs of steps in a conversation, and the one still open at its end (which a streaming message's steps join). */
export interface StepRuns {
  byEntry: ReadonlyMap<number, MessageSteps>;
  open?: { entry: number; index: number; items: readonly StepItem[] };
}

/** Builds runs over messages: anything the chat shows between two steps but another step ends a run. */
class RunBuilder {
  run?: { index: number; items: StepItem[] };

  /** Places `message`'s blocks into `places`, and ends the run at its text, an error, or its end when it stopped. */
  message(message: AssistantMessage, streaming: boolean, places: Map<number, readonly StepItem[] | null>): void {
    message.content.forEach((block, i) => {
      const item = stepItem(message, block, i, streaming);
      if (!item) {
        if (block?.type === "text" && block.text) this.run = undefined;
        return;
      }
      if (this.run) {
        this.run.items.push(item);
        places.set(i, null);
      } else {
        this.run = { index: i, items: [item] };
        places.set(i, this.run.items);
      }
    });
    // Its "failed" or "Stopped." line comes after it.
    if (message.stopReason === "error" || message.stopReason === "aborted") this.run = undefined;
  }
}

/**
 * Groups the agent's steps into runs: the steps one after the other with nothing shown between them (text, a message,
 * an artifact card), across the messages of a reply. Each run shows where its first step is. A message that places the
 * same steps as in `prev` keeps its places from it, so it is not drawn again.
 */
export function stepRuns(entries: readonly EntryRecord[], prev?: StepRuns): StepRuns {
  const byEntry = new Map<number, MessageSteps>();
  const calls = new Set<string>();
  const runs = new RunBuilder();
  let openEntry = -1;
  for (const entry of entries) {
    if (!shown(entry)) continue;
    const message = entry.model?.[0];
    if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      const places = new Map<number, readonly StepItem[] | null>();
      for (const block of message.content) if (block?.type === "toolCall") calls.add(block.id);
      const before = runs.run;
      runs.message(message, false, places);
      if (runs.run && runs.run !== before) openEntry = entry.id as number;
      if (places.size) byEntry.set(entry.id as number, places);
    } else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
      // A result shows as a step of its call, except a published artifact (a card) and one whose call is not in the chat.
      if (published(entry) || !calls.has((message as ToolResultMessage).toolCallId)) runs.run = undefined;
    } else runs.run = undefined;
  }
  if (prev) for (const [id, places] of byEntry) if (sameSteps(prev.byEntry.get(id), places)) byEntry.set(id, prev.byEntry.get(id)!);
  const run = runs.run;
  return { byEntry, open: run && { entry: openEntry, index: run.index, items: run.items } };
}

/**
 * The streaming message's steps: those up to its first text join the run still open before it (`open`), which then
 * shows longer (`grown`, the place of its first step).
 */
export function streamingSteps(runs: StepRuns, message: AssistantMessage): { steps: MessageSteps; grown?: { entry: number; steps: MessageSteps } } {
  const builder = new RunBuilder();
  const places = new Map<number, readonly StepItem[] | null>();
  const head = runs.open && runs.byEntry.get(runs.open.entry);
  if (!runs.open || !head) {
    builder.message(message, true, places);
    return { steps: places };
  }
  const items = [...runs.open.items];
  builder.run = { index: runs.open.index, items };
  builder.message(message, true, places);
  if (items.length === runs.open.items.length) return { steps: places };
  return { steps: places, grown: { entry: runs.open.entry, steps: new Map(head).set(runs.open.index, items) } };
}

/** Whether two places of a message's steps place the same steps. */
export function sameSteps(prev: MessageSteps | undefined, next: MessageSteps | undefined): boolean {
  if (prev === next) return true;
  if (!prev || !next || prev.size !== next.size) return false;
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

/** An MCP tool's server and tool, by its name; nothing for a built-in tool. */
export function mcpParts(name: string): [server: string, tool: string] | undefined {
  let split = name.indexOf(MCP_TOOL_SEPARATOR);
  if (split <= 0) return undefined;
  // A server slug can end in "_" ("Reports (beta)" is "reports_beta_"): the separator is the last two of the run.
  while (name[split + MCP_TOOL_SEPARATOR.length] === "_") split++;
  return [name.slice(0, split), name.slice(split + MCP_TOOL_SEPARATOR.length)];
}

const times = (n: number) => (n === 1 ? "" : n === 2 ? " twice" : ` ${n} times`);

/** What a kind of step did, for so many of them, in the words of a run's summary. */
const SAID: Record<string, (n: number) => string> = {
  run_bash: (n) => (n === 1 ? "ran a command" : `ran ${n} commands`),
  run_python: (n) => (n === 1 ? "ran Python" : `ran Python${times(n)}`),
  "write:new": (n) => (n === 1 ? "wrote a page" : `wrote ${n} pages`),
  "write:edit": (n) => `edited the page${times(n)}`,
  [CHECK_TOOL]: (n) => `checked the page${times(n)}`,
  [PUBLISH_TOOL]: (n) => `published${times(n)}`,
  [DRAFTS_TOOL]: (n) => `listed drafts${times(n)}`,
  artifact_read: (n) => (n === 1 ? "read an artifact" : `read ${n} artifacts`),
  artifact_history: (n) => `looked at version history${times(n)}`,
  artifact_diff: (n) => `compared versions${times(n)}`,
  files_list: (n) => `listed files${times(n)}`,
  files_read: (n) => (n === 1 ? "read a file" : `read ${n} files`),
  files_write: (n) => (n === 1 ? "wrote a file" : `wrote ${n} files`),
  skill_propose: (n) => (n === 1 ? "proposed a skill" : `proposed ${n} skills`),
  [MCP_DISCOVER_TOOL]: (n) => `looked up MCP servers${times(n)}`,
  tool_search: (n) => `searched for tools${times(n)}`,
  react: (n) => `reacted${times(n)}`,
};

/** A step's kind for its summary: a page write by whether it writes a new page, an MCP call by its server. */
function kindOf(call: Pick<ToolCall, "name" | "arguments">): string {
  if (call.name === WRITE_TOOL) return typeof call.arguments?.html === "string" ? "write:new" : "write:edit";
  const mcp = mcpParts(call.name);
  return mcp ? `mcp:${mcp[0]}` : call.name;
}

function said(kind: string, n: number): string {
  if (SAID[kind]) return SAID[kind](n);
  if (kind.startsWith("mcp:")) return `queried ${kind.slice(4)}${times(n)}`;
  return `used ${kind}${times(n)}`;
}

/**
 * A run's summary in a line: what its calls did, by kind in the order they first came ("Queried sales 5 times, ran 3
 * commands"). Thoughts count only in a run of nothing else.
 */
export function runSummary(items: readonly StepItem[]): string {
  const kinds = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const kind = kindOf(item.call);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const line = kinds.size ? [...kinds].map(([kind, n]) => said(kind, n)).join(", ") : plural(items.length, "thought");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
