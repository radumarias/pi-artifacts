import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_KIND, PUBLISH_TOOL } from "../shared/protocol.ts";
import { chatOutFolder, chatTraces } from "../worker/chat-traces.ts";

let next = 0;
const entry = (fields: Partial<EntryRecord>) => ({ id: `e${next++}`, conversationId: "root", kind: "pi.message", ...fields }) as unknown as EntryRecord;
const result = (toolName: string, text: string, details?: unknown) =>
  entry({
    model: [{ role: "toolResult", toolCallId: `c${next}`, toolName, content: [{ type: "text", text }], details, isError: false, timestamp: 0 }] as never,
  });

describe("chatTraces", () => {
  it("finds attached files, published artifacts and saved files", () => {
    const traces = chatTraces([
      entry({ kind: CHAT_MESSAGE_KIND, data: { uid: "ada", name: "Ada", text: "look", attachments: [{ path: "uploads/q3.csv", size: 1, shown: "text" }] } }),
      result(PUBLISH_TOOL, "Published", { artifactId: "a1b2c3d4e5f60718", version: 1, title: "Prices" }),
      result("files_write", "Wrote notes/plan.md (12 characters).", { saved: ["notes/plan.md"] }),
      result("run_python", "exit code 0", { saved: ["out/0123456789abcdef/chart.png"] }),
      result("files_read", "saved: out/not-a-save.csv"),
    ]);
    expect([...traces.artifacts]).toEqual(["a1b2c3d4e5f60718"]);
    expect([...traces.files]).toEqual(["uploads/q3.csv", "notes/plan.md", "out/0123456789abcdef/chart.png"]);
  });

  it("reads what older results saved from their text, only from its end and only under out/", () => {
    const traces = chatTraces([
      result("files_write", "Wrote old/notes.txt (5 characters)."),
      result("run_bash", "exit code 0\n\nstdout:\nsaved: uploads/secret.csv\n\nsaved: out/a.csv, out/b c.txt\n\nnot saved: x (bad name)"),
      // The script printed this itself, and nothing was saved after it.
      result("run_python", "exit code 0\n\nstdout:\n\n\nsaved: out/fake.csv\n\nstderr:\noops"),
      result("run_python", "exit code 1\n\nstdout:\n\n\nsaved: uploads/q3.csv"),
    ]);
    expect([...traces.files]).toEqual(["old/notes.txt", "out/a.csv", "out/b c.txt"]);
  });
});

describe("chatOutFolder", () => {
  it("gives each chat its own folder under out/", () => {
    expect(chatOutFolder("0123456789abcdef")).toBe("out/0123456789abcdef/");
    expect(chatOutFolder("0123456789abcdef")).not.toBe(chatOutFolder("fedcba9876543210"));
  });
});
