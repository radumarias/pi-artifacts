import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { QueuedMessage } from "../shared/protocol.ts";
import { unshown, type Sending } from "../src/chat/sending.ts";

const sent = (key: number, text: string, after = 4): Sending => ({ key, text, after, picking: true });
const entry = (id: number, uid: string, text: string, kind = "chat.message") => ({ id, kind, data: { uid, name: uid, text } }) as unknown as EntryRecord;
const queued = (id: number, uid: string, text: string): QueuedMessage => ({ id, uid, name: uid, text });

describe("unshown", () => {
  it("keeps a message until its entry comes after the one it was sent after", () => {
    const sending = [sent(0, "aa")];
    expect(unshown(sending, [entry(3, "me", "aa")], [], "me")).toEqual(sending);
    expect(unshown(sending, [entry(3, "me", "aa"), entry(5, "me", "aa")], [], "me")).toEqual([]);
  });

  it("lets a message go once it waits in the queue", () => {
    expect(unshown([sent(0, "aa")], [], [queued(9, "me", "aa")], "me")).toEqual([]);
  });

  it("matches only the viewer's own messages with the same text", () => {
    const sending = [sent(0, "aa")];
    const others = [entry(5, "ann", "aa"), entry(6, "me", "bb"), entry(7, "me", "aa", "pi.assistant")];
    expect(unshown(sending, others, [queued(9, "ann", "aa")], "me")).toEqual(sending);
  });

  it("lets one message that came in stand for one sent, the oldest", () => {
    const sending = [sent(0, "aa"), sent(1, "aa")];
    expect(unshown(sending, [entry(5, "me", "aa")], [], "me")).toEqual([sending[1]]);
    expect(unshown(sending, [entry(5, "me", "aa")], [queued(9, "me", "aa")], "me")).toEqual([]);
  });
});
