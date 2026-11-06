import type { EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_AGENT_KIND, MAX_HOPS, type AgentDefinition, type ChatAgentReplyData, type ChatTurnData } from "../shared/agents.ts";
import { AGENT_NAME } from "../shared/mentions.ts";
import { CHAT_MESSAGE_KIND, PUBLISH_TOOL } from "../shared/protocol.ts";
import { AgentTurns, operationId, type Caller, type TurnHost, type TurnResult } from "../worker/agents/controller.ts";
import { ChatRoster, type AgentTurn, type RosterEntry } from "../worker/agents/roster.ts";
import { askOf, messageAskKey, turnInput } from "../worker/agents/turns.ts";
import { memorySql } from "./fakes.ts";

const T0 = 1_000_000;
const OWNER = { uid: "olga", name: "Olga" };
const MIA = { uid: "mia", name: "Mia" };
const [A, B, C, D, E] = ["atlas", "bard", "cora", "dex", "echo"];

type Person = { uid: string; name: string };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
type Handed = { input: string; data: ChatTurnData };
type View = Parameters<ChatRoster["refresh"]>[1];

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // The test may settle a wait before anyone waits on it: a rejection then is not an unhandled one.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const idOf = (name: string) => `id-${name}`;
const sessionOf = (name: string) => `session-${name}`;
const done = (text: string): TurnResult => ({ status: "done", text });

function definition(name: string, over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: idOf(name),
    name,
    avatar: name.slice(0, 2),
    color: "blue",
    job: `Does ${name} work.`,
    instructions: `You are ${name}.`,
    autonomy: 1,
    origin: "user",
    enabled: true,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** An artifact tool's result in an agent's session, as turnEntries returns it. */
function toolResult(toolName: string, details: object, isError = false): EntryRecord {
  const message = { role: "toolResult", toolCallId: "call-1", toolName, content: [], details, isError, timestamp: T0 };
  return { id: 0, conversationId: 0, kind: "pi.tool-result", model: [message] } as unknown as EntryRecord;
}

/**
 * The chat object the controller runs in: a real roster over SQLite, definitions from a map, a log of entries, and
 * every other call recorded. Each turn's wait is a promise the test settles by the turn's id (finish, fail).
 */
class FakeChat implements TurnHost {
  readonly clock = { now: T0 };
  readonly sql = memorySql();
  readonly roster = new ChatRoster(this.sql, () => this.clock.now);
  readonly definitions = new Map<string, AgentDefinition>();
  readonly log: EntryRecord[] = [];
  /** Per turn id, what turnEntries returns of the agent's session. */
  readonly pages = new Map<number, EntryRecord[]>();
  /** The host's calls in order, by a short name, to check what happens before what. */
  readonly calls: string[] = [];
  readonly reads: number[] = [];
  readonly writes: { session: string; text: string; requestId: string }[] = [];
  readonly configured: { entry: RosterEntry; agent: AgentDefinition; turn: AgentTurn }[] = [];
  readonly submits: { session: string; input: string; operationId: string; data: ChatTurnData }[] = [];
  readonly waits: { session: string; operationId: string }[] = [];
  readonly aborts: string[] = [];
  readonly asked: { session: string; turn: number }[] = [];
  readonly posts: { reply: ChatAgentReplyData; forPi: boolean }[] = [];
  /** The turns whose replies were also written for pi to read, once each. */
  readonly asides: number[] = [];
  /** How many pages of the log the catch-ups read. */
  pagesRead = 0;
  readonly toPi: Handed[] = [];
  readonly kept: Promise<unknown>[] = [];
  changes = 0;
  readonly #settled = new Set<Promise<unknown>>();
  readonly #results = new Map<string, Deferred<TurnResult>>();
  #nextEntry = 1;
  readonly turns = new AgentTurns(this);

  constructor(names: readonly string[]) {
    for (const name of names) {
      const agent = definition(name);
      this.definitions.set(agent.id, agent);
      const refused = this.roster.add({
        agentId: agent.id,
        ownerUid: OWNER.uid,
        name,
        session: sessionOf(name),
        avatar: agent.avatar,
        color: agent.color,
        job: agent.job,
      });
      if (refused) throw new Error(refused.error);
    }
  }

  async definition(entry: RosterEntry): Promise<AgentDefinition | null> {
    return this.definitions.get(entry.agentId) ?? null;
  }

  async configure(entry: RosterEntry, agent: AgentDefinition, turn: AgentTurn): Promise<void> {
    this.calls.push(`configure ${entry.name}`);
    this.configured.push({ entry, agent, turn });
  }

  /** The log after `after`, newest first, two entries a page. */
  async *logSince(after: number): AsyncGenerator<readonly EntryRecord[]> {
    this.calls.push("read");
    this.reads.push(after);
    const newer = this.log.filter((entry) => (entry.id as number) > after).reverse();
    for (let at = 0; at < newer.length; at += 2) {
      this.pagesRead++;
      yield newer.slice(at, at + 2);
    }
  }

  async write(session: string, text: string, requestId: string): Promise<void> {
    this.calls.push(`write ${session}`);
    this.writes.push({ session, text, requestId });
  }

  async submit(session: string, input: string, operationId: string, data: ChatTurnData): Promise<void> {
    this.calls.push(`submit ${session}`);
    this.submits.push({ session, input, operationId, data });
  }

  wait(session: string, operationId: string): Promise<TurnResult> {
    this.calls.push(`wait ${session}`);
    this.waits.push({ session, operationId });
    return this.#result(operationId).promise;
  }

  async abort(session: string): Promise<void> {
    this.aborts.push(session);
  }

  async turnEntries(session: string, turn: number): Promise<readonly EntryRecord[]> {
    this.asked.push({ session, turn });
    return this.pages.get(turn) ?? [];
  }

  async post(reply: ChatAgentReplyData, forPi: boolean): Promise<void> {
    this.calls.push(`post ${reply.name}`);
    // Placed once, as the chat object's request ids for a reply and its copy for pi do.
    if (forPi && reply.text && !this.asides.includes(reply.turn)) this.asides.push(reply.turn);
    if (this.posts.some((post) => post.reply.turn === reply.turn)) return;
    this.posts.push({ reply, forPi });
    this.#append({ kind: CHAT_AGENT_KIND, data: reply });
  }

  async handToPi(input: string, data: ChatTurnData): Promise<void> {
    this.calls.push("hand to pi");
    // Placed once, as pi's operation id for the handing turn does.
    if (!this.toPi.some((handed) => handed.data.turn === data.turn)) this.toPi.push({ input, data });
  }

  changed(): void {
    this.changes++;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.kept.push(promise);
    void promise.then(
      () => this.#settled.add(promise),
      () => this.#settled.add(promise),
    );
  }

  /** A person's message in the log, and the caller the chat object would build for the agents it calls. */
  say(who: Person, text: string): Caller {
    const sentAt = T0 + this.#nextEntry;
    this.#append({ kind: CHAT_MESSAGE_KIND, data: { uid: who.uid, name: who.name, text, sentAt } });
    const byOwner = who.uid === OWNER.uid;
    return {
      calledBy: { name: who.name, uid: who.uid },
      ask: askOf({ name: who.name, kind: "person", owner: byOwner }, text),
      askKey: messageAskKey({ uid: who.uid, sentAt }),
      byOwner,
    };
  }

  /** One of pi's replies in the log; its entry id. */
  piSays(text: string): number {
    const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: T0 };
    return this.#append({ kind: "pi.assistant", model: [message] }).id as number;
  }

  /** The turn's run ends with `result`. */
  finish(turn: number, result: TurnResult): void {
    this.#result(operationId(turn)).resolve(result);
  }

  /** Waiting on the turn's run fails. */
  fail(turn: number, error: Error): void {
    this.#result(operationId(turn)).reject(error);
  }

  replies(): ChatAgentReplyData[] {
    return this.posts.map(({ reply }) => reply);
  }

  /** The turn an agent runs now, if any. */
  runningOf(name: string): AgentTurn | null {
    return this.roster.allRunning().find((turn) => turn.agentId === idOf(name)) ?? null;
  }

  /** An agent's newest turn. */
  latest(name: string): AgentTurn {
    const [turn] = this.roster.recentTurns(idOf(name), 1);
    if (!turn) throw new Error(`${name} has no turns`);
    return turn;
  }

  /** What everyone sees of an agent now, as refresh takes it, changed by `over`. */
  view(name: string, over: Partial<View> = {}): View {
    const entry = this.roster.get(idOf(name));
    if (!entry) throw new Error(`${name} is not in the roster`);
    return { name: entry.name, avatar: entry.avatar, color: entry.color, job: entry.job, off: entry.off, ...over };
  }

  /** The promises given to waitUntil that have not settled yet. */
  pendingKept(): number {
    return this.kept.filter((promise) => !this.#settled.has(promise)).length;
  }

  /** Let everything that can settle settle: every fake answers at once, but the waits the test has not settled. */
  async flush(): Promise<void> {
    for (let round = 0; round < 5; round++) {
      await Promise.race([Promise.allSettled(this.kept), tick()]);
      await tick();
    }
  }

  #result(operation: string): Deferred<TurnResult> {
    let found = this.#results.get(operation);
    if (!found) this.#results.set(operation, (found = deferred()));
    return found;
  }

  #append(fields: { kind: string; data?: object; model?: object[] }): EntryRecord {
    const entry = { id: this.#nextEntry++, conversationId: 0, ...fields } as unknown as EntryRecord;
    this.log.push(entry);
    return entry;
  }
}

/** A chat with these agents whose first named agent was just called by the owner, its turn submitted. */
async function called(names: readonly string[], text = `@${names[0]} go`) {
  const chat = new FakeChat(names);
  const [turn] = chat.turns.call([idOf(names[0])], chat.say(OWNER, text));
  await chat.flush();
  return { chat, turn };
}

/** A turn queued, started and submitted in the roster without the controller: one running when the object went away. */
function runningBefore(chat: FakeChat, name: string, { submitted = true } = {}): AgentTurn {
  const turn = queuedBefore(chat, name);
  expect(chat.roster.startNext(idOf(name))?.id).toBe(turn.id);
  if (submitted) chat.roster.markSubmitted(turn.id);
  return { ...turn, status: "running" };
}

function queuedBefore(chat: FakeChat, name: string): AgentTurn {
  const ask = `[Olga · person · your owner]: @${name}`;
  return chat.roster.enqueue({ agentId: idOf(name), hop: 0, calledBy: { name: OWNER.name, uid: OWNER.uid }, byOwner: true, ask });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentTurns: a turn", () => {
  it("catches the session up and sets it up, then submits the turn's input under its operation id", async () => {
    const chat = new FakeChat([A]);
    chat.definitions.set(idOf(A), definition(A, { version: 4 }));
    chat.say(MIA, "Lunch at noon?");
    const caller = chat.say(OWNER, "@atlas sum up the week");
    const [turn] = chat.turns.call([idOf(A)], caller);
    expect(turn).toMatchObject({ agentId: idOf(A), status: "queued", hop: 0, byOwner: true, root: turn.id, ask: caller.ask });
    await chat.flush();

    // The catch-up and the set-up go at once; the input only after both.
    expect(chat.calls).toEqual(["read", `configure ${A}`, `write ${sessionOf(A)}`, `submit ${sessionOf(A)}`, `wait ${sessionOf(A)}`]);
    // The asking message is left out of the catch-up: the turn's input carries it.
    expect(chat.writes).toEqual([{ session: sessionOf(A), requestId: `mirror:${idOf(A)}:2`, text: expect.stringContaining("[Mia · person]: Lunch at noon?") }]);
    expect(chat.writes[0].text).not.toContain("sum up the week");
    expect(chat.configured).toEqual([
      {
        entry: expect.objectContaining({ agentId: idOf(A), name: A, session: sessionOf(A), ownerUid: OWNER.uid }),
        agent: chat.definitions.get(idOf(A)),
        turn: expect.objectContaining({ id: turn.id, status: "running", byOwner: true, ask: caller.ask }),
      },
    ]);
    expect(chat.submits).toEqual([
      { session: sessionOf(A), input: turnInput(turn), operationId: `turn:${turn.id}`, data: { turn: turn.id, calledBy: caller.calledBy, hop: 0 } },
    ]);
    expect(chat.submits[0].input).toContain("Olga asked you");
    expect(chat.submits[0].input).toContain(caller.ask);
    expect(operationId(turn.id)).toBe(`turn:${turn.id}`);
    expect(chat.waits).toEqual([{ session: sessionOf(A), operationId: `turn:${turn.id}` }]);
    expect(chat.roster.get(idOf(A))).toMatchObject({ mirrored: 2 });
    expect(chat.runningOf(A)?.id).toBe(turn.id);
    expect(chat.posts).toEqual([]);
  });

  it("writes nothing when only the asking message is new, and next reads only after what the session read", async () => {
    const { chat, turn } = await called([A], "@atlas one");
    expect(chat.reads).toEqual([-1]);
    expect(chat.writes).toEqual([]);
    expect(chat.roster.get(idOf(A))?.mirrored).toBe(1);

    chat.finish(turn.id, done("One."));
    await chat.flush();
    chat.say(MIA, "nice");
    chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas two"));
    await chat.flush();
    expect(chat.reads).toEqual([-1, 1]);
    // Its own reply (entry 2) is in its session already, and the asking message (entry 4) is in the input.
    expect(chat.writes).toEqual([{ session: sessionOf(A), requestId: `mirror:${idOf(A)}:4`, text: expect.stringContaining("[Mia · person]: nice") }]);
    expect(chat.writes[0].text).not.toContain("One.");
    expect(chat.writes[0].text).not.toContain("two");
    expect(chat.roster.get(idOf(A))?.mirrored).toBe(4);
  });

  it("posts the reply with its text, who called it, its hop, its times and the pages it published", async () => {
    const chat = new FakeChat([A]);
    const caller = chat.say(OWNER, "@atlas chart the sales");
    const [turn] = chat.turns.call([idOf(A)], caller);
    chat.clock.now = T0 + 5;
    await chat.flush();
    chat.pages.set(turn.id, [
      toolResult(PUBLISH_TOOL, { artifactId: "art-1", version: 2, title: "Sales" }),
      toolResult(PUBLISH_TOOL, { artifactId: "art-2", version: 1, title: "Broken" }, true),
      toolResult("run_python", { artifactId: "not-a-page", version: 1 }),
    ]);
    chat.clock.now = T0 + 90;
    chat.finish(turn.id, done("  Here is the chart.  "));
    await chat.flush();

    expect(chat.asked).toEqual([{ session: sessionOf(A), turn: turn.id }]);
    expect(chat.posts).toEqual([
      {
        forPi: true,
        reply: {
          agentId: idOf(A),
          name: A,
          avatar: "at",
          color: "blue",
          ownerUid: OWNER.uid,
          text: "Here is the chart.",
          calledBy: caller.calledBy,
          turn: turn.id,
          hop: 0,
          startedAt: T0 + 5,
          endedAt: T0 + 90,
          published: [{ artifactId: "art-1", title: "Sales", version: 2 }],
        },
      },
    ]);
    expect(chat.roster.turn(turn.id)).toMatchObject({ status: "done", startedAt: T0 + 5, endedAt: T0 + 90 });
    expect(chat.runningOf(A)).toBeNull();
  });

  it("leaves what the turn did not have out of its reply", async () => {
    const { chat, turn } = await called([A]);
    chat.finish(turn.id, done(""));
    await chat.flush();
    const [reply] = chat.replies();
    expect(reply.text).toBe("");
    expect(Object.keys(reply)).not.toContain("published");
    expect(Object.keys(reply)).not.toContain("failed");
  });

  it("posts a failed reply when waiting on the turn fails", async () => {
    const { chat, turn } = await called([A]);
    chat.fail(turn.id, new Error("the session is gone"));
    await chat.flush();
    expect(chat.replies()).toEqual([expect.objectContaining({ turn: turn.id, text: "", failed: "the session is gone" })]);
    expect(chat.roster.turn(turn.id)?.status).toBe("failed");
  });

  it("posts an unanswered turn as failed, with its reason or a default one, and hands nothing on", async () => {
    const chat = new FakeChat([A, B]);
    const [ta, tb] = chat.turns.call([idOf(A), idOf(B)], chat.say(OWNER, "@atlas @bard both of you"));
    await chat.flush();
    chat.finish(ta.id, { status: "unanswered", reason: "it ran out of steps", text: "Half done; @bard take over" });
    await chat.flush();
    chat.finish(tb.id, { status: "unanswered" });
    await chat.flush();

    expect(chat.replies()).toEqual([
      expect.objectContaining({ agentId: idOf(A), text: "Half done; @bard take over", failed: "it ran out of steps" }),
      expect.objectContaining({ agentId: idOf(B), text: "", failed: "it ended without an answer" }),
    ]);
    expect(chat.posts.map(({ forPi }) => forPi)).toEqual([true, true]);
    // A failed turn's names start nothing: bard had only the turn the person gave it.
    expect(chat.roster.recentTurns(idOf(B))).toHaveLength(1);
    expect(chat.submits).toHaveLength(2);
    expect(chat.toPi).toEqual([]);
  });

  it("shows the agent as its definition now says", async () => {
    const chat = new FakeChat([A]);
    chat.definitions.set(idOf(A), definition(A, { name: "astra", avatar: "AS", color: "green", job: "Maps things.", version: 3 }));
    const [turn] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas go"));
    await chat.flush();

    expect(chat.configured[0].entry).toMatchObject({ name: "astra", avatar: "AS", color: "green", job: "Maps things." });
    expect(chat.roster.get(idOf(A))).toMatchObject({ name: "astra" });
    expect(chat.roster.byName("astra")?.agentId).toBe(idOf(A));
    chat.finish(turn.id, done("Mapped."));
    await chat.flush();
    expect(chat.replies()[0]).toMatchObject({ name: "astra", avatar: "AS", color: "green" });
  });
});

describe("AgentTurns: the queue", () => {
  it("runs one turn at a time per agent, and the next once the first ends", async () => {
    const chat = new FakeChat([A]);
    const [first] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas one"));
    const [second] = chat.turns.call([idOf(A)], chat.say(MIA, "@atlas two"));
    await chat.flush();
    expect(chat.submits.map((submit) => submit.operationId)).toEqual([`turn:${first.id}`]);
    expect(chat.roster.turn(second.id)?.status).toBe("queued");
    expect(chat.roster.views(() => "")[0].queued).toBe(1);

    chat.finish(first.id, done("First."));
    await chat.flush();
    expect(chat.submits.map((submit) => submit.operationId)).toEqual([`turn:${first.id}`, `turn:${second.id}`]);
    expect(chat.configured[1].turn).toMatchObject({ id: second.id, byOwner: false, calledBy: { name: MIA.name, uid: MIA.uid } });
    expect(chat.replies().map((reply) => reply.text)).toEqual(["First."]);

    chat.finish(second.id, done("Second."));
    await chat.flush();
    expect(chat.replies().map((reply) => reply.text)).toEqual(["First.", "Second."]);
    expect(chat.runningOf(A)).toBeNull();
    expect(chat.roster.waitingAgents()).toEqual([]);
  });

  it("runs two agents' turns at once, and posts each when it ends", async () => {
    const chat = new FakeChat([A, B]);
    const [ta, tb] = chat.turns.call([idOf(A), idOf(B)], chat.say(OWNER, "@atlas @bard both"));
    await chat.flush();
    expect(chat.submits.map((submit) => submit.session)).toEqual([sessionOf(A), sessionOf(B)]);
    expect(chat.roster.allRunning().map((turn) => turn.id)).toEqual([ta.id, tb.id]);

    chat.finish(tb.id, done("Bard here."));
    await chat.flush();
    expect(chat.replies().map((reply) => reply.name)).toEqual([B]);
    expect(chat.runningOf(A)?.id).toBe(ta.id);

    chat.finish(ta.id, done("Atlas here."));
    await chat.flush();
    expect(chat.replies().map((reply) => reply.name)).toEqual([B, A]);
  });

  it("skips agents not in the roster, and tells no one when none is", async () => {
    const chat = new FakeChat([A]);
    const caller = chat.say(OWNER, "@nobody hello");
    expect(chat.turns.call(["id-nobody"], caller)).toEqual([]);
    await chat.flush();
    expect(chat.changes).toBe(0);
    expect(chat.submits).toEqual([]);

    const turns = chat.turns.call(["id-nobody", idOf(A)], caller);
    expect(turns.map((turn) => turn.agentId)).toEqual([idOf(A)]);
    expect(chat.changes).toBeGreaterThan(0);
  });

  it("gives the agents one message calls one chain, so its hand-offs stay within MAX_HOPS however many it names", async () => {
    const chat = new FakeChat([A, B, C, D, E]);
    const [ta, tb] = chat.turns.call([idOf(A), idOf(B)], chat.say(OWNER, "@atlas @bard"));
    expect([ta.root, tb.root]).toEqual([ta.id, ta.id]);
    await chat.flush();
    chat.finish(ta.id, done("@cora @dex @echo from atlas"));
    await chat.flush();
    chat.finish(tb.id, done("@cora @dex @echo from bard"));
    await chat.flush();

    expect(chat.roster.handOffsFrom(ta.id)).toBe(MAX_HOPS);
    for (const name of [C, D, E]) expect(chat.roster.recentTurns(idOf(name)).map((turn) => turn.root)).toEqual([ta.id]);
  });
});

describe("AgentTurns: hand-offs", () => {
  it("gives an agent a reply names a read-only turn in the same chain, its catch-up leaving the reply out", async () => {
    const chat = new FakeChat([A, B]);
    const caller = chat.say(OWNER, "@atlas find the numbers");
    const [ta] = chat.turns.call([idOf(A)], caller);
    await chat.flush();
    const text = "I found them; @bard can you chart them?";
    chat.finish(ta.id, done(text));
    await chat.flush();

    expect(chat.posts).toEqual([{ forPi: true, reply: expect.objectContaining({ agentId: idOf(A), hop: 0, text }) }]);
    const tb = chat.latest(B);
    expect(tb).toMatchObject({
      status: "running",
      hop: 1,
      byOwner: false,
      root: ta.id,
      calledBy: { name: A, agentId: idOf(A) },
      ask: `[atlas · agent]: ${text}`,
    });
    expect(chat.roster.askKeys(idOf(B), tb.id)).toEqual(new Set([`turn:${ta.id}`]));
    expect(chat.configured.at(-1)?.turn).toMatchObject({ id: tb.id, byOwner: false });
    expect(chat.submits.at(-1)).toMatchObject({
      session: sessionOf(B),
      operationId: `turn:${tb.id}`,
      data: { turn: tb.id, calledBy: { name: A, agentId: idOf(A) }, hop: 1 },
    });
    expect(chat.submits.at(-1)?.input).toContain("atlas (an agent) asked you");
    expect(chat.submits.at(-1)?.input).toContain("This is hand-off 1");
    // Bard reads the person's message, but not atlas's reply: its input carries that.
    expect(chat.writes).toEqual([
      {
        session: sessionOf(B),
        requestId: `mirror:${idOf(B)}:2`,
        text: expect.stringContaining("[Olga · person · your owner]: @atlas find the numbers"),
      },
    ]);
    expect(chat.writes[0].text).not.toContain("I found them");

    chat.finish(tb.id, done("Charted."));
    await chat.flush();
    expect(chat.replies()[1]).toMatchObject({ agentId: idOf(B), hop: 1, calledBy: { name: A, agentId: idOf(A) } });
  });

  it("hands pi a turn when a reply names it, and then does not post the reply for pi to read as well", async () => {
    const { chat, turn } = await called([A]);
    const text = "Plan ready. @pi please build the page.";
    chat.finish(turn.id, done(text));
    await chat.flush();

    expect(chat.posts).toEqual([{ forPi: false, reply: expect.objectContaining({ text }) }]);
    const calledBy = { name: A, agentId: idOf(A) };
    expect(chat.toPi).toEqual([
      { input: turnInput({ calledBy, hop: 1, ask: `[atlas · agent]: ${text}` }), data: { turn: turn.id, calledBy, hop: 1, root: turn.id } },
    ]);
    expect(chat.asides).toEqual([]);
    expect(chat.calls.slice(-2)).toEqual([`post ${A}`, "hand to pi"]);
    expect(chat.roster.recentTurns(idOf(A))).toHaveLength(1);
    expect(chat.submits).toHaveLength(1);
  });

  it("hands work to agents and pi from one reply, in one chain", async () => {
    const { chat, turn } = await called([A, B]);
    chat.finish(turn.id, done("@bard draw it, and @pi publish it"));
    await chat.flush();

    expect(chat.posts[0].forPi).toBe(false);
    expect(chat.latest(B)).toMatchObject({ hop: 1, root: turn.id, status: "running" });
    expect(chat.toPi).toEqual([expect.objectContaining({ data: expect.objectContaining({ hop: 1, root: turn.id }) })]);
  });

  it("lets one reply hand off at most MAX_HOPS times, pi taking one of them when named in time", async () => {
    const first = await called([A, B, C, D, E]);
    first.chat.finish(first.turn.id, done("@bard @cora @pi @dex @echo, all of you"));
    await first.chat.flush();
    expect(first.chat.roster.allRunning().map((turn) => turn.agentId)).toEqual([idOf(B), idOf(C)]);
    expect(first.chat.toPi).toHaveLength(1);
    expect(first.chat.roster.recentTurns(idOf(D))).toEqual([]);
    expect(first.chat.roster.recentTurns(idOf(E))).toEqual([]);

    const second = await called([A, B, C, D, E]);
    second.chat.finish(second.turn.id, done("@bard @cora @dex @pi, all of you"));
    await second.chat.flush();
    expect(second.chat.roster.allRunning().map((turn) => turn.agentId)).toEqual([idOf(B), idOf(C), idOf(D)]);
    expect(second.chat.toPi).toEqual([]);
    expect(second.chat.posts[0].forPi).toBe(true);
  });

  it("never hands work to the agent replying, and tells the chat when an agent it names is off", async () => {
    const { chat, turn } = await called([A, B]);
    chat.definitions.set(idOf(B), definition(B, { enabled: false }));
    chat.roster.refresh(idOf(B), chat.view(B, { off: true }));
    chat.finish(turn.id, done("A note to self, @atlas; and @bard, are you there?"));
    await chat.flush();

    expect(chat.roster.recentTurns(idOf(A))).toHaveLength(1);
    expect(chat.roster.recentTurns(idOf(B))).toEqual([expect.objectContaining({ status: "failed", hop: 1 })]);
    expect(chat.submits).toHaveLength(1);
    expect(chat.posts[0].forPi).toBe(true);
    expect(chat.replies().at(-1)).toMatchObject({ agentId: idOf(B), text: "", failed: "its owner turned @bard off" });
  });

  it("gives a turn to an agent the roster shows as off, which its owner has turned on since", async () => {
    const { chat, turn } = await called([A, B]);
    chat.roster.refresh(idOf(B), chat.view(B, { off: true }));
    chat.finish(turn.id, done("@bard are you back?"));
    await chat.flush();

    expect(chat.roster.get(idOf(B))?.off).toBe(false);
    expect(chat.submits.map((submit) => submit.session)).toEqual([sessionOf(A), sessionOf(B)]);
  });

  it("ends a chain at MAX_HOPS hand-offs when two agents keep naming each other", async () => {
    const { chat, turn } = await called([A, B]);
    for (let n = 0; n <= MAX_HOPS; n++) {
      const running = chat.roster.allRunning();
      expect(running).toHaveLength(1);
      chat.finish(running[0].id, done(n % 2 ? "@atlas back to you" : "@bard your turn"));
      await chat.flush();
    }

    expect(chat.replies().map((reply) => [reply.name, reply.hop])).toEqual(Array.from({ length: MAX_HOPS + 1 }, (_, n) => [n % 2 ? B : A, n]));
    expect(chat.roster.allRunning()).toEqual([]);
    expect(chat.roster.waitingAgents()).toEqual([]);
    expect(chat.submits).toHaveLength(MAX_HOPS + 1);
    expect(chat.roster.handOffsFrom(turn.id)).toBe(MAX_HOPS);
  });

  it("keeps the cap across the branches of one chain", async () => {
    const { chat, turn } = await called([A, B, C, D, E]);
    chat.finish(turn.id, done("@bard and @cora, please"));
    await chat.flush();
    const [tb, tc] = [chat.latest(B), chat.latest(C)];
    expect([tb.root, tc.root]).toEqual([turn.id, turn.id]);

    chat.finish(tb.id, done("@dex and @echo, help me"));
    await chat.flush();
    expect(chat.latest(D)).toMatchObject({ hop: 2, root: turn.id });
    expect(chat.roster.recentTurns(idOf(E))).toEqual([]);

    chat.finish(tc.id, done("@echo too"));
    chat.finish(chat.latest(D).id, done("@echo last"));
    await chat.flush();
    expect(chat.roster.recentTurns(idOf(E))).toEqual([]);
    expect(chat.submits).toHaveLength(4);
    expect(chat.roster.handOffsFrom(turn.id)).toBe(MAX_HOPS);
  });
});

describe("AgentTurns: an agent's definition", () => {
  it("takes an agent whose definition was deleted out of the roster, with the turns that waited for it", async () => {
    const chat = new FakeChat([A]);
    chat.definitions.delete(idOf(A));
    const [first] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas one"));
    const [second] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas two"));
    const before = chat.changes;
    await chat.flush();

    expect(chat.roster.get(idOf(A))).toBeNull();
    expect(chat.roster.turn(first.id)?.status).toBe("stopped");
    expect(chat.roster.turn(second.id)?.status).toBe("stopped");
    expect(chat.configured).toEqual([]);
    expect(chat.writes).toEqual([]);
    expect(chat.submits).toEqual([]);
    expect(chat.posts).toEqual([]);
    expect(chat.changes).toBeGreaterThan(before);
  });

  it("posts the turn an agent ran, and drops it at its next one when its definition was deleted meanwhile", async () => {
    const { chat, turn } = await called([A]);
    const [next] = chat.turns.call([idOf(A)], chat.say(MIA, "@atlas and then?"));
    chat.definitions.delete(idOf(A));
    chat.finish(turn.id, done("Done."));
    await chat.flush();

    expect(chat.replies().map((reply) => reply.text)).toEqual(["Done."]);
    expect(chat.roster.get(idOf(A))).toBeNull();
    expect(chat.roster.turn(next.id)?.status).toBe("stopped");
    expect(chat.submits).toHaveLength(1);
  });

  it("fails the turn of an agent its owner turned off, without setting up its session or submitting", async () => {
    const chat = new FakeChat([A]);
    chat.definitions.set(idOf(A), definition(A, { enabled: false }));
    const [turn] = chat.turns.call([idOf(A)], chat.say(MIA, "@atlas hello?"));
    await chat.flush();

    expect(chat.posts).toEqual([{ forPi: true, reply: expect.objectContaining({ turn: turn.id, text: "", failed: "its owner turned @atlas off" }) }]);
    expect(chat.roster.turn(turn.id)?.status).toBe("failed");
    expect(chat.roster.get(idOf(A))?.off).toBe(true);
    expect(chat.roster.views(() => "")[0].off).toBe(true);
    expect(chat.writes).toEqual([]);
    expect(chat.configured).toEqual([]);
    expect(chat.submits).toEqual([]);
    expect(chat.waits).toEqual([]);
    // Its input never went in: its session has no outputs to look for.
    expect(chat.asked).toEqual([]);
  });
});

describe("AgentTurns: errors", () => {
  it("fails the turn when its session cannot be set up, and starts the next", async () => {
    const chat = new FakeChat([A]);
    const configure = vi.spyOn(chat, "configure").mockRejectedValueOnce(new Error("no such model"));
    const [first] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas one"));
    const [second] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas two"));
    await chat.flush();

    expect(configure).toHaveBeenCalledTimes(2);
    expect(chat.replies()).toEqual([expect.objectContaining({ turn: first.id, failed: "no such model" })]);
    expect(chat.roster.turn(first.id)?.status).toBe("failed");
    expect(chat.submits.map((submit) => submit.operationId)).toEqual([`turn:${second.id}`]);
    expect(chat.waits.map((wait) => wait.operationId)).toEqual([`turn:${second.id}`]);
  });

  it("fails the turn when its input cannot be submitted, and starts the next", async () => {
    const chat = new FakeChat([A]);
    vi.spyOn(chat, "submit").mockRejectedValueOnce(new Error("the inbox is full"));
    const [first] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas one"));
    const [second] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas two"));
    await chat.flush();

    expect(chat.replies()).toEqual([expect.objectContaining({ turn: first.id, failed: "the inbox is full" })]);
    expect(chat.submits.map((submit) => submit.operationId)).toEqual([`turn:${second.id}`]);
    expect(chat.waits.map((wait) => wait.operationId)).toEqual([`turn:${second.id}`]);
    expect(chat.runningOf(A)?.id).toBe(second.id);
  });

  it("fails the turn when the owner's directory cannot be read", async () => {
    const chat = new FakeChat([A]);
    vi.spyOn(chat, "definition").mockRejectedValueOnce(new Error("directory unreachable"));
    const [turn] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas one"));
    await chat.flush();

    expect(chat.replies()).toEqual([expect.objectContaining({ turn: turn.id, failed: "directory unreachable" })]);
    expect(chat.roster.get(idOf(A))).not.toBeNull();
    expect(chat.configured).toEqual([]);
    expect(chat.submits).toEqual([]);
  });

  it("fails the turn when its catch-up cannot be written, and sends it again at the next turn", async () => {
    const chat = new FakeChat([A]);
    vi.spyOn(chat, "write").mockRejectedValueOnce(new Error("write refused"));
    chat.say(MIA, "context");
    const [first] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas one"));
    await chat.flush();
    expect(chat.replies()).toEqual([expect.objectContaining({ turn: first.id, failed: "write refused" })]);
    expect(chat.roster.get(idOf(A))?.mirrored).toBe(-1);

    chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas two"));
    await chat.flush();
    expect(chat.writes).toEqual([expect.objectContaining({ session: sessionOf(A), text: expect.stringContaining("[Mia · person]: context") })]);
  });

  it("posts the reply without pages when the session's entries cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { chat, turn } = await called([A]);
    vi.spyOn(chat, "turnEntries").mockRejectedValueOnce(new Error("entries unavailable"));
    chat.finish(turn.id, done("Published."));
    await chat.flush();

    expect(chat.replies()).toEqual([expect.objectContaining({ text: "Published." })]);
    expect(Object.keys(chat.replies()[0])).not.toContain("published");
    expect(error).toHaveBeenCalledWith("agent turn, outputs:", "entries unavailable");
  });

  it("still hands work on when its reply cannot be posted, and a pump never rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { chat, turn } = await called([A, B]);
    vi.spyOn(chat, "post").mockRejectedValueOnce(new Error("log closed"));
    chat.finish(turn.id, done("@bard over to you"));
    await chat.flush();

    expect(error).toHaveBeenCalledWith("agent reply:", "log closed");
    expect(chat.roster.turn(turn.id)?.status).toBe("done");
    expect(chat.latest(B)).toMatchObject({ status: "running", hop: 1 });
    await expect(chat.turns.pump(idOf(A))).resolves.toBeUndefined();
    await expect(chat.turns.pump("id-nobody")).resolves.toBeUndefined();
  });

  it("goes on to the agent's next turn when pi cannot be handed its turn", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { chat, turn } = await called([A]);
    vi.spyOn(chat, "handToPi").mockRejectedValueOnce(new Error("pi is busy"));
    const [next] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas next"));
    chat.finish(turn.id, done("@pi your turn"));
    await chat.flush();

    expect(error).toHaveBeenCalledWith("agent reply:", "pi is busy");
    expect(chat.roster.outbox(turn.id)).toBeNull();
    expect(chat.posts).toEqual([{ forPi: false, reply: expect.objectContaining({ turn: turn.id }) }]);
    expect(chat.runningOf(A)?.id).toBe(next.id);
  });
});

describe("AgentTurns: stop", () => {
  it("aborts running sessions and drops queued turns, and posts nothing for them", async () => {
    const chat = new FakeChat([A, B]);
    const caller = chat.say(OWNER, "@atlas @bard go");
    const [ta, tb] = chat.turns.call([idOf(A), idOf(B)], caller);
    const [queued] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas and this"));
    await chat.flush();
    const before = chat.changes;

    expect(await chat.turns.stop()).toBe(true);
    expect([...chat.aborts].sort()).toEqual([sessionOf(A), sessionOf(B)]);
    expect(chat.changes).toBeGreaterThan(before);
    for (const turn of [ta, tb, queued]) expect(chat.roster.turn(turn.id)?.status).toBe("stopped");

    // Their runs end after the abort: still nothing is posted, nothing is handed on, and the queued turn never runs.
    chat.finish(ta.id, done("@bard late"));
    chat.fail(tb.id, new Error("aborted"));
    await chat.flush();
    expect(chat.posts).toEqual([]);
    expect(chat.toPi).toEqual([]);
    expect(chat.submits).toHaveLength(2);

    // The agents take new turns as before.
    const [again] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas once more"));
    await chat.flush();
    expect(chat.submits.at(-1)?.operationId).toBe(`turn:${again.id}`);
  });

  it("stops only the agent named", async () => {
    const chat = new FakeChat([A, B]);
    const [ta, tb] = chat.turns.call([idOf(A), idOf(B)], chat.say(OWNER, "@atlas @bard go"));
    await chat.flush();

    expect(await chat.turns.stop(idOf(A))).toBe(true);
    expect(chat.aborts).toEqual([sessionOf(A)]);
    expect(chat.roster.turn(ta.id)?.status).toBe("stopped");
    expect(chat.roster.turn(tb.id)?.status).toBe("running");

    chat.finish(ta.id, done("late"));
    chat.finish(tb.id, done("Bard done."));
    await chat.flush();
    expect(chat.replies().map((reply) => reply.text)).toEqual(["Bard done."]);
    expect(await chat.turns.stop(idOf(A))).toBe(false);
  });

  it("says when there was nothing to stop, and tells no one", async () => {
    const chat = new FakeChat([A]);
    expect(await chat.turns.stop()).toBe(false);
    expect(await chat.turns.stop(idOf(A))).toBe(false);
    expect(chat.aborts).toEqual([]);
    expect(chat.changes).toBe(0);
  });

  it("drops turns that only waited without aborting a session", async () => {
    const chat = new FakeChat([A]);
    const turn = queuedBefore(chat, A);
    expect(await chat.turns.stop()).toBe(true);
    expect(chat.aborts).toEqual([]);
    expect(chat.roster.turn(turn.id)?.status).toBe("stopped");
    expect(chat.changes).toBe(1);
  });

  it("aborts the session again when the turn was stopped while its input went in", async () => {
    const chat = new FakeChat([A]);
    const sent = deferred<void>();
    vi.spyOn(chat, "submit").mockReturnValueOnce(sent.promise);
    const [turn] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas go"));
    await chat.flush();

    expect(await chat.turns.stop()).toBe(true);
    expect(chat.aborts).toEqual([sessionOf(A)]);
    sent.resolve();
    await chat.flush();
    expect(chat.aborts).toEqual([sessionOf(A), sessionOf(A)]);
    expect(chat.roster.turn(turn.id)?.status).toBe("stopped");
    expect(chat.waits).toEqual([]);
    expect(chat.posts).toEqual([]);
  });

  it("still stops when a session cannot be aborted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { chat, turn } = await called([A]);
    vi.spyOn(chat, "abort").mockRejectedValueOnce(new Error("no such session"));
    expect(await chat.turns.stop()).toBe(true);
    expect(error).toHaveBeenCalledWith("agent stop:", "no such session");
    expect(chat.roster.turn(turn.id)?.status).toBe("stopped");
  });

  it("never submits a turn stopped while its session was being set up", async () => {
    const chat = new FakeChat([A]);
    const setUp = deferred<void>();
    vi.spyOn(chat, "configure").mockReturnValueOnce(setUp.promise);
    const [turn] = chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas go"));
    await chat.flush();

    expect(await chat.turns.stop()).toBe(true);
    setUp.resolve();
    await chat.flush();
    expect(chat.roster.turn(turn.id)?.status).toBe("stopped");
    expect(chat.submits).toEqual([]);
    expect(chat.posts).toEqual([]);
  });
});

describe("AgentTurns: resume", () => {
  it("waits again on a turn that was running, once however often it resumes, and posts its reply once", async () => {
    const chat = new FakeChat([A]);
    const turn = runningBefore(chat, A);
    const restarted = new AgentTurns(chat);
    restarted.resume();
    restarted.resume();
    await chat.flush();

    expect(chat.waits).toEqual([{ session: sessionOf(A), operationId: `turn:${turn.id}` }]);
    expect(chat.submits).toEqual([]);
    // The wait is kept alive until the reply is posted.
    expect(chat.pendingKept()).toBe(1);

    chat.finish(turn.id, done("Back again."));
    await chat.flush();
    expect(chat.replies()).toEqual([expect.objectContaining({ turn: turn.id, text: "Back again." })]);
    expect(chat.pendingKept()).toBe(0);
  });

  it("posts a turn's reply once even when two objects wait on it", async () => {
    const chat = new FakeChat([A]);
    const turn = runningBefore(chat, A);
    new AgentTurns(chat).resume();
    new AgentTurns(chat).resume();
    await chat.flush();
    expect(chat.waits).toHaveLength(2);

    chat.finish(turn.id, done("Once."));
    await chat.flush();
    expect(chat.replies().map((reply) => reply.text)).toEqual(["Once."]);
  });

  it("starts the agents with turns waiting, each after the turn it runs ends", async () => {
    const chat = new FakeChat([A, B]);
    const a1 = runningBefore(chat, A);
    const a2 = queuedBefore(chat, A);
    const b1 = queuedBefore(chat, B);
    const restarted = new AgentTurns(chat);
    restarted.resume();
    await chat.flush();

    expect(chat.submits.map((submit) => submit.operationId)).toEqual([`turn:${b1.id}`]);
    expect(chat.waits.map((wait) => wait.operationId)).toEqual([`turn:${a1.id}`, `turn:${b1.id}`]);

    chat.finish(a1.id, done("First, after the restart."));
    await chat.flush();
    expect(chat.replies().map((reply) => reply.turn)).toEqual([a1.id]);
    expect(chat.submits.map((submit) => submit.operationId)).toEqual([`turn:${b1.id}`, `turn:${a2.id}`]);
  });

  it("starts again a turn whose input never went in, under the same operation id", async () => {
    const chat = new FakeChat([A]);
    const turn = runningBefore(chat, A, { submitted: false });
    const restarted = new AgentTurns(chat);
    restarted.resume();
    await chat.flush();

    expect(chat.submits.map((submit) => submit.operationId)).toEqual([`turn:${turn.id}`]);
    expect(chat.waits.map((wait) => wait.operationId)).toEqual([`turn:${turn.id}`]);
    expect(chat.roster.turn(turn.id)).toMatchObject({ status: "running", submitted: true });
    chat.finish(turn.id, done("Started again."));
    await chat.flush();
    expect(chat.replies().map((reply) => reply.text)).toEqual(["Started again."]);
  });

  it("delivers again a reply a restart cut off, handing pi its turn once", async () => {
    const chat = new FakeChat([A]);
    const root = runningBefore(chat, A);
    const reply: ChatAgentReplyData = {
      agentId: idOf(A),
      name: A,
      avatar: "at",
      color: "blue",
      ownerUid: OWNER.uid,
      text: "@pi go",
      calledBy: { name: OWNER.name, uid: OWNER.uid },
      turn: root.id,
      hop: 0,
      startedAt: T0,
      endedAt: T0,
    };
    chat.roster.end(root.id, "done", { reply, toPi: true });
    new AgentTurns(chat).resume();
    await chat.flush();

    expect(chat.posts).toEqual([{ reply, forPi: false }]);
    expect(chat.toPi).toEqual([expect.objectContaining({ data: { turn: root.id, calledBy: { name: A, agentId: idOf(A) }, hop: 1, root: root.id } })]);
    expect(chat.roster.outbox(root.id)).toBeNull();
    new AgentTurns(chat).resume();
    await chat.flush();
    expect(chat.posts).toHaveLength(1);
    expect(chat.toPi).toHaveLength(1);
  });

  it("ends the turn, with its reply to deliver, before it posts the reply: a restart in between delivers it then", async () => {
    const { chat, turn } = await called([A]);
    const atPost: { status?: string; undelivered: number[] }[] = [];
    const post = chat.post.bind(chat);
    vi.spyOn(chat, "post").mockImplementation(async (reply, forPi) => {
      atPost.push({ status: chat.roster.turn(reply.turn)?.status, undelivered: chat.roster.undelivered() });
      await post(reply, forPi);
    });
    chat.finish(turn.id, done("Done."));
    await chat.flush();
    expect(atPost).toEqual([{ status: "done", undelivered: [turn.id] }]);
    expect(chat.roster.undelivered()).toEqual([]);
  });

  it("hands pi nothing when a Stop comes while the reply is posted, and pi reads the reply instead", async () => {
    const { chat, turn } = await called([A]);
    const posted = deferred<void>();
    const post = chat.post.bind(chat);
    vi.spyOn(chat, "post").mockImplementationOnce(async (reply, forPi) => {
      await posted.promise;
      await post(reply, forPi);
    });
    chat.finish(turn.id, done("@pi build it"));
    await chat.flush();
    await chat.turns.stop();
    posted.resolve();
    await chat.flush();

    expect(chat.posts).toEqual([{ forPi: false, reply: expect.objectContaining({ turn: turn.id }) }]);
    expect(chat.asides).toEqual([turn.id]);
    expect(chat.toPi).toEqual([]);
    expect(chat.roster.outbox(turn.id)).toBeNull();
  });

  it("reads the log for a catch-up newest first, and only as far back as it keeps", async () => {
    const chat = new FakeChat([A]);
    // Twenty messages of 6000 characters: the catch-up keeps ten of them, and needs no more than six pages of two.
    for (let n = 0; n < 20; n++) chat.say(MIA, `${String(n).padStart(2, "0")}${"x".repeat(5_982)}`);
    chat.turns.call([idOf(A)], chat.say(OWNER, "@atlas sum it up"));
    await chat.flush();
    expect(chat.pagesRead).toBeLessThanOrEqual(6);
    expect(chat.writes[0].text).toContain("(Earlier messages are left out.)");
    expect(chat.writes[0].text).toContain("[Mia · person]: 19x");
    expect(chat.writes[0].text).not.toContain("[Mia · person]: 09x");
    expect(chat.roster.get(idOf(A))?.mirrored).toBe(21);
  });

  it("does nothing on a wake with no turns", async () => {
    const chat = new FakeChat([A, B]);
    chat.turns.resume();
    await chat.flush();
    expect(chat.waits).toEqual([]);
    expect(chat.submits).toEqual([]);
    expect(chat.kept).toEqual([]);
    expect(chat.changes).toBe(0);
  });

  it("keeps the object alive until a turn's reply is posted", async () => {
    const { chat, turn } = await called([A]);
    expect(chat.pendingKept()).toBeGreaterThan(0);
    chat.finish(turn.id, done("Done."));
    await chat.flush();
    expect(chat.pendingKept()).toBe(0);
  });
});

describe("AgentTurns: pi's replies", () => {
  it("gives the agents pi's reply names turns in a chain of their own, as hand-offs that only read", async () => {
    const chat = new FakeChat([A, B]);
    chat.say(MIA, "Anyone around?");
    const text = "Sure: @bard drafts it, then @atlas checks it.";
    const entry = chat.piSays(text);
    chat.turns.fromPi(text, entry);
    await chat.flush();

    const [tb, ta] = [chat.latest(B), chat.latest(A)];
    expect(tb.id).toBeLessThan(ta.id);
    const handOff = {
      hop: 1,
      byOwner: false,
      root: tb.id,
      calledBy: { name: AGENT_NAME, agentId: AGENT_NAME },
      ask: `[pi · agent]: ${text}`,
    };
    expect(tb).toMatchObject(handOff);
    expect(ta).toMatchObject(handOff);
    expect(chat.roster.askKeys(idOf(B), tb.id)).toEqual(new Set([`entry:${entry}`]));
    expect(chat.submits.map((submit) => submit.session)).toEqual([sessionOf(B), sessionOf(A)]);
    expect(chat.submits[0].input).toContain("pi (an agent) asked you");
    expect(chat.submits[0].input).toContain("This is hand-off 1");
    // Each reads Mia's message, and not pi's reply, which its input carries.
    expect(chat.writes.map((write) => write.session)).toEqual([sessionOf(B), sessionOf(A)]);
    for (const write of chat.writes) {
      expect(write.text).toContain("[Mia · person]: Anyone around?");
      expect(write.text).not.toContain("drafts it");
    }
  });

  it("hands work on from pi to at most MAX_HOPS agents for a person's message", async () => {
    const chat = new FakeChat([A, B, C, D, E]);
    const text = "@atlas @bard @cora @dex @echo, everyone";
    chat.turns.fromPi(text, chat.piSays(text));
    await chat.flush();
    expect(chat.roster.allRunning().map((turn) => turn.agentId)).toEqual([idOf(A), idOf(B), idOf(C)]);
  });

  it("carries on the chain an agent handed pi, up to MAX_HOPS hops", async () => {
    const { chat, turn } = await called([A, B]);
    chat.finish(turn.id, done("@pi can you look?"));
    await chat.flush();
    const [handed] = chat.toPi;
    expect(handed.data).toMatchObject({ hop: 1, root: turn.id });

    const text = "Looked. @bard take it from here.";
    chat.turns.fromPi(text, chat.piSays(text), { hop: handed.data.hop, root: handed.data.root });
    await chat.flush();
    const tb = chat.latest(B);
    expect(tb).toMatchObject({ hop: 2, root: turn.id, calledBy: { name: AGENT_NAME, agentId: AGENT_NAME } });

    chat.finish(tb.id, done("@atlas over to you"));
    await chat.flush();
    const last = chat.latest(A);
    expect(last).toMatchObject({ hop: MAX_HOPS, root: turn.id });
    chat.finish(last.id, done("@bard again?"));
    await chat.flush();
    expect(chat.roster.recentTurns(idOf(B))).toHaveLength(1);
    expect(chat.roster.allRunning()).toEqual([]);
  });

  it("gives no turns from pi to a chain that has made its MAX_HOPS hand-offs", async () => {
    const { chat, turn } = await called([A, B, C, D, E]);
    chat.finish(turn.id, done("@bard @cora @dex"));
    await chat.flush();
    const before = chat.changes;

    chat.turns.fromPi("@echo you too", chat.piSays("@echo you too"), { hop: 1, root: turn.id });
    await chat.flush();
    expect(chat.roster.recentTurns(idOf(E))).toEqual([]);
    expect(chat.changes).toBe(before);
  });

  it("gives no turns for a reply of pi's past the hop limit, or one naming no agent of the roster", async () => {
    const chat = new FakeChat([A]);
    chat.turns.fromPi("@atlas once more", chat.piSays("@atlas once more"), { hop: MAX_HOPS, root: 99 });
    chat.turns.fromPi("@pi talking to myself, and @nobody", chat.piSays("@pi talking to myself, and @nobody"));
    chat.turns.fromPi("", chat.piSays(""));
    await chat.flush();
    expect(chat.roster.recentTurns(idOf(A))).toEqual([]);
    expect(chat.changes).toBe(0);
  });

  it("counts a hand-off to pi against the chain's MAX_HOPS", async () => {
    const { chat, turn } = await called([A, B, C, D]);
    chat.finish(turn.id, done("@pi build it"));
    await chat.flush();
    const [handed] = chat.toPi;

    const text = "Built. @bard @cora @dex please review.";
    chat.turns.fromPi(text, chat.piSays(text), { hop: handed.data.hop, root: handed.data.root });
    await chat.flush();
    // pi took one of the chain's hand-offs: two are left.
    expect(chat.roster.allRunning().map((running) => running.agentId)).toEqual([idOf(B), idOf(C)]);
  });
});
