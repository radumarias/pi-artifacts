import { AGENT_ID_PATTERN, type AgentResult } from "../shared/agents.ts";
import { json, readJson } from "./http.ts";
import type { UserDirectory } from "./users.ts";

/**
 * The agents of a verified user (`directory` is their UserDirectory), which they bring into any of their chats:
 *   GET    /api/agents          their agents
 *   POST   /api/agents          {…fields, enabled?}: a new agent
 *   GET    /api/agents/:id      one
 *   PUT    /api/agents/:id      {…fields, version?, enabled?}: change one; `version` is the one read, and a newer one refuses
 *   PATCH  /api/agents/:id      {enabled, version?}: turn one on or off
 *   DELETE /api/agents/:id      delete one; chats that have it drop it at their next turn
 * Every body is JSON (readJson), so another site cannot make an agent, turned on, for a signed-in user.
 * Returns null for any other path.
 */
export async function agentsRoute(request: Request, directory: DurableObjectStub<UserDirectory>): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const answer = (result: AgentResult | { error: string } | null, status = 200) =>
    result && "error" in result ? json(result, 400) : json(result ?? {}, status);
  if (path === "/api/agents" && method === "GET") return json(await directory.listAgents());
  if (path === "/api/agents" && method === "POST") {
    const body = await readJson<{ enabled?: unknown }>(request);
    if (!body || typeof body !== "object") return json({ error: "Expected an agent as JSON (content-type: application/json)." }, 400);
    return answer(await directory.saveAgent(body, "user", body.enabled !== false), 201);
  }
  const one = path.match(/^\/api\/agents\/([a-f0-9]+)$/);
  if (!one || !AGENT_ID_PATTERN.test(one[1])) return null;
  const id = one[1];
  if (method === "GET") {
    const agent = await directory.getAgent(id);
    return agent ? json(agent) : json({ error: "No such agent." }, 404);
  }
  if (method === "PUT") {
    const body = await readJson<{ enabled?: unknown; version?: unknown }>(request);
    if (!body || typeof body !== "object") return json({ error: "Expected an agent as JSON (content-type: application/json)." }, 400);
    if (body.version !== undefined && typeof body.version !== "number") return json({ error: "version is a number." }, 400);
    const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
    return answer(await directory.saveAgent(body, "user", enabled, { id, version: body.version }));
  }
  if (method === "PATCH") {
    const body = await readJson<{ enabled?: unknown; version?: unknown }>(request);
    if (typeof body?.enabled !== "boolean" || (body.version !== undefined && typeof body.version !== "number")) {
      return json({ error: "Expected {enabled: true | false, version?: number}." }, 400);
    }
    return answer(await directory.setAgentEnabled(id, body.enabled, body.version as number | undefined));
  }
  if (method === "DELETE") {
    // Its only refusal is that there is no such agent, as GET answers it.
    const refused = await directory.deleteAgent(id);
    return refused ? json(refused, 404) : json({});
  }
  return null;
}
