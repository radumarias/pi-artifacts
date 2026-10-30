import { describe, expect, it } from "vitest";
import { queuedMessages } from "../worker/queue.ts";

const message = (uid: string, text: string) => ({ kind: "chat.message", data: { uid, name: `${uid}@example.com`, text } });

describe("queuedMessages", () => {
  it("lists the people's messages waiting in pi's inbox, in its order", () => {
    const docs = {
      "pi.inbox": {
        items: [
          { id: 7, mode: "followUp", content: "ann@example.com: one", entry: message("ann", "one") },
          { id: 8, mode: "write", entry: { kind: "chat.people", data: {} } },
          { id: 9, mode: "followUp", content: "plain input" },
          { id: 10, mode: "steer", content: "bob@example.com: two", entry: message("bob", "two") },
        ],
      },
    };
    // Inbox items as pi stores them: plain JSON, which TypeScript cannot match to the doc's index signature.
    expect(queuedMessages({ docs } as never)).toEqual([
      { id: 7, uid: "ann", name: "ann@example.com", text: "one" },
      { id: 10, uid: "bob", name: "bob@example.com", text: "two" },
    ]);
  });

  it("is empty without an inbox", () => {
    expect(queuedMessages(undefined)).toEqual([]);
    expect(queuedMessages({ docs: {} })).toEqual([]);
  });
});
