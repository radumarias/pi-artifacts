import { describe, expect, it, vi } from "vitest";
import { MCP_DISCOVER_TOOL } from "../shared/protocol.ts";
import { mcpExtension, spillNote } from "../worker/agent/mcp.ts";
import { clip, MAX_TOOL_TEXT } from "../worker/agent/output.ts";
import { McpHub } from "../worker/mcp/hub.ts";

describe("mcpExtension", () => {
  it("offers mcp_discover and names unavailable servers with their reason", async () => {
    const hub = new McpHub([], async () => {
      throw new Error("unused");
    });
    const catalog = new Map([["portal", { tools: [{ name: "reports_run", description: "Run a report", annotations: { readOnlyHint: true } }] }]]);
    const unavailable = new Map([["other", "Not signed in to other. To sign in, open /api/mcp/sign-in/other in this app, then ask again."]]);
    const discover = vi.fn(async () => "listed again");
    const { extension, summary } = mcpExtension(hub, catalog, unavailable, discover);
    const names = extension.tools!.map((tool) => tool.name);
    expect(names).toEqual(["portal__reports_run", MCP_DISCOVER_TOOL]);
    expect(summary).toContain('- "portal"\n  Tools: reports_run (read-only) — agent tool portal__reports_run');
    expect(summary).toContain('- "other": Not signed in');
    const tool = extension.tools!.find((t) => t.name === MCP_DISCOVER_TOOL)!;
    const result = await (tool.execute as unknown as (args: object) => Promise<{ output: { text: string }[] }>)({});
    expect(result.output[0].text).toBe("listed again");
    expect(discover).toHaveBeenCalledOnce();
  });
});

describe("mcpExtension with spill", () => {
  // One read-only tool whose server answers with `answer`, made into the extension's agent tool. The hub runs it with
  // no write gate, as the server lists it read-only.
  function reportTool(answer: string, spill?: (tool: string, text: string) => Promise<string>) {
    const report = { name: "reports_run", description: "Run a report", annotations: { readOnlyHint: true } };
    const hub = new McpHub([{ name: "portal", url: "https://example.invalid/mcp" }], async () => ({
      listTools: async () => [report],
      callTool: async () => ({ content: [{ type: "text", text: answer }] }),
      close: async () => {},
    }));
    const catalog = new Map([["portal", { tools: [report] }]]);
    const { extension } = mcpExtension(hub, catalog, new Map(), async () => "", { spill });
    const tool = extension.tools!.find((t) => t.name === "portal__reports_run")!;
    const execute = tool.execute as unknown as (args: object, api: { conversationId: string }) => Promise<{ output: { text: string }[] }>;
    return async () => (await execute({}, { conversationId: "s1" })).output[0].text;
  }

  it("says how much is shown and where the whole result is", () => {
    const note = spillNote("mcp-results/portal__reports_run-1.txt", 120_000, 15_700);
    expect(note).toContain("120,000 characters");
    expect(note).toContain("first 15,700 are shown");
    expect(note).toContain("saved at mcp-results/portal__reports_run-1.txt");
    expect(note).toContain("files_read and offset 15700");
    expect(note).toContain("run_python");
  });

  it("saves a long result whole and shows its head with the note, within what a turn shows", async () => {
    const long = "r".repeat(50_000);
    const spill = vi.fn(async () => "mcp-results/report.txt");
    const output = await reportTool(long, spill)();
    expect(spill).toHaveBeenCalledWith("portal__reports_run", long);
    expect(output.length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
    const shown = output.indexOf("\n\n[");
    expect(output.slice(0, shown)).toBe(long.slice(0, shown));
    expect(output.slice(shown + 2)).toBe(spillNote("mcp-results/report.txt", 50_000, shown));
  });

  it("does not spill a result that fits", async () => {
    const spill = vi.fn(async () => "unused");
    expect(await reportTool("short", spill)()).toBe("short");
    expect(spill).not.toHaveBeenCalled();
  });

  it("cuts the result as before when saving it fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const long = "r".repeat(20_000);
    const output = await reportTool(long, async () => {
      throw new Error("bucket unavailable");
    })();
    expect(output).toBe(clip(long));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
