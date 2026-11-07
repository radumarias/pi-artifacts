import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { CHAT_AGENT_KIND, checkAgent, type AgentDefinition, type ChatAgentReplyData, type ChatTurnData } from "../shared/agents.ts";
import { CHAT_MESSAGE_KIND, PUBLISH_TOOL } from "../shared/protocol.ts";
import { FILES_WRITE_TOOL } from "../worker/chat-traces.ts";
import type { McpToolInfo } from "../worker/agent/mcp.ts";
import { AgentTurns, operationId, type Caller, type TurnHost, type TurnOutcome, type TurnResult } from "../worker/agents/controller.ts";
import { ChatRoster, newestShown, type AgentTurn, type PostedPage, type RosterEntry, type RunningTurn } from "../worker/agents/roster.ts";
import type { RoomLink, RoomRef, SeatBatch, SeatLink, SeatResult, SeatTurn } from "../worker/agents/seats/link.ts";
import { memberAgentName, seatChatId } from "../worker/agents/seats/names.ts";
import { addRefusal, mayRemove, mayShare, seatedEntry, type ChatRules } from "../worker/agents/seats/rules.ts";
import { AgentSeats, type SeatHost } from "../worker/agents/seats/seat.ts";
import { allowedTools, askLine, askOf, messageAskKey, sharedServer, turnSources, UNKNOWN_SOURCE } from "../worker/agents/turns.ts";
import type { MemoryAgent } from "../worker/memory/chat.ts";
import { memorySql } from "./fakes.ts";

const T0 = 1_000_000;
const RADU = { uid: "radu", name: "Radu" };
const ANA = { uid: "ana", name: "Ana" };
const MIA = { uid: "mia", name: "Mia" };
const ROOM: RoomRef = { ownerUid: RADU.uid, chatId: "room1" };

/** The deployment's MCP tools, by agent tool name: a database anyone may read, and a calendar each user signs in to. */
const MCP = new Map<string, McpToolInfo>([
  ["db_query", { server: "db", readOnly: true }],
  ["db_insert", { server: "db", readOnly: false }],
  ["calendar_events", { server: "calendar", readOnly: true }],
]);
const SIGNS_IN = (server: string) => server === "calendar";
const APP_TOOLS = ["artifact_read", "files_read", "artifact_write"];
const ALL_TOOLS = [...APP_TOOLS, ...MCP.keys()];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(): Promise<void> {
  for (let n = 0; n < 12; n++) await tick();
}

function definition(id: string, name: string, over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name,
    avatar: name.slice(0, 2),
    color: "teal",
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

/** A tool result in a session, as turnEntries returns it: `details` with records, from an MCP tool or an app's. */
/** A tool result of the app's, with its details. */
function tool(toolName: string, details: object): EntryRecord {
  const message = { role: "toolResult", toolCallId: "c", toolName, content: [], details, isError: false, timestamp: T0 };
  return { id: 0, conversationId: 0, kind: "pi.tool-result", model: [message] } as unknown as EntryRecord;
}

function result(toolName: string, records: { id: string; title: string }[]): EntryRecord {
  const server = MCP.get(toolName)?.server ?? "app";
  const details = { items: records.map((record) => ({ server, ...record })) };
  const message = { role: "toolResult", toolCallId: "c", toolName, content: [], details, isError: false, timestamp: T0 };
  return { id: 0, conversationId: 0, kind: "pi.tool-result", model: [message] } as unknown as EntryRecord;
}

/**
 * pi's sessions in one object, as both sides use them: writes and inputs by session, a fork that remembers its parent,
 * and each run's end a promise the test settles by session and operation.
 */
class Sessions {
  readonly writes: { session: string; text: string; requestId: string }[] = [];
  readonly submits: { session: string; input: string; operationId: string; data: ChatTurnData }[] = [];
  /** Each turn's set-up, with what its memory notes read as then (AgentSeats.memoryAgent, as ChatMemory asks it). */
  readonly configured: { session: string; byOwner: boolean; memory?: MemoryAgent | null }[] = [];
  readonly aborts: string[] = [];
  readonly forks = new Map<string, string>();
  /** Per session and turn, what turnEntries returns. */
  readonly entries = new Map<string, EntryRecord[]>();
  readonly #runs = new Map<string, Deferred<TurnResult>>();
  #made = 0;

  constructor(readonly prefix: string) {}

  create(): string {
    return `${this.prefix}-s${++this.#made}`;
  }
  fork(from: string): string {
    const fork = `${this.prefix}-fork${++this.#made}`;
    this.forks.set(fork, from);
    return fork;
  }
  write(session: string, text: string, requestId: string): void {
    // Placed once per request id, as pi does.
    if (!this.writes.some((write) => write.session === session && write.requestId === requestId)) this.writes.push({ session, text, requestId });
  }
  submit(session: string, input: string, op: string, data: ChatTurnData): void {
    if (!this.submits.some((submit) => submit.session === session && submit.operationId === op))
      this.submits.push({ session, input, operationId: op, data });
  }
  run(session: string, op: string): Deferred<TurnResult> {
    const key = `${session}|${op}`;
    let run = this.#runs.get(key);
    if (!run) this.#runs.set(key, (run = deferred()));
    return run;
  }
  /** The session a turn was submitted in. */
  sessionOf(turn: number): string {
    const found = this.submits.find((submit) => submit.data.turn === turn);
    if (!found) throw new Error(`turn ${turn} was not submitted`);
    return found.session;
  }
  finish(turn: number, text: string, entries: EntryRecord[] = []): void {
    const session = this.sessionOf(turn);
    this.entries.set(`${session}|${turn}`, entries);
    this.run(session, operationId(turn)).resolve({ status: "done", text });
  }
  /** Every write into `session` and the sessions forked from it, as one text. */
  textOf(session: string): string {
    return this.writes
      .filter((write) => write.session === session)
      .map((write) => write.text)
      .join("\n");
  }
}

/** The member's own object: their definitions, their sessions, and the seats of their agents in other people's chats. */
class MemberObject implements SeatHost {
  readonly sessions: Sessions;
  readonly definitions = new Map<string, AgentDefinition>();
  readonly kept: Promise<unknown>[] = [];
  /** The wakes asked for later (SeatHost.later), in ms. */
  readonly wakes: number[] = [];
  readonly seats: AgentSeats;
  /** The rooms by their owner's uid and chat id, as RPC reaches them. */
  readonly rooms = new Map<string, Room>();
  pulls = 0;

  constructor(readonly uid: string) {
    this.sessions = new Sessions(uid);
    this.seats = new AgentSeats(memorySql(), this);
  }

  async definition(agentId: string) {
    return this.definitions.get(agentId) ?? null;
  }
  room(ref: RoomRef, agentId: string): RoomLink {
    const room = this.rooms.get(`${ref.ownerUid}:${ref.chatId}`)!;
    return {
      log: async (after, turn) => {
        this.pulls++;
        return room.seatLog(this.uid, agentId, after, turn);
      },
      ended: (turn, ended) => room.seatEnded(this.uid, agentId, turn, ended),
    };
  }
  async create() {
    return this.sessions.create();
  }
  async fork(session: string) {
    return this.sessions.fork(session);
  }
  async write(session: string, text: string, requestId: string) {
    this.sessions.write(session, text, requestId);
  }
  async configure(session: string, _agent: AgentDefinition, turn: SeatTurn) {
    this.sessions.configured.push({ session, byOwner: turn.byOwner, memory: this.seats.memoryAgent(session) });
  }
  async submit(session: string, input: string, op: string, data: ChatTurnData) {
    this.sessions.submit(session, input, op, data);
  }
  wait(session: string, op: string) {
    return this.sessions.run(session, op).promise;
  }
  async abort(session: string) {
    this.sessions.aborts.push(session);
  }
  async turnEntries(session: string, turn: number) {
    return this.sessions.entries.get(`${session}|${turn}`) ?? [];
  }
  async sources(agent: AgentDefinition, entries: readonly EntryRecord[]) {
    return turnSources(entries, MCP, sharedServer(agent, SIGNS_IN));
  }
  waitUntil(promise: Promise<unknown>) {
    this.kept.push(promise);
  }
  later(ms: number) {
    this.wakes.push(ms);
  }
}

/**
 * The chat's object (the room): its roster and turns, the log, its owner's agents in its own sessions, and the seats of
 * members' agents reached as their objects' methods (the RPC the chat object makes).
 */
class Room implements TurnHost {
  readonly chatOwner = RADU.uid;
  readonly roster = new ChatRoster(memorySql(), () => T0);
  readonly sessions = new Sessions("room");
  readonly log: EntryRecord[] = [];
  readonly definitions = new Map<string, AgentDefinition>();
  readonly members = new Set<string>([ANA.uid, MIA.uid]);
  readonly objects = new Map<string, MemberObject>();
  readonly posts: ChatAgentReplyData[] = [];
  /** The turns handed to pi. */
  readonly handed: ChatTurnData[] = [];
  /** Whose drafts the controller said changed. */
  readonly told: string[] = [];
  readonly kept: Promise<unknown>[] = [];
  /** Who may give a turn now, per asker (the rate limit). */
  limited = new Set<string>();
  readonly turns = new AgentTurns(this);
  #next = 1;

  get rules(): ChatRules {
    return { ownerUid: RADU.uid, isInChat: (uid) => uid === RADU.uid || this.members.has(uid), hasAccount: () => true };
  }

  member(uid: string): MemberObject {
    let object = this.objects.get(uid);
    if (!object) {
      object = new MemberObject(uid);
      object.rooms.set(`${ROOM.ownerUid}:${ROOM.chatId}`, this);
      this.objects.set(uid, object);
    }
    return object;
  }

  /** Bring an agent in: the owner's runs here, a member's as a seat in their own object. */
  add(owner: { uid: string; name: string }, name: string, over: Partial<AgentDefinition> = {}): RosterEntry {
    const id = `${owner.uid}${name}`.padEnd(16, "0").slice(0, 16);
    const agent = definition(id, name, over);
    const mine = owner.uid === RADU.uid;
    if (mine) this.definitions.set(id, agent);
    else this.member(owner.uid).definitions.set(id, agent);
    const handle = mine ? name : memberAgentName(name, owner.name, (taken) => this.roster.byName(taken) !== null)!;
    const refused = this.roster.add({
      agentId: id,
      ownerUid: owner.uid,
      name: handle,
      session: mine ? this.sessions.create() : "",
      avatar: agent.avatar,
      color: agent.color,
      job: agent.job,
      ...(!mine && { seat: seatChatId(id) }),
    });
    if (refused) throw new Error(refused.error);
    return this.roster.get(id)!;
  }

  /** A person's message in the log, and the caller the chat object builds for the agents it calls. */
  say(who: { uid: string; name: string }, text: string): Caller {
    const sentAt = T0 + this.#next;
    this.append({ kind: CHAT_MESSAGE_KIND, data: { uid: who.uid, name: who.name, text, sentAt } });
    return {
      calledBy: { name: who.name, uid: who.uid },
      ask: (own) => askOf({ name: who.name, kind: "person", owner: own }, text),
      askKey: messageAskKey({ uid: who.uid, sentAt }),
      byOwner: true,
    };
  }

  append(fields: { kind: string; data?: object }): EntryRecord {
    const entry = { id: this.#next++, conversationId: 0, ...fields } as unknown as EntryRecord;
    this.log.push(entry);
    return entry;
  }

  // TurnHost
  async definition(entry: RosterEntry) {
    return entry.ownerUid === RADU.uid
      ? (this.definitions.get(entry.agentId) ?? null)
      : (this.member(entry.ownerUid).definitions.get(entry.agentId) ?? null);
  }
  async configure(entry: RosterEntry, _agent: AgentDefinition, turn: { session?: string; byOwner: boolean }) {
    this.sessions.configured.push({ session: turn.session ?? entry.session, byOwner: turn.byOwner });
  }
  async *logSince(after: number) {
    yield this.log.filter((entry) => (entry.id as number) > after).reverse();
  }
  async write(session: string, text: string, requestId: string) {
    this.sessions.write(session, text, requestId);
  }
  async submit(session: string, input: string, op: string, data: ChatTurnData) {
    this.sessions.submit(session, input, op, data);
  }
  wait(session: string, op: string) {
    return this.sessions.run(session, op).promise;
  }
  async abort(session: string) {
    this.sessions.aborts.push(session);
  }
  /** Reading a session's entries fails (outputs that cannot be read). */
  entriesFail = false;
  async turnEntries(session: string, turn: number) {
    if (this.entriesFail) throw new Error("storage hiccup");
    return this.sessions.entries.get(`${session}|${turn}`) ?? [];
  }
  async post(reply: ChatAgentReplyData) {
    if (this.posts.some((post) => post.turn === reply.turn)) return;
    this.posts.push(reply);
    this.append({ kind: CHAT_AGENT_KIND, data: reply });
  }
  async tellPi() {}
  async handToPi(_input: string, data: ChatTurnData) {
    this.handed.push(data);
  }
  /** What the sockets would follow at each change of the roster's view. */
  readonly followed: RunningTurn[][] = [];
  changed() {
    this.followed.push(this.roster.runningSessions());
  }
  waitUntil(promise: Promise<unknown>) {
    this.kept.push(promise);
  }
  async fork(session: string) {
    return { session: this.sessions.fork(session) };
  }
  async newest(session: string) {
    return this.newestEntries.get(session);
  }
  async sources(entry: RosterEntry, entries: readonly EntryRecord[]) {
    const agent = (await this.definition(entry))!;
    return { ...turnSources(entries, MCP, sharedServer(agent, SIGNS_IN)), ...(agent.reviewBeforePosting && { review: true }) };
  }
  /** Errors the next gives to a seat fail with, before reaching it (the RPC was cut off). */
  readonly giveErrors: Error[] = [];
  /** The newest entry of a session, as the harness would say (none: an empty session). */
  readonly newestEntries = new Map<string, number>();
  /** The turns the room stopped at a seat. */
  readonly seatAborts: number[] = [];
  seat(entry: RosterEntry): SeatLink {
    const object = this.member(entry.ownerUid);
    return {
      give: async (batch, turn) => {
        const error = this.giveErrors.shift();
        if (error) throw error;
        return object.seats.give(ROOM, entry.agentId, { ...turn, ownerName: entry.ownerUid, kind: "group" }, batch);
      },
      abort: (turn) => {
        this.seatAborts.push(turn);
        return object.seats.abort(ROOM, turn);
      },
      wake: async () => object.seats.wake(ROOM),
    };
  }
  async mayCall(_entry: RosterEntry, uid: string) {
    return !this.limited.has(uid);
  }
  drafted(uid: string) {
    this.told.push(uid);
  }
  /** How each turn ended, as the chat object's metrics and budget hear it. */
  readonly outcomes: { turn: number; outcome: TurnOutcome }[] = [];
  ended(turn: AgentTurn, outcome: TurnOutcome) {
    this.outcomes.push({ turn: turn.id, outcome });
  }
  /** The versions posted replies made the chat's, as the chat object would announce them. */
  readonly announced: PostedPage[] = [];
  posted(pages: readonly PostedPage[]) {
    this.announced.push(...pages);
  }

  // What the chat object answers a seat's call with (ChatAgent.seatLog, seatEnded).
  async seatLog(uid: string, agentId: string, after: number, turn: number): Promise<SeatBatch> {
    const entry = seatedEntry(this.rules, this.roster.get(agentId), uid);
    if (!entry) throw new Error("This agent is not in the chat.");
    return this.turns.batchFor(entry, after, turn);
  }
  async seatEnded(uid: string, agentId: string, turn: number, ended: SeatResult): Promise<boolean> {
    if (!seatedEntry(this.rules, this.roster.get(agentId), uid)) return true;
    return this.turns.seatEnded(agentId, turn, ended);
  }
}
const room = () => new Room();

describe("Member agents: who may do what", () => {
  const rules: ChatRules = {
    ownerUid: RADU.uid,
    isInChat: (uid) => [RADU.uid, ANA.uid, "radu~2"].includes(uid),
    hasAccount: (uid) => uid !== "radu~2",
  };
  const anas: Pick<RosterEntry, "ownerUid"> = { ownerUid: ANA.uid };

  it("refuses someone not in the chat everywhere: adding, removing, sharing, and a seat's calls", () => {
    expect(addRefusal(rules, MIA.uid)).toBe("You are not in this chat.");
    expect(mayRemove(rules, MIA.uid, { ownerUid: MIA.uid })).toBe(false);
    expect(mayShare(rules, MIA.uid, { ownerUid: MIA.uid })).toBe(false);
    const seated = { agentId: "x", ownerUid: MIA.uid, seat: "seat-x" } as RosterEntry;
    expect(seatedEntry(rules, seated, MIA.uid)).toBeNull();
  });

  it("lets a member bring and remove their own agents; the chat's owner removes anyone's; only an agent's owner shares it", () => {
    expect(addRefusal(rules, ANA.uid)).toBeNull();
    expect(addRefusal(rules, "radu~2")).toBe("Add agents as the chat's owner.");
    expect(mayRemove(rules, ANA.uid, anas)).toBe(true);
    expect(mayRemove(rules, RADU.uid, anas)).toBe(true);
    expect(mayRemove(rules, ANA.uid, { ownerUid: RADU.uid })).toBe(false);
    expect(mayShare(rules, ANA.uid, anas)).toBe(true);
    expect(mayShare(rules, RADU.uid, anas)).toBe(false);
  });

  it("takes a seat's call only for the member's own seated agent", () => {
    const seated = { agentId: "x", ownerUid: ANA.uid, seat: "seat-x" } as RosterEntry;
    expect(seatedEntry(rules, seated, ANA.uid)).toBe(seated);
    expect(seatedEntry(rules, seated, RADU.uid)).toBeNull();
    expect(seatedEntry(rules, { ...seated, seat: undefined }, ANA.uid)).toBeNull();
    expect(seatedEntry(rules, null, ANA.uid)).toBeNull();
  });

  it("names a member's agent apart when its name is taken: planner-ana, then a number", () => {
    const taken = new Set(["planner"]);
    expect(memberAgentName("research", "Ana", (name) => taken.has(name))).toBe("research");
    expect(memberAgentName("planner", "Ana Popescu", (name) => taken.has(name))).toBe("planner-ana");
    taken.add("planner-ana");
    expect(memberAgentName("planner", "Ana", (name) => taken.has(name))).toBe("planner-2");
    expect(memberAgentName("planner", "Ștefan", (name) => taken.has(name))).toBe("planner-stefan");
    expect(memberAgentName("planner", "李", (name) => taken.has(name))).toBe("planner-2");
  });
});

describe("Member agents: tools follow who asks", () => {
  const planner = definition("p", "planner", { servers: ["db", "calendar"] });

  it("gives its owner every server, and anyone else only the shared ones, read-only", () => {
    expect(allowedTools(ALL_TOOLS, MCP, planner, true, SIGNS_IN)).toEqual([...APP_TOOLS, "db_query", "db_insert", "calendar_events"]);
    // Another member's question can't use the calendar, which signs in each user.
    expect(allowedTools(ALL_TOOLS, MCP, planner, false, SIGNS_IN)).toEqual(["artifact_read", "db_query"]);
  });

  it("counts a result by the server its call recorded, and one no one can tell as private", () => {
    const recorded = (toolName: string, server?: string) =>
      ({
        id: 9,
        kind: "pi.tool-result",
        model: [
          { role: "toolResult", toolCallId: "c", toolName, content: [], details: server ? { server } : undefined, isError: false, timestamp: 0 },
        ],
      }) as unknown as EntryRecord;
    // The map no longer knows either tool (a refresh dropped them): the call's record says whose it was.
    const { sources } = turnSources([recorded("calendar__events", "calendar")], new Map(), sharedServer(planner, SIGNS_IN));
    expect(sources).toEqual(["calendar"]);
    expect(turnSources([recorded("calendar__events")], new Map(), sharedServer(planner, SIGNS_IN)).sources).toEqual([UNKNOWN_SOURCE]);
    // An app tool's result is no server's.
    expect(turnSources([recorded("files_read")], new Map(), sharedServer(planner, SIGNS_IN)).sources).toEqual([]);
  });

  it("keeps a private turn's records of the shared servers only, and names the private servers it called", () => {
    const entries = [result("db_query", [{ id: "r1", title: "Row 1" }]), result("calendar_events", [{ id: "e1", title: "West launch" }])];
    const { items, sources } = turnSources(entries, MCP, sharedServer(planner, SIGNS_IN));
    expect(sources).toEqual(["calendar"]);
    expect(items.map((item) => item.id)).not.toContain("e1");
  });

  it("keeps a private server's records out though its tool is no longer listed, and still names the server", () => {
    const listed = new Map([...MCP].filter(([name]) => name !== "calendar_events"));
    const entries = [result("db_query", [{ id: "r1", title: "Row 1" }]), result("calendar_events", [{ id: "e1", title: "West launch" }])];
    const { items, sources } = turnSources(entries, listed, sharedServer(planner, SIGNS_IN));
    expect(items.map((item) => item.id)).toEqual(["r1"]);
    expect(sources).toEqual(["calendar"]);
  });

  it("checks review before posting as a yes or no, and keeps it only when on", () => {
    const base = { name: "planner", job: "Plans.", instructions: "Plan." };
    expect(checkAgent({ ...base, reviewBeforePosting: true }).reviewBeforePosting).toBe(true);
    expect(checkAgent({ ...base, reviewBeforePosting: false })).not.toHaveProperty("reviewBeforePosting");
    expect(() => checkAgent({ ...base, reviewBeforePosting: "yes" })).toThrow(/true or false/);
  });
});

describe("Member agents: a seat in the member's own object", () => {
  it("runs a member's agent there, with its owner's tools only when they ask, and posts its reply back to the room", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner", { servers: ["db"] });
    expect(planner).toMatchObject({ ownerUid: ANA.uid, seat: seatChatId(planner.agentId), session: "" });
    chat.say(MIA, "Lunch at noon?");
    const [byRadu] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner what do we know?"));
    await settle();
    const ana = chat.member(ANA.uid);
    // The room ran nothing of it: the seat's session in Ana's object got the catch-up and the turn.
    expect(chat.sessions.submits).toEqual([]);
    const [seatSession] = ana.sessions.submits.map((submit) => submit.session);
    expect(ana.sessions.textOf(seatSession)).toContain("[Mia · person]: Lunch at noon?");
    // Radu is the chat's owner, not the agent's: the turn only reads, and is labelled as anyone's.
    expect(ana.sessions.configured).toEqual([{ session: seatSession, byOwner: false, memory: expect.objectContaining({ byOwner: false }) }]);
    expect(ana.sessions.submits[0].input).not.toContain("your owner");

    ana.sessions.finish(byRadu.id, "We know the Q3 numbers.", [result("db_query", [{ id: "r1", title: "Q3" }])]);
    await settle();
    expect(chat.posts).toEqual([
      expect.objectContaining({ agentId: planner.agentId, ownerUid: ANA.uid, text: "We know the Q3 numbers.", turn: byRadu.id }),
    ]);
    expect(chat.posts[0]).not.toHaveProperty("forked");
    expect(chat.roster.turn(byRadu.id)?.status).toBe("done");

    // Ana asks her own agent: it may use all her servers and files, in a fork of the seat's session.
    const [byAna] = chat.turns.call([planner.agentId], chat.say(ANA, "@planner and mine?"));
    await settle();
    const fork = ana.sessions.sessionOf(byAna.id);
    expect(ana.sessions.forks.get(fork)).toBe(seatSession);
    expect(ana.sessions.configured.at(-1)).toMatchObject({ session: fork, byOwner: true });
    // The seat's own session reads her ask, which went into the fork only.
    expect(ana.sessions.textOf(seatSession)).toContain("@planner and mine?");
    expect(ana.sessions.submits.at(-1)!.input).toContain("your owner");
    ana.sessions.finish(byAna.id, "Yours too.");
    await settle();
    expect(chat.posts.map((post) => post.turn)).toEqual([byRadu.id, byAna.id]);
  });

  it("tells the room what a seat's turn spent in the member's object, for the chat's budget", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner", { servers: ["db"] });
    const [turn] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner what do we know?"));
    await settle();
    const ana = chat.member(ANA.uid);
    ana.sessions
      .run(ana.sessions.sessionOf(turn.id), operationId(turn.id))
      .resolve({ status: "done", text: "Q3.", spent: { tokens: 1200, costUsd: 0.01 } });
    await settle();
    expect(chat.outcomes).toEqual([{ turn: turn.id, outcome: expect.objectContaining({ status: "done", spent: { tokens: 1200, costUsd: 0.01 } }) }]);
  });

  it("checks who asked again in the seat: a turn said to be its owner's from someone else only reads", async () => {
    const ana = new MemberObject(ANA.uid);
    ana.definitions.set("p", definition("p", "planner"));
    const chat = room();
    ana.rooms.set(`${ROOM.ownerUid}:${ROOM.chatId}`, chat);
    const turn = (uid: string, over: Partial<SeatTurn> = {}): SeatTurn => ({
      turn: 7,
      calledBy: { name: uid, uid },
      hop: 0,
      ask: "[x · person]: hi",
      input: "Your turn",
      ownerName: "Ana",
      kind: "group",
      byOwner: true,
      ...over,
    });
    await ana.seats.give(ROOM, "p", turn(RADU.uid));
    await ana.seats.give(ROOM, "p", turn(ANA.uid, { turn: 8, hop: 1 }));
    await ana.seats.give(ROOM, "p", turn(ANA.uid, { turn: 9 }));
    await ana.seats.give(ROOM, "p", turn(ANA.uid, { turn: 10, unattended: true }));
    expect(ana.sessions.configured.map((configured) => configured.byOwner)).toEqual([false, false, true, false]);
  });

  it("reads a seat's sessions as its room for memory notes: its kind, never alone, the owner's only on a turn they asked for", async () => {
    const ana = new MemberObject(ANA.uid);
    ana.definitions.set("p", definition("p", "planner"));
    ana.rooms.set(`${ROOM.ownerUid}:${ROOM.chatId}`, room());
    const turn = (id: number, uid: string, over: Partial<SeatTurn> = {}): SeatTurn => ({
      turn: id,
      calledBy: { name: uid, uid },
      hop: 0,
      ask: "[x · person]: hi",
      input: "Your turn",
      ownerName: "Ana",
      kind: "group",
      byOwner: uid === ANA.uid,
      ...over,
    });
    await ana.seats.give(ROOM, "p", turn(1, MIA.uid));
    await ana.seats.give(ROOM, "p", turn(2, ANA.uid, { kind: "page" }));
    // Said to be hers by the room, but a hand-off: not her turn.
    await ana.seats.give(ROOM, "p", turn(3, ANA.uid, { hop: 1 }));
    const inRoom = (kind: string | null) => ({ chatId: `${ROOM.ownerUid}:${ROOM.chatId}`, kind });
    expect(ana.sessions.configured.map((configured) => configured.memory)).toEqual([
      { agentId: "p", ownerUid: ANA.uid, name: "planner", byOwner: false, room: inRoom("group") },
      { agentId: "p", ownerUid: ANA.uid, name: "planner", byOwner: true, room: inRoom("page") },
      { agentId: "p", ownerUid: ANA.uid, name: "planner", byOwner: false, room: inRoom("group") },
    ]);
    const [shared, fork] = [ana.sessions.sessionOf(1), ana.sessions.sessionOf(2)];
    expect(fork).not.toBe(shared);
    // Once its turns end the room's kind is not known: nothing is read there, and nothing saved as its owner's. A
    // session no seat has is nobody's (ChatMemory's Whose), so nothing either.
    for (const id of [1, 2, 3]) ana.sessions.finish(id, "Done.");
    await settle();
    for (const session of [shared, fork]) expect(ana.seats.memoryAgent(session)).toMatchObject({ byOwner: false, room: inRoom(null) });
    expect(ana.seats.memoryAgent("no such session")).toBeUndefined();
  });

  it("keeps an agent id to whoever brought it first: another person's agent with the same id is refused", () => {
    const chat = room();
    const hers = chat.add(ANA, "helper");
    const same = { agentId: hers.agentId, name: "analyst", session: "s", avatar: "", color: hers.color, job: "" };
    expect(chat.roster.add({ ...same, ownerUid: RADU.uid })).toEqual({ error: expect.stringContaining("Another agent") });
    expect(chat.roster.get(hers.agentId)).toMatchObject({ ownerUid: ANA.uid, seat: seatChatId(hers.agentId) });
    expect(chat.roster.add({ ...same, ownerUid: ANA.uid })).toBeNull();
  });

  it("lets a requeued turn keep its session, a run's or a fork made for it, where its input may be already", () => {
    const chat = room();
    const mine = chat.add(RADU, "planner");
    const ask = { agentId: mine.agentId, hop: 0, calledBy: { name: RADU.name, uid: RADU.uid }, byOwner: true, ask: "go" };
    const reply = chat.roster.enqueue({ ...ask, session: "run-fork" });
    chat.roster.startNext(mine.agentId);
    chat.roster.requeueUnsubmitted();
    expect(chat.roster.turn(reply.id)).toMatchObject({ status: "queued", session: "run-fork" });
    expect(chat.roster.turn(reply.id)).not.toHaveProperty("forked");
    chat.roster.remove(mine.agentId);
    const again = chat.add(RADU, "planner");
    const plain = chat.roster.enqueue({ ...ask, agentId: again.agentId });
    chat.roster.startNext(again.agentId);
    chat.roster.setFork(plain.id, "private-fork", { review: false });
    expect(chat.roster.turn(plain.id)).toMatchObject({ session: "private-fork", forked: true });
    chat.roster.requeueUnsubmitted();
    expect(chat.roster.turn(plain.id)).toMatchObject({ status: "queued", session: "private-fork", forked: true });
  });

  it("keeps a chain no person started read-only, in a seat and with private servers, and never hands pi a turn", async () => {
    const chat = room();
    const mine = chat.add(RADU, "planner", { servers: ["db", "calendar"] });
    const hers = chat.add(ANA, "helper");
    // A run's hand-over, even one that says its owner asked.
    const caller: Caller = {
      calledBy: { name: "watcher", agentId: "w", schedule: true },
      ask: "[watcher · agent]: look",
      byOwner: true,
      unattended: true,
      hop: 1,
    };
    const turns = chat.turns.call([mine.agentId, hers.agentId], caller);
    expect(turns.map((turn) => turn.byOwner)).toEqual([false, false]);
    await settle();
    // No fork: the owner's agent runs in its own session, reading only.
    expect(chat.sessions.configured).toEqual([{ session: mine.session, byOwner: false }]);
    expect(chat.member(ANA.uid).sessions.configured.map((configured) => configured.byOwner)).toEqual([false]);
    chat.sessions.finish(turns[0].id, "@pi have a look at this.");
    await settle();
    expect(chat.handed).toEqual([]);
    expect(chat.posts).toEqual([expect.objectContaining({ turn: turns[0].id })]);
    expect(chat.posts[0]).not.toHaveProperty("forked");
  });

  it("refuses a turn for an agent its owner deleted or turned off, and reports it as unanswered", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    chat.member(ANA.uid).definitions.set(planner.agentId, definition(planner.agentId, "planner", { enabled: false }));
    chat.turns.call([planner.agentId], chat.say(ANA, "@planner hi"));
    await settle();
    expect(chat.posts).toEqual([expect.objectContaining({ failed: expect.stringContaining("turned @planner off") })]);
  });

  it("places a duplicate delivery once", async () => {
    const ana = new MemberObject(ANA.uid);
    ana.definitions.set("p", definition("p", "planner"));
    const batch: SeatBatch = { from: 0, through: 4, text: "What was said…", turn: 1 };
    expect(await ana.seats.deliver(ROOM, "p", batch)).toBe(4);
    expect(await ana.seats.deliver(ROOM, "p", batch)).toBe(4);
    expect(await ana.seats.deliver(ROOM, "p", { ...batch, from: 2, through: 3 })).toBe(4);
    expect(ana.sessions.writes).toHaveLength(1);
    expect(ana.seats.delivered(ROOM, "p")).toBe(4);
  });

  it("fills a gap by pulling the range from the room, and an overlap too", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    const ana = chat.member(ANA.uid);
    chat.say(MIA, "one");
    chat.say(MIA, "two");
    chat.say(MIA, "three");
    // The room believes the seat has read through entry 2 (a delivery it thought went in), but the seat has nothing.
    expect(await ana.seats.deliver(ROOM, planner.agentId, { from: 3, through: 3, text: "[Mia · person]: three", turn: 1 })).toBe(3);
    expect(ana.pulls).toBe(1);
    const [write] = ana.sessions.writes;
    expect(write.text).toContain("one");
    expect(write.text).toContain("three");
    // An overlap (it has through 3; the batch starts at 2) pulls only what comes after.
    chat.say(MIA, "four");
    expect(await ana.seats.deliver(ROOM, planner.agentId, { from: 2, through: 4, text: "two, three, four", turn: 1 })).toBe(4);
    expect(ana.pulls).toBe(2);
    expect(ana.sessions.writes[1].text).toContain("four");
    expect(ana.sessions.writes[1].text).not.toContain("three");
  });

  it("refuses a pull from someone whose agent is not seated in the chat", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    await expect(chat.seatLog(MIA.uid, planner.agentId, -1, 1)).rejects.toThrow(/not in the chat/);
    chat.members.delete(ANA.uid);
    await expect(chat.seatLog(ANA.uid, planner.agentId, -1, 1)).rejects.toThrow(/not in the chat/);
    // A reply from a seat no longer in the chat is let go, and posts nothing.
    expect(await chat.seatEnded(ANA.uid, planner.agentId, 1, { status: "done", text: "hi", published: [], items: [], sources: [] })).toBe(true);
    expect(chat.posts).toEqual([]);
  });

  it("posts a seat's reply once though the seat sends it again after a restart", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    const [turn] = chat.turns.call([planner.agentId], chat.say(ANA, "@planner hi"));
    await settle();
    const ana = chat.member(ANA.uid);
    ana.sessions.finish(turn.id, "Hello.");
    await settle();
    const ended: SeatResult = { status: "done", text: "Hello.", published: [], items: [], sources: [] };
    expect(await chat.seatEnded(ANA.uid, planner.agentId, turn.id, ended)).toBe(true);
    expect(chat.posts).toHaveLength(1);
  });

  it("keeps a reply the room could not take, and posts it on the next wake; a turn given twice runs once", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    const [turn] = chat.turns.call([planner.agentId], chat.say(ANA, "@planner hi"));
    await settle();
    const ana = chat.member(ANA.uid);
    const given = ana.sessions.submits[0];
    await ana.seats.give(ROOM, planner.agentId, {
      turn: turn.id,
      calledBy: given.data.calledBy,
      hop: 0,
      ask: "[Ana · person · your owner]: @planner hi",
      input: given.input,
      ownerName: "Ana",
      kind: "group",
      byOwner: true,
    });
    expect(ana.sessions.submits).toHaveLength(1);
    // The room is down when the turn ends.
    const ended = chat.seatEnded.bind(chat);
    chat.seatEnded = () => Promise.reject(new Error("room restarting"));
    ana.sessions.finish(turn.id, "Hello.");
    await settle();
    expect(chat.posts).toEqual([]);
    chat.seatEnded = ended;
    ana.seats.wake(ROOM);
    await settle();
    expect(chat.posts).toEqual([expect.objectContaining({ turn: turn.id, text: "Hello." })]);
    // Taken: a later wake sends nothing again.
    ana.seats.wake();
    await settle();
    expect(chat.posts).toHaveLength(1);
  });

  it("stops a seat's turn there, and drops the seat when the agent leaves", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    chat.turns.call([planner.agentId], chat.say(ANA, "@planner hi"));
    await settle();
    const ana = chat.member(ANA.uid);
    const [seatSession] = ana.sessions.submits.map((submit) => submit.session);
    expect(await chat.turns.stop(planner.agentId)).toBe(true);
    expect(ana.sessions.aborts).toEqual([seatSession]);
    await ana.seats.drop(ROOM, planner.agentId);
    expect(ana.seats.delivered(ROOM, planner.agentId)).toBe(-1);
  });

  it("ends a turn at once, saying so, when the asker is over the rate limit", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    chat.limited.add(MIA.uid);
    chat.turns.call([planner.agentId], chat.say(MIA, "@planner again"));
    await settle();
    expect(chat.posts).toEqual([expect.objectContaining({ failed: expect.stringContaining("asked too often") })]);
    expect(chat.member(ANA.uid).sessions.submits).toEqual([]);
  });

  it("removes a person's agents with them, keeping their past replies", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    const research = chat.add(RADU, "research");
    expect(chat.roster.ownedBy(ANA.uid).map((entry) => entry.agentId)).toEqual([planner.agentId]);
    chat.roster.remove(planner.agentId);
    expect(chat.roster.list().map((entry) => entry.agentId)).toEqual([research.agentId]);
  });

  it("names a second planner apart, and keeps that name when its definition is read again", () => {
    const chat = room();
    chat.add(RADU, "planner");
    const anas = chat.add(ANA, "planner");
    expect(anas.name).toBe("planner-ana");
    const refreshed = chat.roster.refresh(anas.agentId, { name: "planner", avatar: "pl", color: "teal", job: "Plans.", off: false });
    expect(refreshed?.entry.name).toBe("planner-ana");
  });
});

describe("Member agents: private turns run apart", () => {
  it("runs every turn its owner gives in a fork, whatever servers it shares: it has the owner's files and tools", async () => {
    const chat = room();
    const dbOnly = chat.add(RADU, "planner", { servers: ["db"] });
    const [mine] = chat.turns.call([dbOnly.agentId], chat.say(RADU, "@planner total salaries.md"));
    const [hers] = chat.turns.call([dbOnly.agentId], chat.say(MIA, "@planner hi"));
    await settle();
    expect(chat.sessions.forks.get(chat.sessions.sessionOf(mine.id))).toBe(dbOnly.session);
    chat.sessions.finish(mine.id, "42.");
    await settle();
    expect(chat.sessions.sessionOf(hers.id)).toBe(dbOnly.session);
  });

  it("runs the owner's turn that may reach a private server in a fork; only the posted reply reaches the shared session", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"] });
    chat.say(MIA, "When is the West launch?");
    const [mine] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner check my calendar"));
    await settle();
    const fork = chat.sessions.sessionOf(mine.id);
    expect(chat.sessions.forks.get(fork)).toBe(planner.session);
    // The catch-up went into the shared session before the fork was made, so the fork sees it.
    expect(chat.sessions.textOf(planner.session)).toContain("When is the West launch?");
    expect(chat.roster.turn(mine.id)?.session).toBe(fork);
    // Only its owner follows a fork live.
    expect(chat.roster.runningSessions()).toEqual([{ agentId: planner.agentId, session: fork, turn: mine.id, only: RADU.uid }]);

    chat.sessions.finish(mine.id, "The West launch is in week 41.", [
      result("calendar_events", [{ id: "e1", title: "Board dinner (private)" }]),
      result("db_query", [{ id: "r1", title: "West signups" }]),
    ]);
    await settle();
    const [posted] = chat.posts;
    expect(posted).toMatchObject({ forked: true, sources: ["calendar"], text: "The West launch is in week 41." });
    expect(posted.items?.map((item) => item.id)).toEqual(["r1"]);

    // Mia asks next: her turn runs in the shared session, which has the posted reply and none of the private results.
    const [hers] = chat.turns.call([planner.agentId], chat.say(MIA, "@planner what did the calendar say earlier?"));
    await settle();
    expect(chat.sessions.sessionOf(hers.id)).toBe(planner.session);
    expect(chat.sessions.configured.at(-1)).toEqual({ session: planner.session, byOwner: false });
    const shared = chat.sessions.textOf(planner.session);
    expect(shared).toContain("(your reply, as posted): The West launch is in week 41.");
    expect(shared).not.toContain("Board dinner");
  });

  it("does the same in a member's seat: the fork is in their object, and the reply carries their source chip", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner", { servers: ["db", "calendar"] });
    const [turn] = chat.turns.call([planner.agentId], chat.say(ANA, "@planner my calendar?"));
    await settle();
    const ana = chat.member(ANA.uid);
    const fork = ana.sessions.sessionOf(turn.id);
    expect(ana.sessions.forks.has(fork)).toBe(true);
    ana.sessions.finish(turn.id, "Week 41.", [result("calendar_events", [{ id: "e1", title: "Private" }])]);
    await settle();
    expect(chat.posts).toEqual([expect.objectContaining({ forked: true, sources: ["calendar"], ownerUid: ANA.uid })]);
    expect(chat.posts[0].items ?? []).toEqual([]);
  });

  it("holds a reply built on a private server for its owner to review, then posts it as they edited it", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const [turn] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner calendar, then ask @planner"));
    await settle();
    chat.sessions.finish(turn.id, "Board dinner on Friday; West launch in week 41.", [result("calendar_events", [{ id: "e1", title: "x" }])]);
    await settle();
    expect(chat.posts).toEqual([]);
    expect(chat.told).toEqual([RADU.uid]);
    expect(chat.roster.held(RADU.uid)).toEqual([expect.objectContaining({ turn: turn.id, agentId: planner.agentId })]);
    // Nobody else's.
    expect(chat.roster.held(ANA.uid)).toEqual([]);
    expect(await chat.turns.post(ANA.uid, planner.agentId, turn.id)).toEqual({ error: expect.stringContaining("No such draft") });

    expect(await chat.turns.post(RADU.uid, planner.agentId, turn.id, "The West launch is in week 41.")).toBeNull();
    expect(chat.posts).toEqual([expect.objectContaining({ text: "The West launch is in week 41.", postedBy: RADU.uid, sources: ["calendar"] })]);
    expect(chat.roster.held(RADU.uid)).toEqual([]);
    // Posted once.
    expect(await chat.turns.post(RADU.uid, planner.agentId, turn.id)).toEqual({ error: expect.stringContaining("No such draft") });
    expect(chat.posts).toHaveLength(1);
  });

  it("never posts a discarded draft, and posts a private reply at once when review is off or it read no private server", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const [first] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner one"));
    await settle();
    chat.sessions.finish(first.id, "Private.", [result("calendar_events", [{ id: "e1", title: "x" }])]);
    await settle();
    expect(chat.turns.discard(RADU.uid, planner.agentId, first.id)).toBeNull();
    expect(chat.posts).toEqual([]);
    expect(chat.roster.held(RADU.uid)).toEqual([]);

    const [second] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner two"));
    await settle();
    chat.sessions.finish(second.id, "Only the database.", [result("db_query", [{ id: "r1", title: "Row" }])]);
    await settle();
    expect(chat.posts).toEqual([expect.objectContaining({ turn: second.id, forked: true })]);
    expect(chat.posts[0]).not.toHaveProperty("sources");
  });

  it("lets a removed agent's drafts go with it", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["calendar"], reviewBeforePosting: true });
    const [turn] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner one"));
    await settle();
    chat.sessions.finish(turn.id, "Private.", [result("calendar_events", [])]);
    await settle();
    expect(chat.roster.held(RADU.uid)).toHaveLength(1);
    chat.roster.remove(planner.agentId);
    expect(chat.roster.held(RADU.uid)).toEqual([]);
  });

  it("reads its own forked reply in a catch-up, and skips its own other replies", () => {
    const reply = (forked: boolean) =>
      ({
        id: 9,
        conversationId: 0,
        kind: CHAT_AGENT_KIND,
        data: { agentId: "p", name: "planner", text: "Week 41.", ...(forked && { forked: true }) },
      }) as unknown as EntryRecord;
    expect(askLine(reply(true), "p", RADU.uid)).toBe("[planner · agent] (your reply, as posted): Week 41.");
    expect(askLine(reply(false), "p", RADU.uid)).toBeUndefined();
    expect(askLine(reply(true), "other", RADU.uid)).toBe("[planner · agent]: Week 41.");
  });

  it("reads with its own forked reply the pages it published and the files it saved there, which its session never saw", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"] });
    const [turn] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner chart my week"));
    await settle();
    chat.sessions.finish(turn.id, "Here it is.", [
      tool(PUBLISH_TOOL, { artifactId: "page1", version: 2, title: "My week" }),
      tool(FILES_WRITE_TOOL, { saved: ["out/c1/week.csv"] }),
    ]);
    await settle();
    expect(chat.posts).toEqual([
      expect.objectContaining({ published: [{ artifactId: "page1", version: 2, title: "My week" }], saved: ["out/c1/week.csv"] }),
    ]);
    const posted = { id: 9, conversationId: 0, kind: CHAT_AGENT_KIND, data: chat.posts[0] } as unknown as EntryRecord;
    expect(askLine(posted, planner.agentId, RADU.uid)).toBe(
      '[planner · agent] (your reply, as posted): Here it is. (in that turn you published "My week" (artifact page1, v2); saved out/c1/week.csv)',
    );
  });
});

describe("Member agents: what the review of private turns found", () => {
  const retryable = () => Object.assign(new Error("Network connection lost."), { retryable: true });

  it("puts a forked turn's ask in the shared session too, so later turns read it with the reply", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"] });
    const [mine] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner answer in French from now on"));
    await settle();
    expect(chat.sessions.sessionOf(mine.id)).not.toBe(planner.session);
    // Its input went only into the fork, and the catch-up left the ask out: the shared session reads it on its own.
    const shared = () =>
      chat.sessions.writes
        .filter((write) => write.session === planner.session)
        .map((write) => write.text)
        .join("\n");
    expect(shared()).toContain("answer in French from now on");
    chat.sessions.finish(mine.id, "D'accord.");
    await settle();
    const [hers] = chat.turns.call([planner.agentId], chat.say(MIA, "@planner hi"));
    await settle();
    expect(chat.sessions.sessionOf(hers.id)).toBe(planner.session);
    expect(shared()).toContain("(your reply, as posted): D'accord.");
    // Once: the next catch-up does not read the ask again.
    expect(shared().split("answer in French from now on")).toHaveLength(2);
  });

  it("lets everyone stop following the shared session once a turn forks, and only its owner follow the fork", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"] });
    const [mine] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner my calendar"));
    await settle();
    const fork = chat.sessions.sessionOf(mine.id);
    expect(chat.followed.at(-1)).toEqual([{ agentId: planner.agentId, session: fork, turn: mine.id, only: RADU.uid }]);
  });

  it("starts a requeued forked turn again in its fork: no second fork, and its input placed once", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"] });
    const turn = chat.roster.enqueue({ agentId: planner.agentId, hop: 0, calledBy: { name: RADU.name, uid: RADU.uid }, byOwner: true, ask: "go" });
    chat.roster.startNext(planner.agentId);
    chat.roster.setFork(turn.id, "room-fork-before", { review: false });
    // The object restarted before the input was marked in.
    chat.turns.resume();
    await settle();
    expect(chat.sessions.sessionOf(turn.id)).toBe("room-fork-before");
    expect(chat.sessions.forks.size).toBe(0);
    expect(chat.sessions.configured.at(-1)).toEqual({ session: "room-fork-before", byOwner: true });
  });

  it("holds a forked reply whose outputs cannot be read when its owner reviews such replies, with an unknown source", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const [turn] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner calendar?"));
    await settle();
    chat.entriesFail = true;
    chat.sessions.finish(turn.id, "Board dinner on Friday.");
    await settle();
    expect(chat.posts).toEqual([]);
    expect(chat.roster.held(RADU.uid)).toEqual([
      expect.objectContaining({ turn: turn.id, reply: expect.objectContaining({ sources: [UNKNOWN_SOURCE] }) }),
    ]);
  });

  it("withholds what a fork made until its reply is posted, and for good once it is discarded", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const [kept] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner calendar?"));
    await settle();
    const first = chat.sessions.sessionOf(kept.id);
    expect(chat.roster.withheld()).toEqual(new Set([first]));
    chat.sessions.finish(kept.id, "Friday.", [result("calendar_events", [{ id: "e1", title: "x" }])]);
    await settle();
    // Held for review: still withheld, until its owner posts it.
    expect(chat.roster.withheld()).toEqual(new Set([first]));
    expect(chat.roster.forks().get(first)).toMatchObject({ posted: false, ended: true });
    expect(await chat.turns.post(RADU.uid, planner.agentId, kept.id)).toBeNull();
    expect(chat.roster.withheld()).toEqual(new Set());
    // Kept as a fork, ended: its session is read once more, as the chat's, and then no more.
    expect(chat.roster.forks().get(first)).toMatchObject({ posted: true, ended: true });

    const [dropped] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner again"));
    await settle();
    const second = chat.sessions.sessionOf(dropped.id);
    chat.sessions.finish(dropped.id, "Again Friday.", [result("calendar_events", [{ id: "e1", title: "x" }])]);
    await settle();
    expect(chat.turns.discard(RADU.uid, planner.agentId, dropped.id)).toBeNull();
    expect(chat.roster.withheld()).toEqual(new Set([second]));
  });

  it("keeps a failed or empty fork's outputs withheld: held for its owner when it read a private server and review is on", async () => {
    const chat = room();
    const end = (turn: number, result: TurnResult, entries: EntryRecord[]) => {
      const session = chat.sessions.sessionOf(turn);
      chat.sessions.entries.set(`${session}|${turn}`, entries);
      chat.sessions.run(session, operationId(turn)).resolve(result);
    };
    const calendar = [result("calendar_events", [{ id: "e1", title: "x" }])];
    const reviewed = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    // Failed after it read the calendar (a model error, a step limit), and done with no text: both held, both withheld.
    const [failed] = chat.turns.call([reviewed.agentId], chat.say(RADU, "@planner my week"));
    await settle();
    const failedFork = chat.sessions.sessionOf(failed.id);
    end(failed.id, { status: "unanswered", reason: "model error", text: "Board dinner Friday" }, calendar);
    await settle();
    const [empty] = chat.turns.call([reviewed.agentId], chat.say(RADU, "@planner again"));
    await settle();
    const emptyFork = chat.sessions.sessionOf(empty.id);
    end(empty.id, { status: "done", text: "  " }, calendar);
    await settle();
    expect(chat.posts).toEqual([]);
    expect(chat.roster.held(RADU.uid).map((held) => held.turn)).toEqual([failed.id, empty.id]);
    expect(chat.roster.withheld()).toEqual(new Set([failedFork, emptyFork]));
    // Its owner posts the failed one as theirs: its outputs are the chat's now, and it reads as a reply, not a failure.
    expect(await chat.turns.post(RADU.uid, reviewed.agentId, failed.id)).toBeNull();
    expect(chat.posts).toEqual([expect.objectContaining({ text: "Board dinner Friday", postedBy: RADU.uid })]);
    expect(chat.posts[0]).not.toHaveProperty("failed");
    expect(chat.roster.withheld()).toEqual(new Set([emptyFork]));

    // Without review the failure posts at once, but what its fork made stays withheld, as a discarded draft's does.
    const open = chat.add(RADU, "helper", { servers: ["db", "calendar"] });
    const [unreviewed] = chat.turns.call([open.agentId], chat.say(RADU, "@helper my week"));
    await settle();
    const openFork = chat.sessions.sessionOf(unreviewed.id);
    end(unreviewed.id, { status: "unanswered", reason: "model error" }, [
      ...calendar,
      tool(PUBLISH_TOOL, { artifactId: "p9", version: 1, title: "Week" }),
    ]);
    await settle();
    expect(chat.posts.at(-1)).toMatchObject({ turn: unreviewed.id, failed: "model error" });
    expect(chat.posts.at(-1)).not.toHaveProperty("published");
    expect(chat.roster.withheld()).toEqual(new Set([emptyFork, openFork]));
  });

  it("keeps the files a turn apart saves withheld from when it saves them until its reply is posted", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const calendar = [result("calendar_events", [{ id: "e1", title: "x" }])];
    const [kept] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner total it"));
    await settle();
    const fork = chat.sessions.sessionOf(kept.id);
    // Saved by a tool that was then stopped: no result names it, the record does. pi's session records nothing.
    chat.roster.recordFiles(fork, ["out/c1/totals.csv"]);
    chat.roster.recordFiles(planner.session, ["out/c1/pi.csv"]);
    expect(chat.roster.withheldFiles()).toEqual(new Set(["out/c1/totals.csv"]));
    chat.sessions.finish(kept.id, "Totals.", calendar);
    await settle();
    expect(chat.roster.withheldFiles()).toEqual(new Set(["out/c1/totals.csv"]));
    expect(await chat.turns.post(RADU.uid, planner.agentId, kept.id)).toBeNull();
    expect(chat.roster.withheldFiles()).toEqual(new Set());

    const [dropped] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner again"));
    await settle();
    chat.roster.recordFiles(chat.sessions.sessionOf(dropped.id), ["out/c1/again.csv"]);
    chat.sessions.finish(dropped.id, "Again.", calendar);
    await settle();
    expect(chat.turns.discard(RADU.uid, planner.agentId, dropped.id)).toBeNull();
    expect(chat.roster.withheldFiles()).toEqual(new Set(["out/c1/again.csv"]));
  });

  it("keeps what a fork published by version until its reply is posted, and for good once it is discarded", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const [kept] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner chart it"));
    await settle();
    const fork = chat.sessions.sessionOf(kept.id);
    expect(chat.roster.fork(fork)).toMatchObject({ posted: false, ended: false, review: true });
    // A new version of a page the chat has (w1 v3), and a page of its own (p1 v1); pi's session records nothing.
    chat.roster.recordPage(fork, "w1", 3);
    chat.roster.recordPage(fork, "p1", 1);
    chat.roster.recordPage(planner.session, "x1", 1);
    expect([chat.roster.withheldVersion("w1", 3), chat.roster.withheldVersion("w1", 2), chat.roster.withheldVersion("x1", 1)]).toEqual([
      true,
      false,
      false,
    ]);
    // Not from the fork itself: it builds on what it made.
    expect(chat.roster.withheldVersion("w1", 3, fork)).toBe(false);
    expect([chat.roster.pagesOf(fork), chat.roster.madeApart(), chat.roster.withheldVersion("w1")]).toEqual([
      new Set(["w1", "p1"]),
      new Set(["p1"]),
      true,
    ]);
    chat.sessions.finish(kept.id, "Charted.", [result("calendar_events", [{ id: "e1", title: "x" }])]);
    await settle();
    expect(chat.roster.withheldVersion("w1", 3)).toBe(true);
    expect(await chat.turns.post(RADU.uid, planner.agentId, kept.id)).toBeNull();
    expect([chat.roster.withheldVersion("w1", 3), chat.roster.madeApart(), chat.roster.withheldVersion("w1")]).toEqual([false, new Set(), false]);
    // Recorded only while apart and not posted.
    chat.roster.recordPage(fork, "w1", 4);
    expect(chat.roster.withheldVersion("w1", 4)).toBe(false);

    const [dropped] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner again"));
    await settle();
    const second = chat.sessions.sessionOf(dropped.id);
    chat.roster.recordPage(second, "w1", 5);
    chat.sessions.finish(dropped.id, "Again.", [result("calendar_events", [{ id: "e1", title: "x" }])]);
    await settle();
    expect(chat.turns.discard(RADU.uid, planner.agentId, dropped.id)).toBeNull();
    expect(chat.roster.withheldVersion("w1", 5)).toBe(true);
  });

  it("runs a reply to a run's report apart from the chat: what it publishes waits for its reply, and the session never settles", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const reply = (text: string) => chat.turns.call([planner.agentId], { ...chat.say(RADU, text), session: "run-reply" });
    // The run's report is in the session already: it stays the chat's, and what is apart starts after it.
    chat.newestEntries.set("run-reply", 7);
    const [first] = reply("@planner and the week after?");
    await settle();
    expect(chat.sessions.sessionOf(first.id)).toBe("run-reply");
    expect(chat.roster.fork("run-reply")).toMatchObject({ posted: false, ended: false, review: true, reused: true, from: 7 });
    chat.roster.recordPage("run-reply", "r1", 2);
    chat.sessions.finish(first.id, "Week 42 too.", [result("calendar_events", [{ id: "e1", title: "x" }])]);
    await settle();
    // Held for review: its version waits. A session later turns run in again is never read to its end for good.
    expect(chat.roster.withheldVersion("r1", 2)).toBe(true);
    expect(chat.roster.fork("run-reply")).toMatchObject({ posted: false, ended: false });
    expect(await chat.turns.post(RADU.uid, planner.agentId, first.id)).toBeNull();
    expect(chat.roster.withheldVersion("r1", 2)).toBe(false);
    expect(chat.announced).toEqual([{ artifactId: "r1", version: 2 }]);
    // The next reply in the same session is apart again, in a window of its own from the newest entry then: what the
    // first posted stays the chat's.
    chat.newestEntries.set("run-reply", 12);
    const [second] = reply("@planner and after that?");
    await settle();
    expect(chat.roster.fork("run-reply")).toMatchObject({ posted: false, from: 7 });
    expect(chat.roster.windows("run-reply")).toEqual([
      { turn: first.id, from: 7, through: 12, posted: true },
      { turn: second.id, from: 12, posted: false },
    ]);
    // Given again while still apart (its reply not posted): it keeps its window.
    chat.roster.setApart("run-reply", true, 15, second.id);
    expect(chat.roster.windows("run-reply").at(-1)).toEqual({ turn: second.id, from: 12, posted: false });
    chat.roster.recordPage("run-reply", "r1", 3);
    expect([chat.roster.withheldVersion("r1", 2), chat.roster.withheldVersion("r1", 3)]).toEqual([false, true]);
  });

  it("shows someone else the newest version no turn apart is still holding", () => {
    expect(newestShown(4, new Set([4]))).toBe(3);
    expect(newestShown(4, new Set([2, 4, 3]))).toBe(1);
    expect(newestShown(4, new Set([2]))).toBe(4);
    expect(newestShown(1, new Set([1]))).toBe(0);
  });

  it("posts a held reply to a run's report as its own once a later turn runs in its session, and leaves the later one apart", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const reply = (text: string) => chat.turns.call([planner.agentId], { ...chat.say(RADU, text), session: "run-reply" });
    const calendar = [result("calendar_events", [{ id: "e1", title: "x" }])];
    chat.newestEntries.set("run-reply", 3);
    const [first] = reply("@planner and the week after?");
    await settle();
    chat.roster.recordPage("run-reply", "r1", 1);
    chat.sessions.finish(first.id, "Week 42.", [...calendar, tool(PUBLISH_TOOL, { artifactId: "r1", version: 1, title: "Week" })]);
    await settle();
    // Held for review while the next reply in the session starts.
    chat.newestEntries.set("run-reply", 9);
    const [second] = reply("@planner and week 43?");
    await settle();
    chat.roster.recordPage("run-reply", "r2", 1);
    expect(await chat.turns.post(RADU.uid, planner.agentId, first.id)).toBeNull();
    // The first reply's page is the chat's and its chip shows; the second turn's stays apart.
    expect(chat.posts.at(-1)).toMatchObject({ turn: first.id, published: [{ artifactId: "r1", version: 1, title: "Week" }] });
    expect([chat.roster.withheldVersion("r1", 1), chat.roster.withheldVersion("r2", 1)]).toEqual([false, true]);
    expect(chat.roster.windows("run-reply").map((window) => window.posted)).toEqual([true, false]);
    expect(chat.roster.fork("run-reply")).toMatchObject({ posted: false });
    expect(chat.roster.withheld()).toEqual(new Set(["run-reply"]));
    chat.sessions.finish(second.id, "Week 43.", calendar);
    await settle();
    expect(await chat.turns.post(RADU.uid, planner.agentId, second.id)).toBeNull();
    expect(chat.roster.withheldVersion("r2", 1)).toBe(false);
    expect(chat.roster.anyWithheld()).toBe(false);
    expect(chat.announced).toEqual([
      { artifactId: "r1", version: 1 },
      { artifactId: "r2", version: 1 },
    ]);
  });

  it("keeps what a discarded reply to a run's report made withheld for good, and posts a later reply's own", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const reply = (text: string) => chat.turns.call([planner.agentId], { ...chat.say(RADU, text), session: "run-reply" });
    const calendar = [result("calendar_events", [{ id: "e1", title: "x" }])];
    const [first] = reply("@planner and the week after?");
    await settle();
    chat.roster.recordPage("run-reply", "r1", 2);
    chat.roster.recordDraft("run-reply", "d1");
    chat.sessions.finish(first.id, "Week 42 too.", calendar);
    await settle();
    expect(chat.turns.discard(RADU.uid, planner.agentId, first.id)).toBeNull();
    // The next reply runs in the same session, in a window of its own: what the discarded one made stays withheld.
    const [second] = reply("@planner then just next week?");
    await settle();
    expect(chat.roster.windows("run-reply").map((window) => [window.turn, window.posted])).toEqual([
      [first.id, false],
      [second.id, false],
    ]);
    chat.roster.recordPage("run-reply", "r2", 1);
    chat.roster.recordDraft("run-reply", "d2");
    expect(chat.roster.withheldDrafts("pi")).toEqual(new Set(["d1", "d2"]));
    // The later turn in the same session is apart from the discarded one too: it neither sees nor builds on what it made.
    expect([
      chat.roster.withheldDrafts("run-reply"),
      chat.roster.withheldVersions("r1", "run-reply"),
      chat.roster.withheldVersion("r1", 2, "run-reply"),
      chat.roster.withheldVersion("r2", 1, "run-reply"),
      chat.roster.pagesOf("run-reply"),
    ]).toEqual([new Set(["d1"]), new Set([2]), true, false, new Set(["r2"])]);
    chat.sessions.finish(second.id, "Week 41.", [...calendar, tool(PUBLISH_TOOL, { artifactId: "r2", version: 1, title: "Next" })]);
    await settle();
    expect(await chat.turns.post(RADU.uid, planner.agentId, second.id)).toBeNull();
    expect(chat.posts.at(-1)).toMatchObject({ turn: second.id, text: "Week 41.", published: [{ artifactId: "r2", version: 1, title: "Next" }] });
    expect([chat.roster.withheldVersion("r1", 2), chat.roster.withheldVersion("r2", 1), chat.roster.fork("run-reply")?.posted]).toEqual([
      true,
      false,
      true,
    ]);
    // The discarded window stays withheld for good, and so do its drafts; the posted turn's are the chat's.
    expect([chat.roster.anyWithheld(), chat.roster.withheld()]).toEqual([true, new Set(["run-reply"])]);
    expect(chat.roster.withheldDrafts("pi")).toEqual(new Set(["d1"]));
    expect(chat.announced).toEqual([{ artifactId: "r2", version: 1 }]);
  });

  it("names nothing a failed reply to a run's report published: it stays withheld, as a fork's does", async () => {
    const chat = room();
    const helper = chat.add(RADU, "helper", { servers: ["db", "calendar"] });
    const [turn] = chat.turns.call([helper.agentId], { ...chat.say(RADU, "@helper and next week?"), session: "run-reply" });
    await settle();
    chat.sessions.entries.set(`run-reply|${turn.id}`, [tool(PUBLISH_TOOL, { artifactId: "r1", version: 2, title: "Week" })]);
    chat.roster.recordPage("run-reply", "r1", 2);
    chat.sessions.run("run-reply", operationId(turn.id)).resolve({ status: "unanswered", reason: "model error" });
    await settle();
    expect(chat.posts.at(-1)).toMatchObject({ turn: turn.id, failed: "model error" });
    expect(chat.posts.at(-1)).not.toHaveProperty("published");
    expect(chat.roster.withheldVersion("r1", 2)).toBe(true);
  });

  it("gives a seat its turn again when the call was cut off, and stops it there when giving fails", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    chat.giveErrors.push(retryable());
    const [turn] = chat.turns.call([planner.agentId], chat.say(MIA, "@planner hi"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    const ana = chat.member(ANA.uid);
    expect(ana.sessions.submits.map((submit) => submit.data.turn)).toEqual([turn.id]);
    expect(chat.roster.turn(turn.id)?.status).toBe("running");

    // A failure no retry gets past: the turn fails here, and the seat is told to stop it.
    chat.giveErrors.push(new Error("This agent was deleted."));
    const [next] = chat.turns.call([planner.agentId], chat.say(MIA, "@planner again"));
    ana.sessions.finish(turn.id, "Hi.");
    await settle();
    expect(chat.roster.turn(next.id)?.status).toBe("failed");
    expect(chat.seatAborts).toContain(next.id);
  });

  it("stops a seat's turn the room no longer waits on before it gives the agent its next one", async () => {
    const ana = new MemberObject(ANA.uid);
    ana.definitions.set("p", definition("p", "planner"));
    ana.rooms.set(`${ROOM.ownerUid}:${ROOM.chatId}`, room());
    const turn = (id: number): SeatTurn => ({
      turn: id,
      calledBy: { name: "Mia", uid: MIA.uid },
      hop: 0,
      ask: "[Mia · person]: hi",
      input: "Your turn",
      ownerName: "Ana",
      kind: "group",
      byOwner: false,
    });
    await ana.seats.give(ROOM, "p", turn(1));
    const seat = ana.sessions.sessionOf(1);
    expect(ana.sessions.aborts).toEqual([]);
    await ana.seats.give(ROOM, "p", turn(2));
    expect(ana.sessions.aborts).toEqual([seat]);
  });

  it("counts an agent's hand-offs for the person who started the chain", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner");
    const hers = chat.add(ANA, "helper");
    const [first] = chat.turns.call([planner.agentId], chat.say(MIA, "@planner ask @helper"));
    await settle();
    chat.limited.add(MIA.uid);
    chat.sessions.finish(first.id, "@helper please look.");
    await settle();
    const [handed] = chat.roster.recentTurns(hers.agentId);
    expect(handed).toMatchObject({ by: MIA.uid, status: "failed" });
    // pi's answers count for the person whose message pi answered.
    chat.turns.fromPi("@helper over to you", 99, { hop: 0, by: MIA.uid });
    await settle();
    expect(chat.roster.recentTurns(hers.agentId)[0]).toMatchObject({ by: MIA.uid, status: "failed" });
  });

  it("reads a member's agent's owner only from where it joined, and pi's prompts as the chat owner's", () => {
    const message = (id: number, uid: string) =>
      ({ id, kind: CHAT_MESSAGE_KIND, data: { uid, name: "Ana", text: "Delete it all.", sentAt: id } }) as unknown as EntryRecord;
    const prompt = { id: 1, kind: "pi.user", model: [{ role: "user", content: "Plan my week.", timestamp: 0 }] } as unknown as EntryRecord;
    const anas = { uid: ANA.uid, chatOwner: RADU.uid, from: 10 };
    expect(askLine(message(5, ANA.uid), "p", anas)).toBe("[Ana · person]: Delete it all.");
    expect(askLine(message(12, ANA.uid), "p", anas)).toBe("[Ana · person · your owner]: Delete it all.");
    expect(askLine(prompt, "p", anas)).toBe("[the chat's owner · person]: Plan my week.");
    expect(askLine(prompt, "p", RADU.uid)).toBe("[the owner · person · your owner]: Plan my week.");
  });

  it("keeps an alias only for a seat that got one: a real name with a hyphen follows its owner's rename", () => {
    const chat = room();
    const add = (agentId: string, name: string, aliasOf?: string) =>
      chat.roster.add({
        agentId,
        ownerUid: ANA.uid,
        name,
        session: "",
        avatar: "a",
        color: "teal",
        job: "j",
        seat: seatChatId(agentId),
        ...(aliasOf && { aliasOf }),
      });
    const view = (name: string) => ({ name, avatar: "a", color: "teal" as const, job: "j", off: false });
    expect(add("a1", "data-bot")).toBeNull();
    expect(chat.roster.refresh("a1", view("data"))?.entry.name).toBe("data");
    expect(add("a2", "planner-ana", "planner")).toBeNull();
    expect(chat.roster.refresh("a2", view("planner"))?.entry.name).toBe("planner-ana");
  });

  it("ends an alias on a rename: the new name is taken when free, also a prefix of the old one, and after two renames", () => {
    const chat = room();
    const add = (agentId: string, ownerUid: string, name: string, aliasOf?: string) =>
      chat.roster.add({ agentId, ownerUid, name, session: "", avatar: "a", color: "teal", job: "j", ...(aliasOf && { aliasOf }) });
    const view = (name: string) => ({ name, avatar: "a", color: "teal" as const, job: "j", off: false });
    // Radu's "data-bot" took the name: Ana's joined as "data-bot-ana", then she renames hers "data", which is free.
    expect(add("r1", RADU.uid, "data-bot")).toBeNull();
    const name = memberAgentName("data-bot", "Ana", (n) => chat.roster.byName(n) !== null);
    expect(name).toBe("data-bot-ana");
    expect(add("a1", ANA.uid, name!, "data-bot")).toBeNull();
    expect(chat.roster.refresh("a1", view("data"))?.entry).toMatchObject({ name: "data" });
    expect(chat.roster.get("a1")?.aliasOf).toBeUndefined();
    // "planner-ana" (Radu's "planner" took the name) renamed "writer-bot" (free) and then "writer" (free): each is taken.
    expect(add("r2", RADU.uid, "planner")).toBeNull();
    expect(add("a2", ANA.uid, "planner-ana", "planner")).toBeNull();
    expect(chat.roster.refresh("a2", view("writer-bot"))?.entry.name).toBe("writer-bot");
    expect(chat.roster.get("a2")?.aliasOf).toBeUndefined();
    expect(chat.roster.refresh("a2", view("writer"))?.entry.name).toBe("writer");
    // Renamed back to the name another agent here has: it keeps the one it has, as any rename to a taken name does.
    expect(chat.roster.refresh("a2", view("planner"))?.entry.name).toBe("writer");
    // A refresh that keeps the alias changes nothing.
    expect(add("a3", ANA.uid, "planner-ana", "planner")).toBeNull();
    expect(chat.roster.refresh("a3", view("planner"))).toMatchObject({ entry: { name: "planner-ana", aliasOf: "planner" }, changed: false });
  });
});

describe("Member agents: a seat's turn given again while it is set up, or after the room took it", () => {
  /** The member's object, with `wait` as the harness answers it: an operation never submitted is "not_found". */
  class SlowSeat implements SeatHost {
    readonly uid = ANA.uid;
    readonly ended: { turn: number; result: SeatResult }[] = [];
    readonly submits: string[] = [];
    readonly configures: string[] = [];
    readonly runs = new Map<string, Deferred<TurnResult>>();
    readonly kept: Promise<unknown>[] = [];
    /** The next configure waits on this (a slow refresh before the turn). */
    gate: Deferred<void> | undefined;
    #made = 0;
    async definition() {
      return definition("p", "planner");
    }
    room(): RoomLink {
      return {
        log: async () => ({ from: 0, through: -1, text: "", turn: 0 }),
        ended: async (turn, result) => {
          this.ended.push({ turn, result });
          return true;
        },
      };
    }
    async create() {
      return `s${++this.#made}`;
    }
    async fork(session: string) {
      return `${session}-fork${++this.#made}`;
    }
    async write() {}
    async configure(session: string) {
      this.configures.push(session);
      const gate = this.gate;
      this.gate = undefined;
      if (gate) await gate.promise;
    }
    async submit(session: string, _input: string, op: string) {
      if (!this.submits.includes(`${session}|${op}`)) this.submits.push(`${session}|${op}`);
    }
    run(session: string, op: string): Deferred<TurnResult> {
      const key = `${session}|${op}`;
      let run = this.runs.get(key);
      if (!run) this.runs.set(key, (run = deferred()));
      return run;
    }
    async wait(session: string, op: string): Promise<TurnResult> {
      if (!this.submits.includes(`${session}|${op}`)) return { status: "unanswered", reason: "not_found" };
      return this.run(session, op).promise;
    }
    async abort() {}
    async turnEntries(): Promise<readonly EntryRecord[]> {
      return [];
    }
    async sources() {
      return { items: [], sources: [] };
    }
    waitUntil(promise: Promise<unknown>) {
      this.kept.push(promise);
    }
    later() {}
  }
  const turn = (id: number, byOwner = false): SeatTurn => ({
    turn: id,
    calledBy: byOwner ? { name: ANA.name, uid: ANA.uid } : { name: MIA.name, uid: MIA.uid },
    hop: 0,
    ask: "[Mia · person]: hi",
    input: "Your turn",
    ownerName: "Ana",
    kind: "group",
    byOwner,
  });

  it("leaves a turn still being set up to its give: a give again or a wake meanwhile ends nothing, and its reply reaches the room", async () => {
    for (const again of ["give", "wake"] as const) {
      const host = new SlowSeat();
      const seats = new AgentSeats(memorySql(), host);
      const gate = (host.gate = deferred());
      const first = seats.give(ROOM, "p", turn(1));
      await settle();
      if (again === "give") await seats.give(ROOM, "p", turn(1));
      else seats.wake();
      await settle();
      expect(host.ended).toEqual([]);
      gate.resolve();
      await first;
      await settle();
      expect(host.submits).toEqual(["s1|turn:1"]);
      host.run("s1", "turn:1").resolve({ status: "done", text: "The real answer." });
      await settle();
      expect(host.ended).toEqual([{ turn: 1, result: expect.objectContaining({ status: "done", text: "The real answer." }) }]);
    }
  });

  it("sets up again a turn whose give died before its input was in, in the same session, once", async () => {
    const sql = memorySql();
    const host = new SlowSeat();
    host.gate = deferred();
    void new AgentSeats(sql, host).give(ROOM, "p", turn(1, true));
    await settle();
    // The object went away while the give was configuring: a new one finds the row, never submitted.
    const later = new SlowSeat();
    const seats = new AgentSeats(sql, later);
    seats.wake();
    await settle();
    const [fork] = host.configures;
    expect(later.configures).toEqual([fork]);
    expect(later.submits).toEqual([`${fork}|turn:1`]);
    later.run(fork, "turn:1").resolve({ status: "done", text: "Done." });
    await settle();
    expect(later.ended).toEqual([{ turn: 1, result: expect.objectContaining({ status: "done" }) }]);
  });

  it("never puts in a turn stopped, ended by a later give, or dropped while it was set up, also on a cold seat", async () => {
    for (const stop of ["abort", "later give", "drop"] as const) {
      const host = new SlowSeat();
      const seats = new AgentSeats(memorySql(), host);
      const gate = (host.gate = deferred());
      const first = seats.give(ROOM, "p", turn(1, true));
      await settle();
      if (stop === "abort") await seats.abort(ROOM, 1);
      else if (stop === "drop") await seats.drop(ROOM, "p");
      else void seats.give(ROOM, "p", turn(2));
      await settle();
      gate.resolve();
      await first;
      await settle();
      expect(host.submits.filter((submit) => submit.endsWith("|turn:1"))).toEqual([]);
    }
    // The seat object went away while configuring; the room stopped the turn, and that call starts the seat again.
    const sql = memorySql();
    const host = new SlowSeat();
    host.gate = deferred();
    void new AgentSeats(sql, host).give(ROOM, "p", turn(1, true));
    await settle();
    const later = new SlowSeat();
    const seats = new AgentSeats(sql, later);
    const slow = (later.gate = deferred());
    seats.wake();
    await settle();
    // Its set-up again is going on when the stop comes: it ends, and its input never goes in.
    await seats.abort(ROOM, 1);
    seats.wake();
    slow.resolve();
    await settle();
    expect(later.submits).toEqual([]);
    expect(later.configures).toHaveLength(1);
  });

  it("runs nothing for a late give of a turn the room took already", async () => {
    const host = new SlowSeat();
    const seats = new AgentSeats(memorySql(), host);
    await seats.give(ROOM, "p", turn(1, true));
    await settle();
    const [session, op] = host.submits[0].split("|");
    host.run(session, op).resolve({ status: "done", text: "Done." });
    await settle();
    expect(host.ended).toHaveLength(1);
    await seats.give(ROOM, "p", turn(1, true));
    seats.wake();
    await settle();
    expect(host.submits).toHaveLength(1);
    expect(host.ended).toHaveLength(1);
  });
});
