// How far a call in a chat may go (shared/limits.ts), as plain functions the tests run: what the input a pi run answers
// allows, and what an agent's turn allows. A run goes as far as its agent's autonomy (gate.ts reads it from the
// definition); a page runs as its author.

import { CHAT_TURN_KIND, type ChatTurnData } from "../../../shared/agents.ts";
import type { CallerLevel } from "../../../shared/limits.ts";
import { CHAT_MESSAGE_KIND, type ChatMessageData } from "../../../shared/protocol.ts";
import type { AgentTurn } from "../roster.ts";

/**
 * What one of pi's inputs allows: the owner's own message runs (4), but not their Yes to an offer, which only drafts
 * (its tools are narrowed to reading and agent_propose; anything else that changes data only proposes); anyone else's
 * only proposes (2); a hand-off goes no further than the turn that handed it, which runs only when that turn did
 * (turnLevel) and was a turn a person gave, never one of a run's chains; an input of a kind the app does not know only
 * proposes.
 */
export function inputLevel(
  entry: { kind: string; data?: unknown } | undefined,
  ownerUid: string,
  turn: (id: number) => Pick<AgentTurn, "byOwner" | "calledBy" | "unattended"> | null,
): CallerLevel {
  if (entry?.kind === CHAT_MESSAGE_KIND) {
    const data = entry.data as ChatMessageData;
    if (data.uid !== ownerUid) return { level: 2, because: `on ${data.name}'s message` };
    return data.drafts ? { level: 2, because: YES_ONLY_DRAFTS } : { level: 4, because: "on your own message" };
  }
  if (entry?.kind === CHAT_TURN_KIND) {
    const data = entry.data as ChatTurnData;
    const handing = turn(data.turn);
    if (handing && !handing.unattended && turnLevel(handing).level === 4) return { level: 4, because: "handed over on your own message" };
    return { level: 2, because: `handed over by ${data.calledBy.name}` };
  }
  return { level: 2, because: "on a message the app did not write down" };
}

/** The lowest of the levels a run's inputs allow: a run answering several goes no further than the least of them. */
export function lowestLevel(levels: readonly CallerLevel[]): CallerLevel | undefined {
  return levels.length ? levels.reduce((low, one) => (one.level < low.level ? one : low)) : undefined;
}

/** Why the owner's Yes to an offer only proposes a change: it drafts a routine, nothing more. */
const YES_ONLY_DRAFTS = "on your Yes to an offer, which only drafts";

/**
 * What an agent's turn in a chat allows: its owner's own message that names it runs (4). A turn nobody asked of it
 * only proposes (2): one the chat's router picked it for (the owner named nobody), one it took on its own (speaking up,
 * a follow-up), as does the owner's Yes to an offer (it drafts, with draftTools, and nothing more). Any other turn (a
 * member's, a hand-off) proposes too, and is offered no tool that changes data in the first place (allowedTools).
 */
export function turnLevel(turn: Pick<AgentTurn, "byOwner" | "calledBy">): CallerLevel {
  const { calledBy } = turn;
  if (calledBy.unprompted) return { level: 2, because: "on a turn nobody asked of it" };
  if (!turn.byOwner) return { level: 2, because: `on a turn ${calledBy.name} gave it` };
  if (calledBy.routed) return { level: 2, because: "on your message, which named no agent (the chat picked it)" };
  if (calledBy.drafts) return { level: 2, because: YES_ONLY_DRAFTS };
  return { level: 4, because: "on your own message" };
}
