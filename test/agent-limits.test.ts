import { describe, expect, it } from "vitest";
import { checkAgent, CHAT_TURN_KIND, type StepInput } from "../shared/agents.ts";
import {
  checkRule,
  checkRules,
  GuardrailError,
  inQuietRange,
  kindsFor,
  matchesValue,
  schemaHasPath,
  toolArgs,
  violation,
  type GuardrailRule,
  type PendingActionView,
} from "../shared/limits.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import { ChatActions, type NewAction } from "../worker/agents/limits/actions.ts";
import { LimitsDirectory } from "../worker/agents/limits/directory.ts";
import { approvalEnd, approvalFeed, approvalRef } from "../worker/agents/limits/feed.ts";
import { AgentRuns } from "../worker/agents/runs/store.ts";
import { FeedStore } from "../worker/feed/store.ts";
import { runFeedRef } from "../shared/feed.ts";
import { WriteGate, type Caller, type GateContext, type GateHost } from "../worker/agents/limits/gate.ts";
import { inputLevel, lowestLevel, turnLevel } from "../worker/agents/limits/levels.ts";
import { toolInput } from "../worker/agents/limits/tell.ts";
import { fillInput } from "../worker/agents/runs/executor.ts";
import { CallHeld, McpHub, type McpConnection, type RawToolResult } from "../worker/mcp/hub.ts";
import type { ToolInfo } from "../shared/protocol.ts";
import { memorySql } from "./fakes.ts";

const T0 = Date.UTC(2026, 10, 7, 9, 0);

const rule = (over: Partial<GuardrailRule> & Pick<GuardrailRule, "kind">): GuardrailRule =>
  ({ id: "r1", server: "crm", tool: "update_deal", effect: "block", value: 10, ...over }) as GuardrailRule;

const call = (input: StepInput, at = T0) => ({ server: "crm", tool: "update_deal", input, at });

describe("guardrail rules", () => {
  it("checks a rule's shape and says what to fix", () => {
    expect(checkRule({ id: "a", server: "crm", tool: "update_deal", arg: "discount", kind: "max", value: 10, effect: "approve" })).toEqual({
      id: "a",
      server: "crm",
      tool: "update_deal",
      arg: "discount",
      kind: "max",
      value: 10,
      effect: "approve",
    });
    expect(() => checkRule({ id: "a", server: "crm", tool: "*", arg: "discount", kind: "max", value: 10 })).toThrow(/names one tool/);
    expect(() => checkRule({ id: "a", server: "crm", tool: "x", kind: "max", value: 10 })).toThrow(/names an argument/);
    expect(() => checkRule({ id: "a", server: "crm", tool: "x", kind: "quietDates", value: [{ from: "12-24", to: "2026-12-26" }] })).toThrow(
      GuardrailError,
    );
    expect(() => checkRule({ id: "a", server: "crm", tool: "x", arg: "n", kind: "maxChange", value: 5 })).toThrow(/current value/);
    expect(() => checkRules([rule({ kind: "callsPerDay" }), rule({ kind: "callsPerDay" })])).toThrow(/same id/);
    // Quiet dates and call counts may hold for every tool of every server.
    expect(
      checkRule({ id: "q", server: "*", tool: "*", kind: "quietDates", value: [{ from: "12-24", to: "12-26" }], tz: "Europe/Bucharest" }),
    ).toMatchObject({
      tz: "Europe/Bucharest",
    });
  });

  it("are stored with an agent, checked with it", () => {
    const base = { name: "deals", job: "Keeps deals tidy.", instructions: "Do it." };
    const checked = checkAgent({
      ...base,
      guardrails: [{ id: "a", server: "crm", tool: "update_deal", arg: "discount", kind: "max", value: 10 }],
      approvalHours: 24,
    });
    expect(checked.guardrails).toEqual([{ id: "a", server: "crm", tool: "update_deal", arg: "discount", kind: "max", value: 10, effect: "block" }]);
    expect(checked.approvalHours).toBe(24);
    expect(() => checkAgent({ ...base, guardrails: [{ id: "a", kind: "nope" }] })).toThrow(/limits/);
    expect(() => checkAgent({ ...base, approvalHours: 0 })).toThrow(/hours/);
  });

  it("min and max read every value of the argument, and hold one that is not a number", () => {
    expect(violation(rule({ kind: "max", arg: "discount" }), call({ discount: 12 }))).toMatch(/over 10/);
    expect(violation(rule({ kind: "max", arg: "discount" }), call({ discount: 10 }))).toBeNull();
    expect(violation(rule({ kind: "min", arg: "lines.0.qty", value: 1 }), call({ lines: [{ qty: 0 }] }))).toMatch(/under 1/);
    expect(violation(rule({ kind: "max", arg: "discount" }), call({ discount: "lots" }))).toMatch(/not a number/);
    // A call that does not set the argument is not about it.
    expect(violation(rule({ kind: "max", arg: "discount" }), call({ other: 99 }))).toBeNull();
  });

  it("maxChange compares with the current value, as an amount or a percentage, and holds when it cannot be read", () => {
    const change = rule({ kind: "maxChange", arg: "price", value: 10, percent: true, current: { tool: "get_deal", input: {}, path: "price" } });
    expect(violation(change, call({ price: 105 }), { current: 100 })).toBeNull();
    expect(violation(change, call({ price: 120 }), { current: 100 })).toMatch(/20%/);
    expect(violation({ ...change, percent: undefined }, call({ price: 120 }), { current: 100 })).toMatch(/change of 20, over 10/);
    expect(violation(change, call({ price: 105 }), { current: null })).toMatch(/could not be read/);
  });

  it("never matches text without case, with * for any characters", () => {
    expect(matchesValue("*@example.com", "Ana@Example.com")).toBe(true);
    expect(matchesValue("*@example.com", "ana@example.org")).toBe(false);
    expect(matchesValue("a.b", "aXb")).toBe(false);
    expect(violation(rule({ kind: "never", arg: "to", value: ["*@example.com"] }), call({ to: ["x@else.org", "y@example.com"] }))).toMatch(
      /y@example.com/,
    );
  });

  it("never checks the values inside objects and lists, and fails closed past what it reads", () => {
    const to = rule({ kind: "never", arg: "to", value: ["*@rival.example"] });
    expect(violation(to, call({ to: [{ email: "ok@fine.com" }, { email: "ceo@rival.example", name: "C" }] }))).toMatch(/"ceo@rival.example", which is never allowed/);
    expect(violation(to, call({ to: { primary: { email: "Sam <sam@rival.example>" } } }))).toMatch(/never allowed/);
    expect(violation(to, call({ to: [{ email: "ok@fine.com" }] }))).toBeNull();
    // Recipients kept as an object's keys.
    expect(violation(to, call({ to: { "ok@fine.com": true, "ceo@rival.example": true } }))).toMatch(/"ceo@rival.example", which is never allowed/);
    let deep: unknown = "ceo@rival.example";
    for (let i = 0; i < 8; i++) deep = { next: deep };
    expect(violation(to, call({ to: deep as StepInput[string] }))).toMatch(/nested too deep for a never rule to check/);
  });

  it("never matches a boolean as true or false, and each recipient of a joined list", () => {
    const permanent = rule({ kind: "never", tool: "delete_deal", arg: "permanent", value: ["true"] });
    expect(violation(permanent, { ...call({ permanent: true }), tool: "delete_deal" })).toMatch(/never allowed/);
    expect(violation(permanent, { ...call({ permanent: false }), tool: "delete_deal" })).toBeNull();
    const to = rule({ kind: "never", arg: "to", value: ["leak@blocked.com", "*@rival.example"] });
    expect(violation(to, call({ to: "boss@ok.com, leak@blocked.com" }))).toMatch(/never allowed/);
    expect(violation(to, call({ to: "boss@ok.com;x@rival.example" }))).toMatch(/never allowed/);
    expect(violation(to, call({ to: "boss@ok.com ana@ok.com" }))).toBeNull();
  });

  it("finds an argument under anyOf or oneOf in any of the choices", () => {
    const schema = {
      type: "object",
      properties: {
        deal: { anyOf: [{ type: "null" }, { type: "object", properties: { discount: { type: "number" } }, additionalProperties: false }] },
        to: { oneOf: [{ type: "string" }, { type: "array", items: { type: "object", properties: { email: { type: "string" } } } }] },
      },
      additionalProperties: false,
    };
    expect(schemaHasPath(schema, "deal.discount")).toBe(true);
    expect(schemaHasPath(schema, "to.email")).toBe(true);
    expect(schemaHasPath(schema, "to.0.email")).toBe(true);
    expect(schemaHasPath(schema, "gone")).toBe(false);
    expect(schemaHasPath({ anyOf: [{ type: "object", properties: { a: {} } }, { type: "object", properties: { b: {} } }] }, "c")).toBe(false);
  });

  it("finds no argument under a plain type, so a field renamed under a nullable object or a union counts as gone", () => {
    const schema = {
      type: "object",
      properties: {
        deal: { anyOf: [{ type: "null" }, { type: "object", properties: { discount_pct: { type: "number" } }, additionalProperties: false }] },
        to: { oneOf: [{ type: "string" }, { type: "object", properties: { email: { type: "string" } }, additionalProperties: false }] },
        note: { type: ["string", "null"] },
      },
      additionalProperties: false,
    };
    expect(schemaHasPath(schema, "deal.discount")).toBe(false);
    expect(schemaHasPath(schema, "deal.discount_pct")).toBe(true);
    expect(schemaHasPath(schema, "to.name")).toBe(false);
    expect(schemaHasPath(schema, "note.text")).toBe(false);
    // A node that names no type still says nothing.
    expect(schemaHasPath({ type: "object", properties: { any: {} } }, "any.thing")).toBeUndefined();
  });

  it("never matches the recipient forms mail libraries take: a group, (comments) and spaces around the @", () => {
    expect(matchesValue("leak@blocked.com", "team:leak@blocked.com;")).toBe(true);
    expect(matchesValue("leak@blocked.com", "team: boss@ok.com, leak@blocked.com;")).toBe(true);
    expect(matchesValue("leak@blocked.com", "leak @ blocked.com (x)")).toBe(true);
    expect(matchesValue("*@blocked.com", "Sam <leak (work) @ blocked.com>")).toBe(true);
    expect(matchesValue("leak@blocked.com", "(a, b) leak@blocked.com")).toBe(true);
    expect(matchesValue("leak@blocked.com", "team: boss@ok.com;")).toBe(false);
  });

  it("never matches a recipient written as Name <address>, by its address or its name", () => {
    expect(matchesValue("*@rival.example", "Sam Lee <sam@rival.example>, boss@ok.com")).toBe(true);
    expect(matchesValue("leak@blocked.com", '"Leak, Inc" <LEAK@blocked.com>')).toBe(true);
    expect(matchesValue("sam lee", "Ana <ana@ok.com>; Sam Lee <sam@ok.com>")).toBe(true);
    expect(matchesValue("*@rival.example", "Sam Lee <sam@ok.com>")).toBe(false);
    // A quoted name with brackets of its own: the address is the last one.
    expect(matchesValue("ceo@company.com", '"x<y>"<ceo@company.com>')).toBe(true);
    expect(matchesValue("ceo@company.com", '"<ok@good.com>"<ceo@company.com>')).toBe(true);
    // With no space before the <address>: it is matched on its own all the same.
    expect(matchesValue("sam@rival.example", "Sam<sam@rival.example>")).toBe(true);
  });

  it("reads a field of each object in a list", () => {
    const most = rule({ kind: "max", arg: "items.amount", value: 100 });
    expect(violation(most, call({ items: [{ amount: 10 }, { amount: 500 }] }))).toMatch(/500, over 100/);
    expect(violation(most, call({ items: [{ amount: 10 }] }))).toBeNull();
  });

  it("quiet dates hold every year, across the new year too, in the rule's time zone", () => {
    expect(inQuietRange("2026-12-25", { from: "12-24", to: "12-26" })).toBe(true);
    expect(inQuietRange("2027-01-01", { from: "12-30", to: "01-02" })).toBe(true);
    expect(inQuietRange("2026-06-01", { from: "12-30", to: "01-02" })).toBe(false);
    expect(inQuietRange("2026-12-25", { from: "2026-12-25", to: "2026-12-25" })).toBe(true);
    // 23:30 UTC on the 23rd is already the 24th in Bucharest.
    const late = Date.UTC(2026, 11, 23, 23, 30);
    const quiet = rule({ kind: "quietDates", server: "*", tool: "*", value: [{ from: "12-24", to: "12-26" }] });
    expect(violation(quiet, call({}, late))).toBeNull();
    expect(violation({ ...quiet, tz: "Europe/Bucharest" }, call({}, late))).toMatch(/quiet date/);
  });

  it("the editor's choices come from the tool's input schema", () => {
    const schema = {
      type: "object",
      properties: {
        discount: { type: "number", description: "Percent off" },
        to: { type: "array", items: { type: "string" } },
        stage: { type: "string", enum: ["open", "won", "lost"] },
        deal: { type: "object", properties: { amount: { type: ["integer", "null"] } } },
      },
    };
    expect(toolArgs(schema)).toEqual([
      { path: "discount", type: "number", description: "Percent off" },
      { path: "to", type: "array" },
      { path: "stage", type: "string", values: ["open", "won", "lost"] },
      { path: "deal.amount", type: "integer" },
    ]);
    expect(kindsFor("integer")).toEqual(["min", "max", "maxChange", "never"]);
    expect(kindsFor("string")).toEqual(["never"]);
  });

  it("fills a current value's read from the call's input", () => {
    expect(fillInput({ id: "{{input.deal.id}}", note: "for {{input.deal.id}}" }, { input: { deal: { id: 7 } } })).toEqual({ id: 7, note: "for 7" });
  });
});

describe("levels in a chat", () => {
  const OWNER = "owner-uid";
  const message = (uid: string, name = "Mia") => ({ kind: CHAT_MESSAGE_KIND, data: { uid, name, text: "", sentAt: 1 } });
  const handOff = (turn: number) => ({ kind: CHAT_TURN_KIND, data: { turn, calledBy: { name: "atlas", agentId: "a" }, hop: 1 } });

  it("pi runs on its owner's own message, and only proposes on anyone else's", () => {
    expect(inputLevel(message(OWNER), OWNER, () => null).level).toBe(4);
    expect(inputLevel(message("mia-uid"), OWNER, () => null)).toEqual({ level: 2, because: "on Mia's message" });
    expect(inputLevel({ kind: "pi.user" }, OWNER, () => null).level).toBe(2);
    // One run answering both goes no further than the member's.
    expect(lowestLevel([inputLevel(message(OWNER), OWNER, () => null), inputLevel(message("mia-uid"), OWNER, () => null)])?.level).toBe(2);
  });

  it("a hand-off to pi goes no further than the turn that handed it", () => {
    const radu = { name: "Radu", uid: OWNER };
    expect(inputLevel(handOff(1), OWNER, () => ({ byOwner: true, calledBy: radu })).level).toBe(4);
    expect(inputLevel(handOff(1), OWNER, () => ({ byOwner: false, calledBy: { name: "Mia" } })).level).toBe(2);
    // A run's chain never does, whoever's it is; nor a turn the chat no longer has.
    expect(inputLevel(handOff(1), OWNER, () => ({ byOwner: true, calledBy: radu, unattended: true })).level).toBe(2);
    // Nor a turn the router picked the agent for, though on the owner's message.
    expect(inputLevel(handOff(1), OWNER, () => ({ byOwner: true, calledBy: { ...radu, routed: true } })).level).toBe(2);
    expect(inputLevel(handOff(1), OWNER, () => null).level).toBe(2);
  });

  it("an agent runs on its owner's own turn and proposes on any other", () => {
    expect(turnLevel({ byOwner: true, calledBy: { name: "Radu" } }).level).toBe(4);
    expect(turnLevel({ byOwner: false, calledBy: { name: "Mia" } })).toEqual({ level: 2, because: "on a turn Mia gave it" });
  });

  it("turns nobody asked for propose: speaking up, a follow-up, a router's pick; and the owner's Yes only drafts", () => {
    const radu = { name: "Radu", uid: OWNER };
    expect(turnLevel({ byOwner: false, calledBy: { name: "the conversation", unprompted: "speak-up" } }).level).toBe(2);
    // A follow-up on the owner's own question is still a turn they did not give it.
    expect(turnLevel({ byOwner: true, calledBy: { ...radu, unprompted: "follow-up" } }).level).toBe(2);
    expect(turnLevel({ byOwner: true, calledBy: { ...radu, routed: true } }).level).toBe(2);
    expect(turnLevel({ byOwner: true, calledBy: { ...radu, drafts: true } })).toEqual({ level: 2, because: "on your Yes to an offer, which only drafts" });
    // pi answering a Yes in place of an agent: the same.
    expect(inputLevel({ kind: CHAT_MESSAGE_KIND, data: { uid: OWNER, name: "Radu", text: "", sentAt: 1, drafts: true } }, OWNER, () => null).level).toBe(2);
  });
});

/** An MCP server with a read tool and a write tool, recording every call that reaches it. */
function fakeServer(
  tools: ToolInfo[] = [
    { name: "get_deal", description: "", annotations: { readOnlyHint: true } },
    { name: "update_deal", description: "", inputSchema: { type: "object", properties: { discount: { type: "number" } } } },
  ],
) {
  const calls: { name: string; args: unknown }[] = [];
  const connection: McpConnection = {
    listTools: async () => tools,
    callTool: async (name, args): Promise<RawToolResult> => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify(name === "get_deal" ? { price: 100 } : { ok: true }) }] };
    },
    close: async () => {},
  };
  return { calls, connector: async () => connection };
}

/** The chat a gate guards: real actions over SQLite, callers by session name, a log. */
function guarded(callers: Record<string, Partial<Caller>>, userRules: GuardrailRule[] = []) {
  const clock = { now: T0 };
  const server = fakeServer();
  const hub = new McpHub([{ name: "crm", url: "https://example.invalid/mcp" }], server.connector, () => clock.now);
  const actions = new ChatActions(
    memorySql(),
    () => "chat-1",
    () => clock.now,
  );
  const logged: { outcome: string; detail?: string }[] = [];
  const held: PendingActionView[] = [];
  let calls = 0;
  const host: GateHost = {
    now: () => clock.now,
    caller: async (context: GateContext) => {
      const found = context.kind === "session" ? callers[context.session] : context.kind === "run" ? callers.run : undefined;
      if (!found) throw new Error("this session has no turn that may change anything.");
      return { actor: { name: "pi" }, level: 4, because: "on your own message", origin: {}, ...found } as Caller;
    },
    userRules: async () => userRules,
    agent: async () => null,
    readValue: async (_server, tool, input, path) => {
      const { result } = await hub.read("crm", tool, input, { staleMs: 0, viewer: "owner" });
      return (result.payload as Record<string, unknown>)[path];
    },
    callsSince: async () => calls,
    dayStart: (at) => at - (at % 86_400_000),
    log: (entry) => {
      logged.push(entry);
      if (entry.outcome === "ran" || entry.outcome === "warned") calls++;
    },
    hold: async (action: NewAction) => {
      const view = actions.add(action);
      held.push(view);
      return view;
    },
  };
  const gate = new WriteGate(host);
  hub.guard(gate);
  const write = (session: string, input: StepInput) => hub.call("crm", "update_deal", input, { kind: "session", session });
  const approve = async (id: string, input?: StepInput) => {
    const action = actions.move(id, "pending", "running")!;
    return hub.call("crm", action.tool, input ?? action.input, { kind: "approved", action, level: 2 });
  };
  return { clock, server, hub, host, actions, logged, held, write, approve };
}

/** The verdict a held or refused call came with. */
async function heldBy(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CallHeld) return error.verdict;
    throw error;
  }
  throw new Error("the call ran");
}

describe("the write gate", () => {
  const discountRule = (effect: GuardrailRule["effect"]): GuardrailRule => rule({ kind: "max", arg: "discount", effect });

  it("lets read-only tools through without asking", async () => {
    const chat = guarded({});
    await chat.hub.call("crm", "get_deal", { id: 1 });
    expect(chat.server.calls).toEqual([{ name: "get_deal", args: { id: 1 } }]);
    expect(chat.logged).toEqual([]);
  });

  it("refuses a call from no session it knows, before it reaches the server", async () => {
    const chat = guarded({});
    expect(await heldBy(chat.write("stray", { discount: 1 }))).toMatchObject({ outcome: "refused" });
    // With no one named at all, nothing that changes data runs; nor through a read, nor on a hub with no gate.
    await expect(chat.hub.call("crm", "update_deal", {})).rejects.toMatchObject({ error: { code: "not_granted" } });
    await expect(chat.hub.read("crm", "update_deal", {}, { staleMs: 0, viewer: "owner" })).rejects.toMatchObject({ error: { code: "not_granted" } });
    const open = new McpHub([{ name: "crm", url: "https://example.invalid/mcp" }], chat.server.connector);
    await expect(open.call("crm", "update_deal", {})).rejects.toMatchObject({ error: { code: "not_granted" } });
    expect(chat.server.calls).toEqual([]);
  });

  it("a blocked guardrail never reaches the server, whatever the level", async () => {
    const chat = guarded({ owner: { level: 4 }, member: { level: 2 } }, [discountRule("block")]);
    expect(await heldBy(chat.write("owner", { discount: 25 }))).toMatchObject({
      outcome: "refused",
      message: expect.stringMatching(/rule blocks it.*over 10/),
    });
    // Not even proposed: a call a rule blocks would never run.
    expect(await heldBy(chat.write("member", { discount: 25 }))).toMatchObject({ outcome: "refused" });
    expect(chat.server.calls).toEqual([]);
    expect(chat.held).toEqual([]);
    expect(chat.logged.map((entry) => entry.outcome)).toEqual(["refused", "refused"]);
  });

  it("goes by level: Inform refuses, Recommend proposes, Approve queues, Run runs and logs", async () => {
    const chat = guarded({ one: { level: 1, because: "on its own, in a run" }, two: { level: 2 }, three: { level: 3 }, four: { level: 4 } });
    expect(await heldBy(chat.write("one", { discount: 1 }))).toMatchObject({ outcome: "refused", message: expect.stringMatching(/at Inform/) });
    expect(await heldBy(chat.write("two", { discount: 2 }))).toMatchObject({ outcome: "held", action: { kind: "proposal", input: { discount: 2 } } });
    expect(await heldBy(chat.write("three", { discount: 3 }))).toMatchObject({
      outcome: "held",
      action: { kind: "approval", input: { discount: 3 } },
    });
    await chat.write("four", { discount: 4 });
    expect(chat.server.calls).toEqual([{ name: "update_deal", args: { discount: 4 } }]);
    expect(chat.logged.map((entry) => entry.outcome)).toEqual(["refused", "held", "held", "ran"]);
  });

  it("at Run, a rule that asks for approval holds the call, and one that warns lets it through with the warning", async () => {
    const chat = guarded({ four: { level: 4 } }, [discountRule("approve"), { ...discountRule("warn"), id: "w", value: 5 }]);
    const held = await heldBy(chat.write("four", { discount: 12 }));
    expect(held).toMatchObject({ outcome: "held", action: { kind: "approval", why: expect.stringMatching(/rule asks for your approval/) } });
    await chat.write("four", { discount: 7 });
    expect(chat.server.calls).toEqual([{ name: "update_deal", args: { discount: 7 } }]);
    expect(chat.logged.at(-1)).toMatchObject({ outcome: "warned", detail: expect.stringMatching(/over 5/) });
  });

  it("an approved call runs exactly as stored, once, and only its own call", async () => {
    const chat = guarded({ two: { level: 2 } });
    const held = await heldBy(chat.write("two", { discount: 8 }));
    if (held.outcome !== "held") throw new Error("not held");
    // A call that is not the stored one is not run under its approval, nor one that is not running (approved).
    const running = { ...held.action, status: "running" as const };
    expect(await heldBy(chat.hub.call("crm", "update_deal", { discount: 80 }, { kind: "approved", action: running, level: 2 }))).toMatchObject({
      outcome: "refused",
    });
    expect(await heldBy(chat.hub.call("crm", "update_deal", { discount: 8 }, { kind: "approved", action: held.action, level: 2 }))).toMatchObject({
      outcome: "refused",
    });
    await chat.approve(held.action.id);
    expect(chat.server.calls).toEqual([{ name: "update_deal", args: { discount: 8 } }]);
    // A second press finds it no longer pending.
    expect(chat.actions.move(held.action.id, "pending", "running")).toBeNull();
  });

  it("an approval is checked once more against the rules that block: a quiet date may have begun", async () => {
    const quiet = rule({ id: "q", kind: "quietDates", server: "*", tool: "*", value: [{ from: "11-08", to: "11-08" }] });
    const rules: GuardrailRule[] = [];
    const chat = guarded({ three: { level: 3 } }, rules);
    const held = await heldBy(chat.write("three", { discount: 3 }));
    if (held.outcome !== "held") throw new Error("not held");
    rules.push(quiet);
    chat.clock.now = Date.UTC(2026, 10, 8, 12);
    expect(await heldBy(chat.approve(held.action.id))).toMatchObject({ outcome: "refused", message: expect.stringMatching(/blocks it now/) });
    expect(chat.server.calls).toEqual([]);
  });

  it("maxChange reads the current value through the named read tool", async () => {
    const change = rule({
      kind: "maxChange",
      tool: "update_deal",
      arg: "discount",
      value: 10,
      percent: true,
      current: { tool: "get_deal", input: { id: "{{input.id}}" }, path: "price" },
    });
    const chat = guarded({ four: { level: 4 } }, [change]);
    expect(await heldBy(chat.write("four", { id: 3, discount: 150 }))).toMatchObject({ outcome: "refused" });
    expect(chat.server.calls).toEqual([{ name: "get_deal", args: { id: 3 } }]);
    await chat.write("four", { id: 3, discount: 105 });
    expect(chat.server.calls.at(-1)).toEqual({ name: "update_deal", args: { id: 3, discount: 105 } });
  });

  it("callsPerDay counts the calls that ran today", async () => {
    const chat = guarded({ four: { level: 4 } }, [rule({ kind: "callsPerDay", value: 2 })]);
    await chat.write("four", {});
    await chat.write("four", {});
    expect(await heldBy(chat.write("four", {}))).toMatchObject({ outcome: "refused", message: expect.stringMatching(/2 times today/) });
    expect(chat.server.calls).toHaveLength(2);
  });

  it("callsPerDay counts the calls under way: of three at once, only the first runs", async () => {
    const chat = guarded({ four: { level: 4 } }, [rule({ kind: "callsPerDay", value: 1 })]);
    const outcomes = await Promise.all(
      [1, 2, 3].map((n) =>
        chat.write("four", { discount: n }).then(
          () => "ran",
          (error: unknown) => (error instanceof CallHeld ? error.verdict.outcome : "failed"),
        ),
      ),
    );
    expect(outcomes).toEqual(["ran", "refused", "refused"]);
    expect(chat.server.calls).toHaveLength(1);
  });

  it("callsPerDay does not count a call held for approval, or one refused, checked at the same time", async () => {
    const chat = guarded({ three: { level: 3 }, one: { level: 1 }, four: { level: 4 } }, [rule({ kind: "callsPerDay", value: 1 })]);
    const outcomes = await Promise.all(
      (["three", "one", "four"] as const).map((who) =>
        chat.write(who, { discount: 1 }).then(
          () => "ran",
          (error: unknown) => (error instanceof CallHeld ? error.verdict.outcome : "failed"),
        ),
      ),
    );
    expect(outcomes).toEqual(["held", "refused", "ran"]);
    expect(chat.server.calls).toHaveLength(1);
  });

  it("a rule on an argument the tool no longer has fires, rather than let every call through", async () => {
    const chat = guarded({ four: { level: 4 } }, [rule({ kind: "max", arg: "discount_pct", value: 10, effect: "approve" })]);
    expect(await heldBy(chat.write("four", { discount: 50 }))).toMatchObject({
      outcome: "held",
      action: { why: expect.stringMatching(/has no argument discount_pct/) },
    });
    expect(chat.server.calls).toEqual([]);
  });

  it("an approved call whose agent cannot be read fails, and can be approved again", async () => {
    const chat = guarded({ three: { level: 3, actor: { name: "deals", agentId: "a1" } } });
    const held = await heldBy(chat.write("three", { discount: 3 }));
    if (held.outcome !== "held") throw new Error("not held");
    chat.host.agent = async () => {
      throw new Error("directory unreachable");
    };
    await expect(chat.approve(held.action.id)).rejects.toThrow(/unreachable/);
    expect(chat.server.calls).toEqual([]);
  });

  it("a page cannot wait for an approval: what would be held is refused", async () => {
    const chat = guarded({ page: { level: 4, noHold: true } }, [discountRule("approve")]);
    expect(await heldBy(chat.write("page", { discount: 50 }))).toMatchObject({ outcome: "refused", message: expect.stringMatching(/cannot wait/) });
    expect(chat.held).toEqual([]);
  });
});

/** A call held for the owner, as the gate makes one. */
const action = (over: Partial<NewAction> = {}): NewAction => ({
  kind: "approval",
  actor: { name: "deals", agentId: "a".repeat(16) },
  server: "crm",
  tool: "update_deal",
  input: { discount: 5 },
  why: "at Approve",
  expiresAt: T0 + 3_600_000,
  origin: { session: "3", level: 3 },
  ...over,
});

describe("pending actions", () => {
  it("end once: a press and its expiry, or two presses, decide it once", () => {
    const actions = new ChatActions(
      memorySql(),
      () => "chat-1",
      () => T0,
    );
    const one = actions.add(action());
    expect(actions.get(one.id)?.status).toBe("pending");
    expect(actions.move(one.id, "pending", "declined")).toMatchObject({ status: "declined", decidedAt: T0 });
    expect(actions.move(one.id, "pending", "expired")).toBeNull();
    expect(actions.get(one.id)?.status).toBe("declined");
    expect(actions.origin(one.id)).toEqual({ session: "3", level: 3 });
  });

  it("keep what an approved call came to, and find the ones a restart cut off", () => {
    const actions = new ChatActions(
      memorySql(),
      () => "chat-1",
      () => T0,
    );
    const sql = memorySql();
    const before = new ChatActions(
      sql,
      () => "chat-1",
      () => T0,
    );
    const one = before.add(action());
    before.move(one.id, "pending", "running");
    // Running under the instance that runs it is not cut off; after a restart (a new instance) it is.
    expect(before.interrupted()).toEqual([]);
    expect(actions.interrupted()).toEqual([]);
    const after = new ChatActions(
      sql,
      () => "chat-1",
      () => T0,
    );
    expect(after.interrupted().map((view) => view.id)).toEqual([one.id]);
    const two = after.add(action());
    after.move(two.id, "pending", "running");
    expect(after.move(two.id, "running", "done", "x".repeat(5_000))?.result).toHaveLength(2_000);
  });
});

describe("approvals in the feed", () => {
  const held = (over: Partial<NewAction> = {}) =>
    new ChatActions(
      memorySql(),
      () => "chat-1",
      () => T0,
    ).add(action({ actor: { name: "deals", agentId: "a".repeat(16), avatar: "de", color: "blue" }, ...over }));

  it("waits in Needs you from its hold, naming who asks and the call, and opens its chat", () => {
    const feed = new FeedStore(memorySql());
    const view = held();
    expect(feed.add(approvalFeed(view, "Deals", "group"))).toBe("added");
    expect(feed.counts()).toEqual({ unread: 1, needsYou: 1 });
    const [item] = feed.list({ needsYou: true }).items;
    expect(item).toMatchObject({ kind: "approval", needsYou: true, title: "@deals needs your approval in Deals", open: { to: "chat", chatId: "chat-1" } });
    expect(item.text).toContain("crm.update_deal");
    expect(item.from?.agent?.id).toBe("a".repeat(16));
    // It carries the action as held, which the feed decides it from (Approve, Decline).
    expect(item.action).toMatchObject({ id: view.id, chatId: "chat-1", kind: "approval", status: "pending", expiresAt: view.expiresAt });
    // Added again (a retry): one item.
    expect(feed.add(approvalFeed(view, "Deals", "group"))).toBe("same");
    expect(approvalFeed(held({ kind: "proposal", actor: { name: "pi" } }), "Deals", "group")).toMatchObject({ title: "pi proposes a change in Deals", from: { name: "pi" } });
  });

  it("waits no more once its ref is resolved (what removeNeedsYou does for an approved, declined or expired one)", () => {
    const feed = new FeedStore(memorySql());
    const view = held();
    feed.add(approvalFeed(view, "Deals", "group"));
    expect(feed.resolve(approvalRef("chat-1", view.id))).toBe(1);
    expect(feed.counts()).toEqual({ unread: 0, needsYou: 0 });
    expect(feed.list().items[0]).toMatchObject({ kind: "approval", read: true });
    // Ended twice (a press and its expiry): nothing more.
    expect(feed.resolve(approvalRef("chat-1", view.id))).toBe(0);
  });

  it("keeps how its action ended on the item, so a resolved row still says Ran, Failed, Declined or Expired", () => {
    const feed = new FeedStore(memorySql());
    const view = held();
    feed.add(approvalFeed(view, "Deals", "group"));
    const ref = approvalRef("chat-1", view.id);
    const ended = approvalEnd({ status: "failed", result: `deal 5 is closed ${"x".repeat(500)}`, decidedAt: T0 + 5 });
    expect(ended.result!.length).toBeLessThanOrEqual(300);
    expect(feed.endAction(ref, ended)).toBe(1);
    expect(feed.counts()).toEqual({ unread: 0, needsYou: 0 });
    const [item] = feed.list().items;
    expect(item.action).toMatchObject({ id: view.id, chatId: "chat-1", kind: "approval", status: "failed", decidedAt: T0 + 5, expiresAt: view.expiresAt });
    expect(item.action?.result).toMatch(/^deal 5 is closed/);
    // An item that carries no action is not changed (the caller resolves it then).
    feed.add({ kind: "assumption", ref: "assumption:a1", at: T0, title: "Confirm", open: { to: "agent", agentId: "a1" } });
    expect(feed.endAction("assumption:a1", { status: "expired" })).toBe(0);
    expect(feed.endAction("action:none:1", { status: "expired" })).toBe(0);
  });

  it("never reaches the feed from a chat off the record", () => {
    const feed = new FeedStore(memorySql());
    expect(feed.add(approvalFeed(held(), "Secret", "off_record"))).toBe("refused");
  });

  it("a run that waited for a sign-in going on asks no more, not only at its end (which may wait at a held call)", () => {
    const feed = new FeedStore(memorySql());
    const runs = new AgentRuns(memorySql(), () => T0, undefined, (agentId, dueAt) => feed.resolve(runFeedRef(agentId, dueAt)));
    runs.begin("a1", T0, "schedule", false);
    runs.update("a1", T0, { status: "needs_sign_in" });
    feed.add({ kind: "run", ref: runFeedRef("a1", T0), at: T0, title: "@a is waiting for you to sign in", needsYou: true, status: "needs_sign_in", open: { to: "agent", agentId: "a1" } });
    expect(feed.counts().needsYou).toBe(1);
    runs.restart("a1", T0);
    expect(feed.counts().needsYou).toBe(0);
  });

  it("a run waiting for a held call has not ended: no run item until it does", () => {
    const ended: string[] = [];
    const runs = new AgentRuns(memorySql(), () => T0, (run) => ended.push(run.status));
    runs.begin("a1", T0, "schedule", false);
    runs.update("a1", T0, { status: "waiting" });
    expect(ended).toEqual([]);
    runs.update("a1", T0, { status: "sent" });
    expect(ended).toEqual(["sent"]);
  });
});

describe("the owner's directory of limits", () => {
  const kv = () => {
    const map = new Map<string, unknown>();
    return {
      get: <T>(key: string) => map.get(key) as T | undefined,
      put: (key: string, value: unknown) => void map.set(key, value),
      delete: (key: string) => map.delete(key),
    };
  };

  it("keeps rules for all agents, checked", () => {
    const limits = new LimitsDirectory(memorySql(), kv());
    expect(limits.setRules([{ id: "x", kind: "nope" }])).toHaveProperty("error");
    expect(limits.setRules([rule({ kind: "callsPerDay", value: 3 })])).toHaveLength(1);
    expect(limits.rules()).toMatchObject([{ kind: "callsPerDay", value: 3 }]);
  });

  it("counts the calls that ran since a time, in every chat", () => {
    let now = T0;
    const limits = new LimitsDirectory(memorySql(), kv(), () => now);
    limits.log({ chatId: "c1", actor: "@deals", agentId: "a1", server: "crm", tool: "update_deal", outcome: "ran" });
    limits.log({ chatId: "c2", actor: "pi", server: "crm", tool: "update_deal", outcome: "warned" });
    limits.log({ chatId: "c2", actor: "pi", server: "crm", tool: "update_deal", outcome: "refused" });
    now += 1_000;
    expect(limits.callsSince("crm", "update_deal", T0)).toBe(2);
    expect(limits.callsSince("crm", "update_deal", T0 + 1)).toBe(0);
    // By the agent's id: a renamed agent keeps its calls.
    expect(limits.calls("a1")).toMatchObject([{ actor: "@deals", outcome: "ran" }]);
  });

  it("keeps what waits, and drops what its chat never said expired, naming it", () => {
    let now = T0;
    const limits = new LimitsDirectory(memorySql(), kv(), () => now);
    const item = {
      id: "b".repeat(16),
      chatId: "c1",
      kind: "approval",
      actor: { name: "pi" },
      server: "crm",
      tool: "t",
      input: {},
      why: "",
      createdAt: T0,
      expiresAt: T0 + 10,
      status: "pending",
    } as const;
    limits.addNeedsYou(item);
    expect(limits.dropExpired()).toEqual([]);
    now += 11;
    // Dropped, they are named, so the feed's items for them wait no more either (UserDirectory).
    expect(limits.dropExpired()).toEqual([{ chatId: "c1", id: "b".repeat(16) }]);
    expect(limits.dropExpired()).toEqual([]);
    // One its chat said ended is gone too.
    limits.addNeedsYou({ ...item, expiresAt: now + 10 });
    expect(limits.removeNeedsYou("c1", item.id)).toBe(true);
    now += 11;
    expect(limits.dropExpired()).toEqual([]);
  });
});

describe("telling through an outside tool", () => {
  const telling = { to: ["ana@example.com", "bo@example.com"], text: "The report.", subject: "@brief, daily" };

  it("puts the recipients and the text in the fields the tool's schema has for them", () => {
    const schema = {
      type: "object",
      properties: { to: { type: "array" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "body"],
    };
    expect(toolInput(schema, telling)).toEqual({ to: ["ana@example.com", "bo@example.com"], subject: "@brief, daily", body: "The report." });
    expect(toolInput({ properties: { channel: { type: "string" }, text: { type: "string" } } }, telling)).toEqual({
      channel: "ana@example.com, bo@example.com",
      text: "The report.",
    });
  });

  it("says what it cannot fill rather than guess", () => {
    expect(toolInput({ properties: { a: {}, b: {} } }, telling)).toHaveProperty("error", expect.stringMatching(/a, b/));
    expect(toolInput({ properties: { to: {}, text: {}, priority: {} }, required: ["priority"] }, telling)).toHaveProperty(
      "error",
      expect.stringMatching(/priority/),
    );
  });
});

describe("agent drafts", () => {
  it("offer no limits to the model, and say the owner sets them", async () => {
    const { agentsExtension } = await import("../worker/agents/tools.ts");
    const tool = agentsExtension({ proposeAgent: async () => ({ id: "a".repeat(16), name: "deals", version: 1 }) as never }).tools![0];
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    for (const field of ["autonomy", "guardrails", "approvalHours"]) expect(properties).not.toHaveProperty(field);
    const result = await (tool.execute as unknown as (args: object) => Promise<{ output: { text: string }[] }>)({ name: "deals" });
    expect(result.output[0].text).toMatch(/Limits tab/);
  });
});
