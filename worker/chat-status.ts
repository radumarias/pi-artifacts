import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import { textOf } from "../shared/canonical.ts";
import { CHAT_ASIDE_KIND, type ChatStatus } from "../shared/protocol.ts";

/** A question mark at the end, give or take closing quotes, brackets, Markdown emphasis or an emoji. */
const QUESTION_END = /[?？]["'”’)\]*_`\s\p{Extended_Pictographic}\uFE0F]*$/u;
/** A Markdown list item: "- ", "* ", "+ ", "• ", "1. " or "1) ". */
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;

/**
 * Whether a reply ends by asking the user something: its last paragraph ends with a question mark, or the line just
 * before a closing list does (a question, then the options to pick from). Only the end counts: a question in passing
 * earlier in a reply that then goes on is not one the agent waits on.
 */
export function asksUser(text: string): boolean {
  const trimmed = text.trim();
  const paragraphs = trimmed.split(/\n\s*\n/);
  if (QUESTION_END.test(paragraphs[paragraphs.length - 1])) return true;
  const lines = trimmed.split("\n");
  let end = lines.length;
  while (end > 0 && (LIST_ITEM.test(lines[end - 1]) || !lines[end - 1].trim())) end--;
  return end > 0 && end < lines.length && QUESTION_END.test(lines[end - 1]);
}

/**
 * What a transcript entry says about whether the agent waits on the user: the text of an assistant message that ended
 * its turn, "" for one that called tools, failed or was stopped, or for a person's message (the agent has their
 * answer), and undefined for anything else (tool results, notices, and people talking among themselves in a shared
 * chat, which answers nothing the agent asked).
 */
function lastWord(entry: EntryRecord): string | undefined {
  if (entry.kind === CHAT_ASIDE_KIND) return undefined;
  const message = entry.model?.[0];
  if (message?.role === "user") return "";
  if (message?.role !== "assistant") return undefined;
  const reply = message as AssistantMessage;
  return reply.stopReason === "stop" ? textOf(reply.content) : "";
}

/**
 * A chat's status as the sidebars show it, from its pi events: "running" while a run goes or people's messages wait
 * for one, "waiting" when the last run ended on a question to the user, and null otherwise.
 */
export class RunTracker {
  #running = false;
  /** Inputs waiting in pi's inbox that will start a run; passive writes (notices) do not. */
  #waitingInputs = 0;
  /** The text the agent ended its last turn with; "" when it ended any other way, or someone wrote since. */
  #lastReply = "";

  constructor(snapshot: SnapshotEvent) {
    this.#reset(snapshot);
  }

  /** Start over from a snapshot: on attach, and when the stream overflowed. */
  #reset(snapshot: SnapshotEvent): void {
    this.#running = snapshot.run !== undefined;
    this.#waitingInputs = snapshot.inbox.filter((item) => item.mode !== "write").length;
    this.#lastReply = "";
    for (let i = snapshot.entries.length - 1; i >= 0; i--) {
      const text = lastWord(snapshot.entries[i]);
      if (text === undefined) continue;
      this.#lastReply = text;
      break;
    }
  }

  apply(batch: readonly AgentEvent[]): void {
    for (const event of batch) {
      if (event.type === "snapshot") this.#reset(event);
      else if (event.type === "run_start") {
        this.#running = true;
        this.#lastReply = "";
      } else if (event.type === "run_end") this.#running = false;
      else if (event.type === "inbox_update") this.#waitingInputs = event.items.filter((item) => item.mode !== "write").length;
      else if (event.type === "message_end") {
        const text = lastWord(event.entry);
        if (text !== undefined) this.#lastReply = text;
      }
    }
  }

  get status(): ChatStatus | null {
    if (this.#running || this.#waitingInputs > 0) return "running";
    return asksUser(this.#lastReply) ? "waiting" : null;
  }
}
