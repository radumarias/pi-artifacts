import { exports } from "cloudflare:workers";
import { ID_PATTERN, SOCKET_NOT_A_MEMBER, type CreatedInvite, type Person } from "../shared/protocol.ts";
import { chatAgentName, PERSON_HEADER, type ChatRefusal } from "./chat-agent.ts";
import { closedSocket, json, readJson } from "./http.ts";
import { parseInviteToken } from "./members.ts";
import type { UserDirectory } from "./users.ts";

/**
 * A chat's socket and invites, for a verified `person`. The chat object decides who may do what;
 * these routes only find it and turn its answers into HTTP.
 *   GET    /api/chats/:id/ws                  the chat's WebSocket, for its owner and members; it also carries who is in the chat
 *   POST   /api/chats/:id/invites             (owner) a new single-use invite link
 *   DELETE /api/chats/:id/invites/:inviteId   (owner) revoke an invite
 *   DELETE /api/chats/:id/members/:uid        (owner) remove a member, or (member) leave
 *   POST   /api/invites/accept                {token}: join the chat an invite link is for
 * Returns null for any other path.
 */
export async function chatRoute(request: Request, directory: DurableObjectStub<UserDirectory>, person: Person): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method;
  const answer = (refusal: ChatRefusal | null) => (refusal ? json({ error: refusal.error }, refusal.status) : json({}));

  if (url.pathname === "/api/invites/accept" && method === "POST") {
    const token = parseInviteToken((await readJson<{ token?: unknown }>(request))?.token);
    // Checked against the owner's index first, so a made-up token never wakes a chat object.
    if (!token || !(await exports.UserDirectory.getByName(token.ownerUid).hasChat(token.chatId))) {
      return json({ error: "This invite link is not valid." }, 404);
    }
    const refused = await exports.ChatAgent.getByName(chatAgentName(token.ownerUid, token.chatId)).acceptInvite(token.secret, person);
    return refused ? answer(refused) : json({ chatId: token.chatId });
  }

  const match = url.pathname.match(/^\/api\/chats\/([a-z0-9]+)\/(ws|invites|members)(?:\/([a-z0-9-]+))?$/);
  if (!match || !ID_PATTERN.test(match[1])) return null;
  const [, chatId, what, item] = match;
  const isSocket = what === "ws" && !item;
  if (isSocket && request.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket upgrade" }, 426);
  // Own chats and chats shared with this user.
  const ownerUid = await directory.chatOwner(chatId);
  if (!ownerUid) return isSocket ? closedSocket(SOCKET_NOT_A_MEMBER, "No such chat") : json({ error: "No such chat" }, 404);
  const chat = exports.ChatAgent.getByName(chatAgentName(ownerUid, chatId));

  if (isSocket) {
    // Set here, from the verified identity, replacing anything the browser sent under that name.
    const forwarded = new Request(request);
    forwarded.headers.set(PERSON_HEADER, JSON.stringify(person));
    return chat.fetch(forwarded);
  }
  if (what === "invites" && method === "POST" && !item) {
    const created = await chat.createInvite(person);
    if ("status" in created) return answer(created);
    const { token, ...invite } = created;
    return json({ ...invite, url: `${url.origin}/join/${token}` } satisfies CreatedInvite);
  }
  if (what === "invites" && method === "DELETE" && item) return answer(await chat.revokeInvite(person, item));
  if (what === "members" && method === "DELETE" && item) return answer(await chat.removeMember(person, item));
  return null;
}
