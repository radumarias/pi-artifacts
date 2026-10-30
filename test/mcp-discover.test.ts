import { describe, expect, it, vi } from "vitest";
import { MCP_DISCOVER_TOOL } from "../shared/protocol.ts";
import { mcpExtension } from "../worker/agent/mcp.ts";
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
