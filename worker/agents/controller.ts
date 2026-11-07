import type { EntryRecord } from "@earendil-works/pi-durable";
import { MAX_HOPS, type AgentDefinition, type AgentDraftView, type ChatAgentReplyData, type ChatTurnData } from "../../shared/agents.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { errorMessage, isObject, serial } from "../../shared/util.ts";
import type { DaySpend } from "./spend.ts";
import { sessionOf, type AgentTurn, type ChatRoster, type PostedPage, type RosterEntry, type TurnRequest } from "./roster.ts";
import { isPass } from "./funnel.ts";
import type { SeatBatch, SeatLink, SeatResult } from "./seats/link.ts";
import { chatTraces } from "../chat-traces.ts";
import {
  askedApart,
  askOf,
  CatchUp,
  entryAskKey,
  handOffs,
  itemsIn,
  MAX_ASK_CHARS,
  publishedIn,
  turnAskKey,
  turnInput,
  UNKNOWN_SOURCE,
} from "./turns.ts";

/**
 * What a turn left in its session for its reply to show: the pages it published, the records its results held, the
 * private servers it called, whether it ran in a fork (only its reply reaches the shared session, from the log), and
 * whether its owner reviews it before it is posted.
 */
export type Outputs = Required<Pick<ChatAgentReplyData, "published" | "items" | "sources">> &
  Pick<ChatAgentReplyData, "saved"> & { forked?: boolean; review?: boolean };
export const NO_OUTPUTS: Outputs = { published: [], items: [], sources: [] };

/** How one operation in an agent's session ended, as PiHarness.wait says. */
export interface TurnResult {
  status: "done" | "unanswered";
  text?: string;
  reason?: string;
  /** What its model calls came to, when another object ran it (a seat): the chat's budget counts it too. */
  spent?: TurnSpent;
}

/** What a turn's model calls came to. */
export type TurnSpent = DaySpend;

/** What the turn controller needs from the chat object it runs in: pi's sessions, the log, and the owner's directory. */
export interface TurnHost {
  readonly roster: ChatRoster;
  /** Whose chat this is: pi's prompts in its log are theirs. */
  readonly chatOwner: string;
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
  /**
   * A new session that sees `session`'s history so far: a turn its owner asked for runs in one. `from`: the newest entry
   * it inherited, after which only its own come.
   */
  fork(session: string): Promise<{ session: string; from?: number }>;
  /** The newest entry of a session; undefined for one with none. */
  newest(session: string): Promise<number | undefined>;
  /**
   * What a forked turn's reply shows of its sources (turnSources), from its session's entries: only the shared servers'
   * records, the private servers it called, and whether its owner reviews it first.
   */
  sources(entry: RosterEntry, entries: readonly EntryRecord[]): Promise<Pick<Outputs, "items" | "sources" | "review">>;
  /** The seat of an agent that runs in its owner's own object (a member's: `entry.seat`). */
  seat(entry: RosterEntry): SeatLink;
  /** Whether `uid` (the person whose message started the turn's chain) may give this agent another turn now: a rate limit. */
  mayCall(entry: RosterEntry, uid: string): Promise<boolean>;
  /** A reply of an agent of `ownerUid`'s is held for them to review, or no longer is: tell them. */
  drafted(ownerUid: string): void;
  /** Keep the object alive for work that outlives the call that started it. */
  waitUntil(promise: Promise<unknown>): void;
  /** Why no turn may start now (the chat's daily budget is used up), as the turn's reply says it; undefined when one may. */
  refusal?(): string | undefined;
  /** A reply was posted that made versions a turn apart published the chat's (ChatRoster.release): announce them now. */
  posted?(pages: readonly PostedPage[]): void;
  /** A turn ended: how, and whether a reply was posted for it (an unprompted turn that passed posts none). For the metrics. */
  ended?(turn: AgentTurn, outcome: TurnOutcome): void;
}

/** How a turn ended, as the metrics count it. */
export interface TurnOutcome {
  status: "done" | "failed" | "passed";
  startedAt: number;
  endedAt: number;
  /** What it spent in another object (a seat's turn: TurnResult.spent). */
  spent?: TurnSpent;
}

/**
 * Who gives agents turns, as `call` takes it: their request, less the agent; `hop` is 0 unless said. A person's message
 * gives a turn to each agent it calls, whoever's they are: `byOwner` holds only for the agents of the person who asked
 * (calledBy.uid), and the ask may be labelled per agent by it ("your owner").
 */
export type Caller = Omit<TurnRequest, "agentId" | "hop" | "ask"> & { hop?: number; ask: string | ((byOwner: boolean) => string) };

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
      const entry = this.#host.roster.get(agentId);
      if (!entry) return [];
      // Never in a chain no person started (a run's hand-over), whatever it says.
      const byOwner = caller.byOwner && !caller.unattended && (caller.calledBy.uid === undefined || caller.calledBy.uid === entry.ownerUid);
      const ask = typeof caller.ask === "function" ? caller.ask(byOwner) : caller.ask;
      const by = caller.by ?? caller.calledBy.uid;
      const turn = this.#host.roster.enqueue({ ...caller, agentId, byOwner, ask, hop: caller.hop ?? 0, root, ...(by !== undefined && { by }) });
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
    const started = roster.startNext(agentId);
    if (!started) return;
    let turn: AgentTurn = started;
    this.#host.changed();
    // A person's Stop, or the agent leaving the roster, can end the turn at any await: it then goes no further.
    const live = () => roster.turn(started.id)?.status === "running";
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
      // Counted for the person who started the chain, however many agents (pi among them) it went through.
      const asker = turn.by ?? turn.calledBy.uid;
      if (asker !== undefined && !(await this.#host.mayCall(entry, asker))) {
        await this.#ended(entry, turn, { status: "unanswered", reason: `@${entry.name} was asked too often just now; try again in a minute` });
        return;
      }
      const refused = this.#host.refusal?.();
      if (refused) {
        await this.#ended(entry, turn, { status: "unanswered", reason: refused });
        return;
      }
      if (!live()) return;
      if (entry.seat !== undefined) {
        // Its owner's own object runs it: the turn ends when the seat says so (seatEnded).
        await this.#giveSeat(entry, turn);
        if (!live()) await this.#abortSeat(entry, turn.id);
        return;
      }
      // A turn its owner asked for runs with all of their tools, so apart from the chat: in a fork of the agent's
      // session, made once (one made before a restart is its session still, its input maybe in it already). A turn in
      // a session of its own (a reply to a run's report) reads that session, not the chat: it forks nothing.
      if (turn.byOwner && turn.session === undefined) {
        // A fork sees the agent's session as it is when made: the catch-up goes in first.
        await this.#catchUp(entry, turn.id);
        // Stopped meanwhile: no fork, which nothing would run in or abort.
        if (!live()) return;
        const { session, from } = await this.#host.fork(entry.session);
        if (!live()) return;
        roster.setFork(turn.id, session, { from, review: agent.reviewBeforePosting === true });
        turn = { ...turn, session, forked: true };
        // Its owner follows it live in the fork from now on, and nobody follows the agent's session for it.
        this.#host.changed();
      } else if (turn.session !== undefined && !turn.forked) {
        // A reply to a run's report runs in the run's reply session, apart from the chat as a fork is, from its newest
        // entry on: what is there already (the report, replies posted before) stays the chat's.
        const from = await this.#host.newest(turn.session);
        if (!live()) return;
        roster.setApart(turn.session, agent.reviewBeforePosting === true, from, turn.id);
      }
      if (turn.forked) await Promise.all([this.#tellApart(entry, turn), this.#host.configure(entry, agent, turn)]);
      else await Promise.all([turn.session ? undefined : this.#catchUp(entry, turn.id), this.#host.configure(entry, agent, turn)]);
      if (!live()) return;
      await this.#host.submit(sessionOf(entry, turn), turnInput(turn), operationId(turn.id), {
        turn: turn.id,
        calledBy: turn.calledBy,
        hop: turn.hop,
      });
      roster.markSubmitted(turn.id);
      if (!live()) {
        // Stopped while its input went in: the stop's abort may have come first, so the run it started stops too.
        await this.#host.abort(sessionOf(entry, turn)).catch((error: unknown) => console.error("agent stop:", errorMessage(error)));
        return;
      }
    } catch (error) {
      // A seat may have started it all the same (its answer was lost on the way): it stops there too.
      if (entry.seat !== undefined) await this.#abortSeat(entry, turn.id);
      await this.#ended(entry, turn, { status: "unanswered", reason: errorMessage(error) });
      return;
    }
    this.#host.waitUntil(this.#await(entry, { ...turn, submitted: true }));
  }

  async #abortSeat(entry: RosterEntry, turn: number): Promise<void> {
    await this.#host
      .seat(entry)
      .abort(turn)
      .catch((error: unknown) => console.error("agent stop:", errorMessage(error)));
  }

  /**
   * A forked turn's ask goes into the agent's own session as well, as context: its input went only into the fork, and
   * the catch-up before it left the ask out (the input carries it). Later turns read it there, with the reply as posted.
   */
  async #tellApart(entry: RosterEntry, turn: AgentTurn): Promise<void> {
    await this.#host.write(entry.session, askedApart(turn.ask), `apart:${entry.agentId}:${turn.id}`);
  }

  /**
   * Give a seat its turn, in one call: what was said since it last read (its seat fills a gap itself), then the turn's
   * input. The seat ends it by calling `seatEnded`.
   */
  async #giveSeat(entry: RosterEntry, turn: AgentTurn): Promise<void> {
    const batch = await this.batchFor(entry, entry.mirrored, turn.id);
    const given = {
      turn: turn.id,
      calledBy: turn.calledBy,
      hop: turn.hop,
      ask: turn.ask,
      input: turnInput(turn),
      byOwner: turn.byOwner,
      ...(turn.unattended && { unattended: true as const }),
    };
    // Giving a turn twice places it once: a call cut off on the way (the seat's object restarted) is made again.
    const delivered = await retried(() => this.#host.seat(entry).give(batch.through > entry.mirrored ? batch : null, given));
    this.#host.roster.setMirrored(entry.agentId, delivered);
    this.#host.roster.markSubmitted(turn.id);
  }

  /**
   * What an agent's session has to read of the log after entry `after`, for turn `turn` (CatchUp): read newest first,
   * and only as far back as the catch-up keeps. A seat pulls it to fill a gap.
   */
  async batchFor(entry: RosterEntry, after: number, turn: number): Promise<SeatBatch> {
    const owner = { uid: entry.ownerUid, chatOwner: this.#host.chatOwner, ...(entry.ownerFrom !== undefined && { from: entry.ownerFrom }) };
    const catchUp = new CatchUp(entry.agentId, owner, this.#host.roster.askKeys(entry.agentId, turn));
    for await (const page of this.#host.logSince(after)) if (!catchUp.add(page)) break;
    const { text, through } = catchUp.result();
    return { from: after + 1, through: Math.max(through, after), text, turn };
  }

  /** Send an agent's session what was said in the log since its last turn, as one passive write. */
  async #catchUp(entry: RosterEntry, turn: number): Promise<void> {
    const { text, through } = await this.batchFor(entry, entry.mirrored, turn);
    if (through <= entry.mirrored) return;
    if (text) await this.#host.write(entry.session, text, `mirror:${entry.agentId}:${through}`);
    this.#host.roster.setMirrored(entry.agentId, through);
  }

  /**
   * A seat's turn ended (the seat calls this through its room): it ends here as a turn of this object's does. True once
   * taken, also when it was already or is gone, so the seat lets it go.
   */
  async seatEnded(agentId: string, id: number, result: SeatResult): Promise<boolean> {
    const roster = this.#host.roster;
    const entry = roster.get(agentId);
    const turn = roster.turn(id);
    if (!entry || entry.seat === undefined || turn?.agentId !== agentId) return true;
    await this.#ended(entry, turn, result, result);
    return true;
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
   *
   * A reply built on a private server, of an agent whose owner reviews those, is held for them (`held`): it hands off
   * and is delivered only once they post it (`post`).
   */
  async #ended(entry: RosterEntry, turn: AgentTurn, result: TurnResult, outputs?: Outputs): Promise<void> {
    const roster = this.#host.roster;
    const now = roster.turn(turn.id);
    let delivering: Promise<void> | undefined;
    if (now?.status === "running" || now?.status === "queued") {
      const done = result.status === "done";
      const text = (result.text ?? "").trim();
      // How it ended, for the metrics and the chat's budget (with what it spent in another object, a seat's).
      const outcome = (status: TurnOutcome["status"], startedAt: number, endedAt: number): TurnOutcome => ({
        status,
        startedAt,
        endedAt,
        ...(result.spent && { spent: result.spent }),
      });
      // A turn nobody asked for posts only an answer worth posting: none when it passed, or failed (nobody is waiting
      // for it), and it hands nothing on.
      if (turn.calledBy.unprompted && (!done || !text || isPass(text))) {
        if (roster.end(turn.id, done ? "done" : "failed")) {
          this.#host.ended?.(turn, outcome(done ? "passed" : "failed", now.startedAt ?? now.createdAt, roster.now()));
        }
        this.#host.changed();
        this.pump(entry.agentId);
        return;
      }
      // Only a turn whose input went in has outputs in its session.
      const { published, items, sources, review, saved, ...out } = outputs ?? (now.submitted ? await this.#outputs(entry, now) : NO_OUTPUTS);
      const forked = out.forked === true || now.forked === true;
      // Its owner sees a reply built on a private server first, when they review those (`held`).
      const held = review === true && sources.length > 0;
      // What a turn apart from the chat (a fork, a run's reply session) made stays withheld unless its reply is posted
      // (ChatRoster.release, which posts a done reply with text): a failed or empty one released at once names none of it.
      const shows = !(forked || now.session !== undefined) || held || (done && !!text);
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
        ...(shows && published.length && { published }),
        ...(shows && saved?.length && { saved }),
        ...(turn.run && { run: turn.run }),
        ...(items.length && { items }),
        ...(forked && { forked: true as const }),
        ...(sources.length && { sources }),
      };
      const ended = outcome(done ? "done" : "failed", reply.startedAt, reply.endedAt);
      if (held) {
        // Its owner sees it first: nothing of it reaches the chat, pi or other agents until they post it. A failed or
        // empty one too: what its fork published or saved stays withheld until they post or discard it.
        if (roster.end(turn.id, done ? "done" : "failed", { reply, toPi: false, held: true })) {
          this.#host.ended?.(turn, ended);
          this.#host.drafted(current.ownerUid);
        }
      } else if (roster.end(turn.id, done ? "done" : "failed", { reply, toPi: false })) {
        this.#host.ended?.(turn, ended);
        delivering = this.#release(turn.id, reply, done);
      }
    }
    this.#host.changed();
    this.pump(entry.agentId);
    await delivering;
  }

  /**
   * An ended turn's reply goes to the chat: the agents it names get the next turns, within what its chain may still
   * make, and it is delivered. The turn ended in the roster just before, with no await in between, so a restart never
   * loses its hand-offs or queues them twice. Only a done reply with text (or one its owner posts) makes its fork's
   * outputs the chat's: a failed or empty one's stay withheld.
   */
  #release(id: number, reply: ChatAgentReplyData, done: boolean): Promise<void> {
    const roster = this.#host.roster;
    const turn = roster.turn(id)!;
    const left = MAX_HOPS - roster.handOffsFrom(turn.root);
    // A turn nobody asked for hands nothing on.
    const next = done && left > 0 && !turn.calledBy.unprompted ? handOffs(reply.text, reply.agentId, turn.hop, roster.list()).slice(0, left) : [];
    // A chain no person started never hands pi a turn: pi has the owner's full tools. It reads the reply instead.
    const posted = roster.release(id, reply, !turn.unattended && next.includes(AGENT_NAME));
    if (posted.length) this.#host.posted?.(posted);
    const agents = next.filter((agentId) => agentId !== AGENT_NAME);
    // A hand-off can only read, whoever started the chain: agents cannot give each other permission.
    const ask = askOf({ name: reply.name, kind: "agent" }, reply.text, MAX_ASK_CHARS);
    const calledBy = { name: reply.name, agentId: reply.agentId };
    const hop = {
      calledBy,
      ask,
      askKey: turnAskKey(id),
      byOwner: false,
      hop: turn.hop + 1,
      root: turn.root,
      unattended: turn.unattended,
      ...(turn.by !== undefined && { by: turn.by }),
    };
    if (agents.length) this.call(agents, hop);
    return this.#deliver(id);
  }

  /** A reply of `uid`'s agent `agentId` held for their review, as turn `id`; refused for anyone else's, or one no longer held. */
  #held(uid: string, agentId: string, id: number): AgentDraftView | { error: string } {
    const held = this.#host.roster.held(uid).find((reply) => reply.turn === id && reply.agentId === agentId);
    return held ?? { error: "No such draft: it was posted or discarded already." };
  }

  /** (the agent's owner) Discard a reply held for their review: it never reaches the chat. */
  discard(uid: string, agentId: string, id: number): { error: string } | null {
    const held = this.#held(uid, agentId, id);
    if ("error" in held) return held;
    this.#host.roster.discard(id);
    this.#host.drafted(uid);
    return null;
  }

  /** (the agent's owner) Post a reply held for their review to the chat, as they may have edited it (`text`). */
  async post(uid: string, agentId: string, id: number, edited?: string): Promise<{ error: string } | null> {
    const roster = this.#host.roster;
    const held = this.#held(uid, agentId, id);
    if ("error" in held) return held;
    const text = edited === undefined ? held.reply.text : edited.trim();
    if (!text) return { error: "A reply needs some text; discard it instead." };
    const current = roster.get(held.agentId);
    // A failed one its owner posts is theirs now, as they wrote or kept it.
    const { failed: _, ...kept } = held.reply;
    const reply: ChatAgentReplyData = {
      ...kept,
      ...(current && { name: current.name, avatar: current.avatar, color: current.color }),
      text,
      postedBy: uid,
      endedAt: roster.now(),
    };
    // Its owner made it theirs: it hands off and is delivered as any other reply. Only once: with no await since it was
    // read, a second post finds it no longer held.
    const delivering = this.#release(id, reply, true);
    this.#host.drafted(uid);
    this.#host.changed();
    await delivering;
    return null;
  }

  /**
   * What a turn left in its session: the artifacts it published, and the records its tool results held. A fork's shows
   * only the shared servers' records, and the private servers it called (TurnHost.sources). None when it cannot be read.
   */
  async #outputs(entry: RosterEntry, turn: AgentTurn): Promise<Outputs> {
    try {
      const entries = await this.#host.turnEntries(sessionOf(entry, turn), turn.id);
      // A reply in a run's own session ran with its owner's tools in a session that holds the run's private reads: it
      // shows what a fork's does, but is no fork (its reply says so by its run).
      const found = await outputsOf(entries, turn.session !== undefined, () => this.#host.sources(entry, entries));
      return turn.forked ? found : { ...found, forked: false };
    } catch (error) {
      console.error("agent turn, outputs:", errorMessage(error));
      if (turn.session === undefined) return NO_OUTPUTS;
      // What a turn apart from the chat read cannot be told: its reply says it may be private, and waits for review.
      const agent = await this.#host.definition(entry).catch(() => null);
      return unreadOutputs(turn.forked === true, agent?.reviewBeforePosting === true);
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
        await this.#host.handToPi(turnInput(handed), {
          turn: id,
          calledBy,
          hop: handed.hop,
          root: turn.root,
          ...(turn.by !== undefined && { by: turn.by }),
        });
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
    const seats = new Set<string>();
    for (const turn of roster.allRunning()) {
      const entry = roster.get(turn.agentId);
      if (!entry) continue;
      // A seat's turn ends when the seat says so: have it send what it may have sent while this object was down.
      if (entry.seat !== undefined) seats.add(entry.agentId);
      else if (!this.#waiting.has(turn.id)) this.#host.waitUntil(this.#await(entry, turn));
    }
    for (const agentId of seats) {
      const entry = roster.get(agentId)!;
      this.#host.waitUntil(
        this.#host
          .seat(entry)
          .wake()
          .catch((error: unknown) => console.error("agent seat:", errorMessage(error))),
      );
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
    const started = stopped.filter((turn) => turn.startedAt !== undefined);
    const sessions = new Set<string>();
    const aborts: Promise<void>[] = [];
    for (const turn of started) {
      const entry = roster.get(turn.agentId);
      if (entry?.seat !== undefined) aborts.push(this.#host.seat(entry).abort(turn.id));
      else if (entry) sessions.add(sessionOf(entry, turn));
    }
    aborts.push(...[...sessions].map((session) => this.#host.abort(session)));
    await Promise.all(aborts.map((abort) => abort.catch((error: unknown) => console.error("agent stop:", errorMessage(error)))));
    if (stopped.length) this.#host.changed();
    return stopped.length > 0;
  }

  /**
   * pi replied (entry `entry` of the log, `text`): the agents it names get turns, as hand-offs within the chain pi's turn
   * was in (`root` and `hop` when another agent handed pi that turn; none when a person asked it). `unattended`: a chain
   * that may never hand pi a turn (a Yes's run).
   */
  fromPi(text: string, entry: number, chain: PiChain = { hop: 0 }): void {
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
      ...(chain.by !== undefined && { by: chain.by }),
      ...(chain.unattended && { unattended: true as const }),
    });
  }
}

/**
 * The outputs of a turn apart from the chat whose session could not be read: nothing it published or held shows, its
 * sources are unknown, and its owner reviews it when they review such replies.
 */
export function unreadOutputs(forked: boolean, review: boolean): Outputs {
  return { published: [], items: [], sources: [UNKNOWN_SOURCE], ...(forked && { forked: true }), ...(review && { review: true }) };
}

/** How long a call between objects waits before it is made again (retried), after each failure a retry may get past. */
const RETRY_WAITS = [250, 1_000];

/** Make a call between objects, again after a short wait when it failed in a way a retry may get past (the other object restarted, or was overloaded). */
async function retried<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const wait = RETRY_WAITS[attempt];
      if (wait === undefined || !isObject(error) || error.retryable !== true) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * What a turn left among its session's entries: the pages it published, and the records its results held; for one in
 * a fork, only those `sources` keeps (the shared servers'), with the private servers it called.
 */
export async function outputsOf(
  entries: readonly EntryRecord[],
  forked: boolean,
  sources: () => Promise<Pick<Outputs, "items" | "sources" | "review">>,
): Promise<Outputs> {
  const published = publishedIn(entries);
  if (!forked) return { published, items: itemsIn(entries), sources: [] };
  const saved = [...chatTraces(entries).files];
  return { published, forked: true, ...(saved.length && { saved }), ...(await sources()) };
}

/**
 * The chain pi's turn was in, as fromPi takes it: `root` and `hop` of a hand-off to pi, `unattended` for a Yes's run,
 * and `by`, the person who started it, whom its turns count for.
 */
export type PiChain = { hop: number; root?: number; unattended?: true; by?: string };

/** A turn's operation id in its agent's session: submitting it twice places it once. */
export function operationId(turn: number): string {
  return `turn:${turn}`;
}
