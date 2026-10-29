import type { ArtifactManifest } from "../../shared/protocol.ts";
import type { McpHub } from "../mcp/hub.ts";

export const MAX_HTML_BYTES = 2 * 1024 * 1024;

/**
 * Check a manifest against the servers and tools this chat actually has, as
 * Claude checks declared tool names at publish. Returns the problems found;
 * an empty list means the manifest is valid.
 */
export async function checkManifest(hub: McpHub, manifest: ArtifactManifest): Promise<string[]> {
  const problems: string[] = [];
  const known = new Set(hub.servers().map((server) => server.name));
  const seen = new Set<string>();
  for (const entry of manifest.mcp?.servers ?? []) {
    // Pages and the Worker look a server up by name and take its first entry, so a second one would be ignored.
    if (seen.has(entry.server)) {
      problems.push(`"${entry.server}" is declared more than once; list all its tools in one entry.`);
      continue;
    }
    seen.add(entry.server);
    if (!known.has(entry.server)) {
      problems.push(`Unknown MCP server "${entry.server}". Connected servers: ${[...known].join(", ")}.`);
      continue;
    }
    if (entry.tools.length === 0) {
      problems.push(`"${entry.server}" declares no tools; list every tool the page calls.`);
      continue;
    }
    const tools = new Set((await hub.tools(entry.server)).map((tool) => tool.name));
    for (const tool of entry.tools) {
      if (!tools.has(tool)) problems.push(`"${entry.server}" has no tool "${tool}". Its tools: ${[...tools].join(", ")}.`);
    }
  }
  return problems;
}
