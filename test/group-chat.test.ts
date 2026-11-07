import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { AgentTurnView, ChatAgentView } from "../shared/agents.ts";
import { matchAgents, matchPicks, splitCalls, type MentionChoice } from "../shared/mentions.ts";
import { calledByLabel, opensRun, queueLines, runMarkerText, turnLine } from "../src/chat/agentLines.ts";
import { FOLD_PX, folds } from "../src/chat/Fold.tsx";
import { phraseOf, workingPhrase } from "../src/chat/phrase.ts";

const label = (tool: string) => `[${tool}]`;
const entry = (id: number, kind: string, model?: object[]) => ({ id, conversationId: 1, kind, model }) as unknown as EntryRecord;
const assistant = (id: number, content: object[]) => entry(id, "pi.assistant", [{ role: "assistant", content, stopReason: "toolUse", timestamp: 0 }]);
const call = (name: string) => ({ type: "toolCall", id: name, name, arguments: {} });

describe("the working line's phrase", () => {
  it("is the text right before the newest tool call, as one short phrase", () => {
    expect(workingPhrase([assistant(2, [{ type: "text", text: "Looking for this week's signups.\n\nThen I chart them." }, call("db__query")])], undefined, label)).toBe(
      "Looking for this week's signups",
    );
    expect(phraseOf("x".repeat(100))).toHaveLength(60);
    expect(phraseOf("  ")).toBeUndefined();
  });

  it("is the call's name when no text came before it, and reads what streams first", () => {
    const entries = [assistant(2, [{ type: "text", text: "Checking the sources." }, call("a")])];
    expect(workingPhrase([...entries, assistant(3, [call("db__query")])], undefined, label)).toBe("[db__query]");
    const streaming = { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Now the regions:" }, call("sheet__read")], timestamp: 0 };
    expect(workingPhrase(entries, streaming as never, label)).toBe("Now the regions");
    // Text that streams after the last call (the answer) says nothing new: the last step's phrase stays.
    expect(workingPhrase(entries, { role: "assistant", content: [{ type: "text", text: "Here" }], timestamp: 0 } as never, label)).toBe("Checking the sources");
  });

  it("is nothing before the run's first call: an earlier run's steps are not this one's", () => {
    const entries = [assistant(2, [{ type: "text", text: "Old step." }, call("a")]), entry(3, "chat.message", [{ role: "user", content: "@pi again", timestamp: 0 }])];
    expect(workingPhrase(entries, undefined, label)).toBeUndefined();
    // An aside written mid-run is no new run.
    const aside = { ...entry(4, "chat.message"), data: { uid: "ana", name: "Ana", text: "fyi", aside: true } } as EntryRecord;
    expect(workingPhrase([...entries.slice(0, 1), aside, entry(5, "chat.aside", [{ role: "user", content: "fyi", timestamp: 0 }])], undefined, label)).toBe("Old step");
  });
});

describe("folding long replies", () => {
  it("folds only a reply well past the fold, so a line or two more never takes a click", () => {
    expect(folds(FOLD_PX)).toBe(false);
    expect(folds(FOLD_PX * 1.3)).toBe(false);
    expect(folds(FOLD_PX * 1.5)).toBe(true);
  });
});

const mentionLabelOf = (choice: MentionChoice) => (choice.mention.kind === "file" ? choice.mention.path : choice.mention.kind === "person" ? choice.mention.name : choice.mention.title);
const agent = (name: string, job: string, over: Partial<ChatAgentView> = {}): ChatAgentView => ({
  id: `id-${name}`,
  name,
  avatar: name.slice(0, 2),
  color: "blue",
  job,
  ownerUid: "o",
  ownerName: "Olga",
  ...over,
});

describe("the @ picker's agents", () => {
  const roster = [
    { name: "pi", job: "the chat's assistant", handleOnly: true },
    agent("research", "Finds sources and numbers"),
    agent("builder", "Makes live pages"),
    agent("planner", "Plans campaigns"),
  ];

  it("offers every agent in the roster's order for a bare @, pi first", () => {
    expect(matchAgents(roster, "").map((a) => a.name)).toEqual(["pi", "research", "builder", "planner"]);
  });

  it("puts handles that start with the query first, then job lines with a word that does, then the rest", () => {
    expect(matchAgents(roster, "p").map((a) => a.name)).toEqual(["pi", "planner", "builder"]);
    expect(matchAgents(roster, "pages").map((a) => a.name)).toEqual(["builder"]);
    expect(matchAgents(roster, "ILD").map((a) => a.name)).toEqual(["builder"]);
    expect(matchAgents(roster, "zzz")).toEqual([]);
    // pi matches only by its handle, never on "the chat's assistant".
    expect(matchAgents(roster, "th")).toEqual([]);
    // A full roster shows whole on a bare "@".
    const full = [roster[0], ...Array.from({ length: 6 }, (_, i) => agent(`a${i}`, "Helps"))];
    expect(matchAgents(full, "")).toHaveLength(7);
  });

  it("lists a person whose name starts with the query before agents that match it only by their job", () => {
    const thomas: MentionChoice = { mention: { kind: "person", uid: "t", name: "Thomas" }, detail: "" };
    const notes: MentionChoice = { mention: { kind: "file", path: "the-notes.md" }, detail: "" };
    const withThe = [...roster, agent("writer", "Drafts the copy")];
    const names = (query: string) => matchPicks(withThe, [notes, thomas], query).map((pick) => ("mention" in pick ? mentionLabelOf(pick) : pick.name));
    expect(names("th")).toEqual(["Thomas", "writer", "the-notes.md"]);
    // A handle that starts with the query keeps the agents first.
    expect(names("pl")).toEqual(["planner"]);
    expect(names("")[0]).toBe("pi");
  });

  it("shows each agent's call in a message as a chip, by its handle, outside words and addresses", () => {
    const parts = splitCalls("@research then @builder, not x@builder.dev or @builders; @PI too", ["research", "builder"]);
    expect(parts.filter((part) => part.call).map((part) => `${part.text}→${part.call}`)).toEqual(["@research→research", "@builder→builder", "@PI→pi"]);
    expect(parts.map((part) => part.text).join("")).toBe("@research then @builder, not x@builder.dev or @builders; @PI too");
  });
});

describe("queue lines and runs", () => {
  it("says who is next and why, with the hand-off count, and how many more wait for one at work", () => {
    const research = agent("research", "Finds", { busy: true, queued: 1, running: { turn: 1, calledBy: { name: "Ana", uid: "a" }, hop: 0, elapsedMs: 0 } });
    const builder = agent("builder", "Builds", { queued: 1, next: { calledBy: { name: "research", agentId: "id-research" }, hop: 1 } });
    const planner = agent("planner", "Plans", { queued: 2, next: { calledBy: { name: "Ana", uid: "a" }, hop: 0 } });
    expect(queueLines([research, builder, planner, agent("idle", "Rests")]).map((line) => line.text)).toEqual([
      "@research has 1 more turn waiting",
      "@builder is next: @research named it · hand-off 1 of 3",
      "@planner is next: Ana asked · 2 turns waiting",
    ]);
  });

  it("says of each past turn who asked, how long it took and how it ended", () => {
    const turn = (over: Partial<AgentTurnView>): AgentTurnView => ({
      id: 1,
      agentId: "r",
      status: "done",
      hop: 0,
      calledBy: { name: "Ana", uid: "a" },
      byOwner: false,
      createdAt: 0,
      startedAt: 1_000,
      endedAt: 15_000,
      ...over,
    });
    expect(turnLine(turn({}), 0)).toBe("Ana asked · 14s · done");
    expect(turnLine(turn({ hop: 2, calledBy: { name: "pi", agentId: "pi" }, status: "failed", endedAt: 1_500 }), 0)).toBe("@pi handed it on · 500ms · failed");
    expect(turnLine(turn({ status: "running", endedAt: undefined }), 7_000)).toBe("Ana asked · 6s · working");
    expect(turnLine(turn({ status: "queued", startedAt: undefined, endedAt: undefined }), 0)).toBe("Ana asked · waiting");
    expect(turnLine(turn({ calledBy: { name: "x", schedule: true } }), 0)).toBe("on its schedule · 14s · done");
  });
});

describe("a run's posts in the chat", () => {
  const owner = { name: "Ana", uid: "ana" };
  const run = { dueAt: 1, why: "schedule" as const };

  it("labels the report by why the run went, and a reply continuing it by who asked", () => {
    expect(calledByLabel({ calledBy: { name: "schedule", schedule: true }, run, turn: 0 })).toBe("on its schedule");
    expect(runMarkerText({ run, turn: 0 })).toBe("From a run");
    expect(runMarkerText({ run: { ...run, why: "test", test: true }, turn: 0 })).toBe("Test run: nothing was sent or changed");
    expect(calledByLabel({ calledBy: owner, run, turn: 7 })).toBe("for Ana");
    expect(runMarkerText({ run, turn: 7 })).toBe("Continues a run");
    expect(runMarkerText({ turn: 3 })).toBeNull();
  });
});

describe("a run post's link", () => {
  it("is only for the agent's owner, who alone can open the run", () => {
    const data = { run: { dueAt: 1, why: "schedule" as const }, ownerUid: "ana" };
    expect(opensRun(data, "ana")).toBe(true);
    expect(opensRun(data, "ben")).toBe(false);
    expect(opensRun({ ownerUid: "ana" }, "ana")).toBe(false);
  });
});
