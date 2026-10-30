import { describe, expect, it } from "vitest";
import { inboxIds, queuedIdsOf, queuedMessages } from "../worker/queue.ts";

const message = (uid: string, text: string) => ({ kind: "chat.message", data: { uid, name: `${uid}@example.com`, text } });

// Inbox items as pi stores them: plain JSON, which TypeScript cannot match to the doc's index signature.
const view = {
  docs: {
    "pi.inbox": {
      items: [
        { id: 7, mode: "followUp", content: "ann@example.com: one", entry: message("ann", "one") },
        { id: 8, mode: "write", entry: { kind: "chat.people", data: {} } },
        { id: 9, mode: "followUp", content: "plain input" },
        { id: 10, mode: "steer", content: "bob@example.com: two", entry: message("bob", "two") },
      ],
    },
  },
} as never;

describe("queuedMessages", () => {
  it("lists the people's messages among the ids, in their order", () => {
    expect(queuedMessages(view, [7, 8, 9, 10])).toEqual([
      { id: 7, uid: "ann", name: "ann@example.com", text: "one" },
      { id: 10, uid: "bob", name: "bob@example.com", text: "two" },
    ]);
  });

  it("leaves out an id no longer in the inbox, and is empty without one", () => {
    expect(queuedMessages(view, [10, 11])).toEqual([{ id: 10, uid: "bob", name: "bob@example.com", text: "two" }]);
    expect(queuedMessages({ docs: {} }, [7])).toEqual([]);
  });
});

describe("queuedIdsOf", () => {
  it("lists one person's waiting messages", () => {
    expect(queuedIdsOf(view, "bob")).toEqual([10]);
    expect(queuedIdsOf(view, "carol")).toEqual([]);
  });
});

describe("inboxIds", () => {
  it("takes the ids from the batch's last snapshot or inbox update", () => {
    const update = (...ids: number[]) => ({ type: "inbox_update", items: ids.map((id) => ({ id, mode: "followUp" })) });
    expect(inboxIds([{ type: "snapshot", inbox: [{ id: 1, mode: "followUp" }] }, update(1, 2), { type: "run_start" }] as never)).toEqual([1, 2]);
    expect(inboxIds([update(3), { type: "snapshot", inbox: [] }] as never)).toEqual([]);
    expect(inboxIds([{ type: "run_start" }] as never)).toBeUndefined();
  });
});
