/**
 * One MCP endpoint the chats connect to. The app knows nothing else about it:
 * the agent learns what a server offers from the server itself (its
 * instructions and tool list), and the user names servers and tools in chat.
 * A Cloudflare MCP portal is one entry for every server behind it.
 */
export interface McpServerConfig {
  /** What the agent's tools are prefixed with and what pages pass as `server`. */
  name: string;
  url: string;
  /**
   * `oauth`: each user signs in themselves (the MCP OAuth flow, from a link
   * the agent gives in chat), and their chats call with their own tokens.
   * Pages call as their author, so a page's calls to such a server load only
   * for its author.
   */
  auth?: "oauth";
  /**
   * Who shares a cached result. Pages call as their author, so every viewer
   * gets the same answer: `shared` (the default) lets them all reuse one
   * result, and `viewer` keeps each viewer's results apart. A server with
   * `auth: "oauth"` keeps them apart unless it says `shared`.
   */
  cacheScope?: "viewer" | "shared";
}

/** Whether every viewer of a page reuses one cached result of this server's tools (see `cacheScope`). */
export function sharesResults(server: McpServerConfig): boolean {
  return server.cacheScope ? server.cacheScope === "shared" : server.auth !== "oauth";
}

/** The servers from the MCP_SERVERS binding (cloudflare.config.ts), checked. */
export function mcpServers(env: { MCP_SERVERS?: unknown }): McpServerConfig[] {
  const list = Array.isArray(env.MCP_SERVERS) ? env.MCP_SERVERS : [];
  return list.filter(
    (entry): entry is McpServerConfig =>
      typeof entry?.name === "string" && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$/.test(entry.name) && typeof entry.url === "string" && /^https?:\/\//.test(entry.url),
  );
}
