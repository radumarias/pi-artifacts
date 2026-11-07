import type { EntryRecord } from "@earendil-works/pi-durable";
import { MAX_HOPS, type AgentDefinition, type ChatAgentReplyData, type ChatTurnData } from "../../shared/agents.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { errorMessage, serial } from "../../shared/util.ts";
import type { AgentTurn, ChatRoster, RosterEntry, TurnRequest } from "./roster.ts";
import { askOf, CatchUp, entryAskKey, handOffs, itemsIn, MAX_ASK_CHARS, publishedIn, turnAskKey, turnInput } from "./turns.ts";

/** What a turn left in its session for its reply to show. */
type Outputs = Required<Pick<ChatAgentReplyData, "published" | "items">>;
const NO_OUTPUTS: Outputs = { published: [], items: [] };

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
  /** Set an agent's session up for a turn: its model and effort, its instructions, and the tools the turn may use. */
  configure(entry: RosterEntry, agent: AgentDefinition, turn: AgentTurn): Promise<void>;
  /** The chat's log (the root conversation) after entry `after`, a page at a time, newest first. */
  logSince(after: number): AsyncIterable<readonly EntryRecord[]>;
  /** A passive write into a session: context, no run. `requestId` keeps a retry from placing it twice. */
  write(session: string, text: string, requestId: string): Promise<void>;
  /** The turn's input into its session, which starts its run. */
  submit(session: string, input: string, operationId: string, data: ChatTurnData): Promise<void>;
  /** Wait for an operation of a session to settle. */
  wait(session: string, operationId: string): Promise<TurnResult>;
  /** Stop what a session runs, and what waits in its inbox. */
  abort(session: string): Promise<void>;
  /** The session's entries from the turn's input on (its chat.turn entry), oldest first: where its outputs are found. */
  turnEntries(session: string, turn: number): Promise<readonly EntryRecord[]>;
  /** Post an agent's reply to the log, placed once however often it is posted. */
  post(reply: ChatAgentReplyData): Promise<void>;
  /** Write an agent's reply as context pi reads, placed once however often (not when pi is handed a turn for it). */
  tellPi(reply: ChatAgentReplyData): Promise<void>;
  /** Give pi a turn an agent named it for (`data.turn`, that agent's turn): placed once however often it is handed. */
  handToPi(input: string, data: ChatTurnData): Promise<void>;
  /** The roster's view changed (an agent started or ended a turn, or was dropped): tell everyone. */
  changed(): void;
  /** Keep the object alive for work that outlives the call that started it. */
  waitUntil(promise: Promise<unknown>): void;
}

/** Who gives agents turns, as `call` takes it: their request, less the agent; `hop` is 0 unless said. */
export type Caller = Omit<TurnRequest, "agentId" | "hop"> & { hop?: number };

/**
 * The chat's turn controller for the agents of its roster (not pi, whose turns are pi's own inbox). Each agent takes
 * one turn at a time from a queue in the chat's SQLite: before a turn, its session reads what was said since its last
 * one and is set up for whoever asked; its final answer is posted to the log, and the agents it names get the next
 * turns, within MAX_HOPS hand-offs per chain. A turn survives a restart: `resume` waits on running turns again, and
 * delivers the replies of ended ones not delivered yet.
 */
export class AgentTurns {
  readonly #host: TurnHost;
  /** Per agent, its turns started one at a time, so two never start at once. */
  readonly #pumps = new Map<string, () => Promise<void>>();
  /** The turns this object waits on, so a resume does not wait on one twice. */
  readonly #waiting = new Set<number>();

  constructor(host: TurnHost) {
    this.#host = host;
  }

  /** Queue a turn for each agent, in order, and start them. */
  call(agentIds: readonly string[], caller: Caller): AgentTurn[] {
    // The turns one message gives share one chain, so its hand-offs stay within MAX_HOPS however many agents it names:
    // without one of their own, the first turn starts it for the rest.
    let root = caller.root;
    const turns = agentIds.flatMap((agentId) => {
      if (!this.#host.roster.get(agentId)) return [];
      const turn = this.#host.roster.enqueue({ ...caller, agentId, hop: caller.hop ?? 0, root });
      root ??= turn.id;
      return [turn];
    });
    if (turns.length) this.#host.changed();
    for (const turn of turns) this.pump(turn.agentId);
    return turns;
  }

  /** Start an agent's next turn when it has none running. Never throws: a failed start fails that turn. */
  pump(agentId: string): Promise<void> {
    let pump = this.#pumps.get(agentId);
    if (!pump) {
      pump = serial(() => this.#startNext(agentId).catch((error: unknown) => console.error("agent turn:", errorMessage(error))));
      this.#pumps.set(agentId, pump);
    }
    const started = pump();
    this.#host.waitUntil(started);
    return started;
  }

  async #startNext(agentId: string): Promise<void> {
    const roster = this.#host.roster;
    let entry = roster.get(agentId);
    if (!entry) return;
    const turn = roster.startNext(agentId);
    if (!turn) return;
    this.#host.changed();
    // A person's Stop, or the agent leaving the roster, can end the turn at any await: it then goes no further.
    const live = () => roster.turn(turn.id)?.status === "running";
    try {
      const agent = await this.#host.definition(entry);
      if (!live()) return;
      if (!agent) {
        // Its owner deleted it: it leaves the roster, and what waited for it with it.
        roster.remove(agentId);
        this.#host.changed();
        return;
      }
      const refreshed = roster.refresh(agentId, { name: agent.name, avatar: agent.avatar, color: agent.color, job: agent.job, off: !agent.enabled });
      if (!refreshed) return;
      entry = refreshed.entry;
      if (refreshed.changed) this.#host.changed();
      if (!agent.enabled) {
        await this.#ended(entry, turn, { status: "unanswered", reason: `its owner turned @${entry.name} off` });
        return;
      }
      // A turn in a session of its own reads that session, not the chat: it catches up on nothing.
      await Promise.all([turn.session ? undefined : this.#catchUp(entry, turn.id), this.#host.configure(entry, agent, turn)]);
      if (!live()) return;
      await this.#host.submit(sessionOf(entry, turn), turnInput(turn), operationId(turn.id), { turn: turn.id, calledBy: turn.calledBy, hop: turn.hop });
      roster.markSubmitted(turn.id);
      if (!live()) {
        // Stopped while its input went in: the stop's abort may have come first, so the run it started stops too.
        await this.#host.abort(sessionOf(entry, turn)).catch((error: unknown) => console.error("agent stop:", errorMessage(error)));
        return;
      }
    } catch (error) {
      await this.#ended(entry, turn, { status: "unanswered", reason: errorMessage(error) });
      return;
    }
    this.#host.waitUntil(this.#await(entry, { ...turn, submitted: true }));
  }

  /**
   * Send an agent's session what was said in the log since its last turn, as one passive write. The log is read newest
   * first, and only as far back as the catch-up keeps.
   */
  async #catchUp(entry: RosterEntry, turn: number): Promise<void> {
    const catchUp = new CatchUp(entry.agentId, entry.ownerUid, this.#host.roster.askKeys(entry.agentId, turn));
    for await (const page of this.#host.logSince(entry.mirrored)) if (!catchUp.add(page)) break;
    const { text, through } = catchUp.result();
    if (through <= entry.mirrored) return;
    if (text) await this.#host.write(entry.session, text, `mirror:${entry.agentId}:${through}`);
    this.#host.roster.setMirrored(entry.agentId, through);
  }

  /** Wait for a turn's run to end, then end it. */
  async #await(entry: RosterEntry, turn: AgentTurn): Promise<void> {
    if (this.#waiting.has(turn.id)) return;
    this.#waiting.add(turn.id);
    try {
      let result: TurnResult;
      try {
        result = await this.#host.wait(sessionOf(entry, turn), operationId(turn.id));
      } catch (error) {
        result = { status: "unanswered", reason: errorMessage(error) };
        // The run may still be going: stop it before the next turn sets the session up for someone else's tools.
        await this.#host.abort(sessionOf(entry, turn)).catch((abortError: unknown) => console.error("agent stop:", errorMessage(abortError)));
      }
      await this.#ended(entry, turn, result);
    } finally {
      this.#waiting.delete(turn.id);
    }
  }

  /**
   * A turn ended: it ends in the roster with its reply to deliver, and its hand-offs are queued, with no await in
   * between, so a restart never loses them or queues them twice; the reply is delivered after. Only once: a turn that
   * ended already (a second wait on it, a Stop meanwhile) delivers nothing.
   */
  async #ended(entry: RosterEntry, turn: AgentTurn, result: TurnResult): Promise<void> {
    const roster = this.#host.roster;
    const now = roster.turn(turn.id);
    let delivering: Promise<void> | undefined;
    if (now?.status === "running" || now?.status === "queued") {
      const done = result.status === "done";
      const text = (result.text ?? "").trim();
      // Only a turn whose input went in has outputs in its session.
      const { published, items } = now.submitted ? await this.#outputs(sessionOf(entry, turn), turn.id) : NO_OUTPUTS;
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
        startedAt: now.startedAt ?? now.createdAt,
        endedAt: roster.now(),
        ...(!done && { failed: result.reason ?? "it ended without an answer" }),
        ...(published.length && { published }),
        ...(turn.run && { run: turn.run }),
        ...(items.length && { items }),
      };
      // Who it hands work to, within what the chain may still make.
      const left = MAX_HOPS - roster.handOffsFrom(turn.root);
      const next = done && left > 0 ? handOffs(text, entry.agentId, turn.hop, roster.list()).slice(0, left) : [];
      // A chain no person started never hands pi a turn: pi has the owner's full tools. It reads the reply instead.
      if (roster.end(turn.id, done ? "done" : "failed", { reply, toPi: !turn.unattended && next.includes(AGENT_NAME) })) {
        const agents = next.filter((id) => id !== AGENT_NAME);
        // A hand-off can only read, whoever started the chain: agents cannot give each other permission.
        const ask = askOf({ name: current.name, kind: "agent" }, text, MAX_ASK_CHARS);
        const calledBy = { name: current.name, agentId: entry.agentId };
        const hop = { calledBy, ask, askKey: turnAskKey(turn.id), byOwner: false, hop: turn.hop + 1, root: turn.root, unattended: turn.unattended };
        if (agents.length) this.call(agents, hop);
        delivering = this.#deliver(turn.id);
      }
    }
    this.#host.changed();
    this.pump(entry.agentId);
    await delivering;
  }

  /** The artifacts a turn published and the records its tool results held, as its session's entries say; none when they cannot be read. */
  async #outputs(session: string, turn: number): Promise<Outputs> {
    try {
      const entries = await this.#host.turnEntries(session, turn);
      return { published: publishedIn(entries), items: itemsIn(entries) };
    } catch (error) {
      console.error("agent turn, outputs:", errorMessage(error));
      return NO_OUTPUTS;
    }
  }

  /**
   * Deliver an ended turn's reply: to the log, then to pi when it named pi. Delivering one twice places it once. A
   * failure is logged, and the reply is let go as delivered.
   */
  async #deliver(id: number): Promise<void> {
    const roster = this.#host.roster;
    const outbox = roster.outbox(id);
    const turn = roster.turn(id);
    if (!outbox || !turn) return;
    const { reply } = outbox;
    try {
      await this.#host.post(reply);
      // Read again: a Stop meanwhile hands pi nothing, and pi reads the reply as context instead. A turn handed to pi
      // carries the reply in its input.
      if (roster.outbox(id)?.toPi) {
        const calledBy = { name: reply.name, agentId: reply.agentId };
        const handed = { calledBy, hop: turn.hop + 1, ask: askOf({ name: reply.name, kind: "agent" }, reply.text, MAX_ASK_CHARS) };
        await this.#host.handToPi(turnInput(handed), { turn: id, calledBy, hop: handed.hop, root: turn.root });
      } else await this.#host.tellPi(reply);
    } catch (error) {
      console.error("agent reply:", errorMessage(error));
    }
    roster.markDelivered(id);
  }

  /**
   * After the object restarted: deliver the replies not delivered yet, wait again on the turns it was running, and
   * start the agents that have turns waiting. Cheap when there are none, as on most wakes.
   */
  resume(): void {
    const roster = this.#host.roster;
    if (!roster.hasWork()) return;
    // A turn whose input never went in (the object stopped while it was set up) starts again, from the queue.
    roster.requeueUnsubmitted();
    for (const id of roster.undelivered()) this.#host.waitUntil(this.#deliver(id));
    for (const turn of roster.allRunning()) {
      const entry = roster.get(turn.agentId);
      if (entry && !this.#waiting.has(turn.id)) this.#host.waitUntil(this.#await(entry, turn));
    }
    for (const agentId of roster.waitingAgents()) this.pump(agentId);
  }

  /** Stop every agent's turns, or one agent's: running ones are aborted, waiting ones dropped. True when one was stopped. */
  async stop(agentId?: string): Promise<boolean> {
    return this.#stopped(this.#host.roster.stopAll(agentId));
  }

  /** Someone left the chat: their turns stop, and those their messages handed on (ChatRoster.stopFor). True when one did. */
  async leave(uid: string): Promise<boolean> {
    return this.#stopped(this.#host.roster.stopFor(uid));
  }

  /** Abort the sessions of the turns just stopped that had started, and tell everyone. */
  async #stopped(stopped: readonly AgentTurn[]): Promise<boolean> {
    const roster = this.#host.roster;
    const sessions = new Set(
      stopped.filter((turn) => turn.startedAt !== undefined).flatMap((turn) => turn.session ?? roster.get(turn.agentId)?.session ?? []),
    );
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
    const agents = left > 0 ? handOffs(text, AGENT_NAME, chain.hop, roster.list()).slice(0, left) : [];
    if (!agents.length) return;
    this.call(agents, {
      calledBy: { name: AGENT_NAME, agentId: AGENT_NAME },
      ask: askOf({ name: AGENT_NAME, kind: "agent" }, text),
      askKey: entryAskKey(entry),
      byOwner: false,
      hop: chain.hop + 1,
      ...(chain.root !== undefined && { root: chain.root }),
    });
  }
}

/** The session a turn runs in: its own, else its agent's. */
export function sessionOf(entry: Pick<RosterEntry, "session">, turn: Pick<AgentTurn, "session">): string {
  return turn.session ?? entry.session;
}

/** A turn's operation id in its agent's session: submitting it twice places it once. */
export function operationId(turn: number): string {
  return `turn:${turn}`;
}
