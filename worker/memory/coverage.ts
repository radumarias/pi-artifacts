import type { ServerCoverage } from "../../shared/memory.ts";
import type { ServerCatalog } from "../agent/mcp.ts";

/** How much of a server's instructions the Memory view shows. */
const ABOUT_CHARS = 280;
/** How many of a server's tools it names. */
const SOME_TOOLS = 6;

/** What each listed server covers, for the owner's Memory view: the start of what it says of itself, and some tools. */
export function coverageOf(catalog: ReadonlyMap<string, ServerCatalog>, now = Date.now()): ServerCoverage[] {
  return [...catalog].map(([name, { tools, instructions }]) => {
    const about = instructions?.replace(/\s+/g, " ").trim();
    return {
      name,
      ...(about && { about: about.length > ABOUT_CHARS ? `${about.slice(0, ABOUT_CHARS).trimEnd()}…` : about }),
      tools: tools.length,
      some: tools.slice(0, SOME_TOOLS).map((tool) => tool.name),
      listedAt: now,
    };
  });
}
