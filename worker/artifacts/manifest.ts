import type { ArtifactManifest } from "../../shared/protocol.ts";
import type { McpHub } from "../mcp/hub.ts";

export const MAX_HTML_BYTES = 2 * 1024 * 1024;

/**
 * Check a manifest against the servers and tools this chat actually has, as
 * Claude checks declared tool names at publish. Returns the problems found;
 * an empty list means the manifest is valid.
 */
export async function checkManifest(hub: McpHub, manifest: ArtifactManifest): Promise<string[]> {
  const known = new Set(hub.servers().map((server) => server.name));
  const seen = new Set<string>();
  // Each entry's checks before its first await run in order, so `seen` holds; the tool lists are fetched at once.
  const problems = await Promise.all(
    (manifest.mcp?.servers ?? []).map(async (entry): Promise<string[]> => {
      // Pages and the Worker look a server up by name and take its first entry, so a second one would be ignored.
      if (seen.has(entry.server)) return [`"${entry.server}" is declared more than once; list all its tools in one entry.`];
      seen.add(entry.server);
      if (!known.has(entry.server)) return [`Unknown MCP server "${entry.server}". Connected servers: ${[...known].join(", ")}.`];
      if (entry.tools.length === 0) return [`"${entry.server}" declares no tools; list every tool the page calls.`];
      const tools = new Set((await hub.tools(entry.server)).map((tool) => tool.name));
      return entry.tools.filter((tool) => !tools.has(tool)).map((tool) => `"${entry.server}" has no tool "${tool}". Its tools: ${[...tools].join(", ")}.`);
    }),
  );
  return problems.flat();
}
