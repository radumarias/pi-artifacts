import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { CHAT_AGENT_KIND } from "../shared/agents.ts";
import {
  answersEveryMessage,
  CHAT_CONTEXT_KIND,
  CHAT_COPY_KIND,
  CHAT_KINDS,
  kindAfterJoin,
  kindChoices,
  losesAccess,
  mayLeave,
  narrows,
  widens,
  type ChatKind,
  type ChatMemberVia,
} from "../shared/chat-kinds.ts";
import { CHAT_MESSAGE_KIND, PUBLISH_TOOL } from "../shared/protocol.ts";
import { askLine } from "../worker/agents/turns.ts";
import { BRANCH_CONTEXT_CHARS, branchContext, branchCopies } from "../worker/branch.ts";
import { branchKind, ChatKindState, MAX_BRANCHES, planKindChange, type Kv } from "../worker/chat-kind.ts";
import { ChatRows, MAX_KNOWN_PAIRS, parseRowChange } from "../worker/chat-rows.ts";
import { ChatMembers } from "../worker/members.ts";
import { orderChats } from "../src/chat/chat-order.ts";
import type { ChatSummary } from "../shared/protocol.ts";
import { memorySql } from "./fakes.ts";

const T0 = 1_700_000_000_000;
const ann = { uid: "ann", name: "ann@example.com" };
const bea = { uid: "bea", name: "bea@example.com" };
const cai = { uid: "cai", name: "cai@example.com" };

const member = (person: { uid: string; name: string }, via: ChatMemberVia["via"]): ChatMemberVia => ({ ...person, via });

describe("chat kinds: the rules", () => {
  it("lets agents answer every message only in a private chat", () => {
    expect(CHAT_KINDS.filter(answersEveryMessage)).toEqual(["private"]);
  });

  it("lets memory notes out of a private chat anywhere, of a group or page chat only for that chat, of off the record never", () => {
    const anywhere = { what: "memory", scope: "everywhere" } as const;
    const here = { what: "memory", scope: "chat" } as const;
    expect(CHAT_KINDS.filter((kind) => mayLeave(anywhere, kind))).toEqual(["private"]);
    expect(CHAT_KINDS.filter((kind) => mayLeave(here, kind))).toEqual(["private", "group", "page"]);
  });

  it("keeps search, routines and feed previews out of an off-the-record chat only", () => {
    for (const what of ["search", "routine", "feed"] as const) {
      expect(CHAT_KINDS.filter((kind) => !mayLeave({ what }, kind))).toEqual(["off_record"]);
    }
  });

  it("takes the strictest of several kinds, and lets nothing out without one", () => {
    // The chat already off the record while a sidebar row still says group, and the other way round.
    expect(mayLeave({ what: "search" }, "group", "off_record")).toBe(false);
    expect(mayLeave({ what: "search" }, "off_record", "group")).toBe(false);
    expect(mayLeave({ what: "memory", scope: "everywhere" }, "private", "group")).toBe(false);
    expect(mayLeave({ what: "feed" }, "group", "page")).toBe(true);
    expect(mayLeave({ what: "feed" })).toBe(false);
    expect(mayLeave({ what: "feed" }, null)).toBe(false);
  });

  it("says who loses access for each kind: private everyone, group and off the record those who joined from the page", () => {
    const members = [member(ann, "invite"), member(bea, "page"), member(cai, "added"), member({ uid: "own-seat2", name: "me (2)" }, "seat")];
    const uids = (kind: ChatKind) => losesAccess(kind, members).map((m) => m.uid);
    expect(uids("private")).toEqual(["ann", "bea", "cai", "own-seat2"]);
    expect(uids("group")).toEqual(["bea"]);
    expect(uids("off_record")).toEqual(["bea"]);
    expect(uids("page")).toEqual([]);
  });

  it("makes a private chat a group when someone joins, and leaves the others as they are", () => {
    expect(CHAT_KINDS.map(kindAfterJoin)).toEqual(["group", "group", "page", "off_record"]);
  });

  it("tells narrowing from widening", () => {
    expect(narrows("group", "private")).toBe(true);
    expect(narrows("group", "off_record")).toBe(true);
    expect(narrows("page", "group")).toBe(true);
    expect(narrows("private", "group")).toBe(false);
    expect(narrows("off_record", "group")).toBe(false);
    expect(widens("private", "group")).toBe(true);
    expect(widens("group", "page")).toBe(true);
    expect(widens("group", "private")).toBe(false);
  });

  it("offers on a page only to a chat made from one", () => {
    expect(kindChoices(false)).toEqual(["private", "group", "off_record"]);
    expect(kindChoices(true)).toEqual(CHAT_KINDS);
  });
});

describe("changing a chat's kind", () => {
  const members = [member(ann, "invite"), member(bea, "page")];

  it("removes exactly the people the owner was shown", () => {
    expect(planKindChange("page", "group", members, ["bea"], true)).toEqual({ removed: [member(bea, "page")] });
    expect(planKindChange("group", "private", members, ["bea", "ann"], true)).toEqual({ removed: members });
  });

  it("changes nothing when who loses access changed since the owner looked, and says who it is now", () => {
    const joined = [...members, member(cai, "page")];
    expect(planKindChange("page", "group", joined, ["bea"], true)).toEqual({ error: expect.stringContaining("changed"), status: 409, loses: [member(bea, "page"), member(cai, "page")] });
    // Nobody may be named who would not lose access.
    expect(planKindChange("page", "group", members, ["bea", "ann"], true)).toMatchObject({ status: 409 });
    expect(planKindChange("page", "group", members, [], true)).toMatchObject({ status: 409 });
  });

  it("widens with no one to confirm", () => {
    expect(planKindChange("private", "group", [], [], false)).toEqual({ removed: [] });
    expect(planKindChange("group", "group", members, [], false)).toEqual({ removed: [] });
  });

  it("refuses a kind that is not one, and on a page for a chat no page is linked to", () => {
    expect(planKindChange("group", "public", members, [], false)).toMatchObject({ status: 400 });
    expect(planKindChange("group", "page", members, [], false)).toMatchObject({ status: 400, error: expect.stringContaining("Discuss") });
  });
});

/** A KV store over a Map, as the chat object's storage.kv is. */
function memoryKv(): Kv {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => void map.set(key, value),
    delete: (key) => map.delete(key),
  };
}

describe("ChatKindState", () => {
  it("reads a chat from before kinds as a group if it has members, else private, until one is stored", () => {
    let members = false;
    const state = new ChatKindState(memoryKv(), () => members);
    expect(state.kind()).toBe("private");
    members = true;
    expect(state.kind()).toBe("group");
    state.setKind("off_record");
    members = false;
    expect(state.kind()).toBe("off_record");
  });

  it("keeps the page, where it branched from, and the page a branch knows of", () => {
    const state = new ChatKindState(memoryKv(), () => false);
    state.setPage({ id: "page0001", title: "Signups", version: 2 });
    state.setBranchedFrom({ chatId: "chat0001", title: "Plans", entry: 7, root: "chat0000" });
    expect(state.page()).toEqual({ id: "page0001", title: "Signups", version: 2 });
    expect(state.branchedFrom()).toEqual({ chatId: "chat0001", title: "Plans", entry: 7, root: "chat0000" });
    const branch = new ChatKindState(memoryKv(), () => false);
    branch.setContextPage({ id: "page0001", title: "Signups", version: 2 });
    expect(branch.page()).toBeUndefined();
    expect(branch.knownPage()?.id).toBe("page0001");
  });

  it("makes a branch private, a group with the one who branched it, and keeps off the record; never on a page", () => {
    expect(branchKind("group", false)).toBe("private");
    expect(branchKind("page", true)).toBe("group");
    expect(branchKind("private", false)).toBe("private");
    expect(branchKind("off_record", false)).toBe("off_record");
    expect(branchKind("off_record", true)).toBe("off_record");
  });

  it("keeps out of a page's chat whom the owner removed, until they are let back in", () => {
    const state = new ChatKindState(memoryKv(), () => true);
    state.shutOut("maria");
    state.shutOut("ion");
    expect(state.isShutOut("maria")).toBe(true);
    state.letBackIn("maria");
    expect(state.isShutOut("maria")).toBe(false);
    expect(state.isShutOut("ion")).toBe(true);
  });

  it("comes in by import as its owner's alone, off the record staying so", () => {
    const group = new ChatKindState(memoryKv(), () => false);
    group.setKind("page");
    group.setPage({ id: "page0001", title: "Signups", version: 2 });
    expect(group.imported()).toBe("private");
    expect(group.page()).toBeUndefined();
    const offRecord = new ChatKindState(memoryKv(), () => false);
    offRecord.setKind("off_record");
    expect(offRecord.imported()).toBe("off_record");
  });
});

describe("ChatMembers: how each joined", () => {
  it("records invite, direct adds and page joins, and keeps someone already in as they joined", async () => {
    const members = new ChatMembers(memorySql());
    const created = await members.createInvite(T0);
    if ("error" in created) throw new Error(created.error);
    expect(await members.accept(created.secret, ann, T0)).toBeNull();
    expect(members.add(bea, "added", T0 + 1)).toBeNull();
    expect(members.add(cai, "page", T0 + 2)).toBeNull();
    expect(members.add(cai, "added", T0 + 3)).toBeNull();
    expect(members.listVia()).toEqual([member(ann, "invite"), member(bea, "added"), member(cai, "page")]);
    expect(members.list()).toEqual([ann, bea, cai]);
  });
});

/** The sidebar tables as UserDirectory makes them before ChatRows adds its columns. */
function sidebar() {
  const sql = memorySql();
  sql.exec(`
    CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      status TEXT, activity_at INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL DEFAULT 0, mentioned_at INTEGER NOT NULL DEFAULT 0,
      shared INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE shared_chats (id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, owner_name TEXT NOT NULL, title TEXT NOT NULL, joined_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, status TEXT, activity_at INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL DEFAULT 0, mentioned_at INTEGER NOT NULL DEFAULT 0);
  `);
  const rows = new ChatRows(sql);
  const own = (id: string, at: number, over = "") => sql.exec(`INSERT INTO chats (id, title, created_at, updated_at${over ? ", shared" : ""}) VALUES (?, ?, ?, ?${over ? ", 1" : ""})`, id, `Chat ${id}`, at, at);
  const theirs = (id: string, at: number) =>
    sql.exec("INSERT INTO shared_chats (id, owner_uid, owner_name, title, joined_at, updated_at) VALUES (?, 'bea', 'bea@example.com', ?, ?, ?)", id, `Chat ${id}`, at, at);
  return { sql, rows, own, theirs };
}

describe("ChatRows: what each person changes in their own sidebar", () => {
  it("lists rows from before kinds as the chat was: private, or a group with members", () => {
    const { rows, own, theirs } = sidebar();
    own("mine", T0);
    own("sharedmine", T0 + 1, "shared");
    theirs("theirs", T0 + 2);
    expect(rows.list().map((chat) => [chat.id, chat.kind])).toEqual([
      ["theirs", "group"],
      ["sharedmine", "group"],
      ["mine", "private"],
    ]);
  });

  it("pins, keeping when it was first pinned, and unpins", () => {
    const { rows, own } = sidebar();
    own("one", T0);
    expect(rows.change("one", { pinned: true }, T0 + 5)).toBe(true);
    rows.change("one", { pinned: true }, T0 + 9);
    expect(rows.list()[0].pinnedAt).toBe(T0 + 5);
    rows.change("one", { pinned: false });
    expect(rows.list()[0].pinnedAt).toBeUndefined();
  });

  it("closes a chat until someone tags the user in it again", () => {
    const { rows, own, theirs } = sidebar();
    own("one", T0);
    theirs("two", T0);
    rows.change("one", { closed: true }, T0 + 1);
    rows.change("two", { closed: true }, T0 + 1);
    expect(rows.list().filter((chat) => chat.closed).map((chat) => chat.id).sort()).toEqual(["one", "two"]);
    // UserDirectory's touch reopens on a tag.
    rows.reopen("two");
    expect(rows.list().find((chat) => chat.id === "two")?.closed).toBeUndefined();
    expect(rows.list().find((chat) => chat.id === "one")?.closed).toBe(true);
  });

  it("marks a chat unread by hand, and keeps the user's own name for it apart from its title", () => {
    const { sql, rows, theirs } = sidebar();
    theirs("two", T0);
    rows.change("two", { unread: true, title: "Our numbers" });
    expect(rows.list()[0]).toMatchObject({ title: "Our numbers", unread: true });
    // The owner renaming it, or the chat naming itself, changes `title`, which the user's own name still covers.
    sql.exec("UPDATE shared_chats SET title = 'Renamed' WHERE id = 'two'");
    expect(rows.list()[0].title).toBe("Our numbers");
    rows.change("two", { title: "" });
    expect(rows.list()[0].title).toBe("Renamed");
    expect(rows.change("nope", { pinned: true })).toBe(false);
  });

  it("takes only the fields it knows from what the browser sends", () => {
    expect(parseRowChange({ pinned: true, closed: "yes", title: `  ${"x".repeat(300)} ` })).toEqual({ pinned: true, title: "x".repeat(200) });
    expect(parseRowChange({ nothing: 1 })).toBeNull();
    expect(parseRowChange(null)).toBeNull();
  });
});

describe("off the record reaches the stores' check", () => {
  it("is what the sidebar says of the chat once the chat tells it, and lets nothing out", () => {
    const { sql, rows, own, theirs } = sidebar();
    own("mine", T0);
    theirs("theirs", T0);
    expect(rows.kindOf("mine")).toBe("private");
    // UserDirectory.setChatKind, as the chat calls it on every sidebar that lists it.
    sql.exec("UPDATE chats SET kind = 'off_record' WHERE id = 'mine'");
    sql.exec("UPDATE shared_chats SET kind = 'off_record' WHERE id = 'theirs'");
    for (const id of ["mine", "theirs"]) {
      expect(rows.kindOf(id)).toBe("off_record");
      expect(mayLeave({ what: "memory", scope: "chat" }, rows.kindOf(id))).toBe(false);
      // Also when the write call carries a kind that lags behind.
      expect(mayLeave({ what: "search" }, "group", rows.kindOf(id))).toBe(false);
    }
    expect(rows.kindOf("unknown")).toBeNull();
    expect(mayLeave({ what: "feed" }, rows.kindOf("unknown"))).toBe(false);
  });
});

describe("ChatRows: page chats and people", () => {
  it("finds the chat that discusses a page while that chat is still listed", () => {
    const { sql, rows, own } = sidebar();
    own("talk", T0);
    expect(rows.pageChat("page0001")).toBeNull();
    rows.linkPage("page0001", "talk");
    expect(rows.pageChat("page0001")).toBe("talk");
    sql.exec("DELETE FROM chats WHERE id = 'talk'");
    expect(rows.pageChat("page0001")).toBeNull();
    rows.forgetChat("talk");
    expect(sql.exec("SELECT * FROM page_chats").toArray()).toEqual([]);
  });

  it("knows people only while sharing a chat with them, never the user, newest first", () => {
    const { rows } = sidebar();
    rows.knowPeople("chat1", [ann, bea], "ann", T0);
    rows.knowPeople("chat2", [{ uid: "bea", name: "Bea" }, cai], "ann", T0 + 1);
    expect(rows.people()).toHaveLength(2);
    expect(rows.people()).toEqual(expect.arrayContaining([{ uid: "bea", name: "Bea" }, cai]));
    expect(rows.person("cai")).toEqual(cai);
    expect(rows.person("ann")).toBeNull();
    // Bea leaves chat2: still known through chat1. Then chat1 is gone: not known any more.
    rows.forgetPeople("chat2", "bea");
    expect(rows.person("bea")).not.toBeNull();
    rows.forgetChat("chat1");
    expect(rows.person("bea")).toBeNull();
    // This user leaves chat2: nobody is known through it.
    rows.forgetPeople("chat2");
    expect(rows.people()).toEqual([]);
  });

  it("counts branches against the conversation's first chat, at most MAX_BRANCHES, and frees a deleted one's place", () => {
    const { rows } = sidebar();
    for (let i = 0; i < MAX_BRANCHES; i++) expect(rows.takeBranch("root", MAX_BRANCHES)).toBe(true);
    expect(rows.takeBranch("root", MAX_BRANCHES)).toBe(false);
    expect(rows.takeBranch("other", MAX_BRANCHES)).toBe(true);
    rows.returnBranch("root");
    expect(rows.takeBranch("root", MAX_BRANCHES)).toBe(true);
    // Deleting the first chat keeps the count while its branches are there.
    rows.forgetChat("root");
    expect(rows.takeBranch("root", MAX_BRANCHES)).toBe(false);
    for (let i = 0; i < MAX_BRANCHES; i++) rows.returnBranch("root");
    rows.returnBranch("root");
    rows.forgetChat("root");
    expect(rows.takeBranch("root", 1)).toBe(true);
    expect(rows.takeBranch("root", 1)).toBe(false);
  });

  it("gives a place back only for a branch branchOff counted, not an imported one", () => {
    const from = { chatId: "c1", title: "t", entry: 3, root: "c0" };
    const made = new ChatKindState(memoryKv(), () => false);
    made.setBranchedFrom(from, true);
    expect(made.countedRoot()).toBe("c0");
    const imported = new ChatKindState(memoryKv(), () => false);
    imported.setBranchedFrom(from);
    expect(imported.countedRoot()).toBeUndefined();
  });

  it("keeps at most MAX_KNOWN_PAIRS pairs, newest kept", () => {
    const { rows } = sidebar();
    rows.knowPeople("old", [cai], "ann", T0);
    rows.knowPeople("big", Array.from({ length: MAX_KNOWN_PAIRS }, (_, i) => ({ uid: `p${i}`, name: `p${i}` })), "ann", T0 + 1);
    expect(rows.person("cai")).toBeNull();
    expect(rows.people()).toHaveLength(MAX_KNOWN_PAIRS);
  });
});

/** A transcript entry as the chat's log holds it. */
function entry(id: number, kind: string, data?: unknown, model?: unknown[]): EntryRecord {
  return { id, kind, ...(data !== undefined && { data }), ...(model && { model }) } as unknown as EntryRecord;
}
const said = (id: number, who: { uid: string; name: string }, text: string) => entry(id, CHAT_MESSAGE_KIND, { ...who, text, sentAt: T0 + id });
const piSaid = (id: number, text: string, toolCall = false) =>
  entry(id, "pi.assistant", undefined, [
    { role: "assistant", content: [...(toolCall ? [{ type: "toolCall", id: "t1", name: "files_read", arguments: {} }] : []), { type: "text", text }], timestamp: T0 + id },
  ]);

describe("branching off", () => {
  const owner = ann;
  const log = [
    entry(1, "pi.user", undefined, [{ role: "user", content: "Before chats had authors", timestamp: T0 }]),
    said(2, bea, "What changed this week?"),
    entry(3, "chat.aside", undefined, [{ role: "user", content: "bea: …", timestamp: T0 }]),
    piSaid(4, "", true),
    entry(5, "pi.tool-result", undefined, [{ role: "toolResult", toolName: "files_read", toolCallId: "t1", content: [], isError: false }]),
    piSaid(6, "Signups are up 12%."),
    entry(7, "pi.tool-result", undefined, [
      { role: "toolResult", toolName: PUBLISH_TOOL, toolCallId: "t2", content: [], isError: false, details: { artifactId: "page0001", version: 3, title: "Signups" } },
    ]),
    entry(8, CHAT_AGENT_KIND, { agentId: "a1", name: "research", text: "Mostly from the new form.", turn: 1 }),
    entry(9, "chat.people", { uid: "cai", name: "cai", event: "joined" }),
  ];

  it("copies the conversation as it was: messages, pi's text, agents' replies and published cards, no tool calls or notices", () => {
    const copies = branchCopies(log, owner);
    expect(copies.map((copy) => copy.kind)).toEqual([CHAT_MESSAGE_KIND, CHAT_MESSAGE_KIND, CHAT_COPY_KIND, CHAT_COPY_KIND, CHAT_AGENT_KIND]);
    expect(copies[0].data).toMatchObject({ ...owner, text: "Before chats had authors" });
    expect(copies[1].data).toMatchObject({ ...bea, text: "What changed this week?" });
    expect(copies[2].data).toEqual({ from: "pi", text: "Signups are up 12%.", sentAt: T0 + 6 });
    expect(copies[3].data).toEqual({ from: "artifact", artifactId: "page0001", title: "Signups", version: 3 });
  });

  it("copies only what it is given: the log up to the message it branches from", () => {
    const upTo = log.filter((e) => (e.id as number) <= 2);
    expect(branchCopies(upTo, owner).map((copy) => (copy.data as { text?: string }).text)).toEqual(["Before chats had authors", "What changed this week?"]);
  });

  it("gives the branch's agent the conversation as labelled lines, the owner's marked", async () => {
    const text = await branchContext(log, owner.uid, "Weekly numbers");
    expect(text).toContain('branched off from the chat "Weekly numbers"');
    expect(text).toContain("[the owner · person · your owner]: Before chats had authors");
    expect(text).toContain("[bea@example.com · person]: What changed this week?");
    expect(text).toContain("[pi · agent]: Signups are up 12%.");
    expect(text).toContain("[research · agent]: Mostly from the new form.");
    expect(text).not.toContain("bea: …");
  });

  it("leaves out the chat's own context notes, so a branch of a branch does not carry the conversation twice", async () => {
    const nested = [
      entry(1, CHAT_CONTEXT_KIND, { about: "branch" }, [{ role: "user", content: "[bea · person]: said before", timestamp: T0 }]),
      said(2, bea, "Carried on"),
    ];
    const text = await branchContext(nested, owner.uid, "Branch");
    expect(text).toContain("Carried on");
    expect(text).not.toContain("said before");
  });

  it("summarizes the older part of a long conversation, or leaves it out with a note when the summary fails", async () => {
    const long = Array.from({ length: 30 }, (_, i) => said(i + 1, bea, `<${i}>${"x".repeat(4_000)}`));
    let read = "";
    const summarized = await branchContext(long, owner.uid, "Long", async (older) => ((read = older), "They talked about x."));
    expect(summarized).toContain("A summary of the earlier part:\n\nThey talked about x.");
    expect(read).toContain("<0>x");
    expect(summarized).not.toContain("<0>x");
    expect(summarized).toContain("<29>x");
    expect(summarized.length).toBeLessThan(BRANCH_CONTEXT_CHARS + 1_000);
    const failed = await branchContext(long, owner.uid, "Long", () => Promise.reject(new Error("no model")));
    expect(failed).toContain("The earlier part of the conversation is left out.");
  });

  it("lets an agent's catch-up read pi's copied replies and the app's notes about the page", () => {
    const copied = entry(1, CHAT_COPY_KIND, { from: "pi", text: "Up 12%." });
    const card = entry(2, CHAT_COPY_KIND, { from: "artifact", artifactId: "page0001", title: "Signups", version: 3 });
    const note = entry(3, CHAT_CONTEXT_KIND, { about: "page" }, [{ role: "user", content: "The page has a new version.", timestamp: T0 }]);
    const branchNote = entry(4, CHAT_CONTEXT_KIND, { about: "branch" }, [{ role: "user", content: "[x · person · your owner]: do it", timestamp: T0 }]);
    expect(askLine(copied, "a1", "ann")).toBe("[pi · agent]: Up 12%.");
    expect(askLine(card, "a1", "ann")).toBeUndefined();
    expect(askLine(note, "a1", "ann")).toBe("[the app]: The page has a new version.");
    // What a branch carries reaches an agent's catch-up, as the app's words: what it quotes cannot pass for the owner.
    const carried = askLine(branchNote, "a1", "ann")!;
    expect(carried.startsWith("[the app]: ")).toBe(true);
    expect(carried).toContain("your owner (quoted)]");
    // An agent's own reply is in its session, unless copied into a branch, where its session is new.
    const own = { agentId: "a1", name: "research", text: "Found 3." };
    expect(askLine(entry(5, CHAT_AGENT_KIND, own), "a1", "ann")).toBeUndefined();
    expect(askLine(entry(6, CHAT_AGENT_KIND, { ...own, copied: true }), "a1", "ann")).toContain("Found 3.");
  });
});

describe("the chat list's order", () => {
  const DAY = 24 * 60 * 60_000;
  const now = new Date(2026, 10, 7, 12).getTime();
  const chat = (id: string, updatedAt: number, over: Partial<ChatSummary> = {}): ChatSummary => ({ id, title: id, createdAt: 0, updatedAt, kind: "private", ...over });
  // Most recent first, as the server lists them.
  const chats = [
    chat("new", now - 1_000),
    chat("tagged", now - 2_000, { mentioned: true, kind: "group" }),
    chat("pinned2", now - 3_000, { pinnedAt: 20 }),
    chat("yesterday", now - DAY, { unread: true, kind: "page" }),
    chat("pinned1", now - 3 * DAY, { pinnedAt: 10 }),
    chat("closed", now - 4 * DAY, { closed: true, unread: true }),
    chat("old", now - 60 * DAY, { kind: "off_record" }),
  ];
  const ids = (groups: { key: string; chats: ChatSummary[] }[]) => groups.map((group) => [group.key, group.chats.map((c) => c.id)]);

  it("puts pinned chats first, in the order pinned, then unread ones, then the rest, most recent first", () => {
    const { groups, closed } = orderChats(chats, { unreadFirst: true, groupBy: "none" }, undefined, now);
    expect(ids(groups)).toEqual([
      ["pinned", ["pinned1", "pinned2"]],
      ["unread", ["tagged", "yesterday"]],
      ["all", ["new", "old"]],
    ]);
    expect(groups.at(-1)?.label).toBe("Chats");
    expect(closed.map((c) => c.id)).toEqual(["closed"]);
  });

  it("keeps unread chats where they are when the user does not want them first", () => {
    const { groups } = orderChats(chats, { unreadFirst: false, groupBy: "none" }, undefined, now);
    expect(ids(groups)).toEqual([
      ["pinned", ["pinned1", "pinned2"]],
      ["all", ["new", "tagged", "yesterday", "old"]],
    ]);
  });

  it("groups the rest by date or by kind", () => {
    expect(ids(orderChats(chats, { unreadFirst: false, groupBy: "date" }, undefined, now).groups)).toEqual([
      ["pinned", ["pinned1", "pinned2"]],
      ["today", ["new", "tagged"]],
      ["yesterday", ["yesterday"]],
      ["older", ["old"]],
    ]);
    expect(ids(orderChats(chats, { unreadFirst: true, groupBy: "kind" }, undefined, now).groups)).toEqual([
      ["pinned", ["pinned1", "pinned2"]],
      ["unread", ["tagged", "yesterday"]],
      ["private", ["new"]],
      ["off_record", ["old"]],
    ]);
  });

  it("shows the open chat even when it is closed, and a list with one run has no heading", () => {
    const { groups, closed } = orderChats([chat("a", now), chat("closed", now - 1, { closed: true })], { unreadFirst: true, groupBy: "none" }, "closed", now);
    expect(ids(groups)).toEqual([["all", ["a", "closed"]]]);
    expect(groups[0].label).toBeUndefined();
    expect(closed).toEqual([]);
  });
});
