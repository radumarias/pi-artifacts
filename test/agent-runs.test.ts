import { describe, expect, it } from "vitest";
import type { AgentDefinition, AgentStep, LookStep, StepInput } from "../shared/agents.ts";
import type { Value } from "../shared/conditions.ts";
import type { ArtifactMeta } from "../shared/protocol.ts";
import type { RunDelivery } from "../shared/runs.ts";
import { fillInput, itemKey, itemsOf, reportOf, SignInNeeded, type DeliveryRequest, type WorkResult } from "../worker/agents/runs/executor.ts";
import { publishedAlready, publishFindings, publishRebuilt, readOnlyDeclaration, runMark } from "../worker/agents/runs/page.ts";
import { findingsEdit, FINDINGS_END, FINDINGS_START, reportHtml, workSpend } from "../worker/agents/runs/report.ts";
import { AgentRunner, type RunAlarm, type RunnerHost, type WatchAlarm } from "../worker/agents/runs/runner.ts";
import { sourceName, SourceCore, type Subscriber } from "../worker/agents/runs/source.ts";
import { AgentRuns } from "../worker/agents/runs/store.ts";
import { writeDraft, type PublishScope } from "../worker/agent/publish.ts";
import type { CheckReport } from "../worker/artifacts/check.ts";
import type { McpHub } from "../worker/mcp/hub.ts";
import { MAX_VERSION_MESSAGE, type ArtifactStore } from "../worker/storage/artifacts.ts";
import { ChatDrafts } from "../worker/storage/drafts.ts";
import { FakeBucket, memorySql } from "./fakes.ts";

// Wednesday 4 November 2026, 06:00 in Bucharest (UTC+2).
const T0 = Date.parse("2026-11-04T04:00:00Z");
const SEVEN = Date.parse("2026-11-04T05:00:00Z");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const sales: LookStep = { kind: "look", server: "crm", tool: "weekly_sales", input: {}, as: "sales" };

function agent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "a1b2c3d4e5f60718",
    name: "brief",
    avatar: "br",
    color: "blue",
    job: "Morning brief",
    instructions: "Report the week's sales.",
    autonomy: 1,
    origin: "user",
    enabled: true,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    trigger: { kind: "schedule", at: "07:00", tz: "Europe/Bucharest" },
    workflow: [sales, { kind: "work", prompt: "Say how the week went." }, { kind: "tell", to: ["owner"], via: "chat" }],
    ...over,
  };
}

/** The chat object a runner runs in: real run tables over SQLite, reads and model answers from maps, every call recorded. */
class FakeHome implements RunnerHost {
  readonly clock = { now: T0 };
  readonly sql = memorySql();
  readonly runs = new AgentRuns(this.sql, () => this.clock.now);
  readonly definitions = new Map<string, AgentDefinition>();
  readonly values = new Map<string, Value | ((input: StepInput) => Value)>([["crm.weekly_sales", { total: 940, lastYear: 1000 }]]);
  readonly reads: { call: string; input: StepInput }[] = [];
  readonly signIn = new Set<string>();
  readonly writes = new Map<string, { session: string; text: string }>();
  readonly works: { session: string; prompt: string; operationId: string }[] = [];
  /** pi's operations: one placed twice is one, and answers once. */
  readonly operations = new Map<string, Promise<WorkResult>>();
  answer: (prompt: string) => WorkResult | Promise<WorkResult> = () => ({ status: "done", text: "Sales fell 6% against last year.", cost: 0.01, model: "test/model" });
  readonly delivered: DeliveryRequest[] = [];
  readonly alarms = new Map<string, { at?: number; every?: number; payload: RunAlarm | WatchAlarm }>();
  readonly subscribed: { agentId: string; step: LookStep; everyMinutes: number }[] = [];
  readonly unsubscribed: string[] = [];
  readonly left: string[] = [];
  shared = false;
  readonly pending: Promise<unknown>[] = [];
  #sessions = 0;
  #alarmIds = 0;
  concurrent = 0;
  mostConcurrent = 0;

  async read(server: string, tool: string, input: StepInput): Promise<Value> {
    this.reads.push({ call: `${server}.${tool}`, input });
    if (this.signIn.has(server)) throw new SignInNeeded(server);
    const value = this.values.get(`${server}.${tool}`);
    if (value === undefined) throw new Error(`${server} has no tool "${tool}".`);
    return typeof value === "function" ? value(input) : value;
  }
  async needsSignIn(servers: readonly string[]) {
    return servers.filter((server) => this.signIn.has(server));
  }
  /** The servers that sign in each user that the owner has signed in to. */
  readonly oauth: string[] = [];
  async signInServers() {
    return this.oauth;
  }
  readonly asked: string[] = [];
  /** Asked for a test run: recorded as waiting, nobody told. */
  readonly askedQuietly: string[] = [];
  signInNeeded(_agent: AgentDefinition, servers: readonly string[], quiet: boolean) {
    (quiet ? this.askedQuietly : this.asked).push(...servers);
  }
  async newSession() {
    return `session-${++this.#sessions}`;
  }
  async configure() {}
  async write(session: string, text: string, requestId: string) {
    if (!this.writes.has(requestId)) this.writes.set(requestId, { session, text });
  }
  work(session: string, prompt: string, operationId: string): Promise<WorkResult> {
    let found = this.operations.get(operationId);
    if (!found) {
      this.works.push({ session, prompt, operationId });
      found = (async () => {
        this.mostConcurrent = Math.max(this.mostConcurrent, ++this.concurrent);
        await tick();
        try {
          return await this.answer(prompt);
        } finally {
          this.concurrent--;
        }
      })();
      this.operations.set(operationId, found);
    }
    return found;
  }
  async deliver(request: DeliveryRequest): Promise<RunDelivery> {
    this.delivered.push(request);
    return { kind: "chat", to: request.step.kind === "tell" ? request.step.to.join(", ") : "", text: request.text, status: "sent" };
  }
  changed() {}
  async alarmAt(at: number, payload: RunAlarm) {
    const id = `alarm-${++this.#alarmIds}`;
    this.alarms.set(id, { at, payload });
    return id;
  }
  async alarmEvery(seconds: number, payload: WatchAlarm) {
    const id = `alarm-${++this.#alarmIds}`;
    this.alarms.set(id, { every: seconds, payload });
    return id;
  }
  async cancelAlarm(id: string) {
    this.alarms.delete(id);
  }
  async alarmTime(id: string) {
    const alarm = this.alarms.get(id);
    return alarm ? (alarm.at ?? this.clock.now + alarm.every! * 1000) : null;
  }
  async definition(agentId: string) {
    if (this.failDefinition) throw new Error("directory unreachable");
    return this.definitions.get(agentId) ?? null;
  }
  sharedWatch() {
    return this.shared;
  }
  async subscribe(agentId: string, step: LookStep, everyMinutes: number) {
    this.subscribed.push({ agentId, step, everyMinutes });
  }
  async unsubscribe(agentId: string, source: string) {
    this.unsubscribed.push(agentId);
    this.left.push(source);
  }
  /** A definition read that fails, as at a deploy reset, while set. */
  failDefinition = false;
  waitUntil(promise: Promise<unknown>) {
    this.pending.push(promise);
  }
  async settled() {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }
}

function home(definition = agent()) {
  const host = new FakeHome();
  host.definitions.set(definition.id, definition);
  const runner = new AgentRunner(host, host.sql);
  return { host, runner, definition };
}

// The newest one-shot: a fired one stays in the fake's map, as the real Scheduler drops it only after its callback.
const runAlarm = (host: FakeHome) => [...host.alarms.values()].findLast((alarm) => alarm.at !== undefined)!;

describe("scheduled runs", () => {
  it("sets the next local time as a one-shot, and runs at it", async () => {
    const { host, runner, definition } = home();
    await runner.apply(definition.id, definition);
    expect(runAlarm(host)).toEqual({ at: SEVEN, payload: { agentId: definition.id, dueAt: SEVEN } });
    expect(runner.nextRun(definition.id)).toBe(SEVEN);
    host.clock.now = SEVEN;
    const end = await runner.fired({ agentId: definition.id, dueAt: SEVEN });
    expect(end).toEqual({ status: "sent", started: true });
    // The read went into the item's session before the work step; the report went out once.
    expect(host.reads.map((read) => read.call)).toEqual(["crm.weekly_sales"]);
    expect([...host.writes.values()][0].text).toContain('"total":940');
    expect(host.works).toHaveLength(1);
    expect(host.works[0].operationId).toBe(`run:${definition.id}:${SEVEN}::work:1`);
    expect(host.delivered.map((request) => request.text)).toEqual(["Sales fell 6% against last year."]);
    // Thursday's run is set: 07:00 again.
    expect(runAlarm(host).at).toBe(Date.parse("2026-11-05T05:00:00Z"));
    const [run] = host.runs.list(definition.id);
    expect(run).toMatchObject({ status: "sent", why: "schedule", cost: 0.01, items: { total: 1, acted: 1 }, summary: "Sales fell 6% against last year." });
  });

  it("sends once when the alarm fires twice, at once or later", async () => {
    const { host, runner, definition } = home();
    await runner.apply(definition.id, definition);
    host.clock.now = SEVEN;
    const alarm = { agentId: definition.id, dueAt: SEVEN };
    const [first, second] = await Promise.all([runner.fired(alarm), runner.fired(alarm)]);
    expect([first, second].filter((end) => end?.started)).toHaveLength(1);
    expect(await runner.fired(alarm)).toBeNull();
    // Even the executor, asked directly for the same due time, finds the run ended.
    expect(await runner.executor.start({ agent: definition, dueAt: SEVEN, why: "schedule" })).toEqual({ status: "sent", started: false });
    expect(host.works).toHaveLength(1);
    expect(host.delivered).toHaveLength(1);
    // One alarm ahead: the next run (no retry left over from the second fire).
    expect([...host.alarms.values()].filter((alarm) => alarm.at! > SEVEN)).toHaveLength(1);
  });

  it("makes no model call when a condition does not hold", async () => {
    const workflow: AgentStep[] = [sales, { kind: "onlyIf", condition: "sales.total vs sales.lastYear < -10%" }, ...agent().workflow!.slice(1)];
    const { host, runner, definition } = home(agent({ workflow }));
    await runner.apply(definition.id, definition);
    host.clock.now = SEVEN;
    expect(await runner.fired({ agentId: definition.id, dueAt: SEVEN })).toEqual({ status: "not_today", started: true });
    expect(host.works).toHaveLength(0);
    expect(host.delivered).toHaveLength(0);
    const [run] = host.runs.list(definition.id);
    expect(run).toMatchObject({ status: "not_today", cost: 0, items: { total: 1, notToday: 1 } });
    expect(run.summary).toContain("did not hold");
    const [item] = host.runs.items(definition.id, SEVEN);
    expect(item.steps.map((step) => [step.kind, step.ok])).toEqual([
      ["look", true],
      ["onlyIf", false],
    ]);
  });

  it("goes the if's way, and fails an item whose condition cannot be read", async () => {
    const workflow: AgentStep[] = [
      sales,
      { kind: "if", condition: "sales.total > 900", then: [{ kind: "work", prompt: "Good week." }], else: [{ kind: "work", prompt: "Bad week." }] },
      { kind: "tell", to: ["owner"], via: "chat" },
    ];
    const { host, runner, definition } = home(agent({ workflow }));
    expect(await runner.now(definition.id, false)).toEqual({ dueAt: T0 });
    await host.settled();
    expect(host.works.map((work) => work.prompt.includes("Good week."))).toEqual([true]);
    host.definitions.set(definition.id, agent({ workflow: [sales, { kind: "onlyIf", condition: "sales.missing > 1" }] }));
    host.clock.now = T0 + 1;
    await runner.now(definition.id, false);
    await host.settled();
    const [failed] = host.runs.list(definition.id);
    expect(failed.status).toBe("failed");
    expect(failed.summary).toContain("sales.missing is missing");
  });

  it("runs each item of a scope in its own session, a few at a time, and reports them in one", async () => {
    const regions = ["North", "South", "East", "West", "Islands", "Hills"].map((name, i) => ({ id: `r${i}`, name, change: i % 2 ? -0.08 : 0.02 }));
    const workflow: AgentStep[] = [
      { kind: "look", server: "crm", tool: "region", input: { region: "{{item.id}}" }, as: "region" },
      { kind: "onlyIf", condition: "region.change < -5%" },
      { kind: "work", prompt: "Why is it down?" },
      { kind: "tell", to: ["owner"], via: "chat" },
    ];
    const { host, runner, definition } = home(agent({ workflow, scope: { list: { kind: "look", server: "crm", tool: "regions", input: {} }, each: true } }));
    host.values.set("crm.regions", { items: regions });
    host.values.set("crm.region", (input) => regions.find((region) => region.id === input.region)!);
    host.answer = (prompt) => ({ status: "done", text: `Down in ${/for (\w+)/.exec(prompt)![1]}.`, cost: 0.02 });
    await runner.now(definition.id, false);
    await host.settled();
    expect(host.reads.filter((read) => read.call === "crm.regions")).toHaveLength(1);
    expect(host.reads.filter((read) => read.call === "crm.region").map((read) => read.input)).toHaveLength(6);
    expect(new Set(host.works.map((work) => work.session)).size).toBe(3);
    expect(host.mostConcurrent).toBeLessThanOrEqual(4);
    expect(host.delivered).toHaveLength(1);
    expect(host.delivered[0].text).toBe("**South**\nDown in South.\n\n**West**\nDown in West.\n\n**Hills**\nDown in Hills.");
    const [run] = host.runs.list(definition.id);
    expect(run).toMatchObject({ status: "sent", items: { total: 6, acted: 3, notToday: 3 } });
    expect(run.cost).toBeCloseTo(0.06);
  });

  it("waits for a sign-in, with no model call, and goes when it comes", async () => {
    const { host, runner, definition } = home();
    host.signIn.add("crm");
    await runner.apply(definition.id, definition);
    host.clock.now = SEVEN;
    expect(await runner.fired({ agentId: definition.id, dueAt: SEVEN })).toEqual({ status: "needs_sign_in", started: true });
    expect(host.works).toHaveLength(0);
    expect(host.runs.list(definition.id)[0]).toMatchObject({ status: "needs_sign_in", needsSignIn: ["crm"] });
    expect(host.asked).toEqual(["crm"]);
    // Another alarm for it does not run it again; the sign-in does.
    expect(await runner.executor.start({ agent: definition, dueAt: SEVEN, why: "schedule" })).toMatchObject({ started: false });
    expect(await runner.signedIn("other")).toBe(0);
    host.signIn.delete("crm");
    expect(await runner.signedIn("crm")).toBe(1);
    await host.settled();
    expect(host.runs.list(definition.id)[0]).toMatchObject({ status: "sent" });
    expect(host.delivered).toHaveLength(1);
  });

  it("waits for a sign-in to a server only its work step's tools can come from", async () => {
    // No step reads calendar, but the work step may use its tools: its sign-in is checked before the run.
    const { host, runner, definition } = home(agent({ servers: ["crm", "calendar"] }));
    host.oauth.push("calendar", "mail");
    host.signIn.add("calendar").add("mail");
    await runner.now(definition.id, false);
    await host.settled();
    expect(host.works).toHaveLength(0);
    expect(host.runs.list(definition.id)[0]).toMatchObject({ status: "needs_sign_in", needsSignIn: ["calendar"] });
    // Without a work step, only the servers its steps read.
    const reads = home(agent({ servers: ["crm", "calendar"], workflow: [sales, { kind: "tell", to: ["owner"], via: "chat" }] }));
    reads.host.oauth.push("calendar");
    reads.host.signIn.add("calendar");
    await reads.runner.now(reads.definition.id, false);
    await reads.host.settled();
    expect(reads.host.runs.list(reads.definition.id)[0]).toMatchObject({ status: "sent" });
  });

  it("skips a waiting run once a newer one went, when the sign-in comes late", async () => {
    const { host, runner, definition } = home();
    host.signIn.add("crm");
    await runner.now(definition.id, false);
    await host.settled();
    // The next day's run went (its read no longer needed the sign-in, say): the waiting one would post after it.
    host.signIn.delete("crm");
    host.clock.now = T0 + 86_400_000;
    await runner.now(definition.id, false);
    await host.settled();
    expect(await runner.signedIn("crm")).toBe(0);
    expect(host.runs.get(definition.id, T0)).toMatchObject({ status: "not_today", summary: "Skipped once you signed in: a newer run went since." });
    expect(host.delivered).toHaveLength(1);
  });

  it("finds a sign-in failure mid-run too", async () => {
    const { host, runner, definition } = home();
    host.values.set("crm.weekly_sales", () => {
      throw new SignInNeeded("crm");
    });
    await runner.now(definition.id, false);
    await host.settled();
    expect(host.runs.list(definition.id)[0]).toMatchObject({ status: "needs_sign_in", needsSignIn: ["crm"] });
  });

  it("records what a test would send, and sends nothing", async () => {
    const { host, runner, definition } = home(agent({ enabled: false }));
    expect(await runner.now(definition.id, false)).toEqual({ error: "@brief is off: turn it on first." });
    expect(await runner.now(definition.id, true)).toEqual({ dueAt: T0 });
    await host.settled();
    expect(host.works).toHaveLength(1);
    expect(host.delivered).toHaveLength(0);
    const [run] = host.runs.list(definition.id);
    expect(run).toMatchObject({ status: "sent", test: true, why: "test" });
    const detail = host.runs.get(definition.id, T0)!.detail;
    expect(detail.deliveries).toEqual([
      { kind: "chat", to: "owner", text: "Sales fell 6% against last year.", status: "recorded", detail: "a test: nothing was sent or changed" },
    ]);
  });

  it("restarts a test run waiting for a sign-in, with nobody told", async () => {
    const { host, runner, definition } = home();
    host.signIn.add("crm");
    await runner.now(definition.id, true);
    await host.settled();
    expect(host.runs.list(definition.id)[0]).toMatchObject({ status: "needs_sign_in", test: true });
    expect(host.asked).toEqual([]);
    expect(host.askedQuietly).toEqual(["crm"]);
    host.signIn.delete("crm");
    expect(await runner.signedIn("crm")).toBe(1);
    await host.settled();
    expect(host.runs.list(definition.id)[0]).toMatchObject({ status: "sent", test: true });
  });

    it("refuses writes and other people at Inform", async () => {
    const workflow: AgentStep[] = [{ kind: "do", server: "crm", tool: "update", input: {} }, { kind: "work", prompt: "Report." }];
    const { host, runner, definition } = home(agent({ workflow }));
    await runner.now(definition.id, false);
    await host.settled();
    const [item] = host.runs.items(definition.id, T0);
    expect(item.steps[0]).toMatchObject({ kind: "do", ok: false });
    expect(item.steps[0].detail).toContain("wait for approvals");
    expect(host.reads).toHaveLength(0);
  });

  it("goes on after a restart where its rows say, sending once", async () => {
    const { host, runner, definition } = home();
    // The work step never answers in the first object: it stopped there.
    host.answer = () => new Promise<WorkResult>(() => {});
    void runner.now(definition.id, false);
    await tick();
    await tick();
    expect(host.works).toHaveLength(1);
    expect(host.runs.list(definition.id)[0].status).toBe("running");
    // A new object over the same tables: pi answers the operation it had (by its id).
    const restarted = new FakeHome();
    Object.assign(restarted, { sql: host.sql });
    const runs = new AgentRuns(host.sql, () => restarted.clock.now);
    Object.defineProperty(restarted, "runs", { value: runs });
    restarted.definitions.set(definition.id, definition);
    const again = new AgentRunner(restarted, host.sql);
    again.resume();
    await restarted.settled();
    expect(restarted.works.map((work) => work.operationId)).toEqual([host.works[0].operationId]);
    expect(restarted.delivered).toHaveLength(1);
    expect(runs.list(definition.id)[0].status).toBe("sent");
    again.resume();
    await restarted.settled();
    expect(restarted.delivered).toHaveLength(1);
  });

  it("drops a stale alarm, and follows a definition turned off, changed or deleted", async () => {
    const { host, runner, definition } = home();
    await runner.apply(definition.id, definition);
    // Saved again with the same trigger: the alarm stays.
    await runner.apply(definition.id, { ...definition, version: 2, job: "Changed" });
    expect([...host.alarms.keys()]).toEqual(["alarm-1"]);
    // A new time: the old alarm goes, and its firing runs nothing.
    const later = agent({ version: 3, trigger: { kind: "schedule", at: "09:30", tz: "Europe/Bucharest" } });
    host.definitions.set(definition.id, later);
    await runner.apply(definition.id, later);
    expect([...host.alarms.values()].map((alarm) => alarm.at)).toEqual([Date.parse("2026-11-04T07:30:00Z")]);
    host.clock.now = SEVEN;
    expect(await runner.fired({ agentId: definition.id, dueAt: SEVEN })).toBeNull();
    expect(host.works).toHaveLength(0);
    // Off: no alarm. Deleted: none either.
    await runner.apply(definition.id, { ...later, enabled: false });
    expect(host.alarms.size).toBe(0);
    await runner.apply(definition.id, later);
    await runner.apply(definition.id, null);
    expect(host.alarms.size).toBe(0);
    expect(runner.nextRun(definition.id)).toBeNull();
  });

  it("tries a due time again when its definition cannot be read, and sets it again after a restart", async () => {
    const { host, runner, definition } = home();
    await runner.apply(definition.id, definition);
    host.clock.now = SEVEN;
    host.failDefinition = true;
    await expect(runner.fired({ agentId: definition.id, dueAt: SEVEN })).rejects.toThrow("directory unreachable");
    // The same time, five minutes on: the schedule did not stop.
    expect([...host.alarms.values()].at(-1)).toEqual({ at: SEVEN + 5 * 60_000, payload: { agentId: definition.id, dueAt: SEVEN } });
    host.failDefinition = false;
    expect(await runner.fired({ agentId: definition.id, dueAt: SEVEN })).toEqual({ status: "sent", started: true });
    expect(runner.nextRun(definition.id)).toBe(Date.parse("2026-11-05T05:00:00Z"));
    // The retry alarm went with the next run set: only that one is left for this agent.
    expect([...host.alarms.values()].filter((alarm) => alarm.payload.agentId === definition.id && alarm.at! > SEVEN)).toEqual([
      { at: Date.parse("2026-11-05T05:00:00Z"), payload: { agentId: definition.id, dueAt: Date.parse("2026-11-05T05:00:00Z") } },
    ]);
    // An object whose alarms went (no schedule row): reconcile sets them from the definition.
    const fresh = home(definition);
    await fresh.runner.reconcile(definition.id);
    expect(fresh.runner.nextRun(definition.id)).toBe(SEVEN);
  });

  it("sets the schedule again after a restart when the row's alarm is no longer set", async () => {
    const { host, runner, definition } = home();
    await runner.apply(definition.id, definition);
    // Its alarm ran (or went) and a reset came before the next was set: the stale row is still there.
    host.alarms.clear();
    host.clock.now = SEVEN + 60_000;
    await runner.reconcile(definition.id);
    expect(runner.nextRun(definition.id)).toBe(Date.parse("2026-11-05T05:00:00Z"));
    expect(host.alarms.size).toBe(1);
    // With its alarm set, reconcile leaves it.
    await runner.reconcile(definition.id);
    expect(host.alarms.size).toBe(1);
  });

  it("ignores a definition older than the one its alarm was set from", async () => {
    const { host, runner, definition } = home(agent({ version: 3 }));
    await runner.apply(definition.id, definition);
    await runner.apply(definition.id, agent({ version: 2, enabled: false }));
    expect(runner.nextRun(definition.id)).toBe(SEVEN);
    expect(host.alarms.size).toBe(1);
  });

  it("remembers the newest definition even when it kept the alarm", async () => {
    const { host, runner, definition } = home(agent({ version: 3 }));
    await runner.apply(definition.id, definition);
    // Version 4 changed only the instructions: the same alarm, but version 3 read late no longer turns it off.
    await runner.apply(definition.id, agent({ version: 4, instructions: "Report the month too." }));
    await runner.apply(definition.id, agent({ version: 3, enabled: false }));
    expect(runner.nextRun(definition.id)).toBe(SEVEN);
    expect(host.alarms.size).toBe(1);
  });

  it("restarts only the newest waiting run per agent once signed in, and none of an agent now off", async () => {
    const { host, runner, definition } = home();
    host.signIn.add("crm");
    for (const at of [T0, T0 + 1]) {
      host.clock.now = at;
      await runner.now(definition.id, false);
      await host.settled();
    }
    host.signIn.delete("crm");
    expect(await runner.signedIn("crm")).toBe(1);
    await host.settled();
    const [newest, older] = host.runs.list(definition.id);
    expect(newest).toMatchObject({ dueAt: T0 + 1, status: "sent" });
    expect(older).toMatchObject({ dueAt: T0, status: "not_today", summary: "Skipped once you signed in: a newer run went instead." });
    expect(host.delivered).toHaveLength(1);
    // Off by the time the sign-in comes: skipped.
    host.signIn.add("crm");
    host.clock.now = T0 + 2;
    await runner.now(definition.id, false);
    await host.settled();
    host.definitions.set(definition.id, { ...definition, enabled: false });
    host.signIn.delete("crm");
    expect(await runner.signedIn("crm")).toBe(0);
    expect(host.runs.get(definition.id, T0 + 2)).toMatchObject({ status: "not_today", summary: "Skipped once you signed in: @brief was off." });
  });

  it("fails a run whose items acted when its only delivery failed", async () => {
    const { host, runner, definition } = home();
    host.deliver = async () => {
      throw new Error("chat unreachable");
    };
    await runner.now(definition.id, false);
    await host.settled();
    expect(host.runs.list(definition.id)[0]).toMatchObject({ status: "failed", summary: "Failed: chat unreachable", items: { acted: 1 } });
  });

    it("reads only the agent's own servers", async () => {
    const { host, runner, definition } = home(agent({ servers: ["other"] }));
    await runner.now(definition.id, false);
    await host.settled();
    expect(host.reads).toHaveLength(0);
    expect(host.runs.list(definition.id)[0]).toMatchObject({ status: "failed" });
    expect(host.runs.list(definition.id)[0].summary).toContain("not one of the servers @brief may use");
  });

  it("sends a delivery an item reached before a later step stopped it, with the work done before it", async () => {
    const workflow: AgentStep[] = [
      sales,
      { kind: "work", prompt: "First." },
      { kind: "tell", to: ["owner"], via: "chat" },
      { kind: "work", prompt: "Second." },
      { kind: "onlyIf", condition: "sales.total > 5000" },
      { kind: "tell", to: ["owner"], via: "notify" },
    ];
    const { host, runner, definition } = home(agent({ workflow }));
    host.answer = (prompt) => ({ status: "done", text: prompt.includes("First.") ? "One." : "Two.", cost: 0 });
    await runner.now(definition.id, false);
    await host.settled();
    expect(host.delivered.map((request) => [request.step.kind === "tell" && request.step.via, request.text])).toEqual([["chat", "One."]]);
    expect(host.runs.list(definition.id)[0]).toMatchObject({ status: "sent" });
  });

  it("keeps a page rebuild's session in the run, for a run that goes on", async () => {
    const workflow: AgentStep[] = [sales, { kind: "work", prompt: "Say." }, { kind: "page", artifactId: "a1", edit: "rebuild" }];
    const { host, runner, definition } = home(agent({ workflow }));
    await runner.now(definition.id, false);
    await host.settled();
    const [request] = host.delivered;
    expect(request.session).toMatch(/^session-/);
    expect(host.runs.get(definition.id, T0)!.detail.sessions).toEqual({ [request.key]: request.session });
  });
});

describe("watches", () => {
  const watched = (when: string) =>
    agent({
      trigger: { kind: "watch", step: { kind: "look", server: "crm", tool: "signups", input: {}, as: "signups" }, everyMinutes: 60, when },
      workflow: [{ kind: "work", prompt: "Signups dropped: say by how much." }, { kind: "tell", to: ["owner"], via: "chat" }],
    });

  it("checks on an interval, and runs only when the value moved and the condition holds", async () => {
    const { host, runner, definition } = home(watched("signups.today vs signups.lastWeek < -5%"));
    await runner.apply(definition.id, definition);
    expect([...host.alarms.values()]).toEqual([{ every: 3600, payload: { agentId: definition.id } }]);
    host.values.set("crm.signups", { today: 100, lastWeek: 100 });
    expect(await runner.watchTick({ agentId: definition.id })).toBeNull();
    host.values.set("crm.signups", { today: 90, lastWeek: 100 });
    host.clock.now += 3_600_000;
    expect(await runner.watchTick({ agentId: definition.id })).toEqual({ status: "sent", started: true });
    // The same value again: nothing moved, nothing runs.
    host.clock.now += 3_600_000;
    expect(await runner.watchTick({ agentId: definition.id })).toBeNull();
    expect(host.works).toHaveLength(1);
    const [run] = host.runs.list(definition.id);
    expect(run.why).toBe("watch");
    // Its steps read the watch's value by its name.
    expect(host.runs.get(definition.id, run.dueAt)!.detail.watch).toEqual({ today: 90, lastWeek: 100 });
  });

  it("compares with the value before as previous", async () => {
    const { host, runner, definition } = home(watched("signups.count > previous.count"));
    await runner.moved(definition, { count: 3 });
    host.clock.now += 1;
    expect(await runner.moved(definition, { count: 2 })).toBeNull();
    host.clock.now += 1;
    expect(await runner.moved(definition, { count: 5 })).toMatchObject({ status: "sent" });
  });

  it("goes through a Source when everyone may share the read", async () => {
    const { host, runner, definition } = home(watched("signups.today < 50"));
    host.shared = true;
    await runner.apply(definition.id, definition);
    expect(host.alarms.size).toBe(0);
    expect(host.subscribed).toEqual([{ agentId: definition.id, step: (definition.trigger as { step: LookStep }).step, everyMinutes: 60 }]);
    const source = await sourceName((definition.trigger as { step: LookStep }).step);
    expect(await runner.sourceMoved(definition.id, { today: 40 }, source)).toMatchObject({ status: "sent" });
    await runner.apply(definition.id, null);
    expect(host.unsubscribed).toEqual([definition.id]);
    expect(host.left).toEqual([source]);
  });

  it("answers a Source once the run is stored, and rejects so the value comes again when it could not be", async () => {
    const { host, runner, definition } = home(watched("signups.today < 50"));
    host.shared = true;
    await runner.apply(definition.id, definition);
    const source = await sourceName((definition.trigger as { step: LookStep }).step);
    const begin = host.runs.begin.bind(host.runs);
    host.runs.begin = () => {
      throw new Error("storage reset");
    };
    await expect(runner.sourceMoved(definition.id, { today: 40 }, source, { detach: true })).rejects.toThrow("storage reset");
    host.runs.begin = begin;
    // The same value, told again: handled now, with the run going on after the answer.
    expect(await runner.sourceMoved(definition.id, { today: 40 }, source, { detach: true })).toBeNull();
    expect(host.runs.list(definition.id)[0]).toMatchObject({ why: "watch" });
    await host.settled();
    expect(host.runs.list(definition.id)[0]).toMatchObject({ status: "sent" });
  });

    it("leaves a Source it no longer watches through, and runs nothing for it", async () => {
    const { host, runner, definition } = home(watched("signups.today < 50"));
    host.shared = true;
    await runner.apply(definition.id, definition);
    expect(await runner.sourceMoved(definition.id, { today: 40 }, "an-old-read")).toBeNull();
    expect(host.left).toEqual(["an-old-read"]);
    // A server the agent may no longer use: the Source is left too.
    host.definitions.set(definition.id, { ...definition, servers: ["other"] });
    const source = await sourceName((definition.trigger as { step: LookStep }).step);
    expect(await runner.sourceMoved(definition.id, { today: 30 }, source)).toBeNull();
    expect(host.left).toEqual(["an-old-read", source]);
    expect(host.works).toHaveLength(0);
  });

  it("watches on its own interval once its Source's read is no longer shared", async () => {
    const { host, runner, definition } = home(watched("signups.today < 50"));
    host.shared = true;
    await runner.apply(definition.id, definition);
    expect(host.alarms.size).toBe(0);
    host.shared = false;
    const source = await sourceName((definition.trigger as { step: LookStep }).step);
    expect(await runner.sourceMoved(definition.id, { today: 40 }, source)).toBeNull();
    expect(host.left).toEqual([source]);
    expect(host.alarms.size).toBe(1);
  });

  it("gives the steps the value that fired the watch, and the one before", async () => {
    const { host, runner, definition } = home(watched("signups.count != previous.count"));
    await runner.moved(definition, { count: 3 });
    await host.settled();
    host.clock.now += 1;
    host.works.length = 0;
    host.writes.clear();
    const workflow: AgentStep[] = [{ kind: "onlyIf", condition: "watch.count > previous.count" }, ...definition.workflow!];
    expect(await runner.moved({ ...definition, workflow }, { count: 5 })).toMatchObject({ status: "sent" });
    // The value is in the item's session before its steps, and kept for a run that goes on.
    expect([...host.writes.values()].some((write) => write.text.includes('"count":5'))).toBe(true);
    const [run] = host.runs.list(definition.id);
    expect(host.runs.get(definition.id, run.dueAt)!.detail).toMatchObject({ watch: { count: 5 }, previous: { count: 3 } });
  });

  it("writes the value that fired a watch even with no work step, for a reply to its report to see", async () => {
    const { host, runner, definition } = home(watched("signups.today < 50"));
    const workflow: AgentStep[] = [{ kind: "tell", to: ["owner"], via: "chat" }];
    expect(await runner.moved({ ...definition, workflow }, { today: 40 })).toMatchObject({ status: "sent" });
    expect(host.works).toHaveLength(0);
    expect([...host.writes.values()].some((write) => write.text.includes('"today":40'))).toBe(true);
  });

    it("reads a watch named __proto__ like any other name", async () => {
    const step: LookStep = { kind: "look", server: "crm", tool: "signups", input: {}, as: "__proto__" };
    const { runner, definition } = home(
      agent({ trigger: { kind: "watch", step, everyMinutes: 60, when: "__proto__.count > 2" }, workflow: [{ kind: "work", prompt: "Say." }] }),
    );
    expect(await runner.moved(definition, { count: 3 })).toMatchObject({ status: "sent" });
  });
});

describe("Source", () => {
  function source() {
    const sql = memorySql();
    const host = {
      clock: T0,
      value: { price: 1 } as Value,
      reads: 0,
      alarms: [] as number[],
      told: [] as { subscriber: Subscriber; value: Value }[],
      read: async () => {
        host.reads++;
        return host.value;
      },
      failing: new Set<string>(),
      notify: async (subscriber: Subscriber, value: Value) => {
        if (host.failing.has(subscriber.uid)) throw new Error("unreachable");
        host.told.push({ subscriber, value });
      },
      setAlarm: (at: number) => void host.alarms.push(at),
      now: () => host.clock,
    };
    return { core: new SourceCore(sql, host), host };
  }
  const step = { server: "prices", tool: "quote", input: { symbol: "X" } };
  const ana = { uid: "ana", chatId: "c1", agentId: "a1" };
  const ben = { uid: "ben", chatId: "c2", agentId: "b1" };

  it("polls once for two subscribers, and tells them only when the value moves", async () => {
    const { core, host } = source();
    core.subscribe(step, ana, 60);
    core.subscribe(step, ben, 15);
    expect(await core.poll()).toEqual({ moved: true, told: 2 });
    expect(host.reads).toBe(1);
    expect(host.told.map((told) => told.subscriber.uid)).toEqual(["ana", "ben"]);
    // At the shortest interval asked for.
    expect(host.alarms.at(-1)).toBe(T0 + 15 * 60_000);
    expect(await core.poll()).toEqual({ moved: false, told: 0 });
    host.value = { price: 2 };
    expect(await core.poll()).toEqual({ moved: true, told: 2 });
    expect(host.reads).toBe(3);
    expect(core.unsubscribe(ana)).toBe(true);
    expect(core.unsubscribe(ben)).toBe(false);
    expect(await core.poll()).toEqual({ moved: false, told: 0 });
    expect(host.reads).toBe(3);
  });

  it("tells a new subscriber the value as it is now, and only it when the value did not move", async () => {
    const { core, host } = source();
    core.subscribe(step, ana, 60);
    expect(await core.poll()).toEqual({ moved: true, told: 1 });
    host.clock += 5 * 60_000;
    core.subscribe(step, ben, 60);
    // It polls now, not an interval away.
    expect(host.alarms.at(-1)).toBe(host.clock);
    expect(await core.poll()).toEqual({ moved: false, told: 1 });
    expect(host.told.map((told) => told.subscriber.uid)).toEqual(["ana", "ben"]);
    expect(await core.poll()).toEqual({ moved: false, told: 0 });
  });

  it("tells a subscriber it could not reach at the next poll, though the value did not move again", async () => {
    const { core, host } = source();
    core.subscribe(step, ana, 60);
    core.subscribe(step, ben, 60);
    host.failing.add("ben");
    expect(await core.poll()).toEqual({ moved: true, told: 1 });
    host.failing.clear();
    expect(await core.poll()).toEqual({ moved: false, told: 1 });
    expect(host.told.map((told) => told.subscriber.uid)).toEqual(["ana", "ben"]);
    expect(await core.poll()).toEqual({ moved: false, told: 0 });
  });
});

describe("run helpers", () => {
  it("fills inputs from earlier results, keeping a whole value's type", () => {
    const scope = { item: { id: "r1", name: "West" }, sales: { total: 940 } };
    expect(fillInput({ region: "{{item.id}}", min: "{{sales.total}}", label: "Region {{item.name}}", list: ["{{item.name}}"], n: 3 }, scope)).toEqual({
      region: "r1",
      min: 940,
      label: "Region West",
      list: ["West"],
      n: 3,
    });
  });

  it("finds a scope's items, their keys and names", () => {
    expect(itemsOf([1, 2])).toEqual([1, 2]);
    expect(itemsOf({ results: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(itemsOf({ total: 2, regions: ["a", "b"] })).toEqual(["a", "b"]);
    expect(itemsOf("nope")).toEqual([]);
    expect(itemKey({ id: 7, name: "West" }, 0)).toEqual({ key: "7", label: "West" });
    expect(itemKey({ title: "Q4" }, 2)).toEqual({ key: "#3", label: "Q4" });
    expect(itemKey("East", 0)).toEqual({ key: "East", label: "East" });
  });

  it("reports one item as it is, several under their names", () => {
    expect(reportOf([{ label: "", text: "All fine." }])).toBe("All fine.");
    expect(reportOf([{ label: "West", text: "Down." }, { label: "East" }])).toBe("**West**\nDown.\n\n**East**\n(nothing worked out)");
  });

  it("adds up what a work step cost from its session's answers", () => {
    const answer = (cost: number) => ({ kind: "pi.assistant", model: [{ role: "assistant", provider: "anthropic", model: "m", usage: { cost: { total: cost } } }] });
    expect(workSpend([answer(0.01), { kind: "pi.tool-result" }, answer(0.02)] as never)).toEqual({ cost: 0.03, model: "anthropic/m" });
  });

  it("writes a report into a page's findings block, escaped", () => {
    const html = `<main><h1>Brief</h1>${FINDINGS_START}<p>old</p>${FINDINGS_END}</main>`;
    const at = new Date(T0);
    const edit = findingsEdit(html, "**West** is down.\n\n- one <script>x</script>\n- two", at);
    expect("old" in edit && edit.old).toBe(`${FINDINGS_START}<p>old</p>${FINDINGS_END}`);
    const written = "new" in edit ? edit.new : "";
    expect(written).toContain("<strong>West</strong> is down.");
    expect(written).toContain("<li>one &lt;script&gt;x&lt;/script&gt;</li>");
    expect(written).not.toContain("<script>");
    expect(findingsEdit("<main></main>", "x", at)).toEqual({ error: expect.stringContaining("no findings block") });
    expect(reportHtml("# Title", at)).toContain("<h3>Title</h3>");
  });
});

describe("a run's page step", () => {
  const report = (errors: string[]): CheckReport => ({ errors, warnings: [], calls: [], tests: [], text: "", screenshot: "", thumb: "", width: 1280, height: 800 });
  const meta = { id: "a1", title: "Sales brief", ownerUid: "ada", chatId: "c", latest: 3, versions: [{ version: 3 }] } as unknown as ArtifactMeta;
  const page = `<!doctype html><main>${FINDINGS_START}<p>yesterday</p>${FINDINGS_END}</main>`;

  function scope(errors: string[]) {
    const published: string[] = [];
    const messages: string[] = [];
    /** What onPublished heard: the version, and the chat it was published as. */
    const told: { id: string; latest: number; chatId: string }[] = [];
    const drafts = new ChatDrafts(new FakeBucket().r2, "ada", "0123456789abcdef", new ArrayBuffer(32));
    const publishScope: PublishScope = {
      uid: "ada",
      chatId: "c",
      hub: { servers: () => [] } as unknown as McpHub,
      artifacts: {
        readHtml: async () => page,
        publishVersion: async (input: { html: string; title: string; message?: string }) => {
          published.push(input.html);
          messages.push(input.message ?? "");
          return { id: "a1", title: input.title, latest: 4, updatedAt: 0 } as ArtifactMeta;
        },
      } as unknown as ArtifactStore,
      onPublished: async (artifact, chatId) => {
        told.push({ id: artifact.id, latest: artifact.latest, chatId });
      },
      checkPage: async () => report(errors),
      chatArtifacts: async () => [],
      drafts: async () => drafts,
      skillSets: async () => new Map(),
      readSkillFile: async () => null,
      publishUnchecked: false,
    };
    return { publishScope, published, messages, drafts, told };
  }

  it("tells the scope's chat of a version a run publishes, through the scope's one onPublished", async () => {
    // A page step publishes with the page's own chat as the scope's: the version is recorded there, and the chat that
    // discusses the page hears of it (ChatAgent's onPublished calls pageVersion on it).
    const { publishScope, told } = scope([]);
    const pageScope: PublishScope = { ...publishScope, chatId: "page-chat" };
    await publishFindings(pageScope, meta, "Sales are up.", "Findings", runMark("a1", T0, "0"));
    expect(told).toEqual([{ id: "a1", latest: 4, chatId: "page-chat" }]);
  });

  it("publishes a page whose check passes, with the report in it", async () => {
    const { publishScope, published } = scope([]);
    expect(await publishFindings(publishScope, meta, "Sales are up.", "Findings", runMark("a1", T0, "0"))).toEqual({
      kind: "page",
      to: "Sales brief",
      status: "sent",
      detail: "Sales brief v4 published",
      version: 4,
    });
    expect(published[0]).toContain("<p>Sales are up.</p>");
    expect(published[0]).not.toContain("yesterday");
  });

  it("does not publish a page that fails its check, and says so", async () => {
    const { publishScope, published } = scope(["TypeError: x is undefined"]);
    expect(await publishFindings(publishScope, meta, "Sales are up.", "Findings", runMark("a1", T0, "0"))).toEqual({
      kind: "page",
      to: "Sales brief",
      status: "failed",
      detail: "page not updated: its check found 1 error",
    });
    expect(published).toEqual([]);
  });

  it("publishes once per run: a version with the run's mark is the one it sent", async () => {
    const { publishScope, published, messages } = scope([]);
    const mark = runMark("a1", T0, "2");
    expect(await publishFindings(publishScope, meta, "Sales are up.", "Findings", mark)).toMatchObject({ status: "sent", version: 4 });
    expect(messages).toEqual([`Findings ${mark}`]);
    const after = { ...meta, latest: 4, versions: [...meta.versions, { version: 4, message: messages[0] }] } as unknown as ArtifactMeta;
    expect(publishedAlready(after, mark)).toMatchObject({ status: "sent", version: 4 });
    expect(publishedAlready(after, runMark("a1", T0, "3"))).toBeNull();
    expect(published).toHaveLength(1);
  });

  it("keeps the run's mark in a long message, which the store cuts", async () => {
    const { publishScope, messages } = scope([]);
    const mark = runMark("a1", T0, "0");
    await publishFindings(publishScope, meta, "Sales are up.", `Findings, when ${"signups.count > 10 and ".repeat(20)}true`, mark);
    expect(messages[0].length).toBeLessThanOrEqual(MAX_VERSION_MESSAGE);
    expect(messages[0].endsWith(mark)).toBe(true);
  });

  it("publishes the newest checked draft of that page that the rebuild's own session saved", async () => {
    const { publishScope, published, drafts } = scope([]);
    const seed = await writeDraft(publishScope, { artifact: meta, edits: [] });
    const other = await writeDraft(publishScope, { html: "<!doctype html><main>another page</main>" });
    await drafts.recordCheck(other.id, { errors: 0, warnings: 0 });
    // Nothing of this page passed: the other page's draft is not published in its place.
    expect(await publishRebuilt(publishScope, meta, seed, [seed.id, other.id], "Snapshot", runMark("a1", T0, "1"))).toMatchObject({
      status: "failed",
      detail: "page not updated: no draft of it passed its check",
    });
    const rebuilt = await writeDraft(publishScope, { draftId: seed.id, edits: [{ old: "yesterday", new: "today" }] });
    await drafts.recordCheck(rebuilt.id, { errors: 0, warnings: 0 });
    // Saved by someone else (the owner, another run): not this rebuild's.
    expect(await publishRebuilt(publishScope, meta, seed, [seed.id], "Snapshot", runMark("a1", T0, "1"))).toMatchObject({ status: "failed" });
    expect(await publishRebuilt(publishScope, meta, seed, [seed.id, rebuilt.id], "Snapshot", runMark("a1", T0, "1"))).toMatchObject({
      status: "sent",
      version: 4,
    });
    expect(published).toEqual([expect.stringContaining("<p>today</p>")]);
  });

  it("never publishes a rebuilt page that declares more than the page's read-only tools", async () => {
    const { publishScope, published, drafts } = scope([]);
    const tools = [
      { name: "list_deals", description: "", inputSchema: {}, annotations: { readOnlyHint: true } },
      { name: "update_deal", description: "", inputSchema: {} },
    ];
    publishScope.hub = {
      servers: () => [{ name: "crm" }],
      server: (name: string) => (name === "crm" ? { name: "crm" } : undefined),
      tools: async () => tools,
      tool: async (_server: string, name: string) => tools.find((tool) => tool.name === name),
    } as unknown as McpHub;
    const declared = { mcp: { servers: [{ server: "crm", tools: ["list_deals", "update_deal"] }] } };
    const page = { ...meta, versions: [{ version: 3, manifest: declared }] } as unknown as ArtifactMeta;
    const { servers: readOnly, dropped } = await readOnlyDeclaration(declared, async (_server, name) => !!tools.find((tool) => tool.name === name)?.annotations);
    expect(readOnly).toEqual([{ server: "crm", tools: ["list_deals"] }]);
    expect(dropped).toEqual(["crm.update_deal"]);
    const seed = await writeDraft(publishScope, { artifact: page, edits: [], mcp: readOnly });
    // The page's own write tool, declared again: a load handler could call it as the owner.
    const widened = await writeDraft(publishScope, {
      draftId: seed.id,
      edits: [{ old: "yesterday", new: "today" }],
      mcp: declared.mcp.servers,
    });
    await drafts.recordCheck(widened.id, { errors: 0, warnings: 0 });
    expect(await publishRebuilt(publishScope, page, seed, [seed.id, widened.id], "Snapshot", runMark("a1", T0, "1"))).toMatchObject({
      status: "failed",
      detail: "page not updated: the rebuilt page declares other servers or tools than its read-only ones",
    });
    expect(published).toEqual([]);
    // Kept to the read-only tools, it goes out, and the delivery names the write tool the snapshot is without.
    const kept = await writeDraft(publishScope, { draftId: seed.id, edits: [{ old: "yesterday", new: "today" }] });
    await drafts.recordCheck(kept.id, { errors: 0, warnings: 0 });
    expect(await publishRebuilt(publishScope, page, seed, [seed.id, kept.id], "Snapshot", runMark("a1", T0, "1"), dropped)).toMatchObject({
      status: "sent",
      detail: "Sales brief v4 published as a snapshot without crm.update_deal, which writes",
    });
  });
});
