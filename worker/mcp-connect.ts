import { mcpAuthStore } from "./users.ts";
import { connectStreamableHttp, signInRequired } from "./mcp/connect.ts";
import type { Connector } from "./mcp/hub.ts";
import { McpOAuthClient } from "./mcp/oauth.ts";

/**
 * How a hub of one user's connects: public servers as they are, a server with `auth: "oauth"` with that user's own
 * tokens, never starting a sign-in (that is the user's to do, from a link). `uid` must come from a verified identity.
 */
export function connectAs(uid: string): Connector {
  return async (server) => {
    if (server.auth !== "oauth") return connectStreamableHttp(server);
    const store = mcpAuthStore(uid, server.name);
    const { tokens, redirectUrl } = await store.get();
    if (!tokens || !redirectUrl) throw signInRequired(server.name);
    return connectStreamableHttp(server, new McpOAuthClient(store, server.name, { redirectUrl, interactive: false }));
  };
}
