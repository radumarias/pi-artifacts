import { describe, expect, it } from "vitest";
import { MAX_CHAT_AGENTS, type AgentColor, type ChatAgentReplyData } from "../shared/agents.ts";
import { ChatRoster, type RosterEntry } from "../worker/agents/roster.ts";
import { memorySql } from "./fakes.ts";

const T0 = 1_000_000;
/** Ended turns the roster keeps per agent (KEPT_TURNS in worker/agents/roster.ts, which does not export it). */
const KEPT_TURNS = 200;

const ann = { name: "ann@example.com", uid: "ann" };
const bea = { name: "bea@example.com", uid: "bea" };

type Added = Parameters<ChatRoster["add"]>[0];
type Queued = Parameters<ChatRoster["enqueue"]>[0];
type View = Parameters<ChatRoster["refresh"]>[1];

/** A roster over a fresh database, with a clock the test moves by hand. */
function setup() {
  const sql = memorySql();
  const clock = { now: T0 };
  const roster = new ChatRoster(sql, () => clock.now);
  return { sql, clock, roster };
}

/** A roster with these agents in it, all added at T0. */
function withAgents(...names: string[]) {
  const made = setup();
  for (const name of names) expect(made.roster.add(agent(name))).toBeNull();
  return made;
}

/** What adding the agent `name` passes: its id, session and job line follow from the name. */
function agent(name: string, over: Partial<Added> = {}): Added {
  const id = name.toLowerCase();
  const job = `Helps with ${id}.`;
  return { agentId: `id-${id}`, ownerUid: "owner", name, session: `session-${id}`, avatar: "B", color: "blue", job, ...over };
}

/** A turn a person (ann) asks of an agent, unless `over` says otherwise. */
function ask(agentId: string, over: Partial<Queued> = {}): Queued {
  return { agentId, hop: 0, calledBy: ann, byOwner: true, ask: "ann@example.com: hello", ...over };
}

/** What everyone sees of an entry, as refresh takes it. */
function viewOf(entry: RosterEntry | null): View {
  if (!entry) throw new Error("no such agent");
  return { name: entry.name, avatar: entry.avatar, color: entry.color, job: entry.job, off: entry.off };
}

/** The turn an agent runs now, if any. */
function runningOf(roster: ChatRoster, agentId: string) {
  return roster.allRunning().find((turn) => turn.agentId === agentId) ?? null;
}

/** How many turns wait for each agent, as everyone's view says. */
function queuedOf(roster: ChatRoster): Map<string, number> {
  return new Map(roster.views(() => "").flatMap((view): [string, number][] => (view.queued ? [[view.id, view.queued]] : [])));
}

/** A reply as an ended turn keeps it to deliver. */
function replyTo(turn: { id: number; agentId: string }, text = "Done."): ChatAgentReplyData {
  const name = turn.agentId.replace("id-", "");
  return { agentId: turn.agentId, name, avatar: "B", color: "blue", ownerUid: "owner", text, calledBy: ann, turn: turn.id, hop: 0, startedAt: T0, endedAt: T0 };
}

/** Queue a turn for an agent and start it at once. */
function started(roster: ChatRoster, turn: Queued) {
  const queued = roster.enqueue(turn);
  const running = roster.startNext(turn.agentId);
  expect(running?.id).toBe(queued.id);
  return running!;
}

describe("ChatRoster: its agents", () => {
  it("adds an agent under its name in lower case, with nothing read yet", () => {
    const { roster } = setup();
    expect(roster.hasAny()).toBe(false);
    expect(roster.add(agent("Bob", { color: "green" }))).toBeNull();
    const entry: RosterEntry = {
      agentId: "id-bob",
      ownerUid: "owner",
      name: "bob",
      session: "session-bob",
      avatar: "B",
      color: "green",
      job: "Helps with bob.",
      mirrored: -1,
      off: false,
      shared: false,
    };
    expect(roster.get("id-bob")).toEqual(entry);
    expect(roster.list()).toEqual([entry]);
    expect(roster.hasAny()).toBe(true);
  });

  it("changes nothing when the agent is in the roster already, even a full one", () => {
    const { roster } = withAgents(...Array.from({ length: MAX_CHAT_AGENTS }, (_, n) => `agent${n}`));
    const before = roster.list();
    expect(roster.add(agent("agent0", { name: "renamed", job: "Something else." }))).toBeNull();
    expect(roster.list()).toEqual(before);
  });

  it("refuses a name another agent has here, whatever its case", () => {
    const { roster } = withAgents("Bob");
    expect(roster.add(agent("BOB", { agentId: "id-other", session: "session-other" }))).toEqual({
      error: 'This chat already has an agent named "BOB".',
    });
    expect(roster.list().map((entry) => entry.agentId)).toEqual(["id-bob"]);
    expect(roster.get("id-other")).toBeNull();
  });

  it("holds at most MAX_CHAT_AGENTS agents, and takes one again once one is removed", () => {
    const { roster } = withAgents(...Array.from({ length: MAX_CHAT_AGENTS }, (_, n) => `agent${n}`));
    expect(roster.list()).toHaveLength(MAX_CHAT_AGENTS);
    const refused = roster.add(agent("extra"));
    expect(refused).toEqual({ error: expect.stringContaining(`at most ${MAX_CHAT_AGENTS} agents`) });
    expect(roster.get("id-extra")).toBeNull();

    roster.remove("id-agent3");
    expect(roster.add(agent("extra"))).toBeNull();
    expect(roster.list()).toHaveLength(MAX_CHAT_AGENTS);
  });

  it("lists agents in the order they were added, by name among those added at once", () => {
    const { roster, clock } = setup();
    roster.add(agent("carol"));
    roster.add(agent("alice"));
    clock.now = T0 + 1;
    roster.add(agent("Aaron"));
    expect(roster.list().map((entry) => entry.name)).toEqual(["alice", "carol", "aaron"]);
  });

  it("finds an agent by id, and by name in any case", () => {
    const { roster } = withAgents("bob", "carol");
    expect(roster.get("id-carol")?.name).toBe("carol");
    expect(roster.get("id-nobody")).toBeNull();
    expect(roster.byName("BoB")?.agentId).toBe("id-bob");
    expect(roster.byName("nobody")).toBeNull();
  });

  it("removes an agent and stops its turns not ended, leaving its ended turns and other agents' as they are", () => {
    const { roster, clock } = withAgents("bob", "carol");
    const done = started(roster, ask("id-bob"));
    roster.end(done.id, "done");
    const running = started(roster, ask("id-bob"));
    const waiting = roster.enqueue(ask("id-bob"));
    const carols = roster.enqueue(ask("id-carol"));
    clock.now = T0 + 10;

    expect(roster.remove("id-bob")).toEqual(expect.objectContaining({ agentId: "id-bob", name: "bob" }));
    expect(roster.get("id-bob")).toBeNull();
    expect(roster.byName("bob")).toBeNull();
    expect(roster.turn(done.id)).toEqual(expect.objectContaining({ status: "done", endedAt: T0 }));
    expect(roster.turn(running.id)).toEqual(expect.objectContaining({ status: "stopped", startedAt: T0, endedAt: T0 + 10 }));
    expect(roster.turn(waiting.id)).toEqual(expect.objectContaining({ status: "stopped", endedAt: T0 + 10 }));
    expect(roster.turn(carols.id)?.status).toBe("queued");
    expect(roster.startNext("id-bob")).toBeNull();
    expect(roster.remove("id-bob")).toBeNull();
  });

  it("has no agents once the last one is removed, and takes the same one back with nothing waiting", () => {
    const { roster } = withAgents("bob");
    roster.enqueue(ask("id-bob"));
    roster.remove("id-bob");
    expect(roster.hasAny()).toBe(false);
    expect(roster.list()).toEqual([]);
    expect(roster.add(agent("bob"))).toBeNull();
    expect(roster.startNext("id-bob")).toBeNull();
    expect(roster.waitingAgents()).toEqual([]);
  });
});

describe("ChatRoster: refresh and setMirrored", () => {
  it("keeps what the definition now says, and says whether anything everyone sees changed", () => {
    const { roster } = withAgents("bob");
    const next: View = { name: "bob", avatar: "R", color: "orange", job: "Writes the weekly numbers.", off: false };
    const refreshed = roster.refresh("id-bob", next);
    expect(refreshed?.changed).toBe(true);
    expect(roster.get("id-bob")).toEqual(expect.objectContaining({ avatar: "R", color: "orange", job: "Writes the weekly numbers.", off: false }));
    expect(refreshed?.entry).toEqual(roster.get("id-bob"));
    expect(roster.refresh("id-bob", next)).toEqual({ entry: roster.get("id-bob"), changed: false });
  });

  it.each<[string, Partial<View>]>([
    ["the avatar", { avatar: "Z" }],
    ["the colour", { color: "teal" as AgentColor }],
    ["the job line", { job: "Something new." }],
    ["turning it off", { off: true }],
    ["a free name", { name: "robert" }],
  ])("counts %s as a change", (_, change) => {
    const { roster } = withAgents("bob");
    const before = roster.get("id-bob");
    expect(roster.refresh("id-bob", { ...viewOf(before), ...change })?.changed).toBe(true);
    expect(roster.get("id-bob")).toEqual({ ...before, ...change });
  });

  it("turns an agent off and on again", () => {
    const { roster } = withAgents("bob");
    expect(roster.refresh("id-bob", { ...viewOf(roster.get("id-bob")), off: true })?.changed).toBe(true);
    expect(roster.get("id-bob")?.off).toBe(true);
    expect(roster.refresh("id-bob", { ...viewOf(roster.get("id-bob")), off: false })?.changed).toBe(true);
    expect(roster.get("id-bob")?.off).toBe(false);
  });

  it("takes a free new name in lower case, and keeps the old one when another agent here has it", () => {
    const { roster } = withAgents("bob", "carol");
    expect(roster.refresh("id-bob", { ...viewOf(roster.get("id-bob")), name: "Robert" })?.changed).toBe(true);
    expect(roster.get("id-bob")?.name).toBe("robert");
    expect(roster.byName("robert")?.agentId).toBe("id-bob");
    expect(roster.byName("bob")).toBeNull();

    expect(roster.refresh("id-bob", { ...viewOf(roster.get("id-bob")), name: "Carol" })?.changed).toBe(false);
    expect(roster.get("id-bob")?.name).toBe("robert");
    expect(roster.byName("carol")?.agentId).toBe("id-carol");

    // Its own name in another case is its own name still.
    expect(roster.refresh("id-bob", { ...viewOf(roster.get("id-bob")), name: "ROBERT" })?.changed).toBe(false);
    expect(roster.get("id-bob")?.name).toBe("robert");
  });

  it("keeps the old name but the rest of the view when the new name is taken", () => {
    const { roster } = withAgents("bob", "carol");
    expect(roster.refresh("id-bob", { ...viewOf(roster.get("id-bob")), name: "carol", job: "Renamed." })?.changed).toBe(true);
    expect(roster.get("id-bob")).toEqual(expect.objectContaining({ name: "bob", job: "Renamed." }));
  });

  it("does nothing for an agent not in the roster", () => {
    const { roster } = withAgents("bob");
    expect(roster.refresh("id-nobody", { name: "nobody", avatar: "N", color: "pink", job: "None.", off: false })).toBeNull();
    expect(roster.list().map((entry) => entry.agentId)).toEqual(["id-bob"]);
    expect(roster.byName("nobody")).toBeNull();
  });

  it("moves the newest entry an agent's session has read only forward, per agent", () => {
    const { roster } = withAgents("bob", "carol");
    roster.setMirrored("id-bob", 5);
    expect(roster.get("id-bob")?.mirrored).toBe(5);
    roster.setMirrored("id-bob", 3);
    expect(roster.get("id-bob")?.mirrored).toBe(5);
    roster.setMirrored("id-bob", 9);
    expect(roster.get("id-bob")?.mirrored).toBe(9);
    expect(roster.get("id-carol")?.mirrored).toBe(-1);
    roster.setMirrored("id-carol", 0);
    expect(roster.get("id-carol")?.mirrored).toBe(0);
    roster.setMirrored("id-nobody", 4);
    expect(roster.get("id-nobody")).toBeNull();
  });
});

describe("ChatRoster: queueing turns", () => {
  it("queues a turn a person asked for, which starts a chain of its own", () => {
    const { roster } = withAgents("bob");
    const turn = roster.enqueue(ask("id-bob"));
    expect(turn).toStrictEqual({
      id: turn.id,
      agentId: "id-bob",
      status: "queued",
      hop: 0,
      calledBy: ann,
      byOwner: true,
      root: turn.id,
      ask: "ann@example.com: hello",
      createdAt: T0,
    });
    expect(roster.turn(turn.id)).toStrictEqual(turn);
    expect(roster.turn(turn.id + 1)).toBeNull();
  });

  it("keeps a hand-off's hop, root, caller and ask key", () => {
    const { roster, clock } = withAgents("bob", "carol");
    const first = roster.enqueue(ask("id-bob", { askKey: "entry:7" }));
    clock.now = T0 + 3;
    const handOff = roster.enqueue({
      agentId: "id-carol",
      hop: 1,
      root: first.id,
      calledBy: { name: "bob", agentId: "id-bob" },
      byOwner: false,
      ask: "@bob: carol, check this",
      askKey: `turn:${first.id}`,
    });
    expect(handOff).toStrictEqual({
      id: handOff.id,
      agentId: "id-carol",
      status: "queued",
      hop: 1,
      calledBy: { name: "bob", agentId: "id-bob" },
      byOwner: false,
      root: first.id,
      ask: "@bob: carol, check this",
      createdAt: T0 + 3,
    });
    expect(roster.turn(handOff.id)).toStrictEqual(handOff);
    expect(roster.askKeys("id-carol", handOff.id)).toEqual(new Set([`turn:${first.id}`]));
    expect(handOff.id).toBeGreaterThan(first.id);
  });

  it("keeps falsy values that are values: an empty ask key, root 0 and a schedule as caller", () => {
    const { roster } = withAgents("bob");
    const turn = roster.enqueue(ask("id-bob", { calledBy: { name: "schedule", schedule: true }, byOwner: false, askKey: "", root: 0 }));
    const read = roster.turn(turn.id);
    expect(read).toStrictEqual(turn);
    expect(read).toEqual(expect.objectContaining({ root: 0, byOwner: false }));
    expect(read?.calledBy).toStrictEqual({ name: "schedule", schedule: true });
    expect(roster.askKeys("id-bob", turn.id)).toEqual(new Set([""]));
  });

  it("gives every turn a new id, in the order they were queued, across agents", () => {
    const { roster } = withAgents("bob", "carol");
    const ids = [roster.enqueue(ask("id-bob")).id, roster.enqueue(ask("id-carol")).id, roster.enqueue(ask("id-bob")).id];
    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
});

describe("ChatRoster: running turns", () => {
  it("starts an agent's waiting turns oldest first, one at a time", () => {
    const { roster, clock } = withAgents("bob");
    const turns = [roster.enqueue(ask("id-bob")), roster.enqueue(ask("id-bob", { calledBy: bea })), roster.enqueue(ask("id-bob"))];
    clock.now = T0 + 5;
    const first = roster.startNext("id-bob");
    expect(first).toEqual({ ...turns[0], status: "running", startedAt: T0 + 5 });
    expect(runningOf(roster, "id-bob")).toEqual(first);
    expect(roster.startNext("id-bob")).toBeNull();
    expect(roster.turn(turns[1].id)?.status).toBe("queued");

    clock.now = T0 + 6;
    roster.end(turns[0].id, "done");
    expect(runningOf(roster, "id-bob")).toBeNull();
    expect(roster.startNext("id-bob")?.id).toBe(turns[1].id);
    roster.end(turns[1].id, "failed");
    expect(roster.startNext("id-bob")?.id).toBe(turns[2].id);
    roster.end(turns[2].id, "done");
    expect(roster.startNext("id-bob")).toBeNull();
  });

  it("runs each agent's queue on its own", () => {
    const { roster } = withAgents("bob", "carol");
    const bobs = [roster.enqueue(ask("id-bob")), roster.enqueue(ask("id-bob"))];
    const carols = roster.enqueue(ask("id-carol"));
    expect(roster.startNext("id-bob")?.id).toBe(bobs[0].id);
    expect(roster.startNext("id-carol")?.id).toBe(carols.id);
    expect(roster.startNext("id-carol")).toBeNull();
    expect(roster.allRunning().map((turn) => turn.id)).toEqual([bobs[0].id, carols.id]);
    roster.end(carols.id, "done");
    expect(runningOf(roster, "id-bob")?.id).toBe(bobs[0].id);
    expect(roster.startNext("id-bob")).toBeNull();
  });

  it("starts nothing for an agent with nothing waiting", () => {
    const { roster } = withAgents("bob");
    expect(roster.startNext("id-bob")).toBeNull();
    expect(roster.startNext("id-nobody")).toBeNull();
    expect(runningOf(roster, "id-bob")).toBeNull();
  });

  it("ends a running turn once: a second end leaves it as it ended and returns null", () => {
    const { roster, clock } = withAgents("bob");
    const turn = started(roster, ask("id-bob"));
    clock.now = T0 + 20;
    expect(roster.end(turn.id, "done")).toEqual({ ...turn, status: "done", startedAt: T0, endedAt: T0 + 20 });
    clock.now = T0 + 30;
    expect(roster.end(turn.id, "failed")).toBeNull();
    expect(roster.turn(turn.id)).toEqual(expect.objectContaining({ status: "done", endedAt: T0 + 20 }));
    expect(runningOf(roster, "id-bob")).toBeNull();
  });

  it("does not end a turn that was stopped meanwhile, nor one it does not know", () => {
    const { roster } = withAgents("bob");
    const turn = started(roster, ask("id-bob"));
    roster.stopAll();
    expect(roster.end(turn.id, "done")).toBeNull();
    expect(roster.turn(turn.id)?.status).toBe("stopped");
    expect(roster.end(9999, "done")).toBeNull();
  });

  it("keeps an agent's newest ended turns and prunes older ones, leaving other agents' alone", () => {
    const { roster } = withAgents("bob", "carol");
    const carols = started(roster, ask("id-carol"));
    roster.end(carols.id, "done");
    const ids: number[] = [];
    for (let n = 0; n < KEPT_TURNS + 5; n++) {
      const turn = started(roster, ask("id-bob"));
      expect(roster.end(turn.id, n % 2 ? "failed" : "done")).not.toBeNull();
      ids.push(turn.id);
    }
    expect(roster.recentTurns("id-bob", KEPT_TURNS * 2).map((turn) => turn.id)).toEqual(ids.slice(5).reverse());
    expect(roster.turn(ids[0])).toBeNull();
    expect(roster.turn(ids[4])).toBeNull();
    expect(roster.turn(ids[5])).not.toBeNull();
    expect(roster.turn(carols.id)?.status).toBe("done");
    expect(roster.enqueue(ask("id-bob")).id).toBeGreaterThan(ids.at(-1)!);
  });

  it("never prunes a turn that is running or waiting", () => {
    const { roster } = withAgents("bob");
    const zed = { name: "zed@example.com", uid: "zed" };
    const running = started(roster, ask("id-bob"));
    const waiting = roster.enqueue(ask("id-bob", { calledBy: bea }));
    for (let n = 0; n < KEPT_TURNS + 5; n++) roster.enqueue(ask("id-bob", { calledBy: zed }));
    expect(roster.stopFor("zed")).toHaveLength(KEPT_TURNS + 5);
    // end takes a turn that has not started too, so this one prunes without ending the running turn.
    const last = roster.enqueue(ask("id-bob", { calledBy: zed }));
    expect(roster.end(last.id, "failed")?.status).toBe("failed");
    expect(roster.turn(running.id)?.status).toBe("running");
    expect(roster.turn(waiting.id)?.status).toBe("queued");
    // The newest KEPT_TURNS by id, and the two older ones not ended.
    expect(roster.recentTurns("id-bob", KEPT_TURNS * 2)).toHaveLength(KEPT_TURNS + 2);
  });

  it("stops every turn not ended, in every agent, and only those", () => {
    const { roster, clock } = withAgents("bob", "carol", "dave");
    const daves = started(roster, ask("id-dave"));
    roster.end(daves.id, "done");
    const running = started(roster, ask("id-bob"));
    const waiting = roster.enqueue(ask("id-bob"));
    const carols = roster.enqueue(ask("id-carol"));
    clock.now = T0 + 40;

    const stopped = roster.stopAll().sort((a, b) => a.id - b.id);
    expect(stopped).toEqual([
      { ...running, status: "stopped", endedAt: T0 + 40 },
      { ...waiting, status: "stopped", endedAt: T0 + 40 },
      { ...carols, status: "stopped", endedAt: T0 + 40 },
    ]);
    // What was running has a start: that is how a stop knows which sessions to abort.
    expect(stopped.map((turn) => turn.startedAt !== undefined)).toEqual([true, false, false]);
    expect(roster.turn(daves.id)).toEqual(expect.objectContaining({ status: "done", endedAt: T0 }));
    expect(roster.allRunning()).toEqual([]);
    expect(roster.waitingAgents()).toEqual([]);
    expect(roster.startNext("id-bob")).toBeNull();
    expect(roster.stopAll()).toEqual([]);
  });

  it("stops one agent's turns, leaving the others' going", () => {
    const { roster } = withAgents("bob", "carol");
    const bobs = [started(roster, ask("id-bob")), roster.enqueue(ask("id-bob"))];
    const carolRunning = started(roster, ask("id-carol"));
    const carolWaiting = roster.enqueue(ask("id-carol"));
    expect(
      roster
        .stopAll("id-bob")
        .map((turn) => turn.id)
        .sort((a, b) => a - b),
    ).toEqual(bobs.map((turn) => turn.id));
    expect(runningOf(roster, "id-carol")?.id).toBe(carolRunning.id);
    expect(roster.turn(carolWaiting.id)?.status).toBe("queued");
    expect(roster.stopAll("id-bob")).toEqual([]);
    expect(roster.stopAll("id-nobody")).toEqual([]);
  });

  it("reports what runs and what waits, per agent", () => {
    const { roster } = withAgents("bob", "carol", "dave");
    expect(roster.allRunning()).toEqual([]);
    expect(roster.waitingAgents()).toEqual([]);
    expect(queuedOf(roster)).toEqual(new Map());

    const carols = [roster.enqueue(ask("id-carol")), roster.enqueue(ask("id-carol"))];
    const bobs = [started(roster, ask("id-bob")), roster.enqueue(ask("id-bob"))];
    expect(roster.waitingAgents()).toEqual(["id-bob", "id-carol"]);
    expect(queuedOf(roster)).toEqual(
      new Map([
        ["id-bob", 1],
        ["id-carol", 2],
      ]),
    );
    expect(runningOf(roster, "id-bob")?.id).toBe(bobs[0].id);
    expect(runningOf(roster, "id-carol")).toBeNull();

    roster.startNext("id-carol");
    expect(roster.allRunning().map((turn) => turn.id)).toEqual([carols[0].id, bobs[0].id]);
    expect(queuedOf(roster)).toEqual(
      new Map([
        ["id-bob", 1],
        ["id-carol", 1],
      ]),
    );
    roster.end(carols[0].id, "done");
    roster.startNext("id-carol");
    expect(roster.waitingAgents()).toEqual(["id-bob"]);
    expect(queuedOf(roster).has("id-carol")).toBe(false);
  });

  it("reads the same roster and turns again after the object restarts", () => {
    const { sql, roster } = withAgents("bob", "carol");
    roster.setMirrored("id-bob", 12);
    const running = started(roster, ask("id-bob"));
    const waiting = roster.enqueue(ask("id-carol"));
    const again = new ChatRoster(sql, () => T0 + 5);
    expect(again.list()).toEqual(roster.list());
    expect(again.get("id-bob")?.mirrored).toBe(12);
    expect(again.allRunning()).toEqual([running]);
    expect(again.waitingAgents()).toEqual(["id-carol"]);
    expect(again.enqueue(ask("id-carol")).id).toBeGreaterThan(waiting.id);
  });
});

describe("ChatRoster: chains, ask keys and who asked", () => {
  it("counts the hand-offs of a chain a person started, however they branch, and no other chain's", () => {
    const { roster } = withAgents("bob", "carol", "dave");
    const root = roster.enqueue(ask("id-bob"));
    expect(roster.handOffsFrom(root.id)).toBe(0);
    const handOff = { hop: 1, root: root.id, calledBy: { name: "bob", agentId: "id-bob" }, byOwner: false, ask: "@bob: go on" };
    const toCarol = roster.enqueue({ agentId: "id-carol", ...handOff });
    roster.enqueue({ agentId: "id-dave", ...handOff });
    roster.enqueue({ agentId: "id-bob", ...handOff, hop: 2, calledBy: { name: "carol", agentId: "id-carol" } });
    expect(roster.handOffsFrom(root.id)).toBe(3);

    const other = roster.enqueue(ask("id-carol"));
    roster.enqueue({ agentId: "id-dave", ...handOff, root: other.id });
    expect(roster.handOffsFrom(other.id)).toBe(1);
    expect(roster.handOffsFrom(root.id)).toBe(3);
    // Whether they ran does not matter: a hand-off made counts.
    roster.stopAll("id-carol");
    expect(roster.turn(toCarol.id)?.status).toBe("stopped");
    expect(roster.handOffsFrom(root.id)).toBe(3);
  });

  it("counts a chain that a hand-off started (one of pi's) from its first turn", () => {
    const { roster } = withAgents("bob", "carol");
    const fromPi = { hop: 1, calledBy: { name: "pi", agentId: "pi" }, byOwner: false, ask: "@pi: bob and carol, look" };
    const first = roster.enqueue({ agentId: "id-bob", ...fromPi });
    expect(first.root).toBe(first.id);
    roster.enqueue({ agentId: "id-carol", ...fromPi, root: first.id });
    expect(roster.handOffsFrom(first.id)).toBe(2);
    expect(roster.handOffsFrom(first.id + 100)).toBe(0);
  });

  it("gives the ask keys of an agent's newest turns that went into its session, and of the one starting", () => {
    const { roster } = withAgents("bob", "carol");
    const given = (turn: { id: number }) => (roster.markSubmitted(turn.id), turn);
    given(roster.enqueue(ask("id-bob", { askKey: "entry:1" })));
    given(roster.enqueue(ask("id-bob", { askKey: "entry:2" })));
    given(roster.enqueue(ask("id-bob")));
    given(roster.enqueue(ask("id-carol", { askKey: "entry:3" })));
    given(roster.enqueue(ask("id-bob", { askKey: "turn:9" })));
    given(roster.enqueue(ask("id-bob", { askKey: "entry:2" })));
    // Still waiting: the catch-up before another turn reads its message, as nothing else may.
    const waiting = roster.enqueue(ask("id-bob", { askKey: "entry:7" }));
    expect(roster.askKeys("id-bob", 0)).toEqual(new Set(["entry:1", "entry:2", "turn:9"]));
    expect(roster.askKeys("id-bob", waiting.id)).toEqual(new Set(["entry:1", "entry:2", "turn:9", "entry:7"]));
    expect(roster.askKeys("id-bob", 0, 2)).toEqual(new Set(["entry:2", "turn:9"]));
    expect(roster.askKeys("id-bob", 0, 3)).toEqual(new Set(["entry:2", "turn:9"]));
    expect(roster.askKeys("id-bob", 0, 4)).toEqual(new Set(["entry:1", "entry:2", "turn:9"]));
    expect(roster.askKeys("id-carol", 0)).toEqual(new Set(["entry:3"]));
    expect(roster.askKeys("id-nobody", 0)).toEqual(new Set());
  });

  it("puts a running turn whose input never went in back in the queue, and leaves the others", () => {
    const { roster } = withAgents("bob", "carol");
    const setUp = started(roster, ask("id-bob"));
    const given = started(roster, ask("id-carol"));
    roster.markSubmitted(given.id);
    roster.requeueUnsubmitted();
    expect(roster.turn(setUp.id)).toMatchObject({ status: "queued" });
    expect(roster.turn(setUp.id)).not.toHaveProperty("startedAt");
    expect(roster.turn(given.id)).toMatchObject({ status: "running", submitted: true });
    expect(roster.startNext("id-bob")?.id).toBe(setUp.id);
  });

  it("stops the turns of the person who left, running or waiting, and only theirs", () => {
    const { roster, clock } = withAgents("bob", "carol");
    const running = started(roster, ask("id-bob"));
    const waiting = roster.enqueue(ask("id-bob"));
    const beas = roster.enqueue(ask("id-bob", { calledBy: bea }));
    // A hand-off from an agent that happens to share the person's name is no turn the person asked for.
    const handOff = roster.enqueue(ask("id-bob", { hop: 1, root: beas.id, calledBy: { name: "ann", agentId: "id-ann" }, byOwner: false }));
    const carols = roster.enqueue(ask("id-carol"));
    clock.now = T0 + 50;

    expect(
      roster
        .stopFor("ann")
        .map((turn) => turn.id)
        .sort((a, b) => a - b),
    ).toEqual([running.id, waiting.id, carols.id]);
    expect(roster.turn(waiting.id)).toEqual(expect.objectContaining({ status: "stopped", endedAt: T0 + 50 }));
    expect(roster.turn(running.id)).toEqual(expect.objectContaining({ status: "stopped", startedAt: T0 }));
    expect(roster.turn(beas.id)?.status).toBe("queued");
    expect(roster.turn(handOff.id)?.status).toBe("queued");
    expect(queuedOf(roster)).toEqual(new Map([["id-bob", 2]]));

    expect(roster.stopFor("ann")).toEqual([]);
    expect(roster.stopFor("nobody")).toEqual([]);
  });

  it("stops what the person's messages handed on too, and hands pi none of their chains' replies", () => {
    const { roster } = withAgents("bob", "carol", "dave");
    const theirs = started(roster, ask("id-bob"));
    const handOff = roster.enqueue({
      agentId: "id-carol",
      hop: 1,
      root: theirs.id,
      calledBy: { name: "bob", agentId: "id-bob" },
      byOwner: false,
      ask: "@bob: go",
    });
    roster.end(theirs.id, "done", { reply: replyTo(theirs, "@carol @pi go"), toPi: true });
    const beas = started(roster, ask("id-dave", { calledBy: bea }));
    roster.end(beas.id, "done", { reply: replyTo(beas, "@pi go"), toPi: true });

    expect(roster.stopFor("ann").map((turn) => turn.id)).toEqual([handOff.id]);
    expect(roster.outbox(theirs.id)?.toPi).toBe(false);
    expect(roster.outbox(beas.id)?.toPi).toBe(true);
    expect(roster.undelivered()).toEqual([theirs.id, beas.id]);
  });
});

describe("ChatRoster: replies to deliver", () => {
  it("keeps an ended turn's reply until it is delivered, oldest first, and lets it go after", () => {
    const { roster } = withAgents("bob", "carol");
    const bobs = started(roster, ask("id-bob"));
    const carols = started(roster, ask("id-carol"));
    expect(roster.hasWork()).toBe(true);
    roster.end(carols.id, "done", { reply: replyTo(carols), toPi: false });
    roster.end(bobs.id, "failed", { reply: replyTo(bobs, ""), toPi: true });
    expect(roster.undelivered()).toEqual([bobs.id, carols.id]);
    expect(roster.outbox(bobs.id)).toEqual({ reply: replyTo(bobs, ""), toPi: true });
    expect(roster.outbox(carols.id)).toEqual({ reply: replyTo(carols), toPi: false });
    expect(roster.hasWork()).toBe(true);

    roster.markDelivered(bobs.id);
    expect(roster.outbox(bobs.id)).toBeNull();
    expect(roster.undelivered()).toEqual([carols.id]);
    roster.markDelivered(carols.id);
    expect(roster.undelivered()).toEqual([]);
    expect(roster.hasWork()).toBe(false);
    // The turns stay as they ended, for the runs list.
    expect(roster.turn(bobs.id)?.status).toBe("failed");
  });

  it("has nothing to deliver for a turn that ended without a reply, or one it does not know", () => {
    const { roster } = withAgents("bob");
    const turn = started(roster, ask("id-bob"));
    roster.end(turn.id, "done");
    expect(roster.outbox(turn.id)).toBeNull();
    expect(roster.outbox(9999)).toBeNull();
    expect(roster.undelivered()).toEqual([]);
    expect(roster.hasWork()).toBe(false);
  });

  it("keeps the reply of a turn that ended once only: a second end changes nothing", () => {
    const { roster } = withAgents("bob");
    const turn = started(roster, ask("id-bob"));
    roster.end(turn.id, "done", { reply: replyTo(turn, "first"), toPi: false });
    expect(roster.end(turn.id, "done", { reply: replyTo(turn, "second"), toPi: true })).toBeNull();
    expect(roster.outbox(turn.id)).toEqual({ reply: replyTo(turn, "first"), toPi: false });
  });

  it("counts a turn that handed pi one in its chain's hand-offs, delivered or not", () => {
    const { roster } = withAgents("bob");
    const root = started(roster, ask("id-bob"));
    roster.end(root.id, "done", { reply: replyTo(root, "@pi build it"), toPi: true });
    expect(roster.handOffsFrom(root.id)).toBe(1);
    roster.markDelivered(root.id);
    expect(roster.handOffsFrom(root.id)).toBe(1);
  });

  it("hands pi no turn after a Stop, but still delivers the reply", () => {
    const { roster } = withAgents("bob", "carol");
    const bobs = started(roster, ask("id-bob"));
    const carols = started(roster, ask("id-carol"));
    roster.end(bobs.id, "done", { reply: replyTo(bobs, "@pi go"), toPi: true });
    roster.end(carols.id, "done", { reply: replyTo(carols, "@pi go"), toPi: true });
    roster.stopAll("id-carol");
    expect(roster.outbox(carols.id)).toEqual({ reply: replyTo(carols, "@pi go"), toPi: false });
    expect(roster.outbox(bobs.id)?.toPi).toBe(true);
    roster.stopAll();
    expect(roster.outbox(bobs.id)).toEqual({ reply: replyTo(bobs, "@pi go"), toPi: false });
    expect(roster.undelivered()).toEqual([bobs.id, carols.id]);
  });

  it("never prunes a reply not delivered yet", () => {
    const { roster } = withAgents("bob");
    const first = started(roster, ask("id-bob"));
    roster.end(first.id, "done", { reply: replyTo(first), toPi: false });
    for (let n = 0; n < KEPT_TURNS + 5; n++) roster.end(started(roster, ask("id-bob")).id, "done");
    expect(roster.outbox(first.id)).toEqual({ reply: replyTo(first), toPi: false });
    roster.markDelivered(first.id);
    roster.end(started(roster, ask("id-bob")).id, "done");
    expect(roster.turn(first.id)).toBeNull();
  });

  it("reads the replies to deliver again after the object restarts", () => {
    const { sql, roster } = withAgents("bob");
    const turn = started(roster, ask("id-bob"));
    roster.end(turn.id, "done", { reply: replyTo(turn), toPi: true });
    const again = new ChatRoster(sql);
    expect(again.undelivered()).toEqual([turn.id]);
    expect(again.outbox(turn.id)).toEqual({ reply: replyTo(turn), toPi: true });
  });
});

describe("ChatRoster: what everyone sees", () => {
  it("lists an agent's newest turns first, at most `limit` (20 unless said), and only its own", () => {
    const { roster } = withAgents("bob", "carol");
    const ids = Array.from({ length: 25 }, () => roster.enqueue(ask("id-bob")).id);
    const carols = roster.enqueue(ask("id-carol"));
    expect(roster.recentTurns("id-bob").map((turn) => turn.id)).toEqual(ids.slice(5).reverse());
    expect(roster.recentTurns("id-bob", 3).map((turn) => turn.id)).toEqual(ids.slice(-3).reverse());
    expect(roster.recentTurns("id-carol")).toEqual([carols]);
    expect(roster.recentTurns("id-nobody")).toEqual([]);
  });

  it("shows each agent with its owner's name, whether it is busy, how many turns wait and whether it is off", () => {
    const { roster } = setup();
    roster.add(agent("bob", { color: "green" }));
    roster.add(agent("carol", { ownerUid: "ann", avatar: "C" }));
    roster.add(agent("dave", { ownerUid: "ann" }));
    started(roster, ask("id-bob"));
    roster.enqueue(ask("id-bob"));
    roster.enqueue(ask("id-dave"));
    roster.enqueue(ask("id-dave"));
    roster.refresh("id-carol", { ...viewOf(roster.get("id-carol")), off: true });
    const names: Record<string, string> = { owner: "Olga", ann: "Ann" };
    const asked: string[] = [];

    expect(
      roster.views((uid) => {
        asked.push(uid);
        return names[uid];
      }),
    ).toStrictEqual([
      {
        ...{ id: "id-bob", name: "bob", avatar: "B", color: "green", job: "Helps with bob.", ownerUid: "owner", ownerName: "Olga" },
        ...{ busy: true, running: { turn: 1, calledBy: ann, hop: 0, elapsedMs: 0 }, queued: 1, next: { calledBy: ann, hop: 0 } },
      },
      { id: "id-carol", name: "carol", avatar: "C", color: "blue", job: "Helps with carol.", ownerUid: "ann", ownerName: "Ann", off: true },
      { id: "id-dave", name: "dave", avatar: "B", color: "blue", job: "Helps with dave.", ownerUid: "ann", ownerName: "Ann", queued: 2, next: { calledBy: ann, hop: 0 } },
    ]);
    expect(asked.sort()).toEqual(["ann", "ann", "owner"]);
  });

  it("says how long the running turn has gone, and who gave the oldest waiting turn and its hop", () => {
    const { roster, clock } = withAgents("bob");
    const first = started(roster, ask("id-bob"));
    roster.enqueue(ask("id-bob", { calledBy: { name: "research", agentId: "id-research" }, hop: 2, byOwner: false }));
    roster.enqueue(ask("id-bob", { calledBy: bea }));
    clock.now += 6_500;
    const [view] = roster.views(() => "Olga");
    expect(view.running).toEqual({ turn: first.id, calledBy: ann, hop: 0, elapsedMs: 6_500 });
    expect(view).toMatchObject({ busy: true, queued: 2, next: { calledBy: { name: "research", agentId: "id-research" }, hop: 2 } });
    expect(view).not.toHaveProperty("ended");
    roster.end(first.id, "done");
    const [after] = roster.views(() => "Olga");
    expect(after).not.toHaveProperty("running");
    expect(after.next?.hop).toBe(2);
    // Its latest ended turn, and how it ended: the chat says a stopped turn stopped, as it posts no reply.
    expect(after.ended).toEqual({ turn: first.id, status: "done" });
    const stopped = roster.stopAll("id-bob");
    expect(roster.views(() => "Olga")[0].ended).toEqual({ turn: Math.max(...stopped.map((turn) => turn.id)), status: "stopped" });
  });

  it("names each running turn's session, for the sockets to follow", () => {
    const { roster } = withAgents("bob", "carol");
    expect(roster.runningSessions()).toEqual([]);
    const bobs = started(roster, ask("id-bob"));
    roster.enqueue(ask("id-carol"));
    expect(roster.runningSessions()).toEqual([{ agentId: "id-bob", session: "session-bob", turn: bobs.id }]);
    roster.remove("id-bob");
    expect(roster.runningSessions()).toEqual([]);
  });

  it("shows a renamed agent under its new name, and nothing for an empty roster", () => {
    const { roster } = setup();
    expect(roster.views(() => "nobody")).toEqual([]);
    roster.add(agent("bob"));
    roster.refresh("id-bob", { ...viewOf(roster.get("id-bob")), name: "Robert" });
    expect(roster.views(() => "Olga")).toEqual([expect.objectContaining({ id: "id-bob", name: "robert", ownerName: "Olga" })]);
    expect(roster.views(() => "Olga")[0]).not.toHaveProperty("busy");
    expect(roster.views(() => "Olga")[0]).not.toHaveProperty("queued");
  });
});
