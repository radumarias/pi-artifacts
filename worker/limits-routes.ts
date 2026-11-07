import { exports } from "cloudflare:workers";
import { AGENT_ID_PATTERN } from "../shared/agents.ts";
import { ID_PATTERN } from "../shared/protocol.ts";
import { errorMessage } from "../shared/util.ts";
import { chatAgentName } from "./chat-agent.ts";
import { answerJson, json, readJson } from "./http.ts";
import { connectAs } from "./mcp-connect.ts";
import { McpFailure, McpHub } from "./mcp/hub.ts";
import type { McpServerConfig } from "./mcp/servers.ts";
import type { UserDirectory } from "./users.ts";

/**
 * A verified user's limits on what their agents change (shared/limits.ts; `uid`, and `directory` their UserDirectory):
 *   POST /api/needs-you/:chatId/:id      {decision: "approve" | "decline"}: the action after (PendingActionView)
 *   GET  /api/limits/rules               their rules for all their agents, pi and pages
 *   PUT  /api/limits/rules               {rules}: replace them
 *   GET  /api/limits/calls?agent=&limit= their log of calls that change data, newest first (of one agent, by id)
 *   GET  /api/limits/tools?server=       a server's tools as this user sees them, with their input schemas (the rule editor's)
 * Bodies are JSON (readJson), so another site cannot approve an action for a signed-in user. Null for any other path.
 */
export async function limitsRoute(
  request: Request,
  uid: string,
  directory: DurableObjectStub<UserDirectory>,
  servers: readonly McpServerConfig[],
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const decide = path.match(/^\/api\/needs-you\/([a-z0-9]+)\/([a-f0-9]{16})$/);
  if (decide && method === "POST") {
    const [, chatId, id] = decide;
    if (!ID_PATTERN.test(chatId) || !(await directory.hasChat(chatId))) return json({ error: "No such chat." }, 404);
    const body = await readJson<{ decision?: unknown }>(request);
    if (!body) return json({ error: 'Expected {decision: "approve" | "decline"} as JSON.' }, 400);
    // The chat object is named after this user: only their own chats' actions can be reached, and it checks again.
    const answer = await exports.ChatAgent.getByName(chatAgentName(uid, chatId)).decideAction(uid, id, body.decision);
    return answerJson(answer);
  }
  if (path === "/api/limits/rules" && method === "GET") return json(await directory.guardrails());
  if (path === "/api/limits/rules" && method === "PUT") {
    const body = await readJson<{ rules?: unknown }>(request);
    if (!body) return json({ error: "Expected {rules: [...]} as JSON." }, 400);
    const saved = await directory.setGuardrails(body.rules);
    return json(saved, "error" in saved ? 400 : 200);
  }
  if (path === "/api/limits/calls" && method === "GET") {
    const agentId = url.searchParams.get("agent");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    if (agentId === null) return json(await directory.calls(undefined, limit));
    if (!AGENT_ID_PATTERN.test(agentId)) return json({ error: "agent is an agent's id." }, 400);
    return json(await directory.calls(agentId, limit));
  }
  if (path === "/api/limits/tools" && method === "GET") {
    const name = url.searchParams.get("server") ?? "";
    const server = servers.find((one) => one.name === name);
    if (!server) return json({ error: `No MCP server named "${name}".` }, 404);
    // A hub of this user's alone, for one listing: their own sign-in for a server that signs in each user.
    const hub = new McpHub([server], connectAs(uid));
    try {
      return json(await hub.tools(name), 200, { "cache-control": "private, no-cache" });
    } catch (error) {
      const status = error instanceof McpFailure && error.error.code === "auth_required" ? 409 : 502;
      return json({ error: error instanceof McpFailure ? error.error.message : errorMessage(error) }, status);
    } finally {
      await hub.close().catch(() => {});
    }
  }
  return null;
}
