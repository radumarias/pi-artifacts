import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { ToolInfo } from "../../shared/protocol.ts";
import { deadline, errorMessage } from "../../shared/util.ts";
import { McpFailure, type McpConnection, type RawToolResult } from "./hub.ts";
import { signInPath } from "./oauth.ts";
import type { McpServerConfig } from "./servers.ts";

const CALL_TIMEOUT_MS = 60_000;
/**
 * How long connecting may take, sign-in refresh and handshake included. Every call to the server waits on its
 * connection, so one that never comes would hold them all.
 */
const CONNECT_TIMEOUT_MS = 30_000;
/**
 * How long any one request to the server may stay open, its answer's stream included: longer than a call may take.
 * The SDK reads a call's stream until the server ends it, even after the answer came, and a sign-in refresh has no
 * timeout of its own; a request left open keeps the chat object awake.
 */
const REQUEST_TIMEOUT_MS = 90_000;

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
 * `fetch` for one server's transport, as a chat object can afford it.
 *
 * It answers the standalone stream the SDK opens after connecting (a GET to the server's URL with no Last-Event-ID)
 * itself, as a server without one does: 405. That stream stays open for as long as the server keeps it, and the SDK
 * reopens it whenever it ends, so a chat object holding one never hibernates. Nothing here listens for what a server
 * sends unasked (tool lists are listed again by age), and an answer still comes back on its own request. A GET that
 * resumes a request's interrupted answer carries Last-Event-ID and goes through.
 *
 * Every other request is aborted after `timeoutMs`, unless its answer was read to the end before then.
 */
function forChatObject(url: URL, timeoutMs: number): FetchLike {
  return async (input, init) => {
    if (init?.method === "GET" && new URL(input).href === url.href && !new Headers(init.headers).has("last-event-id")) {
      return new Response(null, { status: 405 });
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
    // The SDK passes every request the transport's one signal: a listener left on it would keep each request's
    // combined signal, and all this closure holds, for as long as the connection lasts.
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
    };
    signal.addEventListener("abort", done, { once: true });
    try {
      const response = await fetch(input, { ...init, signal });
      if (!response.body) {
        done();
        return response;
      }
      // Not a pending timer once the answer is read, or given up on: a timer, too, keeps the object awake.
      return new Response(untilSettled(response.body, done), response);
    } catch (error) {
      done();
      throw error;
    }
  };
}

/**
 * `body`, calling `settled` once it is read to the end, fails, or is cancelled (the SDK cancels the body of a 202, such
 * as its initialized notification's, without reading it).
 */
function untilSettled(body: ReadableStream<Uint8Array>, settled: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          settled();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        settled();
        controller.error(error);
      }
    },
    cancel(reason) {
      settled();
      return reader.cancel(reason);
    },
  });
}

/**
 * Opens a Streamable HTTP session with the MCP SDK. Workers cannot run Ajv, so
 * validation uses @cfworker/json-schema. With `authProvider`, the SDK adds the
 * user's token to every request and refreshes it when it expires.
 */
export async function connectStreamableHttp(
  server: McpServerConfig,
  authProvider?: OAuthClientProvider,
  { connectTimeoutMs = CONNECT_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {},
): Promise<McpConnection> {
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
  try {
    const connecting = signedIn(() => client.connect(new StreamableHTTPClientTransport(url, { authProvider, fetch: forChatObject(url, requestTimeoutMs) })));
    await deadline(
      connecting,
      connectTimeoutMs,
      () =>
        new McpFailure({
          code: "server_unavailable",
          server: server.name,
          retryable: true,
          message: `${server.name} did not connect within ${connectTimeoutMs / 1000} s.`,
        }),
    );
  } catch (error) {
    // Closing aborts the transport's requests still open (a connect can stall on one the SDK gives no timeout, such as
    // its initialized notification). Left open, they would hold the chat object awake. A sign-in refresh is not the
    // transport's: REQUEST_TIMEOUT_MS ends it.
    void client.close().catch(() => {});
    throw error;
  }

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
