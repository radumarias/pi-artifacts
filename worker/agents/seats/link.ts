// What a chat (the room) and a member's agent object (where the member's agent has its seat) say to each other by
// RPC. The room keeps the log and the turn controller; the seat keeps a pi session per room for the agent, with its
// owner's sign-ins, files, skills and budget, which never leave the owner's object. Only labelled lines of the log go
// in, and only a turn's reply (with what the app recorded of its calls) comes back.

import type { ChatTurnData } from "../../../shared/agents.ts";
import type { ChatKind } from "../../../shared/chat-kinds.ts";
import type { Outputs, TurnResult } from "../controller.ts";

/** Which room a seat is for: the chat's owner and id, from which its object's name is built. */
export interface RoomRef {
  ownerUid: string;
  chatId: string;
}

/**
 * Lines of the room's log for a seat's session: the labelled messages (CatchUp) of the entries after `from - 1` through
 * `through`. A seat places a batch once: one through what it has is a duplicate, and one that starts after it has a gap,
 * which the seat fills by pulling the range from the room (`RoomLink.log`).
 */
export interface SeatBatch {
  /** The first log entry the batch covers: the one after what the room last saw the seat take. */
  from: number;
  /** The newest log entry it covers. */
  through: number;
  /** The text to write; empty when nothing in the range is for the agent to read. */
  text: string;
  /** The turn it goes before: its input carries the message it answers, which the batch leaves out. */
  turn: number;
}

/** A turn the room gives a seat: its id in the room, who asked, and the input (turnInput) that starts it. */
export interface SeatTurn extends ChatTurnData {
  /** The message it answers, as one labelled line (AgentTurn.ask): what the seat's session reads of a forked turn. */
  ask: string;
  input: string;
  /** The agent's owner's name as the room shows it: its instructions name them. */
  ownerName: string;
  /** The room's kind as the turn starts: the seat's memory notes read as that chat's (ChatMemory, MemoryAgent.room). */
  kind: ChatKind;
  /** Its owner asked for it: the seat checks this against the asker itself before it offers any private server. */
  byOwner: boolean;
  /** In a chain no person started (a run's hand-over): it only reads, whatever `byOwner` says. */
  unattended?: true;
}

/** How a seat's turn ended, with what the app recorded of it (sources only from a fork): the room builds the reply from it. */
export type SeatResult = TurnResult & Outputs;

/** What the room's turn controller calls on an agent's seat (one per roster entry with a `seat`). */
export interface SeatLink {
  /**
   * Give the agent a turn, after the lines of the log said since it last read (`batch`, none when nothing new); returns
   * once its input is in, with the newest log entry the seat has taken (its delivered seq). Giving one twice places it
   * once. The link adds its owner's name and the room's kind.
   */
  give(batch: SeatBatch | null, turn: Omit<SeatTurn, "ownerName" | "kind">): Promise<number>;
  /** Stop a turn the seat runs. */
  abort(turn: number): Promise<void>;
  /** Have the seat send again the results of the turns it ended that the room has not taken (after a restart of either). */
  wake(): Promise<void>;
}

/** What a seat calls on its room. */
export interface RoomLink {
  /** The lines of the log after entry `after`, for turn `turn`: what fills a gap. */
  log(after: number, turn: number): Promise<SeatBatch>;
  /** A turn ended. True once the room took it (also when it had already, or the turn is gone): the seat lets it go. */
  ended(turn: number, result: SeatResult): Promise<boolean>;
}
