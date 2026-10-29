import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { ToolInfo } from "../../shared/protocol.ts";
import { McpFailure, type McpConnection, type RawToolResult } from "./hub.ts";
import { signInPath } from "./oauth.ts";
import type { McpServerConfig } from "./servers.ts";

const CALL_TIMEOUT_MS = 60_000;

/**
 * The failure a page or the agent sees when the user has not signed in to a
 * server, or their sign-in expired. The path is a link in this app that
 * starts the sign-in; the agent passes it on to the user.
 */
export function signInRequired(server: string): McpFailure {
  return new McpFailure({ code: "auth_required", server, message: `Not signed in to ${server}. To sign in, open ${signInPath(server)} in this app, then ask again.` });
}

/**
 * Opens a Streamable HTTP session with the MCP SDK. Workers cannot run Ajv, so
 * validation uses @cfworker/json-schema. With `authProvider`, the SDK adds the
 * user's token to every request and refreshes it when it expires.
 */
export async function connectStreamableHttp(server: McpServerConfig, authProvider?: OAuthClientProvider): Promise<McpConnection> {
  // The SDK reports a missing or rejected sign-in as UnauthorizedError; everything else passes through.
  const signedIn = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw error instanceof UnauthorizedError ? signInRequired(server.name) : error;
    }
  };
  const client = new Client(
    { name: "pi-artifacts", version: "0.1.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  await signedIn(() => client.connect(new StreamableHTTPClientTransport(new URL(server.url), { authProvider })));

  const connection: McpConnection = {
    instructions: client.getInstructions(),
    async listTools() {
      const tools: ToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await signedIn(() => client.listTools(cursor ? { cursor } : undefined));
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            annotations: tool.annotations
              ? { readOnlyHint: tool.annotations.readOnlyHint, destructiveHint: tool.annotations.destructiveHint }
              : undefined,
            inputSchema: tool.inputSchema,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args) {
      try {
        const result = await signedIn(() =>
          client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { timeout: CALL_TIMEOUT_MS }),
        );
        return result as RawToolResult;
      } catch (error) {
        // The server got the call and may have run it: report it, never send it again (the hub retries other failures).
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
          throw new McpFailure({ code: "server_unavailable", server: server.name, message: `${server.name} did not answer ${name} within ${CALL_TIMEOUT_MS / 1000} s.` });
        }
        throw error;
      }
    },
    close: () => client.close(),
  };
  return connection;
}
