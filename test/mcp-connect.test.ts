import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectStreamableHttp } from "../worker/mcp/connect.ts";
import { McpFailure } from "../worker/mcp/hub.ts";
import { listen } from "./fakes.ts";

// A stateful MCP server that offers the standalone stream (GET), as Cloudflare's MCP portals do. A chat object that
// opened it would hold an outgoing request open for as long as the server kept it, and never hibernate.

const transports = new Map<string, StreamableHTTPServerTransport>();
const methods: string[] = [];

/** While set, the server never answers the initialized notification, as a stalled server or edge would not. */
let stallInitialized = false;
/** Requests the server left unanswered that the client has since given up on. */
let abandoned = 0;

async function handle(req: IncomingMessage, res: ServerResponse) {
  methods.push(req.method ?? "");
  let body = "";
  for await (const chunk of req) body += chunk;
  if (stallInitialized && body.includes("notifications/initialized")) {
    res.on("close", () => abandoned++);
    return;
  }
  const id = req.headers["mcp-session-id"];
  let transport = typeof id === "string" ? transports.get(id) : undefined;
  if (!transport) {
    const created = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (sid) => void transports.set(sid, created) });
    const server = new McpServer({ name: "streaming", version: "1.0.0" });
    server.registerTool("echo", { description: "Echo", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
    await server.connect(created);
    transport = created;
  }
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}

let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  url = `${await listen(server)}/mcp`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("connectStreamableHttp", () => {
  it("never opens the standalone stream, and still calls tools", async () => {
    const connection = await connectStreamableHttp({ name: "Streaming", url, cacheScope: "shared" });
    try {
      const result = await connection.callTool("echo", {});
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      // Give a stream the SDK would have opened after connecting time to reach the server.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(methods).not.toContain("GET");
      expect(methods.filter((method) => method === "POST").length).toBeGreaterThanOrEqual(3);
    } finally {
      await connection.close();
    }
  });

  it("gives up on a connect that stalls, and closes the request it left open", async () => {
    stallInitialized = true;
    try {
      const connecting = connectStreamableHttp({ name: "Streaming", url, cacheScope: "shared" }, undefined, { connectTimeoutMs: 200 });
      await expect(connecting).rejects.toBeInstanceOf(McpFailure);
      await expect(connecting).rejects.toMatchObject({ error: { code: "server_unavailable", retryable: true } });
      await expect.poll(() => abandoned).toBe(1);
    } finally {
      stallInitialized = false;
    }
  });
});
