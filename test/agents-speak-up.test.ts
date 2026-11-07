import { createAssistantMessageEventStream, type AssistantMessage, type Models, type Usage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { describe, expect, it } from "vitest";
import { agentRouterOn, AgentSettingsError, budgetNotice, chatAllowsServer, checkAgentSettings, MIN_DAILY_TOKENS } from "../shared/agent-settings.ts";
import { CHAT_AGENT_KIND, type AgentDefinition } from "../shared/agents.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import {
  agoText,
  answered,
  cosine,
  embedder,
  gateRefusal,
  INTEREST_THRESHOLD,
  isPass,
  lateRefusal,
  looksLikeAsk,
  MAX_UNPROMPTED_PER_DAY,
  recentText,
  UNPROMPTED_COOLDOWN_MS,
  unpromptedInput,
  type GateState,
} from "../worker/agents/funnel.ts";
import {
  agentRouterModel,
  MAX_ROUTED,
  NO_AGENT,
  piPicks,
  routableAgents,
  routeAgents,
  routesAgents,
  ROUTE_THRESHOLD,
  selectAgents,
} from "../worker/agents/router.ts";
import { routeHistory } from "../worker/agent/route.ts";
import { ChatRoster } from "../worker/agents/roster.ts";
import { SpeakUp, type FunnelEvent, type SpeakUpHost } from "../worker/agents/speak-up.ts";
import { ChatSpend, type Spent } from "../worker/agents/spend.ts";
import { memoryKv, memorySql } from "./fakes.ts";

const T0 = Date.parse("2026-11-07T10:00:00Z");
const OWNER = "olga";

let nextId = 1;
const message = (uid: string, text: string, sentAt = T0): EntryRecord =>
  ({ id: nextId++, conversationId: 0, kind: CHAT_MESSAGE_KIND, data: { uid, name: uid, text, sentAt } }) as unknown as EntryRecord;
const agentReply = (name: string, text: string): EntryRecord =>
  ({ id: nextId++, conversationId: 0, kind: CHAT_AGENT_KIND, data: { name, text } }) as unknown as EntryRecord;
const piSays = (text: string): EntryRecord =>
  ({
    id: nextId++,
    conversationId: 0,
    kind: "pi.assistant",
    model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
  }) as unknown as EntryRecord;

describe("the agent router", () => {
  const agents = [
    { id: "id-research", name: "research", job: "Finds sources." },
    { id: "id-builder", name: "builder", job: "Builds pages." },
    { id: "id-ops", name: "ops", job: "Watches the servers." },
  ];

  it("keeps the agents at least as likely as the threshold, best first, at most two, by id", () => {
    expect(
      selectAgents(
        [
          ["research", 0.41],
          ["builder", 0.45],
          [NO_AGENT, 0.14],
        ],
        agents,
      ),
    ).toEqual(["id-builder", "id-research"]);
    expect(
      selectAgents(
        [
          ["research", 0.5],
          ["builder", 0.5],
          ["ops", 0.5],
        ],
        agents,
      ),
    ).toHaveLength(MAX_ROUTED);
  });

  it("picks none for an unsure answer, for nobody, and for names outside the roster or numbers that are not", () => {
    expect(selectAgents([["research", ROUTE_THRESHOLD - 0.01]], agents)).toEqual([]);
    expect(selectAgents([[NO_AGENT, 0.9]], agents)).toEqual([]);
    expect(selectAgents([["stranger", 0.9]], agents)).toEqual([]);
    expect(selectAgents([["research", Number.NaN]], agents)).toEqual([]);
  });

  it("asks one choice question with the agents' names and nobody, and reads the pick from its probabilities", async () => {
    const runs: { model: string; input: Record<string, unknown> }[] = [];
    const ai = {
      run: async (model: string, input: object) => {
        runs.push({ model, input: input as Record<string, unknown> });
        return {
          state: "Completed",
          result: {
            answers: {
              agent: { type: "choice", choice: "builder", confidence: 0.8, probabilities: { builder: 0.8, [NO_AGENT]: 0.1, research: 0.1 } },
            },
            usage: { input_tokens: 500, output_tokens: 1 },
          },
        };
      },
    };
    const model = agentRouterModel("typesafe/jev")!;
    const pick = await routeAgents(
      ai,
      model,
      { message: "make me a page of the totals", history: [], agents, piAnswers: true },
      AbortSignal.timeout(1_000),
    );
    expect(pick.agents).toEqual(["id-builder"]);
    expect(pick.usage.input).toBe(500);
    const questions = (runs[0].input as { questions: Record<string, { type: string; criteria: Record<string, string> }> }).questions;
    expect(questions.agent.type).toBe("choice");
    expect(Object.keys(questions.agent.criteria).sort()).toEqual([NO_AGENT, "builder", "ops", "research"].sort());
  });

  it("throws for a failed call or an answer with no choice, which the chat takes as no pick", async () => {
    const model = agentRouterModel("typesafe/jev")!;
    const request = { message: "hi", history: [], agents, piAnswers: false };
    const failing = { run: async () => Promise.reject(new Error("402 Insufficient balance")) };
    await expect(routeAgents(failing, model, request, AbortSignal.timeout(1_000))).rejects.toThrow();
    const odd = { run: async () => ({ state: "Completed", result: { answers: {}, usage: { input_tokens: 1, output_tokens: 1 } } }) };
    await expect(routeAgents(odd, model, request, AbortSignal.timeout(1_000))).rejects.toThrow();
  });

  it("picks only for a message that names nobody, where it may, and while the chat's budget has room", () => {
    const open = { routerOn: true, addressed: false, tagsPerson: false, anyOn: true, underBudget: true };
    expect(routesAgents(open)).toBe(true);
    expect(routesAgents({ ...open, routerOn: false })).toBe(false);
    expect(routesAgents({ ...open, addressed: true })).toBe(false);
    expect(routesAgents({ ...open, tagsPerson: true })).toBe(false);
    expect(routesAgents({ ...open, anyOn: false })).toBe(false);
    expect(routesAgents({ ...open, underBudget: false })).toBe(false);
  });

  it("picks a member's agent for someone else's message only when the member lets it speak unasked", async () => {
    const entry = (agentId: string, ownerUid: string, off = false) => ({ agentId, ownerUid, off });
    const roster = [entry("owners", OWNER), entry("anas", "ana"), entry("mias", "mia"), entry("off", OWNER, true)];
    const asked: string[] = [];
    const speaksUp = async (e: { agentId: string }) => (asked.push(e.agentId), e.agentId === "mias");
    // Mia writes: the owner's agent, her own, and none of Ana's, which Ana has not let speak unasked.
    expect((await routableAgents(roster, OWNER, "mia", speaksUp)).map((e) => e.agentId)).toEqual(["owners", "mias"]);
    expect(asked).toEqual(["anas"]);
    // Ana writes: her own agent may answer her; Mia's has speaking unasked on.
    expect((await routableAgents(roster, OWNER, "ana", speaksUp)).map((e) => e.agentId)).toEqual(["owners", "anas", "mias"]);
    // A definition that cannot be read leaves its agent out.
    expect((await routableAgents(roster, OWNER, OWNER, async () => Promise.reject(new Error("gone")))).map((e) => e.agentId)).toEqual(["owners"]);
  });

  it("lets pi pay for its picks only when it answers: not past the budget, nor for a message handed to agents", () => {
    expect(piPicks({ calling: true, underBudget: true, handedOn: false })).toBe(true);
    expect(piPicks({ calling: true, underBudget: false, handedOn: false })).toBe(false);
    expect(piPicks({ calling: true, underBudget: true, handedOn: true })).toBe(false);
    expect(piPicks({ calling: false, underBudget: true, handedOn: false })).toBe(false);
  });

  it("names no router for an empty or unknown model id", () => {
    expect(agentRouterModel("")).toBeUndefined();
    expect(agentRouterModel(undefined)).toBeUndefined();
  });

  it("reads the agents' replies as named answers in the history", () => {
    const history = routeHistory([agentReply("research", "Found three sources."), message("mia", "thanks")]);
    expect(history.some((turn) => turn.text.includes("@research: Found three sources."))).toBe(true);
  });
});

describe("the funnel's gates", () => {
  const open: GateState = { muted: false, off: false, busy: false, postsToday: 0, now: T0, budgetLeft: true };

  it("lets an agent past when every gate is open", () => {
    expect(gateRefusal(open)).toBeNull();
  });

  it("stops at the first closed gate, cheapest first", () => {
    expect(gateRefusal({ ...open, off: true, muted: true })).toBe("off");
    expect(gateRefusal({ ...open, muted: true, busy: true })).toBe("muted");
    expect(gateRefusal({ ...open, busy: true })).toBe("busy");
    expect(gateRefusal({ ...open, postsToday: MAX_UNPROMPTED_PER_DAY })).toBe("daily");
    expect(gateRefusal({ ...open, lastAt: T0 - UNPROMPTED_COOLDOWN_MS + 1 })).toBe("cooldown");
    expect(gateRefusal({ ...open, lastAt: T0 - UNPROMPTED_COOLDOWN_MS })).toBeNull();
    expect(gateRefusal({ ...open, budgetLeft: false })).toBe("budget");
  });

  it("then reads the owner's word: the agent is on, may speak up, and its owner's spend has room", () => {
    const agent = { enabled: true, speaksUp: true };
    expect(lateRefusal(agent, true)).toBeNull();
    expect(lateRefusal(null, true)).toBe("off");
    expect(lateRefusal({ ...agent, enabled: false }, true)).toBe("off");
    expect(lateRefusal({ ...agent, speaksUp: false }, false)).toBe("agent");
    expect(lateRefusal(agent, false)).toBe("spend");
  });
});

describe("the funnel's helpers", () => {
  it("takes PASS, with punctuation, emphasis and case around it, and nothing more", () => {
    for (const text of ["PASS", "pass", " **PASS** ", "`PASS`.", "> PASS!", '"Pass"']) expect(isPass(text)).toBe(true);
    for (const text of ["PASS: nothing to add", "I'd pass on this", "Passing it to @ops", ""]) expect(isPass(text)).toBe(false);
  });

  it("tells a question or a request from a remark", () => {
    for (const text of ["Who has the campaign list?", "can you send the totals", "Please pull last week's numbers", "totals?"])
      expect(looksLikeAsk(text)).toBe(true);
    for (const text of ["thanks!", "Lunch was great", "?", "ok"]) expect(looksLikeAsk(text)).toBe(false);
  });

  it("measures cosine similarity, and 0 for vectors that cannot be compared", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2);
    expect(cosine([], [])).toBe(0);
    expect(cosine([1, 2], [1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("reads the end of the conversation oldest first: people, agents and pi", () => {
    const newestFirst = [piSays("Here are the totals."), agentReply("research", "Two sources."), message("mia", "what are the totals?")];
    expect(recentText(newestFirst)).toBe("what are the totals?\n@research: Two sources.\nHere are the totals.");
  });

  it("tells a question answered by someone else, pi or an agent, but not by its asker alone", () => {
    expect(answered([message("mia", "anyone?")], "mia")).toBe(false);
    expect(answered([message("olga", "yes, here")], "mia")).toBe(true);
    expect(answered([piSays("Here.")], "mia")).toBe(true);
    expect(answered([agentReply("ops", "Done.")], "mia")).toBe(true);
  });

  it("says how long ago, and what a follow-up's turn reads", () => {
    expect(agoText(5 * 60_000)).toBe("5 minutes ago");
    expect(agoText(3 * 3_600_000)).toBe("3 hours ago");
    expect(agoText(26 * 3_600_000)).toBe("yesterday");
    expect(agoText(72 * 3_600_000)).toBe("3 days ago");
    expect(unpromptedInput("follow-up", "[Ana · person]: the list?\n(asked yesterday)")).toContain("Do not do the work yet");
    expect(unpromptedInput("speak-up", "[Ana · person]: hmm")).toContain("answer exactly PASS");
  });

  it("embeds through the AI binding, and throws for an answer without one vector per text", async () => {
    const good = embedder(
      {
        run: async () => ({
          data: [
            [1, 0],
            [0, 1],
          ],
        }),
      },
      "@cf/baai/bge-m3",
    )!;
    expect(await good.embed(["a", "b"], AbortSignal.timeout(1_000))).toEqual([
      [1, 0],
      [0, 1],
    ]);
    const bad = embedder({ run: async () => ({ data: [[1, 0]] }) }, "@cf/baai/bge-m3")!;
    await expect(bad.embed(["a", "b"], AbortSignal.timeout(1_000))).rejects.toThrow(/no embeddings/);
    expect(embedder({ run: async () => ({}) }, " ")).toBeUndefined();
  });
});

/** A definition of an agent that speaks up, as its owner's directory has it. */
function definition(name: string, over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: `id-${name}`,
    name,
    avatar: name.slice(0, 2),
    color: "blue",
    job: `${name} work`,
    instructions: `You are ${name}.`,
    autonomy: 1,
    origin: "user",
    enabled: true,
    speaksUp: true,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/**
 * A chat for SpeakUp: a real roster, definitions from a map, and an embedder that puts each text on an axis by the
 * first word it knows ("totals" near @finance, "pages" near @builder), so the test says which agent is close.
 */
function speakUpChat(names: readonly string[], over: Partial<{ speakUp: boolean; budgetLeft: boolean; spendLeft: boolean; embed: boolean }> = {}) {
  const sql = memorySql();
  const clock = { now: T0 };
  const roster = new ChatRoster(sql, () => clock.now);
  const definitions = new Map<string, AgentDefinition>();
  for (const name of names) {
    const agent = definition(name);
    definitions.set(agent.id, agent);
    roster.add({ agentId: agent.id, ownerUid: OWNER, name, session: `session-${name}`, avatar: agent.avatar, color: agent.color, job: agent.job });
  }
  const axes = ["totals", "pages", "weather"];
  const vector = (text: string) =>
    axes.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)).map((x, i, all) => (all.some(Boolean) ? x : i === 2 ? 1 : 0));
  const embedded: string[] = [];
  const events: FunnelEvent[] = [];
  const given: { agentId: string; request: Parameters<SpeakUpHost["give"]>[1] }[] = [];
  const host: SpeakUpHost = {
    roster,
    settings: () => ({ speakUp: over.speakUp ?? true }),
    definition: async (entry) => definitions.get(entry.agentId) ?? null,
    budgetLeft: () => over.budgetLeft ?? true,
    spendLeft: async () => over.spendLeft ?? true,
    embedder:
      over.embed === false
        ? undefined
        : {
            id: "fake",
            embed: async (texts) => {
              embedded.push(...texts);
              return texts.map(vector);
            },
          },
    give: (agentId, request) => {
      given.push({ agentId, request });
      roster.enqueue({ ...request, agentId, hop: 0 });
    },
    observe: (event) => events.push(event),
    now: () => clock.now,
  };
  return { roster, definitions, host, speakUp: new SpeakUp(host), events, given, clock, embedded };
}

describe("agents that speak up", () => {
  // @finance's job is about totals; @builder's about pages.
  const names = ["finance", "builder"];
  const jobs = (chat: ReturnType<typeof speakUpChat>) => {
    chat.definitions.set("id-finance", definition("finance", { job: "Reports the totals" }));
    chat.definitions.set("id-builder", definition("builder", { job: "Builds pages" }));
  };
  const talk = [message("mia", "what were last week's totals?")];

  it("gives the closest agent past the gates an unprompted turn, read-only and unattended", async () => {
    const chat = speakUpChat(names);
    jobs(chat);
    expect(await chat.speakUp.afterPause(talk, { line: "[mia · person]: what were last week's totals?", askKey: "m:mia:1" })).toBe("id-finance");
    expect(chat.given).toEqual([
      {
        agentId: "id-finance",
        request: {
          calledBy: { name: "the conversation", unprompted: "speak-up" },
          ask: "[mia · person]: what were last week's totals?",
          askKey: "m:mia:1",
          byOwner: false,
          unattended: true,
        },
      },
    ]);
    expect(new Map(chat.events.filter((event) => event.stage === "interest").map((event) => [event.agent, event.passed]))).toEqual(
      new Map([
        ["id-finance", true],
        ["id-builder", false],
      ]),
    );
    expect(chat.events.at(-1)).toMatchObject({ agent: "id-finance", stage: "turn", passed: true });
  });

  it("gives nobody a turn when no agent's job is close enough", async () => {
    const chat = speakUpChat(names);
    jobs(chat);
    expect(await chat.speakUp.afterPause([message("mia", "nice weather today")], { line: "x" })).toBeUndefined();
    expect(chat.given).toEqual([]);
    expect(chat.events.filter((event) => event.stage === "interest").every((event) => !event.passed && event.score! < INTEREST_THRESHOLD)).toBe(true);
  });

  it("stops at the gates before any model is asked: muted, its owner does not let it, its daily posts, the chat's budget", async () => {
    const chat = speakUpChat(names);
    jobs(chat);
    chat.roster.setMuted("id-finance", true);
    chat.definitions.set("id-builder", definition("builder", { speaksUp: false }));
    expect(await chat.speakUp.afterPause(talk, { line: "x" })).toBeUndefined();
    expect(chat.embedded).toEqual([]);
    expect(new Map(chat.events.map((event) => [event.agent, event.refusal]))).toEqual(
      new Map([
        ["id-finance", "muted"],
        ["id-builder", "agent"],
      ]),
    );

    const broke = speakUpChat(names, { budgetLeft: false });
    expect(await broke.speakUp.afterPause(talk, { line: "x" })).toBeUndefined();
    expect(broke.events.every((event) => event.refusal === "budget")).toBe(true);

    const capped = speakUpChat(names, { spendLeft: false });
    expect(await capped.speakUp.afterPause(talk, { line: "x" })).toBeUndefined();
    expect(capped.events.every((event) => event.refusal === "spend")).toBe(true);
  });

  it("lets a member's agent speak up only when the member lets it, and asks the member's spend, not the chat owner's", async () => {
    const chat = speakUpChat([]);
    const theirs = definition("finance", { job: "Reports the totals", speaksUp: false });
    chat.definitions.set(theirs.id, theirs);
    chat.roster.add({
      agentId: theirs.id,
      ownerUid: "ana",
      name: "finance-ana",
      session: "",
      avatar: theirs.avatar,
      color: theirs.color,
      job: theirs.job,
      seat: "seat",
    });
    const asked: string[] = [];
    chat.host.spendLeft = async (owner) => (asked.push(owner), true);
    expect(await chat.speakUp.afterPause(talk, { line: "x" })).toBeUndefined();
    expect(chat.events).toEqual([{ agent: theirs.id, stage: "gates", passed: false, refusal: "agent" }]);
    // Ana turns it on: it may speak up now, on her account.
    chat.definitions.set(theirs.id, { ...theirs, speaksUp: true });
    expect(await chat.speakUp.afterPause(talk, { line: "x" })).toBe(theirs.id);
    expect(asked).toEqual(["ana", "ana"]);
  });

  it("keeps to the cooldown and the posts a day per agent", async () => {
    const chat = speakUpChat(["finance"]);
    jobs(chat);
    expect(await chat.speakUp.afterPause(talk, { line: "x" })).toBe("id-finance");
    // Its turn waits: busy.
    expect(await chat.speakUp.afterPause(talk, { line: "x" })).toBeUndefined();
    expect(chat.events.at(-1)?.refusal).toBe("busy");
    for (let posted = 1; posted < MAX_UNPROMPTED_PER_DAY; posted++) {
      chat.roster.end(chat.roster.startNext("id-finance")!.id, "done");
      chat.clock.now += 1_000;
      expect(await chat.speakUp.afterPause(talk, { line: "x" })).toBeUndefined();
      expect(chat.events.at(-1)?.refusal).toBe("cooldown");
      chat.clock.now += UNPROMPTED_COOLDOWN_MS;
      expect(await chat.speakUp.afterPause(talk, { line: "x" })).toBe("id-finance");
    }
    chat.roster.end(chat.roster.startNext("id-finance")!.id, "done");
    chat.clock.now += UNPROMPTED_COOLDOWN_MS;
    expect(await chat.speakUp.afterPause(talk, { line: "x" })).toBeUndefined();
    expect(chat.events.at(-1)?.refusal).toBe("daily");
  });

  it("keeps to the cooldown across midnight (UTC), while the posts a day start again", async () => {
    const chat = speakUpChat(["finance"]);
    jobs(chat);
    chat.clock.now = Date.parse("2026-11-07T23:55:00Z");
    expect(await chat.speakUp.afterPause(talk, { line: "x" })).toBe("id-finance");
    chat.roster.end(chat.roster.startNext("id-finance")!.id, "done");
    chat.clock.now = Date.parse("2026-11-08T00:05:00Z");
    expect(await chat.speakUp.afterPause(talk, { line: "x" })).toBeUndefined();
    expect(chat.events.at(-1)?.refusal).toBe("cooldown");
    expect(chat.roster.unpromptedSince("id-finance", Date.parse("2026-11-08T00:00:00Z")).count).toBe(0);
  });

  it("is not possible where the chat does not allow it, or the deployment has no embeddings model", async () => {
    expect(speakUpChat(names, { speakUp: false }).speakUp.possible()).toBe(false);
    const none = speakUpChat(names, { embed: false });
    expect(none.speakUp.possible()).toBe(false);
    expect(none.speakUp.available()).toBe(false);
    expect(await none.speakUp.afterPause(talk, { line: "x" })).toBeUndefined();
    expect(speakUpChat([]).speakUp.possible()).toBe(false);
  });

  it("offers to pick up a question nobody answered, naming who asked and when", async () => {
    const chat = speakUpChat(names);
    jobs(chat);
    chat.clock.now = T0 + 26 * 3_600_000;
    const ask = { text: "can someone send the totals?", name: "Ana", uid: "ana", sentAt: T0, askKey: "m:ana:1" };
    expect(await chat.speakUp.followUp(ask)).toBe("id-finance");
    expect(chat.given[0].request).toMatchObject({
      calledBy: { name: "Ana", uid: "ana", unprompted: "follow-up" },
      askKey: "m:ana:1",
      byOwner: false,
      unattended: true,
    });
    expect(chat.given[0].request.ask).toContain("can someone send the totals?");
    expect(chat.given[0].request.ask).toContain("(asked yesterday)");
  });

  it("embeds an agent's profile once per version of its definition", async () => {
    const chat = speakUpChat(["finance"]);
    jobs(chat);
    await chat.speakUp.afterPause(talk, { line: "x" });
    chat.roster.stopAll();
    chat.clock.now += UNPROMPTED_COOLDOWN_MS;
    await chat.speakUp.afterPause(talk, { line: "x" });
    expect(chat.embedded.filter((text) => text.startsWith("finance:"))).toHaveLength(1);
    chat.definitions.set("id-finance", definition("finance", { job: "Reports the totals", version: 2 }));
    chat.roster.stopAll();
    chat.clock.now += UNPROMPTED_COOLDOWN_MS;
    await chat.speakUp.afterPause(talk, { line: "x" });
    expect(chat.embedded.filter((text) => text.startsWith("finance:"))).toHaveLength(2);
  });
});

const usage = (totalTokens: number, total: number): Usage => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

/** Models whose every answer is `answer`, recording the options each call was sent with. */
function fakeModels(answer: () => AssistantMessage) {
  const sent: { metadata?: Record<string, unknown>; sessionId?: string }[] = [];
  const models = {
    streamSimple: (_model: unknown, _context: unknown, options?: { metadata?: Record<string, unknown>; sessionId?: string }) => {
      sent.push(options ?? {});
      const stream = createAssistantMessageEventStream();
      const message = answer();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  } as unknown as Models;
  return { models, sent };
}

const assistant = (tokens: number, cost: number, toolCalls = 0): AssistantMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: "ok" },
    ...Array.from({ length: toolCalls }, (_, i) => ({ type: "toolCall" as const, id: `c${i}`, name: "t", arguments: {} })),
  ],
  api: "openai-completions",
  provider: "test",
  model: "m",
  usage: usage(tokens, cost),
  stopReason: "stop",
  timestamp: T0,
});

const MODEL = { api: "openai-completions", provider: "test", id: "m" } as never;

describe("a chat's spend meter", () => {
  function meter(budget?: number) {
    const kv = memoryKv();
    const clock = { now: T0 };
    const told: Spent[] = [];
    const spend = new ChatSpend({ kv, uid: OWNER, chatId: "c1", budget: () => budget, spent: (spent) => told.push(spent), now: () => clock.now });
    return { kv, clock, told, spend };
  }

  it("counts each answer's tokens and dollars for the day, and tells who it was for", async () => {
    const { spend, told } = meter();
    spend.tag("conv-a", { agent: "id-research" });
    spend.requested("conv-a", "provider-a");
    const { models, sent } = fakeModels(() => assistant(1_200, 0.01, 2));
    const metered = spend.models(models);
    await metered.streamSimple(MODEL, { messages: [] } as never, { sessionId: "provider-a" }).result();
    await metered.streamSimple(MODEL, { messages: [] } as never, {}).result();
    expect(spend.today()).toEqual({ tokens: 2_400, costUsd: 0.02 });
    expect(told).toEqual([
      { tokens: 1_200, costUsd: 0.01, toolCalls: 2, tags: { agent: "id-research" }, conversation: "conv-a" },
      { tokens: 1_200, costUsd: 0.01, toolCalls: 2, tags: { agent: "pi" } },
    ]);
    // AI Gateway's metadata: who, which chat, and which agent and run.
    expect(sent[0].metadata).toEqual({ uid: OWNER, chat: "c1", agent: "id-research" });
    expect(sent[1].metadata).toEqual({ uid: OWNER, chat: "c1", agent: "pi" });
  });

  it("tags a run's requests with the run", () => {
    const { spend } = meter();
    spend.tag("conv-run", { agent: "id-ops", run: "id-ops:123" });
    spend.requested("conv-run", "provider-run");
    expect(spend.metadata("provider-run")).toEqual({ uid: OWNER, chat: "c1", agent: "id-ops", run: "id-ops:123" });
    expect(spend.metadata(undefined)).toEqual({ uid: OWNER, chat: "c1", agent: "pi" });
  });

  it("stops calls once the daily budget is used up, with the budget's notice, and starts again the next day", async () => {
    const { spend, clock } = meter(MIN_DAILY_TOKENS);
    const { models, sent } = fakeModels(() => assistant(MIN_DAILY_TOKENS, 0.1));
    const metered = spend.models(models);
    expect(spend.refusal()).toBeUndefined();
    await metered.streamSimple(MODEL, { messages: [] } as never).result();
    expect(spend.refusal()).toBeDefined();
    expect(spend.refusal()).toBe(budgetNotice(MIN_DAILY_TOKENS));
    const refused = await metered.streamSimple(MODEL, { messages: [] } as never).result();
    expect(refused).toMatchObject({ stopReason: "error", errorMessage: budgetNotice(MIN_DAILY_TOKENS) });
    // Not sent: the provider saw only the first call.
    expect(sent).toHaveLength(1);
    clock.now += 86_400_000;
    expect(spend.refusal()).toBeUndefined();
    await metered.streamSimple(MODEL, { messages: [] } as never).result();
    expect(sent).toHaveLength(2);
  });

  it("counts a turn another object ran for the chat in its day, without telling it as an answer of its own", () => {
    const { spend, told } = meter(1_000);
    spend.count({ tokens: 1_200, costUsd: 0.02 });
    expect(spend.today()).toEqual({ tokens: 1_200, costUsd: 0.02 });
    expect(told).toEqual([]);
    expect(spend.refusal()).toBeDefined();
    spend.count({ tokens: -5, costUsd: 0 });
    expect(spend.today().tokens).toBe(1_200);
  });

  it("never stops without a budget, and keeps only the newest days", async () => {
    const { spend, clock, kv } = meter();
    const { models } = fakeModels(() => assistant(50_000_000, 1));
    const metered = spend.models(models);
    for (let day = 0; day < 6; day++) {
      await metered.streamSimple(MODEL, { messages: [] } as never).result();
      expect(spend.refusal()).toBeUndefined();
      clock.now += 86_400_000;
    }
    expect([...kv.map.keys()].filter((key) => key.startsWith("spend:")).length).toBeLessThanOrEqual(3);
  });

  it("does not word the budget's notice as a passing failure pi-ai would retry", () => {
    const refused = { ...assistant(0, 0), stopReason: "error" as const, errorMessage: budgetNotice(10_000) };
    expect(isRetryableAssistantError(refused)).toBe(false);
  });
});

describe("a chat's agent settings", () => {
  it("replaces the fields given, clears those set to null, and keeps the rest", () => {
    const current = { router: true, speakUp: true, dailyTokens: 50_000 };
    expect(checkAgentSettings({ speakUp: null, servers: [" crm ", "crm", "docs"] }, current)).toEqual({
      router: true,
      dailyTokens: 50_000,
      servers: ["crm", "docs"],
    });
    expect(checkAgentSettings({ dailyTokens: null }, current)).toEqual({ router: true, speakUp: true });
  });

  it("refuses what is not a setting's value", () => {
    expect(() => checkAgentSettings("on", {})).toThrow(AgentSettingsError);
    expect(() => checkAgentSettings({ router: "yes" }, {})).toThrow(AgentSettingsError);
    expect(() => checkAgentSettings({ dailyTokens: MIN_DAILY_TOKENS - 1 }, {})).toThrow(AgentSettingsError);
    expect(() => checkAgentSettings({ dailyTokens: 12_345.5 }, {})).toThrow(AgentSettingsError);
    expect(() => checkAgentSettings({ servers: [""] }, {})).toThrow(AgentSettingsError);
  });

  it("routes by default only in a private chat, and allows every server until the chat names some", () => {
    expect(agentRouterOn({}, "private")).toBe(true);
    expect(agentRouterOn({}, "group")).toBe(false);
    expect(agentRouterOn({ router: true }, "group")).toBe(true);
    expect(agentRouterOn({ router: false }, "private")).toBe(false);
    expect(chatAllowsServer({}, "crm")).toBe(true);
    expect(chatAllowsServer({ servers: ["docs"] }, "crm")).toBe(false);
  });
});
