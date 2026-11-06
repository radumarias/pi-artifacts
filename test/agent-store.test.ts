import { describe, expect, it } from "vitest";
import {
  defaultColor,
  isDraftAgent,
  MAX_AGENT_PROPOSALS,
  MAX_AGENTS,
  type AgentDefinition,
  type AgentInput,
  type AgentOrigin,
  type AgentResult,
} from "../shared/agents.ts";
import { AgentStore, type AgentSave } from "../worker/agents/store.ts";
import { memorySql } from "./fakes.ts";

const T0 = 1_000_000;
const research = {
  name: "research",
  job: "Finds and sums up sources.",
  instructions: "Search, read the best three results, then write a short summary with links.",
};
const MISSING_ID = "0".repeat(16);

/** An agent's fields under another name, with some changed. */
function fields(name: string, change: Partial<AgentInput> = {}): AgentInput {
  return { ...research, name, ...change };
}

/** A clock the test moves by hand. */
function testClock(start = T0) {
  let at = start;
  return {
    now: () => at,
    set: (to: number) => {
      at = to;
    },
  };
}

/** The definition a save or a switch returned, failing the test with its error otherwise. */
function saved(result: AgentResult): AgentDefinition {
  if ("error" in result) throw new Error(result.error);
  return result;
}

function newStore(now: () => number = () => T0): AgentStore {
  return new AgentStore(memorySql(), now);
}

describe("AgentStore: saving", () => {
  it("saves a new agent turned on, with its badge, colour and autonomy filled in", () => {
    const store = newStore();
    const agent = saved(store.save(research, "user", undefined));
    expect(agent).toEqual({
      ...research,
      id: expect.stringMatching(/^[a-f0-9]{16}$/),
      avatar: "re",
      color: defaultColor("research"),
      autonomy: 1,
      origin: "user",
      enabled: true,
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(agent).not.toHaveProperty("copiedFrom");
    expect(store.get(agent.id)).toEqual(agent);
  });

  it("saves a new agent off when the user asks for that", () => {
    const store = newStore();
    const agent = saved(store.save(research, "user", false));
    expect(agent.enabled).toBe(false);
    expect(isDraftAgent(agent)).toBe(false);
  });

  it("checks and trims the fields, and lowercases the name", () => {
    const store = newStore();
    const agent = saved(store.save({ ...research, name: " Research ", job: "  Finds sources.  ", avatar: " R " }, "user", undefined));
    expect(agent).toMatchObject({ name: "research", job: "Finds sources.", avatar: "R" });
    expect(store.byName("research")?.id).toBe(agent.id);
  });

  it("keeps every field it was given, as checked", () => {
    const store = newStore();
    const input: AgentInput = {
      ...research,
      avatar: "Rs",
      color: "teal",
      model: "some-model",
      effort: "high",
      servers: ["docs", "search"],
      sharedServers: ["docs"],
      trigger: { kind: "schedule", at: "07:00", tz: "UTC", days: ["mon", "fri"] },
      workflow: [{ kind: "work", prompt: "Sum up what changed." }],
      autonomy: 2,
      assumed: ["trigger"],
    };
    const agent = saved(store.save(input, "user", undefined));
    expect(agent).toMatchObject(input);
    expect(store.get(agent.id)).toMatchObject(input);
  });

  it.each([
    ["fields that are not an object", "research"],
    ["a name with spaces", fields("deep research")],
    ["a one-letter name", fields("r")],
    ["the chat's own agent's name", fields("pi")],
    ["a word that calls everyone", fields("everyone")],
    ["no job line", fields("research", { job: "  " })],
    ["no instructions", fields("research", { instructions: "" })],
    ["an unknown colour", { ...research, color: "red" }],
  ])("answers what to fix for %s, saving nothing", (_, input) => {
    const store = newStore();
    expect(store.save(input, "user", undefined)).toEqual({ error: expect.any(String) });
    expect(store.list()).toEqual([]);
  });

  it("changes an agent in place: the fields are replaced, the version counts up and when it was made stays", () => {
    const clock = testClock();
    const store = newStore(clock.now);
    const first = saved(store.save(fields("research", { model: "some-model" }), "user", undefined));
    clock.set(T0 + 500);
    const second = saved(store.save(fields("research", { job: "Finds primary sources." }), "user", undefined, { id: first.id }));
    expect(second).toMatchObject({ id: first.id, job: "Finds primary sources.", version: 2, createdAt: T0, updatedAt: T0 + 500, enabled: true });
    // A save replaces the whole definition: a field it leaves out is gone.
    expect(second).not.toHaveProperty("model");
    expect(store.list()).toEqual([second]);
  });

  it("keeps an agent on or off as it was, unless the save says otherwise", () => {
    const store = newStore();
    const { id } = saved(store.save(research, "user", false));
    expect(saved(store.save(fields("research", { job: "Edited." }), "user", undefined, { id })).enabled).toBe(false);
    expect(saved(store.save(research, "user", true, { id })).enabled).toBe(true);
    expect(saved(store.save(fields("research", { job: "Edited again." }), "user", undefined, { id })).enabled).toBe(true);
    expect(saved(store.save(research, "user", false, { id })).enabled).toBe(false);
  });

  it("renames an agent, which frees its old name", () => {
    const store = newStore();
    const { id } = saved(store.save(research, "user", undefined));
    expect(saved(store.save(fields("scout"), "user", undefined, { id })).name).toBe("scout");
    expect(store.byName("research")).toBeNull();
    expect(store.byName("scout")?.id).toBe(id);
    expect(saved(store.save(research, "user", undefined)).id).not.toBe(id);
  });

  it("keeps names unique, whatever their case", () => {
    const store = newStore();
    const first = saved(store.save(research, "user", undefined));
    const second = saved(store.save(fields("scout"), "user", undefined));
    expect(store.save(fields("Research"), "user", undefined)).toEqual({ error: expect.stringContaining('already an agent named "research"') });
    const clash = { error: expect.stringContaining("already an agent named") };
    expect(store.save(fields("research"), "user", undefined, { id: second.id })).toEqual(clash);
    // Saving an agent under its own name is no clash.
    expect(saved(store.save(fields("research", { job: "Same name." }), "user", undefined, { id: first.id })).version).toBe(2);
    expect(store.list().map((agent) => agent.name)).toEqual(["research", "scout"]);
  });

  it("refuses a change to an agent that is not there, and makes none", () => {
    const store = newStore();
    expect(store.save(research, "user", undefined, { id: MISSING_ID })).toEqual({ error: "No such agent." });
    expect(store.save(research, "agent", undefined, { id: MISSING_ID })).toEqual({ error: "No such agent." });
    expect(store.list()).toEqual([]);
  });

  it("refuses a change over a newer version than the writer read, so two editors never undo each other", () => {
    const store = newStore();
    const read = saved(store.save(research, "user", undefined));
    const mine = saved(store.save(fields("research", { job: "Mine." }), "user", undefined, { id: read.id, version: read.version }));
    expect(mine.version).toBe(2);
    expect(store.save(fields("research", { job: "Theirs." }), "user", undefined, { id: read.id, version: read.version })).toEqual({
      error: expect.stringContaining("changed since you read it (version 2)"),
    });
    expect(store.get(read.id)).toEqual(mine);
    // A save that names no version is not compared.
    expect(saved(store.save(fields("research", { job: "Theirs." }), "user", undefined, { id: read.id })).version).toBe(3);
  });

  it("makes every change strictly newer than the last, even within one millisecond or when the clock goes back", () => {
    const clock = testClock(T0 + 10);
    const store = newStore(clock.now);
    const agent = saved(store.save(research, "user", undefined));
    expect(agent.updatedAt).toBe(T0 + 10);
    expect(saved(store.save(research, "user", undefined, { id: agent.id })).updatedAt).toBe(T0 + 11);
    expect(saved(store.setEnabled(agent.id, false)).updatedAt).toBe(T0 + 12);
    clock.set(T0);
    const later = saved(store.save(research, "user", undefined, { id: agent.id }));
    expect(later).toMatchObject({ updatedAt: T0 + 13, createdAt: T0 + 10, version: 4 });
  });

  it("keeps where a copy came from, and keeps it through a change that names another", () => {
    const store = newStore();
    const copiedFrom = { owner: "ann", id: "a".repeat(16), version: 3 };
    const copy = saved(store.save(research, "user", undefined, { copiedFrom }));
    expect(copy.copiedFrom).toEqual(copiedFrom);
    const other = { owner: "bob", id: "b".repeat(16), version: 1 };
    const changed = saved(store.save(fields("research", { job: "Mine now." }), "user", undefined, { id: copy.id, copiedFrom: other }));
    expect(changed.copiedFrom).toEqual(copiedFrom);
  });

  it(`holds at most ${MAX_AGENTS} agents, whoever makes them`, () => {
    const store = newStore();
    const agents = Array.from({ length: MAX_AGENTS }, (_, n) => saved(store.save(fields(`helper-${n}`), "user", undefined)));
    const full = { error: expect.stringContaining(`There are ${MAX_AGENTS} agents`) };
    expect(store.save(fields("one-more"), "user", undefined)).toEqual(full);
    expect(store.save(fields("one-more"), "agent", undefined)).toEqual(full);
    expect(store.list()).toHaveLength(MAX_AGENTS);
    // Changing one is still allowed.
    expect(saved(store.save(fields("helper-0", { job: "Changed." }), "user", undefined, { id: agents[0].id })).version).toBe(2);
    expect(store.delete(agents[1].id)).toBeNull();
    expect(saved(store.save(fields("one-more"), "user", undefined)).name).toBe("one-more");
  });
});

describe("AgentStore: the model's proposals", () => {
  it("saves a proposal off and as the model's, even when it asks for on", () => {
    const store = newStore();
    const proposal = saved(store.save(research, "agent", true));
    expect(proposal).toMatchObject({ origin: "agent", enabled: false, version: 1 });
    expect(isDraftAgent(proposal)).toBe(true);
  });

  it("lets the model revise its own proposal, which stays off and stays its own", () => {
    const store = newStore();
    const proposal = saved(store.save(research, "agent", undefined));
    const revised = saved(store.save(fields("research", { job: "Revised." }), "agent", true, { id: proposal.id, version: 1 }));
    expect(revised).toMatchObject({ id: proposal.id, job: "Revised.", origin: "agent", enabled: false, version: 2 });
  });

  it("never lets the model change or take the name of one of the user's agents", () => {
    const store = newStore();
    const mine = saved(store.save(research, "user", undefined));
    const refused = { error: expect.stringContaining("the model cannot change it") };
    expect(store.save(fields("research", { job: "Hijacked." }), "agent", undefined, { id: mine.id })).toEqual(refused);
    expect(store.save(fields("scout"), "agent", undefined, { id: mine.id })).toEqual(refused);
    expect(store.save(fields("Research"), "agent", undefined)).toEqual({ error: expect.stringContaining("already an agent named") });
    expect(store.list()).toEqual([mine]);
  });

  it(`lets at most ${MAX_AGENT_PROPOSALS} proposals wait for review at once`, () => {
    const store = newStore();
    const proposals = Array.from({ length: MAX_AGENT_PROPOSALS }, (_, n) => saved(store.save(fields(`idea-${n}`), "agent", undefined)));
    const waiting = { error: expect.stringContaining(`${MAX_AGENT_PROPOSALS} proposed agents already wait for review`) };
    expect(store.save(fields("one-more"), "agent", undefined)).toEqual(waiting);
    // The cap is on proposals only: the user's own agents and revisions of waiting proposals still go in.
    saved(store.save(fields("mine"), "user", undefined));
    saved(store.save(fields("idea-0", { job: "Revised." }), "agent", undefined, { id: proposals[0].id }));
    // Each proposal the user deals with frees a place: turning it on, saving it, or deleting it.
    saved(store.setEnabled(proposals[0].id, true));
    saved(store.save(fields("one-more"), "agent", undefined));
    expect(store.save(fields("two-more"), "agent", undefined)).toEqual(waiting);
    saved(store.save(fields("idea-1"), "user", undefined, { id: proposals[1].id }));
    saved(store.save(fields("two-more"), "agent", undefined));
    expect(store.delete(proposals[2].id)).toBeNull();
    saved(store.save(fields("three-more"), "agent", undefined));
    expect(store.save(fields("four-more"), "agent", undefined)).toEqual(waiting);
    expect(store.list().filter(isDraftAgent)).toHaveLength(MAX_AGENT_PROPOSALS);
  });

  it("makes a proposal the user's when they save it, keeping it off unless they turn it on", () => {
    const store = newStore();
    const proposal = saved(store.save(research, "agent", undefined));
    const reviewed = saved(store.save(fields("research", { job: "Reviewed." }), "user", undefined, { id: proposal.id, version: 1 }));
    expect(reviewed).toMatchObject({ origin: "user", enabled: false, version: 2 });
    expect(isDraftAgent(reviewed)).toBe(false);
    // Now the user's, the model can no longer change it.
    expect(store.save(research, "agent", undefined, { id: proposal.id })).toEqual({ error: expect.stringContaining("the model cannot change it") });
    expect(saved(store.save(research, "user", true, { id: proposal.id })).enabled).toBe(true);
  });
});

describe("AgentStore: turning agents on and off", () => {
  it("turns an agent off and on again, counting its version up each time", () => {
    const clock = testClock();
    const store = newStore(clock.now);
    const agent = saved(store.save(research, "user", undefined));
    clock.set(T0 + 100);
    const off = saved(store.setEnabled(agent.id, false));
    expect(off).toMatchObject({ enabled: false, origin: "user", version: 2, updatedAt: T0 + 100, createdAt: T0 });
    clock.set(T0 + 200);
    expect(saved(store.setEnabled(agent.id, true, off.version))).toMatchObject({ enabled: true, version: 3, updatedAt: T0 + 200 });
  });

  it("changes nothing when the agent already is as asked", () => {
    const clock = testClock();
    const store = newStore(clock.now);
    const agent = saved(store.save(research, "user", undefined));
    clock.set(T0 + 100);
    expect(store.setEnabled(agent.id, true)).toEqual(agent);
    const proposal = saved(store.save(fields("scout"), "agent", undefined));
    expect(store.setEnabled(proposal.id, false)).toEqual(proposal);
    expect(store.get(proposal.id)?.origin).toBe("agent");
  });

  it("makes a proposal the user's when they turn it on, out of the model's reach", () => {
    const store = newStore();
    const proposal = saved(store.save(research, "agent", undefined));
    expect(saved(store.setEnabled(proposal.id, true, proposal.version))).toMatchObject({ origin: "user", enabled: true, version: 2 });
    expect(store.save(fields("research", { job: "Revised." }), "agent", undefined, { id: proposal.id })).toEqual({
      error: expect.stringContaining("the model cannot change it"),
    });
    // Turned off again, it stays the user's.
    expect(saved(store.setEnabled(proposal.id, false))).toMatchObject({ origin: "user", enabled: false });
  });

  it("refuses to turn on an agent that changed since it was read, but turns one off whatever was read", () => {
    const store = newStore();
    const read = saved(store.save(research, "agent", undefined));
    saved(store.save(fields("research", { job: "Revised behind the user's back." }), "agent", undefined, { id: read.id }));
    expect(store.setEnabled(read.id, true, read.version)).toEqual({ error: expect.stringContaining("changed since you read it") });
    expect(store.get(read.id)).toMatchObject({ enabled: false, origin: "agent", version: 2 });
    expect(saved(store.setEnabled(read.id, true, 2))).toMatchObject({ enabled: true, version: 3 });
    expect(saved(store.setEnabled(read.id, false, 1))).toMatchObject({ enabled: false, version: 4 });
    // Without a version there is nothing to compare.
    expect(saved(store.setEnabled(read.id, true))).toMatchObject({ enabled: true, version: 5 });
  });

  it("refuses an agent that is not there", () => {
    expect(newStore().setEnabled(MISSING_ID, true)).toEqual({ error: "No such agent." });
  });
});

describe("AgentStore: reading and deleting", () => {
  it("lists agents by name", () => {
    const store = newStore();
    for (const name of ["zeta", "alpha", "mid-way", "beta"]) saved(store.save(fields(name), "user", undefined));
    saved(store.save(fields("gamma"), "agent", undefined));
    expect(store.list().map((agent) => agent.name)).toEqual(["alpha", "beta", "gamma", "mid-way", "zeta"]);
    expect(store.list().find((agent) => agent.name === "gamma")).toMatchObject({ origin: "agent", enabled: false });
  });

  it("finds an agent by its name, in any case, and by its id", () => {
    const store = newStore();
    const agent = saved(store.save(research, "user", undefined));
    expect(store.byName("research")).toEqual(agent);
    expect(store.byName("ReSearch")).toEqual(agent);
    expect(store.byName("scout")).toBeNull();
    expect(store.get(agent.id)).toEqual(agent);
    expect(store.get(MISSING_ID)).toBeNull();
  });

  it("deletes an agent, freeing its name, and says when there was none", () => {
    const store = newStore();
    const agent = saved(store.save(research, "user", undefined));
    const other = saved(store.save(fields("scout"), "user", undefined));
    expect(store.delete(agent.id)).toBeNull();
    expect(store.get(agent.id)).toBeNull();
    expect(store.byName("research")).toBeNull();
    expect(store.list()).toEqual([other]);
    expect(store.delete(agent.id)).toEqual({ error: "No such agent." });
    expect(saved(store.save(research, "user", undefined)).id).not.toBe(agent.id);
  });

  it("keeps the agents in the SQL it was given, for the next object to read", () => {
    const sql = memorySql();
    const agent = saved(new AgentStore(sql, () => T0).save(research, "user", undefined));
    expect(new AgentStore(sql, () => T0 + 1).list()).toEqual([agent]);
  });
});

describe("AgentStore.version", () => {
  it("changes with every save, switch and delete, and with nothing that changed no agent", () => {
    const clock = testClock();
    const store = newStore(clock.now);
    let last = store.version();
    expect(last).toBe("0");
    const changed = () => {
      const now = store.version();
      expect(now).not.toBe(last);
      last = now;
    };
    const agent = saved(store.save(research, "user", undefined));
    changed();
    saved(store.save(fields("research", { job: "Edited." }), "user", undefined, { id: agent.id }));
    changed();
    saved(store.setEnabled(agent.id, false));
    changed();
    const other = saved(store.save(fields("scout"), "agent", undefined));
    changed();
    expect(store.delete(other.id)).toBeNull();
    changed();
    // A refused save, a switch to what it already is and a delete of nothing leave it as it was.
    clock.set(T0 + 1_000);
    store.save(research, "user", undefined);
    store.save({ name: "x" }, "user", undefined);
    store.setEnabled(agent.id, false);
    store.delete(MISSING_ID);
    expect(store.version()).toBe(last);
  });

  it("changes when one agent is replaced by another within one millisecond", () => {
    const store = newStore(() => T0);
    const agent = saved(store.save(research, "user", undefined));
    const before = store.version();
    expect(store.delete(agent.id)).toBeNull();
    saved(store.save(fields("scout"), "user", undefined));
    expect(store.version()).not.toBe(before);
  });
});

/** What the routes call on a user's UserDirectory stub. */
interface AgentDirectory {
  listAgents(): Promise<AgentDefinition[]>;
  getAgent(id: string): Promise<AgentDefinition | null>;
  saveAgent(input: unknown, origin: AgentOrigin, enabled?: boolean, save?: AgentSave): Promise<AgentResult>;
  setAgentEnabled(id: string, enabled: boolean, version?: number): Promise<AgentResult>;
  deleteAgent(id: string): Promise<{ error: string } | null>;
}

// The routes take a DurableObjectStub of UserDirectory, a class whose Workers types this test project does not load,
// so they are imported by a path the type checker does not follow, and called with a directory of the methods they use.
const routesModule = new URL("../worker/agents-routes.ts", import.meta.url).href;
const { agentsRoute } = (await import(routesModule)) as { agentsRoute: (request: Request, directory: AgentDirectory) => Promise<Response | null> };

/** A user's directory over an AgentStore, recording what the routes ask of it. */
function directoryOver(store: AgentStore) {
  const calls: { method: keyof AgentDirectory; args: unknown[] }[] = [];
  const directory: AgentDirectory = {
    listAgents: async () => (calls.push({ method: "listAgents", args: [] }), store.list()),
    getAgent: async (id) => (calls.push({ method: "getAgent", args: [id] }), store.get(id)),
    saveAgent: async (input, origin, enabled, save) => {
      calls.push({ method: "saveAgent", args: [input, origin, enabled, save] });
      return store.save(input, origin, enabled, save);
    },
    setAgentEnabled: async (id, enabled, version) => {
      calls.push({ method: "setAgentEnabled", args: [id, enabled, version] });
      return store.setEnabled(id, enabled, version);
    },
    deleteAgent: async (id) => (calls.push({ method: "deleteAgent", args: [id] }), store.delete(id)),
  };
  return { directory, calls };
}

/** A request to the app: `json` is sent as a JSON body, `text` as it is, under `type` (JSON's by default). */
function request(method: string, path: string, body?: { json?: unknown; text?: string; type?: string }): Request {
  if (!body) return new Request(`https://pi.test${path}`, { method });
  const headers = { "content-type": body.type ?? "application/json" };
  return new Request(`https://pi.test${path}`, { method, headers, body: body.text ?? JSON.stringify(body.json) });
}

/** A 400 answer whose error says `text`. */
function refused(text: string) {
  return { status: 400, body: { error: expect.stringContaining(text) } };
}

function routes() {
  const store = newStore();
  const { directory, calls } = directoryOver(store);
  /** The route's answer, read as JSON; fails the test when the routes left the request to others. */
  const send = async (method: string, path: string, body?: { json?: unknown; text?: string; type?: string }) => {
    const response = await agentsRoute(request(method, path, body), directory);
    if (!response) throw new Error(`${method} ${path} was not routed`);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> & AgentDefinition & { error?: string } };
  };
  return { store, calls, send };
}

describe("agentsRoute", () => {
  it("lists the user's agents by name", async () => {
    const { store, send } = routes();
    expect(await send("GET", "/api/agents")).toEqual({ status: 200, body: [] });
    saved(store.save(fields("scout"), "user", undefined));
    saved(store.save(research, "agent", undefined));
    const { status, body } = await send("GET", "/api/agents?fresh=1");
    expect(status).toBe(200);
    expect((body as unknown as AgentDefinition[]).map((agent) => agent.name)).toEqual(["research", "scout"]);
  });

  it("makes an agent from a JSON body, turned on unless enabled is false, always as the user's", async () => {
    const { store, calls, send } = routes();
    const on = await send("POST", "/api/agents", { json: { ...research, origin: "agent" } });
    expect(on.status).toBe(201);
    expect(on.body).toMatchObject({ name: "research", origin: "user", enabled: true, version: 1 });
    expect(on.body).not.toHaveProperty("origin", "agent");
    const off = await send("POST", "/api/agents", { json: { ...fields("scout"), enabled: false } });
    expect(off).toMatchObject({ status: 201, body: { name: "scout", enabled: false, origin: "user" } });
    // Anything but false turns it on.
    expect((await send("POST", "/api/agents", { json: { ...fields("finder"), enabled: "no" } })).body.enabled).toBe(true);
    expect(store.list()).toHaveLength(3);
    const saves = calls.filter((call) => call.method === "saveAgent");
    expect(saves.map((call) => call.args.slice(1))).toEqual([
      ["user", true, undefined],
      ["user", false, undefined],
      ["user", true, undefined],
    ]);
  });

  it("makes a new agent from a POST that names an existing one's id and version", async () => {
    const { store, send } = routes();
    const agent = saved(store.save(research, "user", undefined));
    const made = await send("POST", "/api/agents", { json: { ...fields("scout"), id: agent.id, version: agent.version } });
    expect(made.status).toBe(201);
    expect(made.body.id).not.toBe(agent.id);
    expect(store.get(agent.id)).toEqual(agent);
  });

  it("answers what is wrong with an agent's fields with a 400", async () => {
    const { store, send } = routes();
    expect(await send("POST", "/api/agents", { json: fields("deep research") })).toEqual(refused("name"));
    expect(await send("POST", "/api/agents", { json: [research] })).toEqual({ status: 400, body: { error: "Expected an agent as an object." } });
    saved(store.save(research, "user", undefined));
    expect(await send("POST", "/api/agents", { json: research })).toEqual(refused("already an agent named"));
    expect(store.list()).toHaveLength(1);
  });

  it.each([
    ["text/plain", { text: JSON.stringify(research), type: "text/plain" }],
    ["a form", { text: "name=research&job=x&instructions=y", type: "application/x-www-form-urlencoded" }],
    ["JSON that does not parse", { text: "{name: research" }],
    ["JSON null", { json: null }],
    ["a JSON string", { json: "research" }],
  ])("refuses to make an agent from %s", async (_, body) => {
    const { store, calls, send } = routes();
    expect(await send("POST", "/api/agents", body)).toEqual(refused("Expected an agent as JSON"));
    expect(store.list()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("takes a JSON content type with parameters", async () => {
    const { send } = routes();
    expect((await send("POST", "/api/agents", { json: research, type: "application/json; charset=utf-8" })).status).toBe(201);
  });

  it("gets one agent, or a 404 for one that is not there", async () => {
    const { store, send } = routes();
    const agent = saved(store.save(research, "user", undefined));
    expect(await send("GET", `/api/agents/${agent.id}`)).toEqual({ status: 200, body: agent });
    expect(await send("GET", `/api/agents/${MISSING_ID}`)).toEqual({ status: 404, body: { error: "No such agent." } });
  });

  it("changes an agent with PUT, refusing one over a newer version", async () => {
    const { store, calls, send } = routes();
    const agent = saved(store.save(research, "user", undefined));
    const mine = await send("PUT", `/api/agents/${agent.id}`, { json: { ...fields("research", { job: "Mine." }), version: 1 } });
    expect(mine).toMatchObject({ status: 200, body: { id: agent.id, job: "Mine.", version: 2, origin: "user" } });
    const theirs = await send("PUT", `/api/agents/${agent.id}`, { json: { ...fields("research", { job: "Theirs." }), version: 1 } });
    expect(theirs).toEqual(refused("changed since you read it (version 2)"));
    expect(store.get(agent.id)?.job).toBe("Mine.");
    // Without a version, the last save wins.
    const last = await send("PUT", `/api/agents/${agent.id}`, { json: fields("research", { job: "Theirs." }) });
    expect(last.body).toMatchObject({ job: "Theirs.", version: 3 });
    expect(calls.filter((call) => call.method === "saveAgent").map((call) => call.args.slice(1))).toEqual([
      ["user", undefined, { id: agent.id, version: 1 }],
      ["user", undefined, { id: agent.id, version: 1 }],
      ["user", undefined, { id: agent.id, version: undefined }],
    ]);
  });

  it("keeps an agent on or off through a PUT unless enabled is true or false", async () => {
    const { store, send } = routes();
    const { id } = saved(store.save(research, "user", false));
    expect((await send("PUT", `/api/agents/${id}`, { json: { ...research, enabled: "yes" } })).body.enabled).toBe(false);
    expect((await send("PUT", `/api/agents/${id}`, { json: research })).body.enabled).toBe(false);
    expect((await send("PUT", `/api/agents/${id}`, { json: { ...research, enabled: true } })).body.enabled).toBe(true);
    expect((await send("PUT", `/api/agents/${id}`, { json: { ...research, enabled: false } })).body.enabled).toBe(false);
  });

  it("makes a proposal the user's when they change it with PUT", async () => {
    const { store, send } = routes();
    const proposal = saved(store.save(research, "agent", undefined));
    expect((await send("PUT", `/api/agents/${proposal.id}`, { json: { ...research, version: proposal.version } })).body).toMatchObject({
      origin: "user",
      enabled: false,
      version: 2,
    });
  });

  it("refuses a PUT whose body is not JSON, or whose version is not a number", async () => {
    const { store, calls, send } = routes();
    const agent = saved(store.save(research, "user", undefined));
    const path = `/api/agents/${agent.id}`;
    expect(await send("PUT", path, { text: JSON.stringify(research), type: "text/plain" })).toEqual(refused("Expected an agent as JSON"));
    expect(await send("PUT", path, { json: 7 })).toEqual(refused("Expected an agent as JSON"));
    expect(await send("PUT", path, { json: { ...research, version: "1" } })).toEqual({ status: 400, body: { error: "version is a number." } });
    expect(await send("PUT", path, { json: { ...research, version: null } })).toEqual({ status: 400, body: { error: "version is a number." } });
    expect(calls).toEqual([]);
    expect(store.get(agent.id)).toEqual(agent);
  });

  it("refuses a PUT to an agent that is not there, without making one", async () => {
    const { store, send } = routes();
    expect(await send("PUT", `/api/agents/${MISSING_ID}`, { json: research })).toEqual({ status: 400, body: { error: "No such agent." } });
    expect(store.list()).toEqual([]);
  });

  it("turns an agent on and off with PATCH, refusing to turn on one that changed since it was read", async () => {
    const { store, calls, send } = routes();
    const proposal = saved(store.save(research, "agent", undefined));
    saved(store.save(fields("research", { job: "Revised." }), "agent", undefined, { id: proposal.id }));
    const path = `/api/agents/${proposal.id}`;
    expect(await send("PATCH", path, { json: { enabled: true, version: 1 } })).toEqual(refused("changed since you read it"));
    const on = await send("PATCH", path, { json: { enabled: true, version: 2 } });
    expect(on).toMatchObject({ status: 200, body: { enabled: true, origin: "user", version: 3 } });
    expect(await send("PATCH", path, { json: { enabled: false } })).toMatchObject({ status: 200, body: { enabled: false, version: 4 } });
    // Already off: nothing changes, and it still answers with the agent.
    expect(await send("PATCH", path, { json: { enabled: false } })).toMatchObject({ status: 200, body: { enabled: false, version: 4 } });
    expect(calls.map((call) => call.args)).toEqual([
      [proposal.id, true, 1],
      [proposal.id, true, 2],
      [proposal.id, false, undefined],
      [proposal.id, false, undefined],
    ]);
  });

  it.each([
    ["no enabled", { json: { version: 1 } }],
    ["an enabled that is not true or false", { json: { enabled: "true" } }],
    ["a version that is not a number", { json: { enabled: true, version: "1" } }],
    ["a body that is not JSON", { text: JSON.stringify({ enabled: true }), type: "text/plain" }],
    ["JSON null", { json: null }],
  ])("refuses a PATCH with %s", async (_, body) => {
    const { store, calls, send } = routes();
    const agent = saved(store.save(research, "user", false));
    expect(await send("PATCH", `/api/agents/${agent.id}`, body)).toEqual(refused("Expected {enabled: true | false, version?: number}."));
    expect(calls).toEqual([]);
    expect(store.get(agent.id)).toEqual(agent);
  });

  it("refuses a PATCH of an agent that is not there", async () => {
    const { send } = routes();
    expect(await send("PATCH", `/api/agents/${MISSING_ID}`, { json: { enabled: true } })).toEqual({ status: 400, body: { error: "No such agent." } });
  });

  it("deletes an agent with DELETE, and refuses one that is not there", async () => {
    const { store, send } = routes();
    const agent = saved(store.save(research, "user", undefined));
    expect(await send("DELETE", `/api/agents/${agent.id}`)).toEqual({ status: 200, body: {} });
    expect(store.list()).toEqual([]);
    expect(await send("DELETE", `/api/agents/${agent.id}`)).toEqual({ status: 400, body: { error: "No such agent." } });
  });

  it.each([
    ["GET", "/api/agentsx"],
    ["GET", "/api/agents/"],
    ["GET", "/api/agents/abc123"],
    ["GET", `/api/agents/${"a".repeat(17)}`],
    ["GET", `/api/agents/${"A".repeat(16)}`],
    ["GET", `/api/agents/${"g".repeat(16)}`],
    ["GET", `/api/agents/${"a".repeat(16)}/turns`],
    ["DELETE", `/api/agents/..%2F${"a".repeat(16)}`],
    ["POST", `/api/agents/${"a".repeat(16)}`],
    ["PUT", "/api/agents"],
    ["PATCH", "/api/agents"],
    ["DELETE", "/api/agents"],
    ["GET", "/api/skills"],
  ])("leaves %s %s to the other routes, without asking the directory", async (method, path) => {
    const store = newStore();
    const { directory, calls } = directoryOver(store);
    const agent = saved(store.save(research, "user", undefined));
    const body = method === "GET" ? undefined : { json: research };
    expect(await agentsRoute(request(method, path, body), directory)).toBeNull();
    expect(calls).toEqual([]);
    expect(store.list()).toEqual([agent]);
  });
});
