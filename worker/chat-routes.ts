import { exports } from "cloudflare:workers";
import type { MentionOptions } from "../shared/mentions.ts";
import { ID_PATTERN, SOCKET_NOT_A_MEMBER, type ArtifactSummary, type ChatContents, type ChatDeletion, type CreatedInvite, type Person } from "../shared/protocol.ts";
import { chatAgentName, closedSocket, PERSON_HEADER, type ChatRefusal } from "./chat-agent.ts";
import { serveChatFile, storeUpload } from "./files-routes.ts";
import { json, readJson } from "./http.ts";
import { parseInviteToken } from "./members.ts";
import { newestFirst, type UserFiles } from "./storage/user-files.ts";
import type { UserDirectory } from "./users.ts";

/**
 * A chat's socket and invites, for a verified `person`. The chat object decides who may do what;
 * these routes only find it and turn its answers into HTTP.
 *   DELETE /api/chats/:id                     (owner) {files?: string[]}: delete the chat, its artifacts and those of its files listed
 *   GET    /api/chats/:id/deletion            (owner) what that would delete
 *   GET    /api/chats/:id/ws                  the chat's WebSocket, for its owner and members; it also carries who is in the chat
 *   POST   /api/chats/:id/invites             (owner) a new single-use invite link
 *   DELETE /api/chats/:id/invites/:inviteId   (owner) revoke an invite
 *   DELETE /api/chats/:id/members/:uid        (owner) remove a member, or (member) leave
 *   POST   /api/chats/:id/attachments         files for a message, as POST /api/files takes them, into the owner's files
 *   POST   /api/chats/:id/seen                this user has seen the chat: it is no longer unread in their sidebar.
 *                                             {seenAt?}: when they had last seen it, if something came in since
 *   GET    /api/chats/:id/mentions            what "@" offers in the composer: for the owner their files and artifacts,
 *                                             for anyone else the chat's files and artifacts, and their own files
 *   GET    /api/chats/:id/contents            the chat's files and artifacts (the owner's), for the people in it to open
 *   GET    /api/chats/:id/files/<path>        one of the chat's files, served as GET /api/files/raw/ serves the user's own
 *   POST   /api/invites/accept                {token}: join the chat an invite link is for
 * Returns null for any other path.
 */
export async function chatRoute(
  request: Request,
  directory: DurableObjectStub<UserDirectory>,
  person: Person,
  filesOf: (uid: string) => Promise<UserFiles>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method;
  const answer = (refusal: ChatRefusal | null) => (refusal ? json({ error: refusal.error }, refusal.status) : json({}));

  if (url.pathname === "/api/invites/accept" && method === "POST") {
    const token = parseInviteToken((await readJson<{ token?: unknown }>(request))?.token);
    // Checked against the owner's index first, so a made-up token never wakes a chat object.
    const title = token && (await exports.UserDirectory.getByName(token.ownerUid).chatTitle(token.chatId));
    if (!token || !title) return json({ error: "This invite link is not valid." }, 404);
    const refused = await exports.ChatAgent.getByName(chatAgentName(token.ownerUid, token.chatId)).acceptInvite(token.secret, person, title);
    return refused ? answer(refused) : json({ chatId: token.chatId });
  }

  const file = url.pathname.match(/^\/api\/chats\/([a-z0-9]+)\/files\/(.+)$/);
  if (file && method === "GET" && ID_PATTERN.test(file[1])) {
    const ownerUid = await directory.chatOwner(file[1]);
    if (!ownerUid) return json({ error: "No such chat" }, 404);
    const chat = exports.ChatAgent.getByName(chatAgentName(ownerUid, file[1]));
    return serveChatFile(
      request,
      file[2],
      () => filesOf(ownerUid),
      (path) => chat.mayOpenFile(person.uid, path),
    );
  }

  const match = url.pathname.match(/^\/api\/chats\/([a-z0-9]+)(?:\/(ws|invites|members|attachments|mentions|contents|deletion|seen)(?:\/([a-z0-9-]+))?)?$/);
  if (!match || !ID_PATTERN.test(match[1])) return null;
  const [, chatId, what, item] = match;
  const isSocket = what === "ws" && !item;
  if (isSocket && request.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket upgrade" }, 426);
  // Only this user's own sidebar entry changes, so it needs no chat object.
  if (what === "seen" && method === "POST" && !item) {
    const seenAt = await directory.markSeen(chatId);
    return json(seenAt === null ? {} : { seenAt });
  }
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
  // The agent acts as the owner and reads the owner's files, so a member's attachments go there too.
  if (what === "attachments" && method === "POST" && !item) {
    if (!(await chat.isInChat(person.uid))) return json({ error: "You are not in this chat." }, 403);
    const stored = await storeUpload(request, () => filesOf(ownerUid), person.uid !== ownerUid);
    // Someone else's files go beside the owner's, never over one, and they may attach only what they uploaded (and
    // the chat's files): the chat keeps what that is.
    if (stored.ok && person.uid !== ownerUid) await chat.noteUploads(person.uid, ((await stored.clone().json()) as { paths: string[] }).paths);
    return stored;
  }
  // What "@" offers. The owner: all their files and artifacts (see mentionable). Anyone
  // else: only what the chat holds of the owner's, and their own files, which the chat copies to the owner's when named.
  if (what === "mentions" && method === "GET" && !item) {
    if (!(await chat.isInChat(person.uid))) return json({ error: "You are not in this chat." }, 403);
    const offered = (artifacts: ArtifactSummary[]) => artifacts.map(({ id, title, latest, chatId }) => ({ id, title, latest, chatId }));
    if (person.uid !== ownerUid) {
      const [contents, own] = await Promise.all([chat.contents(person.uid), filesOf(person.uid).then((f) => f.list())]);
      if (!contents) return json({ error: "You are not in this chat." }, 403);
      return json({
        files: [...contents.files, ...newestFirst(own).map((f) => ({ ...f, own: true as const }))],
        artifacts: offered(contents.artifacts),
      } satisfies MentionOptions);
    }
    const [files, artifacts] = await Promise.all([filesOf(ownerUid).then((f) => f.list()), exports.UserDirectory.getByName(ownerUid).listArtifacts()]);
    return json({ files: newestFirst(files), artifacts: offered(artifacts) } satisfies MentionOptions);
  }
  if (what === "contents" && method === "GET" && !item) {
    const contents = await chat.contents(person.uid);
    return contents ? json(contents satisfies ChatContents) : json({ error: "You are not in this chat." }, 403);
  }
  if (!what && method === "DELETE") {
    const asked = (await readJson<{ files?: unknown }>(request))?.files;
    const files = Array.isArray(asked) ? asked.filter((path): path is string => typeof path === "string") : [];
    const refused = await chat.deleteChat(person, { files });
    if (refused) return answer(refused);
    // Last, once the chat holds nothing: until then it stays in the owner's list, to delete again should a step fail.
    await directory.forgetChat(chatId);
    // Its object restarts, and the call fails as it does.
    await chat.resetDeleted().catch(() => {});
    return json({});
  }
  if (what === "deletion" && method === "GET" && !item) {
    const preview = await chat.deletionPreview(person);
    return "status" in preview ? answer(preview) : json(preview satisfies ChatDeletion);
  }
  if (what === "invites" && method === "DELETE" && item) return answer(await chat.revokeInvite(person, item));
  if (what === "members" && method === "DELETE" && item) return answer(await chat.removeMember(person, item));
  return null;
}
