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
  it("is left out when the owner wrote neither", () => {
    expect(userSystemPrompt({ user: "", chat: "" })).toBeUndefined();
  });

  it("has the owner's own prompt alone", () => {
    const text = userSystemPrompt({ user: "Answer in French.", chat: "" })!;
    expect(text).toContain("For all their chats:\nAnswer in French.");
    expect(text).not.toContain("For this chat");
  });

  it("has the chat's alone, without pointing to one above", () => {
    const text = userSystemPrompt({ user: "", chat: "Prices in EUR." })!;
    expect(text).toContain("For this chat:\nPrices in EUR.");
    expect(text).not.toContain("For all their chats");
  });

  it("puts the chat's after the owner's, and lets it win", () => {
    const text = userSystemPrompt({ user: "Prices in USD.", chat: "Prices in EUR." })!;
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
    expect(await render()).toBeUndefined();
    prompts = { user: "Be brief.", chat: "" };
    expect(await render()).toContain("Be brief.");
  });
});

describe("withoutSystemPrompt", () => {
  const system = {
    kind: "pi.system",
    id: 2,
    model: [{ role: "system", content: "", sections: { user_system_prompt: "secret" }, toolsAdded: [{ name: "files_read" }], timestamp: 5 }],
  };
  const user = { kind: "pi.user", id: 3, model: [{ role: "user", content: "sections" }] };

  it("keeps a system entry in its place, without the prompt's sections and tools", () => {
    const event = { type: "snapshot", snapshot: { entries: [system, user] } };
    const sent = withoutSystemPrompt(event);
    expect(sent.snapshot.entries).toEqual([{ kind: "pi.system", id: 2, model: [{ role: "system", content: "", timestamp: 5 }] }, user]);
    expect(JSON.stringify(sent)).not.toMatch(/secret|files_read/);
    // The event it came from is left as it was.
    expect(event.snapshot.entries[0]).toBe(system);
  });

  it("returns what has no system entry as it is", () => {
    const event = { type: "entry", entry: user };
    expect(withoutSystemPrompt(event)).toBe(event);
  });
});
