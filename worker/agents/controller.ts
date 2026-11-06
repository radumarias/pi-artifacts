import type { EntryRecord } from "@earendil-works/pi-durable";
import { CHAT_TURN_KIND, defaultAvatar, defaultColor, MAX_HOPS, type AgentDefinition, type ChatAgentReplyData, type ChatTurnData } from "../../shared/agents.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { errorMessage } from "../../shared/util.ts";
import type { AgentTurn, ChatRoster, RosterEntry } from "./roster.ts";
import { askOf, handOffs, mirrorText, publishedIn, turnInput } from "./turns.ts";

/** How one operation in an agent's session ended, as PiHarness.wait says. */
export interface TurnResult {
  status: "done" | "unanswered";
  text?: string;
  reason?: string;
}

/** What the turn controller needs from the chat object it runs in: pi's sessions, the log, and the owner's directory. */
export interface TurnHost {
  readonly roster: ChatRoster;
  /** The owner's current definition of an agent; null when it is gone. */
  definition(entry: RosterEntry): Promise<AgentDefinition | null>;
  /** The name to show for an agent's owner. */
  ownerName(uid: string): string;
  /** Set an agent's session up for a turn: its model and effort, its instructions, and the tools the turn may use. */
  configure(entry: RosterEntry, agent: AgentDefinition, turn: AgentTurn): Promise<void>;
  /** The chat's log (the root conversation) after entry `after`, oldest first. */
  logAfter(after: number): Promise<readonly EntryRecord[]>;
  /** A passive write into a session: context, no run. `requestId` keeps a retry from placing it twice. */
  write(session: string, text: string, requestId: string): Promise<void>;
  /** The turn's input into its session, which starts its run. */
  submit(session: string, input: string, operationId: string, data: ChatTurnData): Promise<void>;
  /** Wait for an operation of a session to settle. */
  wait(session: string, operationId: string): Promise<TurnResult>;
  /** Stop what a session runs, and what waits in its inbox. */
  abort(session: string): Promise<void>;
  /** The session's entries from the turn's input on (its chat.turn entry), oldest first: where its published pages are found. */
  turnEntries(session: string, turn: number): Promise<readonly EntryRecord[]>;
  /** Post an agent's reply to the log; `forPi`: also as context pi reads (not when pi is handed the turn, which carries it). */
  post(reply: ChatAgentReplyData, forPi: boolean): Promise<void>;
  /** Give pi a turn: another agent named it. */
  handToPi(turn: { hop: number; root: number; calledBy: ChatAgentReplyData["calledBy"]; ask: string }): Promise<void>;
  /** The roster's view changed (an agent started or ended a turn, or was dropped): tell everyone. */
  changed(): void;
  /** Keep the object alive for work that outlives the call that started it. */
  waitUntil(promise: Promise<unknown>): void;
}

/** Who gave an agent a turn, as `call` takes it. */
export interface Caller {
  calledBy: ChatAgentReplyData["calledBy"];
  /** The asking message, as its labelled line. */
  ask: string;
  askKey?: string;
  byOwner: boolean;
  answers?: number;
  hop?: number;
  root?: number;
}

/**
 * The chat's turn controller for the agents of its roster (not pi, whose turns are pi's own inbox). Each agent takes
 * one turn at a time from a queue in the chat's SQLite: before a turn, its session reads what was said since its last
 * one and is set up for whoever asked; its final answer is posted to the log, and the agents it names get the next
 * turns, within MAX_HOPS hand-offs per chain. A turn survives a restart: `resume` waits on running turns again.
 */
export class AgentTurns {
  readonly #host: TurnHost;
  /** Per agent, the pumping now going, so two never start one agent's turns at once. */
  readonly #pumps = new Map<string, Promise<void>>();
  /** The turns this object waits on, so a resume does not wait on one twice. */
  readonly #waiting = new Set<number>();

  constructor(host: TurnHost) {
    this.#host = host;
  }

  /** Queue a turn for each agent, in order, and start them. */
  call(agentIds: readonly string[], caller: Caller): AgentTurn[] {
    // Hand-offs from one reply share one chain: without one of their own, the first turn starts it for the rest.
    let root = caller.root;
    const turns = agentIds.flatMap((agentId) => {
      if (!this.#host.roster.get(agentId)) return [];
      const { calledBy, answers, byOwner, ask, askKey } = caller;
      const turn = this.#host.roster.enqueue({ agentId, hop: caller.hop ?? 0, root, calledBy, answers, byOwner, ask, askKey });
      if ((caller.hop ?? 0) > 0) root ??= turn.id;
      return [turn];
    });
    if (turns.length) this.#host.changed();
    for (const turn of turns) this.pump(turn.agentId);
    return turns;
  }

  /** Start an agent's next turn when it has none running. Never throws: a failed start fails that turn. */
  pump(agentId: string): Promise<void> {
    const previous = this.#pumps.get(agentId) ?? Promise.resolve();
    const next = previous.then(() => this.#startNext(agentId));
    const kept = next.catch((error: unknown) => console.error("agent turn:", errorMessage(error)));
    this.#pumps.set(agentId, kept);
    void kept.finally(() => {
      if (this.#pumps.get(agentId) === kept) this.#pumps.delete(agentId);
    });
    this.#host.waitUntil(kept);
    return kept;
  }

  async #startNext(agentId: string): Promise<void> {
    const roster = this.#host.roster;
    const entry = roster.get(agentId);
    if (!entry) return;
    const turn = roster.startNext(agentId);
    if (!turn) return;
    this.#host.changed();
    try {
      const agent = await this.#host.definition(entry);
      if (!agent) {
        // Its owner deleted it: it leaves the roster, and what waited for it with it.
        roster.remove(agentId);
        this.#host.changed();
        return;
      }
      const view = { name: agent.name, avatar: agent.avatar ?? defaultAvatar(agent.name), color: agent.color ?? defaultColor(agent.name), job: agent.job, off: !agent.enabled };
      if (roster.refresh(agentId, view)) this.#host.changed();
      if (!agent.enabled) {
        await this.#ended(roster.get(agentId) ?? entry, turn, { status: "unanswered", reason: `its owner turned @${entry.name} off` });
        return;
      }
      const current = roster.get(agentId) ?? entry;
      await this.#catchUp(current);
      await this.#host.configure(current, agent, turn);
      roster.refresh(agentId, view, agent.version);
      const data: ChatTurnData = { turn: turn.id, calledBy: turn.calledBy, hop: turn.hop };
      await this.#host.submit(current.session, turnInput(turn), operationId(turn.id), data);
    } catch (error) {
      await this.#ended(entry, turn, { status: "unanswered", reason: errorMessage(error) });
      return;
    }
    void this.#await(entry, turn);
  }

  /** Send an agent's session what was said in the log since its last turn, as one passive write. */
  async #catchUp(entry: RosterEntry): Promise<void> {
    const entries = await this.#host.logAfter(entry.mirrored);
    if (!entries.length) return;
    const { text, through } = mirrorText(entries, entry.agentId, entry.ownerUid, this.#host.roster.askKeys(entry.agentId));
    if (text) await this.#host.write(entry.session, text, `mirror:${entry.agentId}:${through}`);
    this.#host.roster.setMirrored(entry.agentId, through);
  }

  /** Wait for a turn's run to end, then post its reply and start what follows. */
  async #await(entry: RosterEntry, turn: AgentTurn): Promise<void> {
    if (this.#waiting.has(turn.id)) return;
    this.#waiting.add(turn.id);
    try {
      let result: TurnResult;
      try {
        result = await this.#host.wait(entry.session, operationId(turn.id));
      } catch (error) {
        result = { status: "unanswered", reason: errorMessage(error) };
      }
      await this.#ended(entry, turn, result);
    } finally {
      this.#waiting.delete(turn.id);
    }
  }

  /** A turn ended: once only, its reply goes to the log, and its hand-offs and the agent's next turn start. */
  async #ended(entry: RosterEntry, turn: AgentTurn, result: TurnResult): Promise<void> {
    const roster = this.#host.roster;
    const ended = roster.end(turn.id, result.status === "done" ? "done" : "failed");
    // Stopped meanwhile (a person's Stop, or the agent left the roster): it posts nothing.
    if (!ended) {
      this.#host.changed();
      this.pump(entry.agentId);
      return;
    }
    const text = (result.text ?? "").trim();
    let published: ChatAgentReplyData["published"] = [];
    try {
      published = publishedIn(await this.#host.turnEntries(entry.session, turn.id));
    } catch (error) {
      console.error("agent turn, pages:", errorMessage(error));
    }
    const current = roster.get(entry.agentId) ?? entry;
    const reply: ChatAgentReplyData = {
      agentId: entry.agentId,
      name: current.name,
      avatar: current.avatar,
      color: current.color,
      ownerUid: current.ownerUid,
      text,
      calledBy: turn.calledBy,
      turn: turn.id,
      hop: turn.hop,
      startedAt: ended.startedAt ?? ended.createdAt,
      endedAt: ended.endedAt ?? Date.now(),
      ...(result.status !== "done" && { failed: result.reason ?? "it ended without an answer" }),
      ...(turn.answers !== undefined && { answers: turn.answers }),
      ...(published.length && { published }),
    };
    // Who it hands work to, within what the chain may still make.
    const left = MAX_HOPS - roster.handOffsFrom(turn.root);
    const next = result.status === "done" && left > 0 ? handOffs(text, entry.agentId, turn.hop, roster.list()).slice(0, left) : [];
    const toPi = next.includes(AGENT_NAME);
    try {
      await this.#host.post(reply, !toPi);
    } catch (error) {
      console.error("agent reply:", errorMessage(error));
    }
    // The agent's own reply is in its session already: its catch-up starts after it.
    const caller = {
      calledBy: { name: current.name, agentId: entry.agentId },
      ask: askOf({ name: current.name, kind: "agent" }, text),
      askKey: `turn:${turn.id}`,
      // A hand-off can only read, whoever started the chain: agents cannot give each other permission.
      byOwner: false,
      hop: turn.hop + 1,
      root: turn.root,
      ...(turn.answers !== undefined && { answers: turn.answers }),
    };
    const agents = next.filter((id) => id !== AGENT_NAME);
    if (agents.length) this.call(agents, caller);
    if (toPi) {
      await this.#host.handToPi(caller).catch((error: unknown) => console.error("hand to pi:", errorMessage(error)));
    }
    this.#host.changed();
    this.pump(entry.agentId);
  }

  /**
   * After the object restarted: wait again on the turns it was running, and start the agents that have turns waiting.
   * Cheap when there are none, as on most wakes.
   */
  resume(): void {
    const roster = this.#host.roster;
    for (const turn of roster.allRunning()) {
      const entry = roster.get(turn.agentId);
      if (entry && !this.#waiting.has(turn.id)) this.#host.waitUntil(this.#await(entry, turn));
    }
    for (const agentId of roster.waitingAgents()) this.pump(agentId);
  }

  /** Stop every agent's turns, or one agent's: running ones are aborted, waiting ones dropped. True when one was stopped. */
  async stop(agentId?: string): Promise<boolean> {
    const roster = this.#host.roster;
    const stopped = roster.stopAll(agentId);
    const sessions = new Set(stopped.filter((turn) => turn.startedAt !== undefined).flatMap((turn) => roster.get(turn.agentId)?.session ?? []));
    await Promise.all([...sessions].map((session) => this.#host.abort(session).catch((error: unknown) => console.error("agent stop:", errorMessage(error)))));
    if (stopped.length) this.#host.changed();
    return stopped.length > 0;
  }

  /**
   * pi replied (entry `entry` of the log, `text`): the agents it names get turns, as hand-offs within the chain pi's turn
   * was in (`root` and `hop` when another agent handed pi that turn; none when a person asked it).
   */
  fromPi(text: string, entry: number, chain: { hop: number; root?: number } = { hop: 0 }): void {
    const roster = this.#host.roster;
    const left = chain.root === undefined ? MAX_HOPS : MAX_HOPS - roster.handOffsFrom(chain.root);
    const agents = left > 0 ? handOffs(text, AGENT_NAME, chain.hop, roster.list()).filter((id) => id !== AGENT_NAME).slice(0, left) : [];
    if (!agents.length) return;
    this.call(agents, {
      calledBy: { name: AGENT_NAME, agentId: AGENT_NAME },
      ask: askOf({ name: AGENT_NAME, kind: "agent" }, text),
      askKey: `entry:${entry}`,
      byOwner: false,
      hop: chain.hop + 1,
      ...(chain.root !== undefined && { root: chain.root }),
    });
  }
}

/** A turn's operation id in its agent's session: submitting it twice places it once. */
export function operationId(turn: number): string {
  return `turn:${turn}`;
}
