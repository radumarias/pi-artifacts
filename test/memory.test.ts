import { describe, expect, it } from "vitest";
import type { ChatKind } from "../shared/chat-kinds.ts";
import { checkManifest } from "../shared/data-export.ts";
import {
  checkNoteChange,
  checkNoteInput,
  MAX_NOTE_CHARS,
  MAX_NOTES,
  MAX_RECALLED,
  MAX_UNCONFIRMED,
  MAX_UNCONFIRMED_ALL,
  MEMORY_FORGET_TOOL,
  MEMORY_NOTE_TOOL,
  MEMORY_RECALL_TOOL,
  memorySection,
  placeNote,
  promptNotes,
  reads,
  type MemoryNote,
  type MemoryReader,
  type MemoryWriter,
} from "../shared/memory.ts";
import type { McpToolInfo } from "../worker/agent/mcp.ts";
import { AgentRuns } from "../worker/agents/runs/store.ts";
import { allowedTools } from "../worker/agents/turns.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { CHAT_TURN_KIND } from "../shared/agents.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import { ChatMemory, MAX_RUN_PAGES, runAskedByOwner, type MemoryAgent } from "../worker/memory/chat.ts";
import { coverageOf } from "../worker/memory/coverage.ts";
import { UserMemory } from "../worker/memory/memory.ts";
import { recalledText } from "../worker/memory/tools.ts";
import { memorySql } from "./fakes.ts";

const T0 = 1_000_000;
const PRIVATE = "c1private";
const GROUP = "c2group";
const PAGE = "c3page";
const OFF = "c4off";
const RESEARCH = "a".repeat(16);
const BUILDER = "b".repeat(16);

/** A clock the test moves by hand, a millisecond per read so notes made in a row keep their order. */
function clock(start = T0) {
  let at = start;
  return () => at++;
}

/** The owner's directory as memory sees it: their chats by kind, and their agents. */
function directory(kinds: Record<string, ChatKind> = { [PRIVATE]: "private", [GROUP]: "group", [PAGE]: "page", [OFF]: "off_record" }, start = T0) {
  let changes = 0;
  const memory = new UserMemory(
    memorySql(),
    {
      chatKind: (id) => kinds[id] ?? null,
      chatTitles: () => new Map(Object.keys(kinds).map((id) => [id, `Chat ${id}`])),
      agentNames: () =>
        new Map([
          [RESEARCH, "research"],
          [BUILDER, "builder"],
        ]),
      changed: () => changes++,
    },
    clock(start),
  );
  return { memory, kinds, changes: () => changes };
}

const reader = (chatId: string, kind: ChatKind, alone: boolean, agentId?: string): MemoryReader => ({
  chatId,
  kinds: [kind],
  alone,
  ...(agentId && { agentId }),
});
const writer = (chatId: string, kind: ChatKind, alone: boolean, byOwner: boolean, agentId?: string): MemoryWriter => ({
  ...reader(chatId, kind, alone, agentId),
  byOwner,
  learnedBy: agentId ? "research" : "pi",
});

/** A note the owner wrote, as it is kept. */
function note(change: Partial<MemoryNote>): MemoryNote {
  return {
    id: "000000000001",
    scope: "user",
    text: "Use euros.",
    source: "person",
    kind: "preference",
    uses: 0,
    pinned: false,
    confirmed: true,
    createdAt: T0,
    updatedAt: T0,
    ...change,
  };
}

function saved<T>(result: T | { error: string }): T {
  if (result && typeof result === "object" && "error" in result) throw new Error(result.error);
  return result as T;
}

describe("who reads a note", () => {
  const mine = note({ scope: "user" });
  const agents = note({ scope: "agent", agentId: RESEARCH });
  const chats = note({ scope: "chat", chatId: GROUP });

  it("reads the owner's own notes only where nobody else reads the replies: a private chat with nobody else in it", () => {
    expect(reads(reader(PRIVATE, "private", true), mine)).toBe(true);
    expect(reads(reader(PRIVATE, "private", true, RESEARCH), mine)).toBe(true);
    // A member's turn, or an owner's turn whose reply the members see.
    expect(reads(reader(GROUP, "group", false), mine)).toBe(false);
    expect(reads(reader(GROUP, "group", false, RESEARCH), mine)).toBe(false);
    // A page chat's joiners, and a group whose members all left.
    expect(reads(reader(PAGE, "page", false), mine)).toBe(false);
    expect(reads(reader(GROUP, "group", true), mine)).toBe(false);
    // The strictest of the kinds wins: one copy still saying private does not let them in.
    expect(reads({ chatId: PRIVATE, kinds: ["private", "group"], alone: true }, mine)).toBe(false);
  });

  it("reads an agent's notes only in that agent's sessions, wherever it works, and a chat's only in that chat", () => {
    expect(reads(reader(GROUP, "group", false, RESEARCH), agents)).toBe(true);
    expect(reads(reader(GROUP, "group", false, BUILDER), agents)).toBe(false);
    expect(reads(reader(GROUP, "group", false), agents)).toBe(false);
    expect(reads(reader(GROUP, "group", false), chats)).toBe(true);
    expect(reads(reader(GROUP, "group", false, BUILDER), chats)).toBe(true);
    expect(reads(reader(PAGE, "page", false), chats)).toBe(false);
  });

  it("reads nothing in a chat off the record, nor a note forgotten or waiting for a confirm", () => {
    for (const each of [mine, agents, note({ scope: "chat", chatId: OFF })])
      expect(reads(reader(OFF, "off_record", true, RESEARCH), each)).toBe(false);
    expect(reads({ chatId: PRIVATE, kinds: ["private", null], alone: true }, mine)).toBe(false);
    expect(reads(reader(PRIVATE, "private", true), { ...mine, confirmed: false })).toBe(false);
    expect(reads(reader(PRIVATE, "private", true), { ...mine, forgottenAt: T0 })).toBe(false);
  });
});

describe("where a learned note goes", () => {
  it("refuses everything from a chat off the record", () => {
    expect(placeNote(writer(OFF, "off_record", true, true), "chat", "preference")).toEqual({ error: expect.stringContaining("off the record") });
    expect(placeNote({ ...writer(GROUP, "group", false, true), kinds: ["group", "off_record"] }, "chat", "preference")).toHaveProperty("error");
  });

  it("keeps what is learned in a shared chat with that chat", () => {
    expect(placeNote(writer(GROUP, "group", false, true, RESEARCH), "user", "preference")).toEqual({
      scope: "chat",
      agentId: RESEARCH,
      chatId: GROUP,
      confirmed: true,
      narrowed: true,
    });
    expect(placeNote(writer(PAGE, "page", false, true, RESEARCH), "agent", "preference")).toMatchObject({ scope: "chat", narrowed: true });
    expect(placeNote(writer(PRIVATE, "private", true, true, RESEARCH), "agent", "preference")).toEqual({
      scope: "agent",
      agentId: RESEARCH,
      chatId: PRIVATE,
      confirmed: true,
    });
  });

  it("saves a fact, and anything a turn its owner did not ask for saves, waiting for a confirm", () => {
    expect(placeNote(writer(PRIVATE, "private", true, true), "user", "fact")).toMatchObject({ confirmed: false });
    expect(placeNote(writer(GROUP, "group", false, false), "chat", "preference")).toMatchObject({ confirmed: false });
  });

  it("lets only an agent save a note for itself", () => {
    expect(placeNote(writer(PRIVATE, "private", true, true), "agent", "preference")).toHaveProperty("error");
  });
});

describe("UserMemory", () => {
  it("refuses notes from a chat off the record, whichever copy of its kind says so", () => {
    const { memory, kinds } = directory();
    expect(memory.learn(writer(OFF, "off_record", true, true), { text: "Ana prefers mornings.", scope: "chat", kind: "preference" })).toHaveProperty(
      "error",
    );
    // The chat just went off the record; the owner's sidebar heard first.
    kinds[GROUP] = "off_record";
    expect(memory.learn(writer(GROUP, "group", false, true), { text: "Standup is at nine.", scope: "chat", kind: "preference" })).toHaveProperty(
      "error",
    );
    // A chat that is not the owner's keeps nothing either.
    expect(memory.learn(writer("cXnotmine", "private", true, true), { text: "Use euros.", scope: "user", kind: "preference" })).toHaveProperty(
      "error",
    );
    expect(memory.store.list()).toEqual([]);
    expect(memory.add({ text: "Standup is at nine.", scope: "chat", chatId: OFF })).toHaveProperty("error");
  });

  it("keeps an unconfirmed fact out of every reader until its owner confirms it", () => {
    const { memory } = directory();
    const learned = saved(memory.learn(writer(PRIVATE, "private", true, true), { text: "The Q3 target is 1.2M.", scope: "user", kind: "fact" }));
    expect(learned.note).toMatchObject({ confirmed: false, source: "learned", learnedBy: "pi", chatId: PRIVATE });
    const here = reader(PRIVATE, "private", true);
    expect(memory.read(here).notes).toEqual([]);
    expect(memory.recall(here, "target", []).notes).toEqual([]);
    saved(memory.change(learned.note.id, { confirmed: true }));
    expect(memory.read(here).notes.map((each) => each.text)).toEqual(["The Q3 target is 1.2M."]);
  });

  it("never gives a member's turn the owner's private notes, only the chat's", () => {
    const { memory } = directory();
    saved(memory.add({ text: "My salary is private.", scope: "user" }));
    saved(memory.add({ text: "Standup is at nine.", scope: "chat", chatId: GROUP }));
    saved(memory.add({ text: "Cite sources.", scope: "agent", agentId: RESEARCH }));
    const member = reader(GROUP, "group", false, RESEARCH);
    expect(memory.read(member).notes.map((each) => each.text)).toEqual(["Standup is at nine.", "Cite sources."]);
    expect(memory.recall(member, "salary", []).notes).toEqual([]);
    expect(memory.recall(reader(GROUP, "group", false), "", []).notes).toHaveLength(1);
  });

  it("forgets, shows the forgotten note, and brings it back", () => {
    const { memory } = directory();
    const kept = saved(memory.add({ text: "Use euros.", scope: "user" }));
    const here = reader(PRIVATE, "private", true);
    expect(saved(memory.forget(kept.id)).forgottenAt).toBeGreaterThan(0);
    expect(memory.read(here).notes).toEqual([]);
    expect(memory.list()[0]).toMatchObject({ id: kept.id, forgottenAt: expect.any(Number) });
    // A new note saying the same keeps a forgotten one from coming back twice.
    const again = saved(memory.add({ text: "use  EUROS.", scope: "user" }));
    expect(again.id).not.toBe(kept.id);
    expect(memory.restore(kept.id)).toHaveProperty("error");
    saved(memory.forget(again.id));
    expect(saved(memory.restore(kept.id)).forgottenAt).toBeUndefined();
    expect(memory.read(here).notes.map((each) => each.id)).toEqual([kept.id]);
    expect(memory.delete(again.id)).toBeNull();
    expect(memory.list().map((each) => each.id)).toEqual([kept.id]);
  });

  it("lets the model forget only a note it reads, in a turn its owner asked for", () => {
    const { memory } = directory();
    const mine = saved(memory.add({ text: "Use euros.", scope: "user" }));
    const chats = saved(memory.add({ text: "Standup is at nine.", scope: "chat", chatId: GROUP }));
    expect(memory.forgetFor(writer(GROUP, "group", false, false), chats.id)).toHaveProperty("error");
    expect(memory.forgetFor(writer(GROUP, "group", false, true), mine.id)).toHaveProperty("error");
    expect(saved(memory.forgetFor(writer(GROUP, "group", false, true), chats.id)).forgottenAt).toBeDefined();
    expect(saved(memory.forgetFor(writer(PRIVATE, "private", true, true), mine.id)).forgottenAt).toBeDefined();
  });

  it("counts a use for each recall that returns a note, and when the caller says a prompt held it", () => {
    const { memory } = directory();
    const kept = saved(memory.add({ text: "Use euros.", scope: "user" }));
    const here = reader(PRIVATE, "private", true);
    memory.read(here);
    expect(memory.store.get(kept.id)?.uses).toBe(0);
    memory.recall(here, "euros", []);
    memory.recall(here, "dollars", []);
    memory.use([kept.id, kept.id]);
    expect(memory.store.get(kept.id)?.uses).toBe(2);
  });

  it("keeps one note for the same words for the same reader, confirming it when said again by its owner", () => {
    const { memory } = directory();
    const first = saved(memory.learn(writer(GROUP, "group", false, false), { text: "Standup is at nine.", scope: "chat", kind: "preference" }));
    expect(first.note.confirmed).toBe(false);
    const second = saved(memory.learn(writer(GROUP, "group", false, true), { text: "standup is at nine.", scope: "chat", kind: "preference" }));
    expect(second).toMatchObject({ existed: true, note: { id: first.note.id, confirmed: true } });
    expect(memory.store.list()).toHaveLength(1);
    // A fact waits for the owner's own confirm: said again in a turn, it still waits.
    const fact = saved(memory.learn(writer(PRIVATE, "private", true, true), { text: "The target is 40.", scope: "user", kind: "fact" }));
    expect(
      saved(memory.learn(writer(PRIVATE, "private", true, true), { text: "The target is 40.", scope: "user", kind: "fact" })).note.confirmed,
    ).toBe(false);
    // Nor does saving it as a preference: only the owner's own word confirms a fact.
    expect(
      saved(memory.learn(writer(PRIVATE, "private", true, true), { text: "The target is 40.", scope: "user", kind: "preference" })).note,
    ).toMatchObject({ id: fact.note.id, confirmed: false });
    expect(saved(memory.add({ text: "The target is 40.", scope: "user" })).id).toBe(fact.note.id);
    expect(memory.store.get(fact.note.id)?.confirmed).toBe(true);
  });

  it("lets turns the owner did not ask for fill only their own chat's waiting notes, and dismisses one by deleting it", () => {
    const { memory } = directory();
    for (let i = 0; i < MAX_UNCONFIRMED; i++)
      saved(memory.learn(writer(GROUP, "group", false, false), { text: `Ana says ${i}.`, scope: "chat", kind: "preference" }));
    const refused = memory.learn(writer(GROUP, "group", false, false), { text: "One more.", scope: "chat", kind: "preference" });
    expect(refused).toHaveProperty("error");
    // The owner's own turns still save what waits for their confirm.
    const fact = saved(memory.learn(writer(PRIVATE, "private", true, true), { text: "The target is 40.", scope: "user", kind: "fact" }));
    expect(fact.note.confirmed).toBe(false);
    saved(memory.forget(fact.note.id));
    expect(memory.store.get(fact.note.id)).toBeNull();
  });

  it("never lets saves the owner did not ask for take the owner's room", () => {
    const pages = Array.from({ length: MAX_UNCONFIRMED_ALL / MAX_UNCONFIRMED + 1 }, (_, i) => `page${i}`);
    const { memory } = directory({ [PRIVATE]: "private", spare: "page", ...Object.fromEntries(pages.map((id) => [id, "page" as const])) });
    // Joiners of a few page chats fill each one's waiting room, more than MAX_UNCONFIRMED_ALL in all.
    for (const page of pages)
      for (let i = 0; i < MAX_UNCONFIRMED; i++)
        saved(memory.learn(writer(page, "page", false, false), { text: `Said in ${page}: ${i}.`, scope: "chat", kind: "preference" }));
    const fact = saved(memory.learn(writer(PRIVATE, "private", true, true), { text: "The target is 40.", scope: "user", kind: "fact" }));
    expect(fact.note.confirmed).toBe(false);
    // And the owner keeps MAX_NOTES of their own besides.
    for (let i = 1; i < MAX_NOTES; i++) saved(memory.add({ text: `Rule ${i}.`, scope: "user" }));
    expect(memory.add({ text: "One too many.", scope: "user" })).toHaveProperty("error");
    // Theirs then wait no more: there is no room left.
    expect(memory.learn(writer("spare", "page", false, false), { text: "Another.", scope: "chat", kind: "preference" })).toHaveProperty("error");
  });

  it("holds at most MAX_UNCONFIRMED notes waiting for a confirm", () => {
    const { memory } = directory();
    for (let i = 0; i < MAX_UNCONFIRMED; i++)
      saved(memory.learn(writer(PRIVATE, "private", true, true), { text: `Fact ${i}.`, scope: "user", kind: "fact" }));
    expect(memory.learn(writer(PRIVATE, "private", true, true), { text: "One more fact.", scope: "user", kind: "fact" })).toHaveProperty("error");
    expect(memory.learn(writer(PRIVATE, "private", true, true), { text: "A preference.", scope: "user", kind: "preference" })).not.toHaveProperty(
      "error",
    );
  });

  it("moves a chat's note to the owner's own, and never into a chat off the record or to someone else's agent", () => {
    const { memory } = directory();
    const chats = saved(memory.add({ text: "Standup is at nine.", scope: "chat", chatId: GROUP }));
    expect(saved(memory.change(chats.id, { scope: "user" }))).toMatchObject({ scope: "user", chatId: GROUP });
    expect(memory.change(chats.id, { scope: "chat", chatId: OFF })).toHaveProperty("error");
    expect(memory.change(chats.id, { scope: "agent", agentId: "c".repeat(16) })).toHaveProperty("error");
    expect(saved(memory.change(chats.id, { scope: "agent", agentId: RESEARCH, pinned: true }))).toMatchObject({
      scope: "agent",
      agentId: RESEARCH,
      pinned: true,
    });
  });

  it("goes with a deleted chat or agent", () => {
    const { memory } = directory();
    saved(memory.add({ text: "Standup is at nine.", scope: "chat", chatId: GROUP }));
    saved(memory.add({ text: "Cite sources.", scope: "agent", agentId: RESEARCH }));
    const learned = saved(
      memory.learn(writer(PRIVATE, "private", true, true, RESEARCH), { text: "Use euros.", scope: "user", kind: "preference" }),
    ).note;
    memory.forgetChat(GROUP);
    memory.forgetAgent(RESEARCH);
    expect(memory.store.list()).toEqual([expect.objectContaining({ id: learned.id, scope: "user", chatId: PRIVATE })]);
    expect(memory.store.get(learned.id)?.agentId).toBeUndefined();
  });

  it("exports and imports notes, never one of a chat off the record, mapping the agents' ids", () => {
    const from = directory();
    saved(from.memory.add({ text: "Use euros.", scope: "user", pinned: true }));
    saved(from.memory.add({ text: "Cite sources.", scope: "agent", agentId: RESEARCH }));
    saved(from.memory.add({ text: "Standup is at nine.", scope: "chat", chatId: GROUP }));
    // The chat went off the record after the note was kept.
    from.kinds[GROUP] = "off_record";
    const exported = from.memory.exported();
    expect(exported.map((each) => each.text)).toEqual(["Cite sources.", "Use euros."]);

    const to = directory({ [PRIVATE]: "private" });
    const results = to.memory.import([...exported, note({ id: "00000000000f", scope: "chat", chatId: GROUP, text: "Old chat." })], {
      [RESEARCH]: BUILDER,
    });
    expect(results.map((result) => ("error" in result ? "error" : "ok"))).toEqual(["ok", "ok", "error"]);
    expect(to.memory.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Cite sources.", agentId: BUILDER }),
        expect.objectContaining({ text: "Use euros.", pinned: true }),
      ]),
    );
    // Imported again, nothing is added.
    expect(to.memory.import(exported, { [RESEARCH]: BUILDER })).toEqual([
      expect.objectContaining({ skipped: true }),
      expect.objectContaining({ skipped: true }),
    ]);
    expect(to.memory.import([{ text: "not a note" }])).toEqual([expect.objectContaining({ error: expect.any(String) })]);
  });

  it("keeps a note's times on import, never later than now", () => {
    const to = directory(undefined, T0 + 1_000);
    const results = to.memory.import([
      note({ id: "00000000000a", text: "Old rule.", createdAt: T0 - 50, updatedAt: T0 - 10 }),
      note({ id: "00000000000b", text: "From later.", createdAt: T0 + 5_000, updatedAt: T0 + 6_000 }),
    ]);
    expect(results).toEqual([{ id: "00000000000a" }, { id: "00000000000b" }]);
    expect(to.memory.list().find((each) => each.id === "00000000000a")).toMatchObject({ createdAt: T0 - 50, updatedAt: T0 - 10 });
    // Capped at the clock's now then (it ticks once a read).
    const later = to.memory.list().find((each) => each.id === "00000000000b");
    expect(later?.createdAt).toBeLessThan(T0 + 1_010);
    expect(later?.updatedAt).toBe(later?.createdAt);
  });

  it("imports a forgotten note once, and never brings back one forgotten here", () => {
    const owner = directory();
    const gone = saved(owner.memory.add({ text: "Old rule.", scope: "user" }));
    const kept = saved(owner.memory.add({ text: "Use euros.", scope: "user" }));
    saved(owner.memory.forget(gone.id));
    const exported = owner.memory.exported();
    saved(owner.memory.forget(kept.id));
    expect(owner.memory.import(exported)).toEqual([
      { id: kept.id, skipped: true },
      { id: gone.id, skipped: true },
    ]);
    expect(owner.memory.list()).toHaveLength(2);
    expect(owner.memory.list().every((each) => each.forgottenAt !== undefined)).toBe(true);
  });

  it("edits a forgotten note even when one in use says the same", () => {
    const owner = directory();
    const gone = saved(owner.memory.add({ text: "Old rule.", scope: "user" }));
    saved(owner.memory.forget(gone.id));
    saved(owner.memory.add({ text: "Use euros.", scope: "user" }));
    expect(owner.memory.change(gone.id, { text: "Use euros." })).toMatchObject({ text: "Use euros." });
    expect(owner.memory.restore(gone.id)).toHaveProperty("error");
  });

  it("checks what the Memory view sends", () => {
    expect(checkNoteInput({ text: "  Use   euros. " })).toEqual({ text: "Use euros.", scope: "user" });
    expect(checkNoteInput({ text: "x".repeat(MAX_NOTE_CHARS + 1) })).toHaveProperty("error");
    expect(checkNoteInput({ text: "Hi", scope: "chat" })).toHaveProperty("error");
    expect(checkNoteChange({ confirmed: false })).toHaveProperty("error");
    expect(checkNoteChange({ pinned: "yes" })).toHaveProperty("error");
    expect(checkNoteChange({ scope: "agent", agentId: RESEARCH, text: "Cite." })).toEqual({ scope: "agent", agentId: RESEARCH, text: "Cite." });
  });
});

describe("the prompt's notes", () => {
  it("keeps pinned and the newest notes within the budget, in the order they were made", () => {
    const notes = [
      note({ id: "000000000001", text: "a".repeat(40), createdAt: 1, updatedAt: 1, uses: 9 }),
      note({ id: "000000000002", text: "b".repeat(40), createdAt: 2, updatedAt: 2 }),
      note({ id: "000000000003", text: "c".repeat(40), createdAt: 3, updatedAt: 3, pinned: true }),
    ];
    expect(promptNotes(notes, 160).map((each) => each.id)).toEqual(["000000000002", "000000000003"]);
    expect(promptNotes(notes).map((each) => each.id)).toEqual(["000000000001", "000000000002", "000000000003"]);
  });

  it("lets a new note in when the budget is full, whatever the older ones' uses", () => {
    const { memory } = directory();
    const old = saved(memory.add({ text: `Report in USD. ${"x".repeat(150)}`, scope: "user" }));
    // Three prompts held it (a use counts once per call).
    for (let n = 0; n < 3; n++) memory.use([old.id]);
    for (let n = 0; n < 25; n++) {
      const each = saved(memory.add({ text: `Older note ${n}. ${"y".repeat(150)}`, scope: "user" }));
      memory.use([each.id]);
    }
    // As long as the rest: it gets in only by its rank, not into room a longer one left.
    const fresh = saved(memory.add({ text: `Report in EUR. ${"z".repeat(150)}`, scope: "user" }));
    const { notes, more } = memory.read(reader(PRIVATE, "private", true));
    expect(more).toBeGreaterThan(0);
    expect(notes.map((each) => each.id)).toContain(fresh.id);
    expect(notes.map((each) => each.id)).not.toContain(old.id);
  });

  it("always says something, and nothing of notes off the record", () => {
    expect(memorySection({ kinds: ["off_record"] }, [note({})])).not.toContain("Use euros.");
    expect(memorySection({ kinds: ["private"] }, [])).toContain(MEMORY_NOTE_TOOL);
    const text = memorySection({ kinds: ["private"] }, [note({})], 2);
    expect(text).toContain("- [000000000001] (about the owner) Use euros.");
    expect(text).toContain("2 more notes");
  });
});

describe("ChatMemory", () => {
  /**
   * A chat of the owner's: its kind, who is in it (both may change: `state`), the agent each session is, whether pi's
   * turn answers the owner, and the conversations whose prompt was started afresh.
   */
  function chat(chatId: string, kind: ChatKind, alone: boolean, owner = directory()) {
    const state: { kind: ChatKind; alone: boolean; piByOwner: boolean; compacting?: Promise<unknown>; placed?: Promise<unknown> } = {
      kind,
      alone,
      piByOwner: true,
    };
    const sessions = new Map<string, MemoryAgent>();
    const kv = new Map<string, unknown>();
    const fresh: (string | undefined)[] = [];
    let used: string[] = [];
    const memory = new ChatMemory({
      ownerUid: "owner",
      chatId,
      kind: () => state.kind,
      alone: () => state.alone,
      agentFor: (conversation) => sessions.get(conversation) ?? null,
      piByOwner: async () => state.piByOwner,
      freshPrompt: async (conversation) => {
        fresh.push(conversation);
        return { placed: state.placed ?? Promise.resolve(), ...(state.compacting && { compacting: state.compacting }) };
      },
      directory: () => ({
        readNotes: (reader) => owner.memory.read(reader),
        useNotes: (ids) => {
          used = [...used, ...ids];
          owner.memory.use(ids);
        },
        recallNotes: (reader, query, shown, offset) => owner.memory.recall(reader, query, shown, offset),
        learnNote: (writer, input) => owner.memory.learn(writer, input),
        forgetNoteFor: (writer, id) => owner.memory.forgetFor(writer, id),
      }),
      kv: { get: <T>(key: string) => kv.get(key) as T | undefined, put: (key: string, value: unknown) => void kv.set(key, value) },
    });
    return { memory, host: memory.host(), sessions, owner, state, fresh, used: () => used };
  }

  it("gives pi in a shared chat only the chat's notes, and saves what it learns there for the owner to confirm", async () => {
    const owner = directory();
    saved(owner.memory.add({ text: "My salary is private.", scope: "user" }));
    saved(owner.memory.add({ text: "Standup is at nine.", scope: "chat", chatId: GROUP }));
    const { host } = chat(GROUP, "group", false, owner);
    const section = await host.section("root");
    expect(section).toContain("Standup is at nine.");
    expect(section).not.toContain("salary");
    const learned = saved(await host.note("root", { text: "Ana runs the demo.", scope: "user", kind: "preference" }));
    expect(learned).toMatchObject({ narrowed: true, note: { scope: "chat", chatId: GROUP, confirmed: false } });
    expect(await host.forget("root", learned.note.id)).toHaveProperty("error");
  });

  it("gives an agent's session its own notes, and lets only its owner's turn save and forget", async () => {
    const owner = directory();
    const { host, sessions } = chat(PRIVATE, "private", true, owner);
    sessions.set("s1", { agentId: RESEARCH, ownerUid: "owner", name: "research", byOwner: true });
    const kept = saved(await host.note("s1", { text: "Cite sources.", scope: "agent", kind: "preference" }));
    expect(kept.note).toMatchObject({ scope: "agent", agentId: RESEARCH, confirmed: true, learnedBy: "research" });
    sessions.set("s1", { agentId: RESEARCH, ownerUid: "owner", name: "research", byOwner: false });
    expect(await host.forget("s1", kept.note.id)).toHaveProperty("error");
    // A hand-off saves only what waits for a confirm.
    expect(saved(await host.note("s1", { text: "Prefer short answers.", scope: "agent", kind: "preference" })).note.confirmed).toBe(false);
    expect((await host.recall("s1", "")).notes).toEqual([expect.objectContaining({ text: "Cite sources." })]);
  });

  it("keeps a conversation's section for its turn, and counts a note's use once per conversation", async () => {
    const owner = directory();
    const kept = saved(owner.memory.add({ text: "Use euros.", scope: "user" }));
    const { memory, host, used } = chat(PRIVATE, "private", true, owner);
    expect(await memory.refresh()).toContain("Use euros.");
    saved(owner.memory.add({ text: "Short answers.", scope: "user" }));
    // The same turn: the section stays as it started.
    expect(await host.section("root")).not.toContain("Short answers.");
    const next = await memory.refresh();
    expect(next.indexOf("Use euros.")).toBeLessThan(next.indexOf("Short answers."));
    await memory.refresh();
    expect(used().filter((id) => id === kept.id)).toHaveLength(1);
    expect(owner.memory.store.get(kept.id)?.uses).toBe(1);
  });

  it("reads the section again once the chat is shared, never keeping the owner's own notes in it", async () => {
    const owner = directory();
    saved(owner.memory.add({ text: "My salary is private.", scope: "user" }));
    const { memory, host, state, fresh, sessions } = chat(PRIVATE, "private", true, owner);
    sessions.set("s1", { agentId: RESEARCH, ownerUid: "owner", name: "research", byOwner: true });
    expect(await memory.refresh()).toContain("salary");
    expect(await memory.refresh("s1")).toContain("salary");
    state.alone = false;
    state.kind = "group";
    expect(await host.section("root")).not.toContain("salary");
    // Every conversation whose prompt held them starts it afresh, and only once.
    await memory.audienceChanged();
    expect(fresh).toEqual([undefined, "s1"]);
    await memory.refresh();
    await memory.audienceChanged();
    expect(fresh).toHaveLength(2);
  });

  it("starts a prompt afresh at the next turn when the audience changed while nobody was told", async () => {
    const owner = directory();
    saved(owner.memory.add({ text: "My salary is private.", scope: "user" }));
    const { memory, state, fresh } = chat(PRIVATE, "private", true, owner);
    await memory.refresh();
    state.kind = "group";
    expect(await memory.refresh()).not.toContain("salary");
    expect(fresh).toEqual([undefined]);
  });

  it("starts a prompt afresh again once a compaction it could not stop has placed its summary", async () => {
    const owner = directory();
    saved(owner.memory.add({ text: "My salary is private.", scope: "user" }));
    const { memory, host, state, fresh } = chat(PRIVATE, "private", true, owner);
    await memory.refresh();
    let settled!: () => void;
    state.compacting = new Promise<void>((resolve) => (settled = resolve));
    state.kind = "group";
    await memory.audienceChanged();
    expect(fresh).toEqual([undefined]);
    // Until the edits that leave it out are in, each request leaves the summary out itself.
    expect(host.leavesOutSummaries("root")).toBe(true);
    state.compacting = undefined;
    let placed!: () => void;
    state.placed = new Promise<void>((resolve) => (placed = resolve));
    settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fresh).toEqual([undefined, undefined]);
    expect(host.leavesOutSummaries("root")).toBe(true);
    placed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.leavesOutSummaries("root")).toBe(false);
    // Done then: nothing more to leave out.
    await memory.refresh();
    expect(fresh).toHaveLength(2);
  });

  it("lets pi save as the owner only in a turn that answers the owner's own message", async () => {
    const owner = directory();
    const { host, state } = chat(PRIVATE, "private", true, owner);
    state.piByOwner = false;
    const handed = saved(await host.note("root", { text: "Use dollars.", scope: "user", kind: "preference" }));
    expect(handed.note.confirmed).toBe(false);
    const kept = saved(owner.memory.add({ text: "Use euros.", scope: "user" }));
    expect(await host.forget("root", kept.id)).toHaveProperty("error");
    state.piByOwner = true;
    expect(saved(await host.note("root", { text: "Short answers.", scope: "user", kind: "preference" })).note.confirmed).toBe(true);
  });

  it("tells pi's run is the owner's only when every input since its last run is the owner's own message", async () => {
    let id = 0;
    const entry = (kind: string, extra: Partial<EntryRecord> = {}) => ({ id: id++, conversationId: "1", kind, ...extra }) as unknown as EntryRecord;
    const message = (uid: string, aside = false) => entry(CHAT_MESSAGE_KIND, { data: { uid, name: uid, text: "hi", ...(aside && { aside: true }) } });
    const reply = (stopReason: string) => entry("pi.assistant", { model: [{ role: "assistant", content: [], stopReason } as never] });
    // Newest first, as the log is read.
    const asked = (...newestFirst: EntryRecord[]) =>
      runAskedByOwner(
        (async function* () {
          yield newestFirst;
        })(),
        "owner",
      );
    expect(await asked(reply("toolUse"), message("owner"), reply("stop"), entry(CHAT_TURN_KIND))).toBe(true);
    // A hand-off in the run, even with the owner's message after it (steered in, or the run resumed after a restart).
    expect(await asked(reply("toolUse"), message("owner"), entry(CHAT_TURN_KIND), reply("stop"))).toBe(false);
    // A member's message in the run, before the chat was made private again.
    expect(await asked(reply("toolUse"), message("owner"), message("ana"), reply("stop"))).toBe(false);
    // Asides are not inputs; the conversation's first run goes back to the start of the log; no input is no one's.
    expect(await asked(reply("toolUse"), message("ana", true), message("owner"))).toBe(true);
    expect(await asked(reply("toolUse"))).toBe(false);
    // A failed request retried in the run does not end it; a run that ended in one is read over more inputs.
    expect(await asked(reply("toolUse"), reply("error"), message("owner"), reply("stop"))).toBe(true);
    expect(await asked(reply("toolUse"), reply("error"), message("owner"), entry(CHAT_TURN_KIND), reply("stop"))).toBe(false);
    // A run longer than it reads is not judged the owner's.
    const long = (async function* () {
      for (let page = 0; page <= MAX_RUN_PAGES; page++) yield [reply("toolUse")];
      yield [message("owner")];
    })();
    expect(await runAskedByOwner(long, "owner")).toBe(false);
  });

  it("never gives a run's sessions the owner's own notes, as their reports reach other chats", async () => {
    const owner = directory();
    saved(owner.memory.add({ text: "My salary is private.", scope: "user" }));
    saved(owner.memory.add({ text: "Cite sources.", scope: "agent", agentId: RESEARCH }));
    const { memory, sessions } = chat(PRIVATE, "private", true, owner);
    sessions.set("run", { agentId: RESEARCH, ownerUid: "owner", name: "research", byOwner: false, run: true });
    const section = await memory.refresh("run");
    expect(section).toContain("Cite sources.");
    expect(section).not.toContain("salary");
  });

  it("recalls first the notes the prompt does not hold", async () => {
    const owner = directory();
    for (let n = 0; n < 30; n++) saved(owner.memory.add({ text: `Note number ${n} ${"x".repeat(150)}.`, scope: "user" }));
    const { memory, host } = chat(PRIVATE, "private", true, owner);
    const section = await memory.refresh();
    const notShown = owner.memory.list().filter((note) => !section.includes(note.text)).length;
    expect(notShown).toBeGreaterThan(0);
    const found = await host.recall("root", "");
    expect(found.notes.slice(0, notShown).every((note) => !section.includes(note.text))).toBe(true);
  });

  it("pages through the notes that match, saying how many more there are", async () => {
    const owner = directory();
    for (let n = 0; n < MAX_RECALLED + 5; n++) saved(owner.memory.add({ text: `Note number ${n}.`, scope: "user" }));
    const { host } = chat(PRIVATE, "private", true, owner);
    const first = await host.recall("root", "note");
    expect(first.total).toBe(MAX_RECALLED + 5);
    expect(recalledText(first.notes, first.total, 0)).toContain(`5 more match: call again with offset ${MAX_RECALLED}.`);
    const rest = await host.recall("root", "note", MAX_RECALLED);
    expect(rest.notes).toHaveLength(5);
    expect(new Set([...first.notes, ...rest.notes].map((note) => note.id)).size).toBe(MAX_RECALLED + 5);
    expect(recalledText(rest.notes, rest.total, MAX_RECALLED)).not.toContain("more match");
  });

  it("says nothing is read or saved where the owner's directory refuses, as the tools do", async () => {
    // The sidebar already says off the record; the chat object lags.
    const owner = directory({ [GROUP]: "off_record" });
    const { host } = chat(GROUP, "group", false, owner);
    expect(await host.section("root")).toContain("off the record");
    expect(await host.note("root", { text: "Ana runs the demo.", scope: "chat", kind: "preference" })).toHaveProperty("error");
  });

  it("reads and saves nothing in a chat off the record", async () => {
    const owner = directory();
    saved(owner.memory.add({ text: "Use euros.", scope: "user" }));
    const { host } = chat(OFF, "off_record", true, owner);
    expect(await host.section("root")).toContain("off the record");
    expect(await host.section("root")).not.toContain("euros");
    expect(await host.note("root", { text: "Secret plan.", scope: "chat", kind: "preference" })).toHaveProperty("error");
    expect((await host.recall("root", "")).notes).toEqual([]);
  });
});

describe("memory tools for agents' turns", () => {
  it("offers memory_recall to any turn, and memory_note and memory_forget only to its owner's", () => {
    const tools = ["artifact_read", MEMORY_NOTE_TOOL, MEMORY_RECALL_TOOL, MEMORY_FORGET_TOOL];
    const mcp = new Map<string, McpToolInfo>();
    expect(allowedTools(tools, mcp, {}, false, () => false)).toEqual(["artifact_read", MEMORY_RECALL_TOOL]);
    expect(allowedTools(tools, mcp, {}, true, () => false)).toEqual(tools);
  });
});

describe("what servers cover", () => {
  it("keeps the start of a server's instructions and a few tool names", () => {
    const tools = Array.from({ length: 9 }, (_, i) => ({ name: `tool_${i}`, description: "" }));
    const [server] = coverageOf(new Map([["crm", { tools, instructions: `Deals and   contacts. ${"x".repeat(400)}` }]]), 5);
    expect(server).toMatchObject({ name: "crm", tools: 9, some: tools.slice(0, 6).map((tool) => tool.name), listedAt: 5 });
    expect(server.about?.startsWith("Deals and contacts.")).toBe(true);
    expect(server.about?.endsWith("…")).toBe(true);
  });
});

describe("export manifest", () => {
  it("refuses memory that is not a list", () => {
    const manifest = {
      format: "pi-artifacts-export",
      version: 2,
      uid: "u",
      chats: [],
      artifacts: [],
      files: [],
      sharedWithMe: [],
      account: { skills: [], memory: {} },
    };
    expect(checkManifest(manifest)).toHaveProperty("error");
    expect(checkManifest({ ...manifest, account: { skills: [], memory: [] } })).not.toHaveProperty("error");
  });
});

describe("a run's sessions", () => {
  it("are its agent's, so its turns read that agent's notes and never pi's", async () => {
    const runs = new AgentRuns(memorySql(), () => 1_000);
    // Sessions are numbers, as pi gives them; pi's own is "1".
    runs.begin(RESEARCH, 500, "schedule", false);
    await runs.beginItem(RESEARCH, 500, "", "", async () => "7");
    runs.setReplySession(RESEARCH, 500, "8");
    runs.update(RESEARCH, 500, { detail: { sessions: { "2": "9" }, sent: ["1"], when: "1" } });
    for (const session of ["7", "8", "9"]) expect(runs.agentOfSession(session)).toBe(RESEARCH);
    // Only where sessions are kept: a delivery key, a sent list or any other value of the detail is none.
    for (const session of ["1", "2"]) expect(runs.agentOfSession(session)).toBeNull();
  });
});
