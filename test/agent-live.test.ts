import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { ChatAgentView } from "../shared/agents.ts";
import { TurnFilter } from "../worker/agents/live.ts";
import { ARRIVING_MS, reduceAgents, shownLive, type AgentsLive } from "../src/chat/useChat.ts";

const entry = (id: number, kind: string, data?: object, model?: object[]) => ({ id, conversationId: 2, kind, data, model }) as unknown as EntryRecord;
const turnInput = (id: number, turn: number) => entry(id, "chat.turn", { turn, calledBy: { name: "Ana" }, hop: 0 }, [{ role: "user", content: "Your turn", timestamp: 0 }]);
const said = (id: number, text: string) => entry(id, "pi.assistant", undefined, [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 }]);
const catchUp = (id: number) => entry(id, "chat.aside", undefined, [{ role: "user", content: "What was said in the chat since your last turn: …", timestamp: 0 }]);

function snapshot(entries: EntryRecord[], over: object = {}) {
  return {
    type: "snapshot",
    entries,
    run: { inputs: [1] },
    tools: [{ callId: "c1", name: "x", status: "running" }],
    nestedTools: [],
    compactions: [],
    inbox: [{ id: 9, mode: "followUp" }],
    agent: { model: { provider: "p", modelId: "m" }, thinkingLevel: "low", instructions: "Owner's secret instructions", tools: ["a", "b"] },
    usage: {},
    ...over,
  } as unknown as AgentEvent;
}

describe("an agent's turn, as the chat's sockets follow it", () => {
  it("cuts a snapshot to the turn's entries, from its input on", () => {
    const filter = new TurnFilter(7);
    const [event] = filter.pass([snapshot([said(1, "an old answer"), turnInput(2, 6), said(3, "last turn"), catchUp(4), turnInput(5, 7), said(6, "Looking…")])]);
    expect(event).toMatchObject({ type: "snapshot", entries: [turnInput(5, 7), said(6, "Looking…")], run: { inputs: [1] }, inbox: [] });
  });

  it("holds back the catch-up and anything else before the turn's input is placed, then passes the turn's events", () => {
    const filter = new TurnFilter(7);
    // Taken while the turn was being set up: the run it shows is not this turn's.
    const [early] = filter.pass([snapshot([said(1, "last turn")])]);
    expect(early).toMatchObject({ entries: [], run: undefined, tools: [], generation: undefined });
    expect(filter.pass([{ type: "entry_appended", entry: catchUp(2) } as AgentEvent])).toEqual([]);
    const placed = filter.pass([
      { type: "run_start", inputs: [3] },
      { type: "entry_appended", entry: turnInput(3, 7) },
      { type: "message_start", message: { role: "assistant", content: [] } },
    ] as unknown as AgentEvent[]);
    expect(placed.map((event) => event.type)).toEqual(["entry_appended", "message_start"]);
    const later = filter.pass([
      { type: "message_end", entry: said(4, "Done.") },
      { type: "agent_changed", agent: { instructions: "secret" } },
      { type: "usage_changed", usage: {} },
      { type: "inbox_update", items: [] },
      { type: "run_end", inputs: [3] },
    ] as unknown as AgentEvent[]);
    expect(later.map((event) => event.type)).toEqual(["message_end", "run_end"]);
  });

  it("finds no entries for a turn whose input is not in the session", () => {
    const [event] = new TurnFilter(4).pass([snapshot([said(1, "a"), turnInput(2, 3)])]);
    expect(event).toMatchObject({ entries: [] });
  });

  it("keeps the turn when a compaction cut its input out of the context, and never shows the summary", () => {
    const summary = entry(9, "pi.compaction", { summary: "Earlier: the owner's private turn…" });
    // A socket that attaches after the compaction: the caller looked the input's id up.
    const late = new TurnFilter(7, 5);
    const [event] = late.pass([snapshot([summary, said(4, "the catch-up's answer"), said(6, "Looking…"), said(8, "Found it.")])]);
    expect(event).toMatchObject({ entries: [said(6, "Looking…"), said(8, "Found it.")], run: { inputs: [1] } });
    expect(late.pass([{ type: "entry_appended", entry: summary } as AgentEvent])).toEqual([]);
    // One that followed from the start keeps its steps through an overflow snapshot taken after the compaction.
    const follower = new TurnFilter(7);
    follower.pass([snapshot([catchUp(4), turnInput(5, 7)])]);
    const [again] = follower.pass([snapshot([summary, said(6, "Looking…")])]);
    expect(again).toMatchObject({ entries: [said(6, "Looking…")] });
    // Without the input's id, nothing in a compacted snapshot is known to be the turn's.
    expect(new TurnFilter(7).pass([snapshot([summary, said(6, "Looking…")])])[0]).toMatchObject({ entries: [], run: undefined });
  });

  it("drops what lands before the input once it is known, such as a catch-up written meanwhile", () => {
    const filter = new TurnFilter(7, 5);
    expect(filter.pass([{ type: "entry_appended", entry: catchUp(4) } as AgentEvent])).toEqual([]);
    expect(filter.pass([{ type: "message_end", entry: said(6, "Hi") } as AgentEvent])).toHaveLength(1);
  });
});

const research: ChatAgentView = { id: "r", name: "research", avatar: "rs", color: "blue", job: "Finds sources.", ownerUid: "o", ownerName: "Olga" };
const builder: ChatAgentView = { ...research, id: "b", name: "builder", job: "Makes pages." };
const running = (agent: ChatAgentView, turn: number, elapsedMs = 0): ChatAgentView => ({
  ...agent,
  busy: true,
  running: { turn, calledBy: { name: "Ana", uid: "ana" }, hop: 0, elapsedMs },
});
const events = (agent: string, turn: number, list: object[], at = 1_000) => ({ type: "agentEvents" as const, agent, turn, events: list as AgentEvent[], at });

describe("the app's view of the agents' live turns", () => {
  it("keeps each agent's events in its own view, and starts afresh for a new turn", () => {
    let live: AgentsLive = {};
    live = reduceAgents(live, events("r", 1, [snapshot([turnInput(1, 1)])]));
    live = reduceAgents(live, events("b", 4, [snapshot([turnInput(9, 4), said(10, "Building…")])]));
    live = reduceAgents(live, events("r", 1, [{ type: "message_end", entry: said(2, "Two sources.") }]));
    expect(live.r.state.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(live.b.state.entries.map((e) => e.id)).toEqual([9, 10]);
    live = reduceAgents(live, events("r", 2, [snapshot([turnInput(3, 2)])]));
    expect(live.r).toMatchObject({ turn: 2 });
    expect(live.r.state.entries.map((e) => e.id)).toEqual([3]);
  });

  it("times a turn from the roster's elapsed time, and lets it go ARRIVING_MS after it ends", () => {
    let live = reduceAgents({}, { type: "agents", agents: [running(research, 1, 6_000)], at: 10_000 });
    expect(live.r).toMatchObject({ turn: 1, startedAt: 4_000 });
    live = reduceAgents(live, events("r", 1, [snapshot([turnInput(1, 1)])], 10_100));
    // Told again while it runs: the start stays, and nothing changes.
    expect(reduceAgents(live, { type: "agents", agents: [running(research, 1, 9_000)], at: 13_000 })).toBe(live);
    live = reduceAgents(live, { type: "agents", agents: [research], at: 20_000 });
    expect(live.r.endedAt).toBe(20_000);
    expect(reduceAgents(live, { type: "expire", at: 20_000 + ARRIVING_MS - 1 })).toBe(live);
    expect(reduceAgents(live, { type: "expire", at: 20_000 + ARRIVING_MS })).toEqual({});
  });

  it("says how a turn ended once the roster does: a stopped one posts no reply", () => {
    let live = reduceAgents({}, { type: "agents", agents: [running(research, 1)], at: 0 });
    live = reduceAgents(live, { type: "agents", agents: [{ ...research, ended: { turn: 1, status: "stopped" } }], at: 5_000 });
    expect(live.r).toMatchObject({ endedAt: 5_000, ended: "stopped" });
    // An earlier turn's end says nothing of this one.
    live = reduceAgents(live, { type: "agents", agents: [running(research, 2)], at: 6_000 });
    live = reduceAgents(live, { type: "agents", agents: [{ ...research, ended: { turn: 1, status: "stopped" } }], at: 7_000 });
    expect(live.r).toMatchObject({ turn: 2, endedAt: 7_000 });
    expect(live.r.ended).toBeUndefined();
  });

  it("shows the live turns in the roster's order, but not one whose reply is in the transcript", () => {
    let live = reduceAgents({}, { type: "agents", agents: [running(builder, 4), running(research, 3)], at: 0 });
    const roster = [running(research, 3), running(builder, 4)];
    expect(shownLive(live, roster, []).map((turn) => turn.agent.id)).toEqual(["r", "b"]);
    const reply = entry(30, "chat.agent", { agentId: "r", turn: 3, text: "Done." });
    expect(shownLive(live, roster, [reply]).map((turn) => turn.agent.id)).toEqual(["b"]);
    // An agent removed from the roster is not shown.
    expect(shownLive(live, [running(research, 3)], []).map((turn) => turn.agent.id)).toEqual(["r"]);
    live = reduceAgents(live, { type: "reset" });
    expect(shownLive(live, roster, [])).toEqual([]);
  });
});
