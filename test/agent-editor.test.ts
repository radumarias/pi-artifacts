import { describe, expect, it } from "vitest";
import {
  AGENT_PROPOSE_TOOL,
  copyInput,
  copyName,
  proposedBy,
  withoutSignInShares,
  type AgentChanges,
  type AgentDefinition,
  type AgentInput,
  type AgentResult,
  type AgentServerInfo,
} from "../shared/agents.ts";
import { checkManifest, EXPORT_FORMAT, EXPORT_VERSION, idRemapper, type ChatDumpPart, type ExportedAgent } from "../shared/data-export.ts";
import { glanceRows, instructionSteps, isConflict, runsLabel, stateLabel } from "../src/agents/glance.ts";
import { agentPath, agentPlace } from "../src/agents/nav.ts";
import { ChatRoster } from "../worker/agents/roster.ts";
import { AgentStore } from "../worker/agents/store.ts";
import { dumpChat, importedRoster, restorePart } from "../worker/chat-dump.ts";
import { memorySql } from "./fakes.ts";

const T0 = 1_000_000;
const research = {
  name: "research",
  job: "Finds and sums up sources.",
  instructions: "1. Search.\n2. Read the best three results.\n\nLink every source.",
};

function saved(result: AgentResult): AgentDefinition {
  if ("error" in result) throw new Error(result.error);
  return result;
}

const newStore = () => new AgentStore(memorySql(), () => T0);

describe("AgentStore: the chats an agent is in", () => {
  it("keeps which chats an agent is in, and whether it is shared in each, as the chats say", () => {
    const store = newStore();
    const agent = saved(store.save(research, "user", undefined));
    store.noteChat(agent.id, "chat-b", true);
    store.noteChat(agent.id, "chat-a", true, true);
    // Said again (a chat that opened again): one row, its sharing as said last.
    store.noteChat(agent.id, "chat-b", true, true);
    store.noteChat(agent.id, "chat-b", true);
    expect(store.chatsOf(agent.id)).toEqual([
      { chatId: "chat-a", shared: true },
      { chatId: "chat-b", shared: false },
    ]);
    store.noteChat(agent.id, "chat-a", false);
    expect(store.chatsOf(agent.id)).toEqual([{ chatId: "chat-b", shared: false }]);
  });

  it("forgets a deleted chat, and a deleted agent's chats; a chat that adds an agent gone meanwhile leaves nothing", () => {
    const store = newStore();
    const a = saved(store.save(research, "user", undefined));
    const b = saved(store.save({ ...research, name: "scout" }, "user", undefined));
    for (const chat of ["one", "two"]) {
      store.noteChat(a.id, chat, true);
      store.noteChat(b.id, chat, true);
    }
    store.forgetChat("one");
    expect(store.chatsOf(a.id)).toEqual([{ chatId: "two", shared: false }]);
    expect(store.delete(a.id)).toBeNull();
    expect(store.chatsOf(a.id)).toEqual([]);
    expect(store.chatsOf(b.id)).toEqual([{ chatId: "two", shared: false }]);
    store.noteChat(a.id, "three", true);
    expect(store.chatsOf(a.id)).toEqual([]);
  });
});

describe("AgentStore: turning on confirms what was assumed", () => {
  it("drops the assumed fields as the owner turns a proposal on, and not as they turn it off", () => {
    const store = newStore();
    const proposal = saved(store.save({ ...research, assumed: ["servers", "trigger"] }, "agent", false));
    expect(proposal.assumed).toEqual(["servers", "trigger"]);
    const on = saved(store.setEnabled(proposal.id, true, proposal.version));
    expect(on.assumed).toBeUndefined();
    expect(on).toMatchObject({ enabled: true, origin: "user", instructions: research.instructions });
    // A save keeps the guesses the user has not confirmed yet, as the form sends them.
    const again = saved(store.save({ ...research, assumed: ["model"] }, "user", undefined, { id: on.id }));
    expect(saved(store.setEnabled(again.id, false)).assumed).toEqual(["model"]);
  });
});

describe("a save over an older version", () => {
  it("is refused in words the tabs know as a conflict, so they start again from the newer one", () => {
    const store = newStore();
    const first = saved(store.save(research, "user", false));
    saved(store.save({ ...research, job: "Newer" }, "user", undefined, { id: first.id, version: first.version }));
    const stale = store.save({ ...research, job: "Mine" }, "user", undefined, { id: first.id, version: first.version });
    expect("error" in stale && isConflict(stale.error)).toBe(true);
  });
});

describe("a drafted agent's shares", () => {
  it("never include a server that signs in each user; the rest stay as drafted", () => {
    const signsIn = (server: string) => server === "calendar";
    const drafted = { ...research, servers: ["db", "calendar"], sharedServers: ["db", "calendar"] };
    expect(withoutSignInShares(drafted, signsIn)).toEqual({ ...drafted, sharedServers: ["db"] });
    // Without a list it shares the default, which leaves sign-in servers out already.
    expect(withoutSignInShares(research, signsIn)).toBe(research);
    expect(withoutSignInShares("not an agent", signsIn)).toBe("not an agent");
  });
});

describe("copies of a shared agent", () => {
  it("takes what the person changed, else the original's fields, and never its state", () => {
    const original = {
      ...research,
      model: "m-1",
      servers: ["db"],
      enabled: true,
      origin: "user",
      assumed: ["servers"],
      copiedFrom: { owner: "x", id: "y", version: 1 },
    };
    expect(copyInput(original, { job: "Mine now.", model: null, origin: "agent", enabled: true } as AgentChanges)).toEqual({
      ...research,
      job: "Mine now.",
      model: null,
      servers: ["db"],
    });
  });

  it("finds a free name for a copy", () => {
    const taken = new Set(["research", "research-2", `${"a".repeat(24)}`]);
    const has = (name: string) => taken.has(name);
    expect(copyName("scout", has)).toBe("scout");
    expect(copyName("research", has)).toBe("research-3");
    expect(copyName("a".repeat(24), has)).toBe(`${"a".repeat(22)}-2`);
    expect(copyName("x", () => true)).toBeNull();
  });

  it("saves a copy off, as the copier's, with where it came from, under a free name", () => {
    const store = newStore();
    saved(store.save(research, "user", undefined));
    const from = { owner: "ann", id: "a".repeat(16), version: 4 };
    const copy = saved(store.saveCopy({ ...research, job: "Their version." }, from));
    expect(copy).toMatchObject({ name: "research-2", job: "Their version.", enabled: false, origin: "user", copiedFrom: from, version: 1 });
    // A change to the copy keeps where it came from.
    expect(saved(store.save({ ...research, name: "research-2" }, "user", true, { id: copy.id })).copiedFrom).toEqual(from);
    expect(store.saveCopy({ ...research, name: "BAD NAME" }, from)).toEqual({ error: expect.stringContaining("name") });
  });
});

describe("AgentStore: import", () => {
  const exported = (change: Partial<ExportedAgent> = {}): ExportedAgent => ({
    ...research,
    id: "1234567890abcdef",
    origin: "user",
    enabled: true,
    ...change,
  });

  it("keeps the agent's id and state, and never replaces one of the user's by its name", () => {
    const store = newStore();
    expect(store.import(exported({ enabled: false, copiedFrom: { owner: "o", id: "i", version: 2 } }))).toEqual({ id: "1234567890abcdef" });
    expect(store.get("1234567890abcdef")).toMatchObject({
      name: "research",
      enabled: false,
      origin: "user",
      copiedFrom: { owner: "o", id: "i", version: 2 },
    });
    // The same zip again, or another agent by that name: the user's stays, and its id is what the rosters point at.
    expect(store.import(exported({ id: "fedcba0987654321", job: "Another." }))).toEqual({ id: "1234567890abcdef", skipped: true });
    expect(store.list()).toHaveLength(1);
    expect(store.get("1234567890abcdef")?.job).toBe(research.job);
  });

  it("gives a new id when its own is taken, takes a proposal back as one, and refuses what checkAgent refuses", () => {
    const store = newStore();
    store.import(exported());
    const other = store.import(exported({ name: "scout" }));
    expect("id" in other && other.id).toMatch(/^[a-f0-9]{16}$/);
    expect("id" in other && other.id).not.toBe("1234567890abcdef");
    const proposal = store.import(exported({ id: "00000000000000aa", name: "draft", origin: "agent", enabled: true }));
    expect(store.get("id" in proposal ? proposal.id : "")).toMatchObject({ origin: "agent", enabled: false });
    expect(store.import(exported({ id: "00000000000000bb", name: "bad name" }))).toEqual({ error: expect.any(String) });
    // A copiedFrom that is not one is left out.
    const odd = store.import(exported({ id: "00000000000000cc", name: "odd", copiedFrom: { owner: 1 } as unknown as ExportedAgent["copiedFrom"] }));
    expect(store.get("id" in odd ? odd.id : "")?.copiedFrom).toBeUndefined();
  });
});

describe("ChatRoster: sharing an agent with the chat", () => {
  const entry = (agentId: string, name: string) => ({
    agentId,
    ownerUid: "ann",
    name,
    session: `s-${name}`,
    avatar: "A",
    color: "blue" as const,
    job: "Helps.",
  });

  it("shares an agent and stops, and the chat's view says so", () => {
    const roster = new ChatRoster(memorySql(), () => T0);
    roster.add(entry("id-a", "alpha"));
    expect(roster.get("id-a")?.shared).toBe(false);
    expect(roster.setShared("id-a", true)).toBe(true);
    expect(roster.views(() => "Ann")[0]).toMatchObject({ id: "id-a", shared: true });
    roster.setShared("id-a", false);
    expect(roster.views(() => "Ann")[0]).not.toHaveProperty("shared");
    expect(roster.setShared("id-nobody", true)).toBe(false);
  });
});

describe("a chat's export carries its agents", () => {
  const OLD_UID = "0123456789abcdef0123456789abcdef";
  const NEW_UID = "fedcba9876543210fedcba9876543210";
  const kv = () => {
    const map = new Map<string, unknown>();
    return {
      map,
      get: (key: string) => map.get(key),
      put: (key: string, value: unknown) => void map.set(key, value),
      delete: (key: string) => map.delete(key),
    };
  };

  /** A chat with a conversation and two agents, one of which has turns in flight. */
  function chatWithAgents() {
    const sql = memorySql();
    sql.db.exec(`CREATE TABLE pi_entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL) STRICT`);
    for (let id = 1; id <= 5; id++) {
      sql.exec(
        "INSERT INTO pi_entries VALUES (?, 1, ?)",
        id,
        JSON.stringify({ kind: id === 5 ? "chat.turn" : "chat.agent", data: { agentId: "aaaaaaaaaaaaaaaa", ownerUid: OLD_UID, turn: id + 10 } }),
      );
    }
    const roster = new ChatRoster(sql, () => T0);
    roster.add({ agentId: "aaaaaaaaaaaaaaaa", ownerUid: OLD_UID, name: "alpha", session: "2", avatar: "A", color: "blue", job: "Alpha." });
    roster.add({ agentId: "bbbbbbbbbbbbbbbb", ownerUid: OLD_UID, name: "beta", session: "3", avatar: "B", color: "green", job: "Beta." });
    roster.setShared("aaaaaaaaaaaaaaaa", true);
    roster.enqueue({ agentId: "aaaaaaaaaaaaaaaa", hop: 0, calledBy: { name: "Ann", uid: OLD_UID }, byOwner: true, ask: "[Ann · person] go" });
    return sql;
  }

  function exported(sql: ReturnType<typeof memorySql>): ChatDumpPart[] {
    const parts: ChatDumpPart[] = [];
    let page = dumpChat(sql, kv(), []);
    parts.push(page.part);
    while (page.next) parts.push((page = dumpChat(sql, kv(), [], page.next)).part);
    return JSON.parse(JSON.stringify(parts)) as ChatDumpPart[];
  }

  it("carries the roster, never the turns, and the import keeps only the agents it brought in, as the importer's", () => {
    const parts = exported(chatWithAgents());
    const tables = parts.flatMap((part) => part.tables.map((table) => table.name));
    expect(tables).toContain("chat_agents");
    expect(tables).not.toContain("chat_agent_turns");

    // A new chat object, whose constructor made its roster: alpha came in under a new id, beta was not imported.
    const target = memorySql();
    new ChatRoster(target, () => T0);
    const remap = idRemapper([
      [OLD_UID, NEW_UID],
      ["aaaaaaaaaaaaaaaa", "cccccccccccccccc"],
    ]);
    for (const part of parts) restorePart(target, kv(), [], part, remap);
    const result = importedRoster(target, NEW_UID, ["cccccccccccccccc"]);
    expect(result).toEqual({ agents: ["cccccccccccccccc"], through: 5 });
    const roster = new ChatRoster(target, () => T0);
    expect(roster.list()).toEqual([
      expect.objectContaining({ agentId: "cccccccccccccccc", ownerUid: NEW_UID, name: "alpha", session: "2", shared: false }),
    ]);
    expect(roster.hasWork()).toBe(false);
    // Its session ran turns up to 15: a new one is numbered on from there, never as one of those.
    expect(roster.enqueue({ agentId: "cccccccccccccccc", hop: 0, calledBy: { name: "Ann", uid: NEW_UID }, byOwner: true, ask: "go" }).id).toBe(16);
    // Its replies in the log point at its new id too.
    const record = JSON.parse(String(target.exec("SELECT record FROM pi_entries WHERE id = 1").toArray()[0].record)) as { data: { agentId: string } };
    expect(record.data.agentId).toBe("cccccccccccccccc");
  });

  it("keeps no agent from an export made before agents, and reads a chat with no conversation", () => {
    const sql = memorySql();
    expect(importedRoster(sql, NEW_UID, [])).toEqual({ agents: [], through: -1 });
    new ChatRoster(sql, () => T0);
    expect(importedRoster(sql, NEW_UID, ["cccccccccccccccc"])).toEqual({ agents: [], through: -1 });
  });

  it("refuses a manifest whose agents are not a list", () => {
    const manifest = { format: EXPORT_FORMAT, version: EXPORT_VERSION, uid: "u", chats: [], artifacts: [], files: [], sharedWithMe: [] };
    expect(checkManifest({ ...manifest, account: { skills: [], agents: {} } })).toEqual({ error: expect.any(String) });
    expect(checkManifest({ ...manifest, account: { skills: [], agents: [] } })).not.toHaveProperty("error");
    // An export from before agents still reads; one newer than this deployment is refused as a whole.
    expect(checkManifest({ ...manifest, version: 1, account: { skills: [] } })).not.toHaveProperty("error");
    expect(checkManifest({ ...manifest, version: EXPORT_VERSION + 1, account: { skills: [] } })).toEqual({ error: expect.any(String) });
    expect(checkManifest({ ...manifest, account: { skills: [] } })).not.toHaveProperty("error");
  });
});

describe("the draft card's words", () => {
  const agent = (change: Partial<AgentDefinition> = {}) =>
    ({
      ...research,
      id: "a".repeat(16),
      avatar: "re",
      color: "blue",
      autonomy: 1,
      origin: "agent",
      enabled: false,
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      ...change,
    }) as AgentDefinition;

  it("says the state an agent is in", () => {
    expect(stateLabel(agent())).toEqual({ text: "Proposed by pi · off", tone: "draft" });
    expect(stateLabel(agent({ origin: "user" }))).toEqual({ text: "Draft · off", tone: "off" });
    expect(stateLabel(agent({ origin: "user", copiedFrom: { owner: "o", id: "i", version: 1 } }))).toEqual({
      text: "Your copy · off",
      tone: "draft",
    });
    expect(stateLabel(agent({ enabled: true }))).toEqual({ text: "On", tone: "on" });
  });

  it("reads the instructions' numbered steps, and keeps the rest as its rules", () => {
    expect(instructionSteps("Intro line.\n\n1. One\n   more of one\n2) Two\n\n3. Three\n\nRules here.")).toEqual({
      steps: ["One more of one", "Two", "Three"],
      rest: "Intro line.\n\nRules here.",
    });
    expect(instructionSteps("No list here.\n- a bullet")).toBeNull();
  });

  it("says when it runs", () => {
    expect(runsLabel(undefined)).toBeNull();
    expect(runsLabel({ kind: "schedule", at: "07:00", tz: "Europe/Bucharest" })).toEqual({ value: "Every day at 07:00", note: "Europe/Bucharest" });
    expect(runsLabel({ kind: "schedule", at: "09:30", tz: "UTC", days: ["mon", "tue", "wed", "thu", "fri"] })?.value).toBe("Weekdays at 09:30");
    expect(runsLabel({ kind: "schedule", at: "09:30", tz: "UTC", days: ["sun", "mon"] })?.value).toBe("Mon, Sun at 09:30");
    expect(runsLabel({ kind: "watch", step: { kind: "look", server: "db", tool: "t", input: {} }, everyMinutes: 120, when: "x < 3" })).toEqual({
      value: "Checks db every 2 h",
      note: "when x < 3",
    });
  });

  it("fills the at-a-glance rows from its fields, with the model's guesses as Assumed", () => {
    const rows = glanceRows(
      agent({
        servers: ["db"],
        trigger: { kind: "schedule", at: "07:00", tz: "UTC" },
        scope: { list: { kind: "look", server: "crm", tool: "regions", input: {} }, each: true },
        workflow: [
          { kind: "if", condition: "a", then: [{ kind: "look", server: "web", tool: "get", input: {} }] },
          { kind: "work", prompt: "p", skill: "forecasting" },
          { kind: "tell", to: ["Leads"], via: "notify" },
        ],
        assumed: ["Tells", "trigger"],
      }),
    );
    expect(rows.map(({ key, value, assumed, field }) => ({ key, value, assumed, field }))).toEqual([
      { key: "scope", value: "Each item of crm regions", assumed: false, field: "scope" },
      { key: "runs", value: "Every day at 07:00", assumed: true, field: "trigger" },
      { key: "reads", value: "db, web, crm", assumed: false, field: "servers" },
      { key: "tells", value: "Leads", assumed: true, field: "workflow" },
      { key: "knows", value: "forecasting skill", assumed: false, field: "instructions" },
    ]);
    const plain = glanceRows(agent());
    expect(plain.find((row) => row.key === "runs")?.value).toBe("When someone calls @research");
    expect(plain.find((row) => row.key === "reads")?.value).toBe("Every server");
    // With no list of its own, a step naming one server does not make it the only one.
    const any = glanceRows(agent({ workflow: [{ kind: "look", server: "web", tool: "get", input: {} }] })).find((row) => row.key === "reads");
    expect(any).toMatchObject({ value: "web", note: "and any other: it may use every server" });
  });

  it("finds the proposal in a tool result, and nothing in a failed one or another tool's", () => {
    const result = (toolName: string, details: unknown, isError = false) => ({
      kind: "pi.tool-result",
      model: [{ role: "toolResult", toolName, details, isError }],
    });
    const details = { agentId: "a".repeat(16), name: "research", version: 1 };
    expect(proposedBy(result(AGENT_PROPOSE_TOOL, details))).toEqual(details);
    expect(proposedBy(result(AGENT_PROPOSE_TOOL, details, true))).toBeUndefined();
    expect(proposedBy(result("artifact_publish", details))).toBeUndefined();
    expect(proposedBy(result(AGENT_PROPOSE_TOOL, { ...details, agentId: "../x" }))).toBeUndefined();
    expect(proposedBy({ kind: "pi.assistant", model: [] })).toBeUndefined();
  });

  it("goes to an agent's page and back from its URL", () => {
    const id = "b".repeat(16);
    const path = agentPath({ id, field: "servers", chat: "c0ffee00" });
    expect(path).toBe(`/agents/${id}?field=servers&chat=c0ffee00`);
    expect(agentPlace(new URL(path, "https://app.test"))).toEqual({ id, tab: undefined, field: "servers", chat: "c0ffee00" });
    expect(agentPlace(new URL("/agents/new", "https://app.test"))).toMatchObject({ id: "new" });
    expect(agentPlace(new URL(`/agents/${id}?chat=../x`, "https://app.test"))?.chat).toBeUndefined();
    expect(agentPlace(new URL("/agents/nothex", "https://app.test"))).toBeNull();
  });
});
