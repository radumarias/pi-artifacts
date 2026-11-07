// What the chat says, in a line, about its agents' turns: who is next and why, and how each past turn went.

import { MAX_HOPS, type AgentTurnView, type ChatAgentView } from "../../shared/agents.ts";
import { formatElapsed } from "./elapsed.ts";
import { tookFor } from "./Steps.tsx";

/** Who gave a turn, as a line names them: a person by name, an agent by its handle, or the agent's schedule. */
export function callerName(calledBy: AgentTurnView["calledBy"]): string {
  if (calledBy.schedule) return "its schedule";
  return calledBy.agentId ? `@${calledBy.name}` : calledBy.name;
}

/** One line under the running agents: who waits for a turn, why, and how far the chain of hand-offs is. */
interface QueueLine {
  agentId: string;
  text: string;
}

/**
 * The queue lines under the working agents, in the roster's order: for an agent that waits, who is next and why
 * ("@builder is next: @research named it · hand-off 1 of 3"), with how many turns wait for it when more than one; for
 * one that works, how many more wait for it.
 */
export function queueLines(agents: readonly ChatAgentView[]): QueueLine[] {
  return agents.flatMap((agent): QueueLine[] => {
    if (!agent.queued) return [];
    if (agent.busy) return [{ agentId: agent.id, text: `@${agent.name} has ${agent.queued} more ${agent.queued === 1 ? "turn" : "turns"} waiting` }];
    const next = agent.next;
    const why = !next ? "" : next.hop > 0 ? `: ${callerName(next.calledBy)} named it · hand-off ${next.hop} of ${MAX_HOPS}` : `: ${callerName(next.calledBy)} asked`;
    const more = agent.queued > 1 ? ` · ${agent.queued} turns waiting` : "";
    return [{ agentId: agent.id, text: `@${agent.name} is next${why}${more}` }];
  });
}

const STATUS_WORDS: Record<AgentTurnView["status"], string> = { queued: "waiting", running: "working", done: "done", failed: "failed", stopped: "stopped" };

/** One past turn in an agent's runs list: who asked, how long it took, and how it ended ("Ana asked · 14s · done"). */
export function turnLine(turn: AgentTurnView, now: number): string {
  const who = turn.calledBy.schedule ? "on its schedule" : `${callerName(turn.calledBy)} ${turn.hop > 0 ? "handed it on" : "asked"}`;
  const took =
    turn.startedAt === undefined ? undefined : turn.endedAt !== undefined ? tookFor(turn.endedAt - turn.startedAt) : formatElapsed(now - turn.startedAt);
  return [who, took, STATUS_WORDS[turn.status]].filter(Boolean).join(" · ");
}
