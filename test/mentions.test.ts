import { describe, expect, it } from "vitest";
import { activeQuery, keptMentions, matchMentions, parseMentions, splitMentions, type Mention, type MentionChoice } from "../shared/mentions.ts";
import type { ArtifactMeta } from "../shared/protocol.ts";
import { resolveMentions } from "../worker/agent/mentions.ts";

const file = (path: string): MentionChoice => ({ mention: { kind: "file", path }, detail: "" });
const artifact = (id: string, title: string): MentionChoice => ({ mention: { kind: "artifact", id, title }, detail: "" });

describe("activeQuery", () => {
  it("follows an @ at the start or after a space, up to the caret", () => {
    expect(activeQuery("@sal", 4)).toEqual({ start: 0, query: "sal" });
    expect(activeQuery("look at @q3/sa", 14)).toEqual({ start: 8, query: "q3/sa" });
    expect(activeQuery("look at @", 9)).toEqual({ start: 8, query: "" });
    expect(activeQuery("two\n@x", 6)).toEqual({ start: 4, query: "x" });
  });

  it("ignores an @ inside a word, after a line break in the query, or none at all", () => {
    expect(activeQuery("mail ada@example.com", 20)).toBeNull();
    expect(activeQuery("@abc\nmore", 9)).toBeNull();
    expect(activeQuery("no mention", 10)).toBeNull();
  });

  it("looks only before the caret", () => {
    expect(activeQuery("@abc and more", 4)).toEqual({ start: 0, query: "abc" });
  });
});

describe("matchMentions", () => {
  const choices = [
    file("uploads/reports/q3/sales.csv"),
    file("uploads/wholesale.csv"),
    file("uploads/prices.csv"),
    artifact("aaaaaaaa", "Sales dashboard"),
    artifact("bbbbbbbb", "Crypto prices"),
  ];

  it("ranks names that start with the query first, artifacts before files", () => {
    expect(matchMentions(choices, "sal").map((c) => c.mention)).toEqual([
      { kind: "artifact", id: "aaaaaaaa", title: "Sales dashboard" },
      { kind: "file", path: "uploads/reports/q3/sales.csv" },
      { kind: "file", path: "uploads/wholesale.csv" },
    ]);
  });

  it("matches words and paths, ignoring case", () => {
    expect(matchMentions(choices, "PRICES").map((c) => c.mention.kind)).toEqual(["artifact", "file"]);
    expect(matchMentions(choices, "q3").map((c) => (c.mention.kind === "file" ? c.mention.path : ""))).toEqual(["uploads/reports/q3/sales.csv"]);
  });

  it("offers everything, in order, for an empty query, up to the limit of each kind", () => {
    expect(matchMentions(choices, "", 2)).toHaveLength(4);
  });
});

describe("mentions in text", () => {
  const picked: Mention[] = [
    { kind: "file", path: "uploads/sales.csv" },
    { kind: "artifact", id: "aaaaaaaa", title: "Sales dashboard" },
  ];

  it("keeps only the picks still in the text", () => {
    expect(keptMentions("compare @uploads/sales.csv with last week", picked)).toEqual([picked[0]]);
  });

  it("splits text into plain runs and mentions", () => {
    expect(splitMentions("use @uploads/sales.csv in @Sales dashboard!", picked)).toEqual(["use ", picked[0], " in ", picked[1], "!"]);
    expect(splitMentions("email@uploads/sales.csv", [])).toEqual(["email@uploads/sales.csv"]);
  });

  it("prefers the longest token at one place", () => {
    const both: Mention[] = [
      { kind: "artifact", id: "aaaaaaaa", title: "Sales" },
      { kind: "artifact", id: "bbbbbbbb", title: "Sales dashboard" },
    ];
    expect(splitMentions("@Sales dashboard", both)).toEqual([both[1]]);
  });
});

describe("parseMentions", () => {
  it("takes files by path and artifacts by id, without repeats", () => {
    expect(
      parseMentions(
        [
          { kind: "file", path: "uploads/a.csv" },
          { kind: "artifact", id: "abcdefgh" },
          { kind: "file", path: "uploads/a.csv" },
        ],
      ),
    ).toEqual([
      { kind: "file", path: "uploads/a.csv" },
      { kind: "artifact", id: "abcdefgh" },
    ]);
    expect(parseMentions(undefined)).toEqual([]);
  });

  it("refuses anything else", () => {
    expect(() => parseMentions("x")).toThrow();
    expect(() => parseMentions([{ kind: "artifact", id: "../x" }])).toThrow();
    expect(() => parseMentions([{ kind: "user", id: "ada" }])).toThrow();
    expect(() => parseMentions(Array.from({ length: 21 }, (_, i) => ({ kind: "file", path: `a${i}` })))).toThrow();
  });
});

describe("resolveMentions", () => {
  const meta = (id: string, ownerUid: string, chatId: string): ArtifactMeta =>
    ({ id, title: `Page ${id}`, ownerUid, chatId, latest: 3, versions: [], createdAt: 0, updatedAt: 0 }) as unknown as ArtifactMeta;
  const metas = new Map([
    ["herechat", meta("herechat", "ada", "chat1")],
    ["elsewher", meta("elsewher", "ada", "chat2")],
    ["notadas1", meta("notadas1", "bob", "chat9")],
  ]);
  const scope = (byOwner: boolean) => ({ ownerUid: "ada", chatId: "chat1", byOwner, readMeta: async (id: string) => metas.get(id) ?? null });

  it("names files by path and the owner's artifacts by id for the model", async () => {
    const { mentions, note, broughtIn } = await resolveMentions(
      [
        { kind: "file", path: " uploads/a.csv" },
        { kind: "artifact", id: "herechat" },
        { kind: "artifact", id: "elsewher" },
      ],
      scope(true),
    );
    expect(mentions).toEqual([
      { kind: "file", path: "uploads/a.csv" },
      { kind: "artifact", id: "herechat", title: "Page herechat" },
      { kind: "artifact", id: "elsewher", title: "Page elsewher" },
    ]);
    expect(note).toContain("the file uploads/a.csv");
    expect(note).toContain('the artifact "Page herechat" (artifact_id herechat, version 3, published in this chat)');
    expect(note).toContain('"Page elsewher" (artifact_id elsewher, version 3, from another chat)');
    expect(broughtIn).toEqual(["elsewher"]);
  });

  it("drops another user's artifacts, bad paths, and for a member the owner's other chats", async () => {
    const inputs = [
      { kind: "artifact" as const, id: "notadas1" },
      { kind: "artifact" as const, id: "missingx" },
      { kind: "file" as const, path: "../bob/files/x" },
      { kind: "artifact" as const, id: "elsewher" },
      { kind: "artifact" as const, id: "herechat" },
    ];
    const { mentions, broughtIn } = await resolveMentions(inputs, scope(false));
    expect(mentions).toEqual([{ kind: "artifact", id: "herechat", title: "Page herechat" }]);
    expect(broughtIn).toEqual([]);
    expect((await resolveMentions([], scope(true))).note).toBe("");
  });
});
