import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { firstNew } from "../src/chat/entries.ts";
import { CHAT_MESSAGE_KIND, CHAT_PEOPLE_KIND } from "../shared/protocol.ts";

let id = 0;
const entry = (kind: string, fields: Partial<EntryRecord>): EntryRecord => ({ id: ++id, conversationId: 1, kind, ...fields }) as never;
const said = (uid: string, sentAt: number, aside = false) =>
  entry(CHAT_MESSAGE_KIND, { data: { uid, name: uid, text: "hi", sentAt, ...(aside && { aside }) } } as never);
const reply = (timestamp: number) => entry("pi.assistant", { model: [{ role: "assistant", content: [], timestamp }] } as never);
const legacy = (timestamp: number) => entry("pi.user", { model: [{ role: "user", content: "hi", timestamp }] } as never);
const joined = (uid: string) => entry(CHAT_PEOPLE_KIND, { data: { uid, name: uid, event: "joined" } } as never);
const forModel = () => entry("chat.aside", {});

describe("where the New line goes", () => {
  it("goes over the first reply after the reader last looked", () => {
    const entries = [said("me", 10), reply(20), said("me", 30), reply(40), reply(50)];
    expect(firstNew(entries, 25, "me", true)).toBe(entries[3].id);
  });

  it("skips the reader's own messages, and their own join notice", () => {
    const entries = [reply(10), said("me", 30), joined("me"), said("bob", 40)];
    expect(firstNew(entries, 20, "me", true)).toBe(entries[3].id);
  });

  it("counts a message from before chats kept who wrote it as the owner's", () => {
    const entries = [reply(10), legacy(30), reply(40)];
    expect(firstNew(entries, 20, "me", true)).toBe(entries[2].id);
    expect(firstNew(entries, 20, "bob", false)).toBe(entries[1].id);
  });

  it("is none when nothing came after, or when everything did", () => {
    const entries = [said("me", 10), reply(20)];
    expect(firstNew(entries, 20, "me", true)).toBeUndefined();
    expect(firstNew([reply(30), reply(40)], 20, "me", true)).toBeUndefined();
  });

  it("ignores entries the app does not show", () => {
    const entries = [forModel(), reply(30)];
    expect(firstNew(entries, 20, "me", true)).toBeUndefined();
    const later = [reply(10), forModel(), said("bob", 30, true)];
    expect(firstNew(later, 20, "me", true)).toBe(later[2].id);
  });
});
