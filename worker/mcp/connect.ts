import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { ToolInfo } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
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
 * What a failed tool call is reported as. The hub sends a call that failed with anything but an McpFailure
 * again on a fresh connection, so only a call the server surely did not run passes through as it is: one
 * whose HTTP request the server refused (a 4xx, such as 404 for an expired session), or a sign-in failure.
 * Anything else may have run (a write tool must not run twice) or is the server's own answer.
 */
function callFailure(server: string, tool: string, error: unknown): unknown {
  if (error instanceof McpFailure) return error;
  if (error instanceof StreamableHTTPError && error.code !== undefined && error.code >= 400 && error.code < 500) return error;
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new McpFailure({ code: "server_unavailable", server, message: `${server} did not answer ${tool} within ${CALL_TIMEOUT_MS / 1000} s.` });
  }
  if (error instanceof McpError && error.code !== ErrorCode.ConnectionClosed) {
    // A JSON-RPC error the server answered with: the call reached it, and the connection is fine.
    return new McpFailure({ code: "tool_error", server, message: error.message });
  }
  return new McpFailure({ code: "server_unavailable", server, retryable: true, message: `${server} did not finish ${tool}: ${errorMessage(error)}` });
}

/**
 * `fetch`, except for the standalone stream the SDK opens after connecting (a GET to the server's URL with no
 * Last-Event-ID), which it answers itself as a server without one does: 405. That stream is an outgoing request that
 * stays open for as long as the server keeps it, and the SDK reopens it whenever it ends, so a chat object holding one
 * never hibernates: it stays awake, and billed, for hours after its last message. Nothing here listens for what a
 * server sends unasked (tool lists are listed again by age), and an answer still comes back on its own request. A GET
 * that resumes a request's interrupted answer carries Last-Event-ID and goes through.
 */
export function withoutStandaloneStream(url: URL): FetchLike {
  return (input, init) => {
    const standalone = init?.method === "GET" && new URL(input).href === url.href && !new Headers(init.headers).has("last-event-id");
    return standalone ? Promise.resolve(new Response(null, { status: 405 })) : fetch(input, init);
  };
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
  const url = new URL(server.url);
  await signedIn(() => client.connect(new StreamableHTTPClientTransport(url, { authProvider, fetch: withoutStandaloneStream(url) })));

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
        throw callFailure(server.name, name, error);
      }
    },
    close: () => client.close(),
  };
  return connection;
}
