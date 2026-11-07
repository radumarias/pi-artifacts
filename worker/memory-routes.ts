import type { MemoryNote } from "../shared/memory.ts";
import { json, readJson } from "./http.ts";
import type { UserDirectory } from "./users.ts";

/**
 * The memory notes of a verified user (`directory` is their UserDirectory), as the Memory view and an agent's Knows tab
 * show and change them (shared/memory.ts):
 *   GET    /api/memory              {notes: [MemoryNoteView], coverage: [ServerCoverage]}, forgotten notes too
 *   POST   /api/memory              {text, scope, agentId?, chatId?, pinned?}: a note the user writes, confirmed
 *   PATCH  /api/memory/:id          {text?, pinned?, confirmed?: true, scope?, agentId?, chatId?}: change one
 *   POST   /api/memory/:id/forget   no agent reads it from now on
 *   POST   /api/memory/:id/restore  bring a forgotten one back
 *   DELETE /api/memory/:id          delete one for good
 * Every body is JSON (readJson), so another site cannot write a note into a signed-in user's memory.
 * Returns null for any other path.
 */
export async function memoryRoute(request: Request, directory: DurableObjectStub<UserDirectory>): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/memory" && !path.startsWith("/api/memory/")) return null;
  const method = request.method;
  const answer = (result: MemoryNote | { error: string } | null) => (result && "error" in result ? json(result, 400) : json(result ?? {}));
  if (path === "/api/memory" && method === "GET") {
    return json(await directory.memoryView());
  }
  if (path === "/api/memory" && method === "POST") {
    const body = await readJson(request);
    if (!body) return json({ error: "Expected a note as JSON (content-type: application/json)." }, 400);
    return answer(await directory.addNote(body));
  }
  const one = path.match(/^\/api\/memory\/([a-f0-9]{12})(\/forget|\/restore)?$/);
  if (!one) return null;
  const [, id, action] = one;
  if (action === "/forget" && method === "POST") return answer(await directory.forgetNote(id));
  if (action === "/restore" && method === "POST") return answer(await directory.restoreNote(id));
  if (action) return null;
  if (method === "PATCH") {
    const body = await readJson(request);
    if (!body) return json({ error: "Expected a change as JSON (content-type: application/json)." }, 400);
    return answer(await directory.changeNote(id, body));
  }
  if (method === "DELETE") return answer(await directory.deleteNote(id));
  return null;
}
