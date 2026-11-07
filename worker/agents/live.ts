// What a chat's sockets are sent of an agent's session while it has a turn: only that turn, so a socket that attaches
// mid-turn gets the turn's entries, never the agent's whole history (withoutSystemPrompt then strips its setup).

import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { CHAT_TURN_KIND, type ChatTurnData } from "../../shared/agents.ts";

/** Whether `entry` is the input that started turn `turn` in its agent's session. */
export function isTurnEntry(entry: Pick<EntryRecord, "kind" | "data">, turn: number): boolean {
  return entry.kind === CHAT_TURN_KIND && (entry.data as Partial<ChatTurnData> | undefined)?.turn === turn;
}

/** The entry an event carries, if any. */
function entryOf(event: AgentEvent): EntryRecord | undefined {
  return event.type === "message_end" || event.type === "entry_appended" || event.type === "tool_execution_end" ? event.entry : undefined;
}

/** A compaction's summary entry: it sums up the session's context before it (other turns, the catch-ups), never shown. */
const isSummary = (entry: EntryRecord) => entry.kind === "pi.compaction";

/**
 * Follows one agent session's events for one of its turns, and passes on only what belongs to that turn: a snapshot cut
 * to the turn's entries, the entries from the turn's input on, and the run's live events. Before the turn's input is
 * placed (the session reads the chat's catch-up first), nothing is passed on: that is the agent's context, not its work.
 * The session's state changes, usage, inbox and compaction summaries are left out.
 *
 * Once the filter knows the input's entry id (seen in a snapshot or as it lands, or `inputId` when the caller looked it
 * up), a compaction that cut past the input changes nothing: a snapshot without the input still holds the turn's
 * entries, those after it.
 */
export class TurnFilter {
  #inputId: number | undefined;

  constructor(
    readonly turn: number,
    inputId?: number,
  ) {
    this.#inputId = inputId;
  }

  /** The events of one batch to send, in order; none when nothing in it is the turn's. */
  pass(events: readonly AgentEvent[]): AgentEvent[] {
    return events.flatMap((event): AgentEvent[] => {
      if (event.type === "snapshot") {
        const at = event.entries.findLastIndex((entry) => isTurnEntry(entry, this.turn));
        if (at >= 0) this.#inputId = event.entries[at].id as number;
        const inputId = this.#inputId;
        const entries = inputId === undefined ? [] : event.entries.filter((entry) => (entry.id as number) >= inputId && !isSummary(entry));
        // A snapshot before the turn's input is placed may show the run before it, which is not this turn's.
        const run = inputId !== undefined ? event : { ...event, run: undefined, generation: undefined, tools: [], nestedTools: [] };
        return [{ ...run, entries, inbox: [] }];
      }
      if (event.type === "agent_changed" || event.type === "usage_changed" || event.type === "inbox_update" || event.type === "submission") return [];
      const entry = entryOf(event);
      if (entry && isTurnEntry(entry, this.turn)) this.#inputId ??= entry.id as number;
      if (this.#inputId === undefined) return [];
      // What landed before the input (a catch-up written meanwhile) or sums up the context is not the turn's.
      if (entry && ((entry.id as number) < this.#inputId || isSummary(entry))) return [];
      return [event];
    });
  }
}
