import { exports } from "cloudflare:workers";
import { ID_PATTERN, type ChatPeopleView, type CreatedInvite, type Person } from "../shared/protocol.ts";
import { chatAgentName, PERSON_HEADER } from "./chat-agent.ts";
import { json } from "./http.ts";
import { parseInviteToken } from "./members.ts";

type Directory = ReturnType<typeof exports.UserDirectory.getByName>;

/**
 * A chat's socket, its people and its invites, for a verified `person`:
 *   GET    /api/chats/:id/ws                  the chat's WebSocket, for its owner and members
 *   GET    /api/chats/:id/people              who is in the chat; for the owner, the open invites too
 *   POST   /api/chats/:id/invites             (owner) a new single-use invite link
 *   DELETE /api/chats/:id/invites/:inviteId   (owner) revoke an invite
 *   DELETE /api/chats/:id/members/:uid        (owner) remove a member, or (member) leave
 *   POST   /api/invites/accept                {token}: join the chat an invite link is for
 * Returns null for any other path.
 */
export async function chatRoute(request: Request, directory: Directory, person: Person): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/api/invites/accept" && method === "POST") {
    const body = await request.json<{ token?: unknown }>().catch(() => null);
    const token = parseInviteToken(body?.token);
    // Checked against the owner's index first, so a made-up token never wakes a chat object.
    if (!token || !(await exports.UserDirectory.getByName(token.ownerUid).hasChat(token.chatId))) {
      return json({ error: "This invite link is not valid." }, 404);
    }
    const joined = await exports.ChatAgent.getByName(chatAgentName(token.ownerUid, token.chatId)).acceptInvite(token.secret, person);
    if ("error" in joined) return json(joined, 403);
    await directory.addSharedChat({ id: token.chatId, ownerUid: token.ownerUid, ownerName: joined.ownerName, title: joined.title });
    return json({ chatId: token.chatId });
  }

  const match = url.pathname.match(/^\/api\/chats\/([a-z0-9]+)\/(ws|people|invites|members)(?:\/([a-z0-9-]+))?$/);
  if (!match || !ID_PATTERN.test(match[1])) return null;
  const [, chatId, what, item] = match;
  // Own chats and chats shared with this user. The chat object itself decides whether they are still in it.
  const ownerUid = await directory.chatOwner(chatId);
  if (!ownerUid) return json({ error: "No such chat" }, 404);
  const chat = exports.ChatAgent.getByName(chatAgentName(ownerUid, chatId));
  const isOwner = ownerUid === person.uid;

  if (what === "ws" && !item) {
    if (request.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket upgrade" }, 426);
    if (!isOwner && !(await chat.isInChat(person.uid))) return notInChat(directory, chatId, ownerUid);
    // Set here, from the verified identity, replacing anything the browser sent under that name.
    const forwarded = new Request(request);
    forwarded.headers.set(PERSON_HEADER, JSON.stringify(person));
    return chat.fetch(forwarded);
  }

  if (what === "people" && !item && method === "GET") {
    if (!(await chat.isInChat(person.uid))) return notInChat(directory, chatId, ownerUid);
    const people = await chat.people();
    return json({ ...people, ...(isOwner && { invites: await chat.invites() }) } satisfies ChatPeopleView);
  }

  if (what === "invites" && (method === "POST" || method === "DELETE")) {
    if (!isOwner) return json({ error: "Only the chat's owner can invite people." }, 403);
    if (method === "DELETE") return item && (await chat.revokeInvite(item)) ? json({}) : json({ error: "No such invite" }, 404);
    if (item) return null;
    const created = await chat.createInvite(person);
    if ("error" in created) return json(created, 409);
    const { token, ...invite } = created;
    return json({ ...invite, url: `${url.origin}/join/${token}` } satisfies CreatedInvite);
  }

  if (what === "members" && item && method === "DELETE") {
    if (!isOwner && item !== person.uid) return json({ error: "Only the chat's owner can remove people." }, 403);
    if (!(await chat.removeMember(person.uid, item))) return json({ error: "No such member" }, 404);
    // Their sidebar entry goes too; when they removed themselves, that is this directory.
    await exports.UserDirectory.getByName(item).removeSharedChat(chatId, ownerUid);
    return json({});
  }

  return null;
}

/** A shared chat this user was removed from: forget it in their sidebar. */
async function notInChat(directory: Directory, chatId: string, ownerUid: string): Promise<Response> {
  await directory.removeSharedChat(chatId, ownerUid);
  return json({ error: "You are no longer in this chat." }, 403);
}
