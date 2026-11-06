import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { historyStep, ownMessages, type Recalled } from "../src/chat/history.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";

let id = 0;
const entry = (kind: string, fields: Partial<EntryRecord>): EntryRecord => ({ id: ++id, conversationId: 1, kind, ...fields }) as never;
const said = (uid: string, text: string, extra: object = {}) =>
  entry(CHAT_MESSAGE_KIND, { data: { uid, name: uid, text, sentAt: id * 10, ...extra } } as never);
const legacy = (text: string) =>
  entry("pi.user", { model: [{ role: "user", content: [{ type: "text", text }, { type: "image" }], timestamp: 5 }] } as never);
const reply = () => entry("pi.assistant", { model: [{ role: "assistant", content: [], timestamp: 1 }] } as never);

describe("the viewer's earlier messages", () => {
  it("lists only the viewer's, newest first, each text once where it was last sent", () => {
    const entries = [said("me", "one"), reply(), said("bob", "theirs"), said("me", "two"), said("me", "one"), said("me", "  ")];
    const texts = ownMessages(entries, "me", true).map((message) => message.text);
    expect(texts).toEqual(["one", "two"]);
    expect(ownMessages(entries, "me", true)[0].id).toBe(entries[4].id);
  });

  it("keeps what a message named, to send it with the text again", () => {
    const mentions = [{ kind: "file", path: "data/sales.csv" }];
    expect(ownMessages([said("me", "plot @sales.csv", { mentions })], "me", false)[0].mentions).toEqual(mentions);
  });

  it("counts a message from before chats kept who wrote it as the owner's, by its text", () => {
    const entries = [legacy("old one")];
    expect(ownMessages(entries, "me", true)).toEqual([{ id: entries[0].id, text: "old one", sentAt: 5 }]);
    expect(ownMessages(entries, "bob", false)).toEqual([]);
  });
});

describe("Up and Down in the composer", () => {
  const history: Recalled[] = [
    { id: 3, text: "newest" },
    { id: 2, text: "two\nlines" },
    { id: 1, text: "oldest" },
  ];
  const at = (n: number) => ({ start: n, end: n });

  it("Up in an empty box brings back the newest, and goes on to older ones", () => {
    expect(historyStep(history, undefined, "", at(0), -1)).toBe(history[0]);
    expect(historyStep(history, 3, "newest", at(6), -1)).toBe(history[1]);
    expect(historyStep(history, 1, "oldest", at(6), -1)).toBeUndefined();
  });

  it("leaves the arrows to the caret in a typed or edited message", () => {
    expect(historyStep(history, undefined, "draft", at(0), -1)).toBeUndefined();
    expect(historyStep(history, 3, "newest!", at(7), -1)).toBeUndefined();
    expect(historyStep(history, 3, "newest!", at(7), 1)).toBeUndefined();
    expect(historyStep(history, undefined, "", at(0), 1)).toBeUndefined();
  });

  it("moves the caret between lines of a message brought back before stepping", () => {
    // At the end (where it lands) Up steps on; on the second line elsewhere it moves the caret.
    expect(historyStep(history, 2, "two\nlines", at(9), -1)).toBe(history[2]);
    expect(historyStep(history, 2, "two\nlines", at(6), -1)).toBeUndefined();
    expect(historyStep(history, 2, "two\nlines", at(2), -1)).toBe(history[2]);
    expect(historyStep(history, 2, "two\nlines", at(2), 1)).toBeUndefined();
    expect(historyStep(history, 2, "two\nlines", at(6), 1)).toBe(history[0]);
  });

  it("Down past the newest gives back the draft, and a selection is left alone", () => {
    expect(historyStep(history, 3, "newest", at(6), 1)).toBeNull();
    expect(historyStep(history, 3, "newest", { start: 0, end: 6 }, -1)).toBeUndefined();
  });
});
