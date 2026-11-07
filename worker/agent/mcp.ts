import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { itemsOf, type McpResultDetails } from "../../shared/items.ts";
import { isReadOnly, MCP_DISCOVER_TOOL, MCP_TOOL_SEPARATOR, type ToolInfo } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import type { McpHub } from "../mcp/hub.ts";
import { clip, MAX_TOOL_TEXT, text } from "./output.ts";

/** Tool names the providers accept: the server's name as a slug, then the MCP tool's name. */
export function mcpToolName(server: string, tool: string): string {
  return `${server.toLowerCase().replace(/[^a-z0-9]+/g, "_")}${MCP_TOOL_SEPARATOR}${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}

/** What the hub says about one agent tool of an MCP server: whose it is, and whether it only reads. */
export interface McpToolInfo {
  server: string;
  readOnly: boolean;
}

/** What one MCP server told the chat about itself. */
export interface ServerCatalog {
  tools: ToolInfo[];
  instructions?: string;
}

/** What follows the head of a result too long for a turn: how much is shown, and where the whole of it is. */
export function spillNote(path: string, totalChars: number, shownChars: number): string {
  const n = (count: number) => count.toLocaleString("en");
  return (
    `[The result is ${n(totalChars)} characters long; the first ${n(shownChars)} are shown. The whole result is saved at ${path} ` +
    `for a while: read on with files_read and offset ${shownChars}, or pass it in files to run_python.]`
  );
}

/** The head of `full` saved at `path`, and the note after it: together no longer than a turn shows. */
function spilled(full: string, path: string): string {
  // The note's numbers only get shorter once `shown` is known, so a note worked out for MAX_TOOL_TEXT shown fits.
  const shown = MAX_TOOL_TEXT - spillNote(path, full.length, MAX_TOOL_TEXT).length - 2;
  return `${full.slice(0, Math.max(0, shown))}\n\n${spillNote(path, full.length, Math.max(0, shown))}`;
}

/**
 * One pi tool per MCP tool, calling through the hub the artifacts also use.
 * The agent knows only what the servers say about themselves. Servers that
 * could not be listed (down, or the user has not signed in) are named in the
 * prompt with the reason, so the agent can tell the user. `discover` lists
 * every server afresh and returns the new listing: the agent's mcp_discover.
 * Returns the extension, the summary its prompt section shows, and the
 * listing mcp_discover answers with.
 *
 * `deferred`: the MCP tools are pi's deferred tools, offered to the model only once loaded: the tool picker loads the
 * few each message needs (worker/agent/tool-pick.ts), and the model loads others with tool_search.
 *
 * `spill`: where a result longer than a turn shows (MAX_TOOL_TEXT) is kept whole. It is given the agent tool's name and
 * the whole text, and returns the path it saved it at; the model gets the head of the result and a note naming the path
 * (spillNote). Without it, or when it fails, the result is cut and the rest is lost.
 */
export function mcpExtension(
  hub: McpHub,
  catalog: Map<string, ServerCatalog>,
  unavailable: Map<string, string>,
  discover: () => Promise<string>,
  { deferred = false, spill }: { deferred?: boolean; spill?: (tool: string, text: string) => Promise<string> } = {},
): { extension: Extension; summary: string; listing: string; toolInfo: Map<string, McpToolInfo> } {
  // Slugging and the 64-character cut can map two tools to one name ("My Server" and "my-server", "a.b" and "a_b"),
  // and providers reject a request whose tool names repeat: number the later ones.
  const used = new Set<string>();
  const tools = [];
  // Whose each agent tool is, and whether it only reads: what an agent's turn is limited by (worker/agents/turns.ts).
  const toolInfo = new Map<string, McpToolInfo>();
  const servers: string[] = [];
  for (const [server, { tools: serverTools, instructions }] of catalog) {
    const list: string[] = [];
    for (const tool of serverTools) {
      const base = mcpToolName(server, tool.name);
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base.slice(0, 64 - String(n).length - 1)}_${n}`;
      used.add(name);
      const readOnly = isReadOnly(tool);
      toolInfo.set(name, { server, readOnly });
      list.push(`${tool.name}${readOnly ? " (read-only)" : ""} — agent tool ${name}`);
      tools.push(
        defineTool({
          name,
          description: `[MCP server "${server}", tool "${tool.name}"${readOnly ? ", read-only" : ""}] ${tool.description}`,
          parameters: Type.Unsafe<Record<string, unknown>>((tool.inputSchema as object) ?? { type: "object" }),
          replay: readOnly ? "safe" : "unsafe",
          ...(deferred && { deferred: true as const }),
          execute: async (args) => {
            const result = await hub.call(server, tool.name, args);
            const payload = result.payload ?? result.content;
            // The records it holds, for the chips under the reply built on it (shared/items.ts): taken here, from what
            // the server returned, never from what the model writes. The model does not read details.
            const items = itemsOf(server, payload);
            // Compact JSON: the result stays in the conversation, which every later call sends again, and indenting
            // a table of rows adds a token or so per field.
            const full = typeof payload === "string" ? payload : JSON.stringify(payload);
            let shown: string | undefined;
            if (spill && full.length > MAX_TOOL_TEXT) {
              try {
                shown = spilled(full, await spill(name, full));
              } catch (error) {
                console.error("mcp spill:", name, errorMessage(error));
              }
            }
            return {
              output: text(shown ?? clip(full)),
              details: { server, ...(items.length && { items }) } satisfies McpResultDetails,
            };
          },
        }),
      );
    }
    const about = instructions?.trim() ? `\n  Says about itself: ${instructions.trim().replace(/\s+/g, " ").slice(0, 1_500)}` : "";
    servers.push(`- "${server}"${about}\n  Tools: ${list.length ? list.join("; ") : "none listed for this user"}`);
  }
  const connected = servers.length ? servers.join("\n") : "(none)";
  const missing = unavailable.size
    ? "Servers this chat cannot use right now. If the user asks for one, say why, and pass on any sign-in link exactly, " +
      "as a Markdown link (a path such as /api/mcp/sign-in/<name> is only clickable that way):\n" +
      [...unavailable].map(([name, reason]) => `- "${name}": ${reason}`).join("\n")
    : "";
  const summary =
    "MCP servers connected to this chat. Pages declare them by these exact names. Use the servers and tools the user names; " +
    "when they don't, pick by the tool descriptions. One entry may be a portal: a single address in front of several servers, whose " +
    "tools all appear under the portal's name (often prefixed with each server's name), and whose own tools may list or connect the servers behind it. " +
    `When the user asks what is available, or says they have just signed in or connected something, call ${MCP_DISCOVER_TOOL} first, then answer from what it lists. ` +
    "A tool may answer with a link the user must open (to sign in, for example); pass such links on as they are.\n" +
    (deferred
      ? "Only the tools this message looks likely to need are offered to you; the others listed here are not loaded. " +
        `To call one that is not offered, load it first with ${TOOL_SEARCH_TOOL_NAME}, searching for its agent tool name.\n`
      : "") +
    connected +
    (missing && `\n\n${missing}`);
  // What mcp_discover answers: the servers without the guidance the prompt already gives, and the sign-in links first,
  // so that a portal's long tool list, cut to fit a tool result, cannot cut them off.
  const listing = `${missing && `${missing}\n\n`}Connected servers:\n${connected}`;
  tools.push(
    defineTool({
      name: MCP_DISCOVER_TOOL,
      description:
        "List every MCP server of this chat again, now: each server's tools for this user (a portal's included), and the servers that need a sign-in, with the link. " +
        (deferred ? `Load a tool it finds with ${TOOL_SEARCH_TOOL_NAME} before calling it. ` : "Tools it finds can be called right after. ") +
        "Use it when the user asks what is available, after they sign in, or when a tool you expected is missing.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => ({ output: text(clip(await discover())) }),
    }),
  );
  const extension = defineExtension({ name: "mcp", tools, sections: [section("mcp_servers", () => summary)] });
  return { extension, summary, listing, toolInfo };
}
