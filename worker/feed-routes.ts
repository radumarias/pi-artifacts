import { exports } from "cloudflare:workers";
import { AGENT_ID_PATTERN } from "../shared/agents.ts";
import { isFollowKind } from "../shared/feed.ts";
import { ID_PATTERN } from "../shared/protocol.ts";
import { chatAgentName } from "./chat-agent.ts";
import { json, readJson } from "./http.ts";
import type { Storage } from "./storage/index.ts";
import type { UserDirectory } from "./users.ts";

/**
 * A verified user's feed and follows (`uid`, and `directory` their UserDirectory; shared/feed.ts):
 *   GET    /api/feed?unread&needs   the newest items (only unread ones, only those needing them), and the counts
 *   GET    /api/feed/counts         only the counts: what the sidebar's entry shows
 *   POST   /api/feed/read           {ids} or {all: true}, with {read: false} to mark unread again: the unread count
 *   GET    /api/follows             what they follow
 *   POST   /api/follows             {kind: "page", id} or {kind: "agent", id, chatId}: follow it
 *   DELETE /api/follows/:kind/:id   stop following it
 * Following needs what opening the target needs: a page anyone signed in may open (pages are shared by link), as long
 * as it exists; an agent only someone in a chat where its owner shares it (ChatAgent.sharedAgent). Nobody follows their
 * own: those reach them already. POST bodies are JSON (readJson), so another site cannot follow for them. Null for
 * any other path.
 */
export async function feedRoute(request: Request, uid: string, directory: DurableObjectStub<UserDirectory>, storage: Storage): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === "/api/feed" && method === "GET") {
    return json(await directory.feed({ unread: url.searchParams.has("unread"), needsYou: url.searchParams.has("needs") }));
  }
  if (path === "/api/feed/counts" && method === "GET") return json(await directory.feedCounts());
  if (path === "/api/feed/read" && method === "POST") {
    const body = await readJson<{ ids?: unknown; all?: unknown; read?: unknown }>(request);
    const ids = Array.isArray(body?.ids) && body.ids.length <= 500 && body.ids.every((id) => Number.isSafeInteger(id)) ? (body.ids as number[]) : null;
    if (!body || (body.all !== true && !ids)) return json({ error: "Expected {ids: [numbers]} or {all: true}." }, 400);
    return json(await directory.markFeed(body.all === true ? "all" : ids!, body.read !== false));
  }
  if (path === "/api/follows" && method === "GET") return json(await directory.listFollows());
  if (path === "/api/follows" && method === "POST") {
    const body = await readJson<{ kind?: unknown; id?: unknown; chatId?: unknown }>(request);
    if (!body || !isFollowKind(body.kind) || typeof body.id !== "string") return json({ error: "Expected {kind: \"page\" | \"agent\", id}." }, 400);
    const target = body.kind === "page" ? await pageTarget(storage, body.id) : await agentTarget(directory, uid, body.id, body.chatId);
    if ("status" in target) return json({ error: target.error }, target.status);
    if (target.ownerUid === uid) return json({ error: `This ${body.kind} is yours: what it does reaches you already.` }, 400);
    // Both sides, the follower's first (UserDirectory.follow).
    const followed = await directory.follow({
      kind: body.kind,
      id: body.id,
      ownerUid: target.ownerUid,
      title: target.title,
      ...(target.chat && { chatOwner: target.chat.ownerUid, chatId: target.chat.id }),
    });
    return "error" in followed ? json(followed, 409) : json(followed, 201);
  }
  const one = path.match(/^\/api\/follows\/([a-z]+)\/([a-z0-9]+)$/);
  if (one && method === "DELETE" && isFollowKind(one[1])) {
    return json(await directory.unfollow(one[1], one[2], url.searchParams.get("chat") ?? undefined));
  }
  return null;
}

type Target = { ownerUid: string; title: string; chat?: { ownerUid: string; id: string } } | { status: number; error: string };

/** A page to follow: any that exists. */
async function pageTarget(storage: Storage, id: string): Promise<Target> {
  if (!ID_PATTERN.test(id)) return { status: 404, error: "No such page." };
  const meta = await storage.artifacts.readMeta(id);
  return meta ? { ownerUid: meta.ownerUid, title: meta.title } : { status: 404, error: "No such page." };
}

/** An agent to follow, from a chat this user is in where its owner shares it: as opening it there checks. */
async function agentTarget(directory: DurableObjectStub<UserDirectory>, uid: string, id: string, chatId: unknown): Promise<Target> {
  if (!AGENT_ID_PATTERN.test(id)) return { status: 404, error: "No such agent." };
  if (typeof chatId !== "string" || !ID_PATTERN.test(chatId)) return { status: 400, error: "Name the chat it is shared in: {kind: \"agent\", id, chatId}." };
  const chatOwner = await directory.chatOwner(chatId);
  if (!chatOwner) return { status: 404, error: "No such chat." };
  const shared = await exports.ChatAgent.getByName(chatAgentName(chatOwner, chatId)).sharedAgent(uid, id);
  if ("status" in shared) return { status: shared.status, error: shared.error };
  return { ownerUid: shared.ownerUid, title: `@${shared.name}`, chat: { ownerUid: chatOwner, id: chatId } };
}
