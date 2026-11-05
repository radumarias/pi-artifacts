import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { checkSystemPrompt, MAX_SYSTEM_PROMPT } from "../shared/system-prompt.ts";
import { systemPromptExtension, userSystemPrompt, withoutSystemPrompt } from "../worker/agent/prompt.ts";

describe("checkSystemPrompt", () => {
  it("trims, and takes empty as clearing it", () => {
    expect(checkSystemPrompt("  Answer in French.\n")).toEqual({ text: "Answer in French." });
    expect(checkSystemPrompt("   ")).toEqual({ text: "" });
  });

  it("takes the longest there may be, and refuses longer", () => {
    expect(checkSystemPrompt("x".repeat(MAX_SYSTEM_PROMPT))).toEqual({ text: "x".repeat(MAX_SYSTEM_PROMPT) });
    expect(checkSystemPrompt("x".repeat(MAX_SYSTEM_PROMPT + 1))).toHaveProperty("error");
  });

  it.each([undefined, null, 3, ["text"], { text: "x" }])("refuses %j", (value) => {
    expect(checkSystemPrompt(value)).toHaveProperty("error");
  });
});

describe("userSystemPrompt", () => {
  it("stays in its place when the owner wrote neither, so writing one later patches only it", () => {
    expect(userSystemPrompt({ user: "", chat: "" })).toBe("The chat's owner wrote no instructions of their own.");
  });

  it("has the owner's own prompt alone", () => {
    const text = userSystemPrompt({ user: "Answer in French.", chat: "" });
    expect(text).toContain("For all their chats:\nAnswer in French.");
    expect(text).not.toContain("For this chat");
  });

  it("has the chat's alone, without pointing to one above", () => {
    const text = userSystemPrompt({ user: "", chat: "Prices in EUR." });
    expect(text).toContain("For this chat:\nPrices in EUR.");
    expect(text).not.toContain("For all their chats");
  });

  it("puts the chat's after the owner's, and lets it win", () => {
    const text = userSystemPrompt({ user: "Prices in USD.", chat: "Prices in EUR." });
    expect(text.indexOf("Prices in USD.")).toBeLessThan(text.indexOf("Prices in EUR."));
    expect(text).toContain("these win");
  });

  it("keeps the built-in page rules above the owner's", () => {
    expect(userSystemPrompt({ user: "x", chat: "" })).toMatch(/rules above for pages, those rules win/);
  });
});

describe("systemPromptExtension", () => {
  it("renders the prompts it reads each time, as one tagged section", async () => {
    let prompts = { user: "", chat: "" };
    const [section] = systemPromptExtension(async () => prompts).sections!;
    const render = () => section.render(undefined as never, undefined as never);
    expect(section.tag).not.toBe(false);
    expect(await render()).toContain("no instructions");
    prompts = { user: "Be brief.", chat: "" };
    expect(await render()).toContain("Be brief.");
  });
});

describe("withoutSystemPrompt", () => {
  const system = {
    kind: "pi.system",
    id: 2,
    conversationId: "c",
    model: [{ role: "system", content: "", sections: { user_system_prompt: "secret" }, toolsAdded: [{ name: "files_read" }], timestamp: 5 }],
  } as unknown as EntryRecord;
  const user = { kind: "pi.user", id: 3, conversationId: "c", model: [{ role: "user", content: "sections", timestamp: 6 }] } as unknown as EntryRecord;
  const snapshot = (entries: EntryRecord[]) => ({ type: "snapshot", entries }) as unknown as AgentEvent;

  it("keeps a system entry in its place, without the prompt's sections and tools", () => {
    const event = snapshot([system, user]);
    const sent = withoutSystemPrompt(event) as Extract<AgentEvent, { type: "snapshot" }>;
    expect(sent.entries).toEqual([{ ...system, model: [{ role: "system", content: "", timestamp: 5 }] }, user]);
    expect(JSON.stringify(sent)).not.toMatch(/secret|files_read/);
    // The event it came from is left as it was.
    expect((event as typeof sent).entries[0]).toBe(system);
  });

  it.each(["message_end", "entry_appended", "tool_execution_end"])("strips the entry of %s", (type) => {
    const sent = withoutSystemPrompt({ type, entry: system } as unknown as AgentEvent);
    expect(JSON.stringify(sent)).not.toMatch(/secret|files_read/);
  });

  it("returns an event with no system entry as it is", () => {
    for (const event of [snapshot([user]), { type: "entry_appended", entry: user } as AgentEvent, { type: "tool_execution_end" } as AgentEvent]) {
      expect(withoutSystemPrompt(event)).toBe(event);
    }
  });
});
