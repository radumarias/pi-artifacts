import { exports } from "cloudflare:workers";
import { copyInput, type AgentChanges, type SharedAgentView } from "../shared/agents.ts";
import type { MentionOptions } from "../shared/mentions.ts";
import {
  ID_PATTERN,
  SEAT_PARAM,
  SECOND_SEAT,
  secondSeat,
  SOCKET_NOT_A_MEMBER,
  type ArtifactSummary,
  type ChatContents,
  type ChatDeletion,
  type CreatedInvite,
  type Person,
} from "../shared/protocol.ts";
import { chatAgentName, closedSocket, PERSON_HEADER, type ChatRefusal } from "./chat-agent.ts";
import { serveChatFile, storeUpload } from "./files-routes.ts";
import type { ChatSystemPrompt } from "../shared/system-prompt.ts";
import { json, readJson } from "./http.ts";
import { parseInviteToken } from "./members.ts";
import { parseRowChange } from "./chat-rows.ts";
import { newestFirst, type UserFiles } from "./storage/user-files.ts";
import { newId, type Storage } from "./storage/index.ts";
import type { UserDirectory } from "./users.ts";

/**
 * A chat's socket and invites, for a verified `person`. The chat object decides who may do what;
 * these routes only find it and turn its answers into HTTP.
 *   DELETE /api/chats/:id                     (owner) {files?: string[]}: delete the chat, its artifacts and those of its files listed
 *   GET    /api/chats/:id/deletion            (owner) what that would delete
 *   GET    /api/chats/:id/ws                  the chat's WebSocket, for its owner and members; it also carries who is in the chat
 *   POST   /api/chats/:id/invites             (owner) a new single-use invite link
 *   DELETE /api/chats/:id/invites/:inviteId   (owner) revoke an invite
 *   PATCH  /api/chats/:id                     this user's own sidebar row (ChatRowChange): {pinned?, closed?, unread?, title?}
 *   POST   /api/chats/:id/members             (owner) {uid}: add someone they share another chat with, directly
 *   DELETE /api/chats/:id/members/:uid        (owner) remove a member, or (member) leave
 *   GET    /api/chats/:id/kind?to=<kind>      (owner) who would lose access if the chat became that kind
 *   PUT    /api/chats/:id/kind                (owner) {kind, loses: uids}: make it that kind, removing exactly `loses`
 *   POST   /api/chats/:id/branch              {entry}: branch off a new chat carrying the conversation up to that entry
 *   POST   /api/chats/:id/seat                (owner) join the chat a second time, as a member (secondSeat)
 *   POST   /api/chats/:id/attachments         files for a message, as POST /api/files takes them, into the owner's files
 *   POST   /api/chats/:id/seen                this user has seen the chat: it is no longer unread in their sidebar.
 *                                             {seenAt?}: when they had last seen it, if something came in since.
 *                                             ?left: they stopped looking at it, so what it showed them is read
 *   GET    /api/chats/:id/mentions            what "@" offers in the composer: for the owner their files and artifacts,
 *                                             for anyone else the chat's files and artifacts, and their own files
 *   GET    /api/chats/:id/contents            the chat's files and artifacts (the owner's), for the people in it to open
 *   GET    /api/chats/:id/files/<path>        one of the chat's files, served as GET /api/files/raw/ serves the user's own
 *   GET    /api/chats/:id/system-prompt       the chat's system prompt, which adds to the owner's own, for the people in it
 *   PUT    /api/chats/:id/system-prompt       (owner) {text}: change it; empty clears it
 *   GET    /api/chats/:id/agents              the chat's agents and their latest turns, for the people in it
 *   POST   /api/chats/:id/agents              (owner) {agentId}: bring one of their agents (turned on) into the chat
 *   DELETE /api/chats/:id/agents/:agentId     (owner) take an agent out of the chat; its replies stay
 *   GET    /api/chats/:id/agents/:agentId     one agent of the chat, read-only (SharedAgentView): its owner, or anyone
 *                                             in the chat while the owner shares it there
 *   PATCH  /api/chats/:id/agents/:agentId     (owner) {shared}: share it with the people of the chat, or stop
 *   POST   /api/chats/:id/agents/:agentId/copy  {…fields, version}: someone's own copy of the version of a shared agent
 *                                             they read (a newer one refuses), with their changes,
 *                                             saved off in their directory with copiedFrom; it runs with their sign-ins
 *   POST   /api/invites/accept                {token}: join the chat an invite link is for
 *   POST   /api/artifacts/:id/discuss         {create?}: the chat that discusses an artifact: its owner opens it, or with
 *                                             `create` makes it; anyone else joins it
 * With `?as=second`, a chat's routes (but its files) take the owner as their second seat in it, and refuse anyone else.
 * Returns null for any other path.
 */
export async function chatRoute(
  request: Request,
  directory: DurableObjectStub<UserDirectory>,
  signedIn: Person,
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
    const refused = await exports.ChatAgent.getByName(chatAgentName(token.ownerUid, token.chatId)).acceptInvite(token.secret, signedIn, title);
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
      (path) => chat.mayOpenFile(signedIn.uid, path),
    );
  }

  const match = url.pathname.match(
    /^\/api\/chats\/([a-z0-9]+)(?:\/(ws|invites|members|attachments|mentions|contents|deletion|seen|seat|system-prompt|agents|kind|branch)(?:\/([a-z0-9-]+)(?:\/(copy))?)?)?$/,
  );
  if (!match || !ID_PATTERN.test(match[1])) return null;
  const [, chatId, what, item, sub] = match;
  // Only an agent's copy has a part after its item.
  if (sub && what !== "agents") return null;
  const isSocket = what === "ws" && !item;
  if (isSocket && request.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket upgrade" }, 426);
  // Only this user's own sidebar entry changes, so it needs no chat object.
  if (what === "seen" && method === "POST" && !item) {
    if (url.searchParams.has("left")) {
      await directory.leftChat(chatId);
      return json({});
    }
    const seenAt = await directory.markSeen(chatId);
    return json(seenAt === null ? {} : { seenAt });
  }
  if (!what && method === "PATCH") {
    const change = parseRowChange(await readJson(request));
    if (!change) return json({ error: "Expected {pinned?, closed?, unread?, title?}." }, 400);
    return (await directory.changeChatRow(chatId, change)) ? json({}) : json({ error: "No such chat" }, 404);
  }
  // Own chats and chats shared with this user.
  const deny = (error: string, status: number) => (isSocket ? closedSocket(SOCKET_NOT_A_MEMBER, error) : json({ error }, status));
  const ownerUid = await directory.chatOwner(chatId);
  if (!ownerUid) return deny("No such chat", 404);
  const chat = exports.ChatAgent.getByName(chatAgentName(ownerUid, chatId));
  const seated = url.searchParams.get(SEAT_PARAM) === SECOND_SEAT;
  if (seated && ownerUid !== signedIn.uid) return deny("Only the chat's owner can sit in it a second time.", 403);
  const person = seated ? secondSeat(signedIn) : signedIn;

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
      // The owner's second seat is their account: it has no files of its own.
      const own = seated ? [] : filesOf(person.uid).then((f) => f.list());
      const [contents, ownFiles] = await Promise.all([chat.contents(person.uid), own]);
      if (!contents) return json({ error: "You are not in this chat." }, 403);
      return json({
        files: [...contents.files, ...newestFirst(ownFiles).map((f) => ({ ...f, own: true as const }))],
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
  if (what === "seat" && method === "POST" && !item) return answer(await chat.addSecondSeat(person));
  if (what === "system-prompt" && !item && (method === "GET" || method === "PUT")) {
    // readJson takes only a JSON content type: another site cannot post one into a signed-in owner's chat.
    const result =
      method === "GET" ? await chat.chatSystemPrompt(person.uid) : await chat.setChatSystemPrompt(person, (await readJson<{ text?: unknown }>(request))?.text);
    return "status" in result ? answer(result) : json(result satisfies ChatSystemPrompt);
  }
  if (what === "agents" && sub === "copy") {
    if (method !== "POST" || !item) return null;
    const shared = await chat.sharedAgent(person.uid, item);
    return "status" in shared ? answer(shared) : copyAgent(request, directory, shared);
  }
  if (what === "agents") {
    const result =
      method === "GET" && !item
        ? await chat.agentsFor(person.uid)
        : method === "POST" && !item
          ? await chat.addAgent(person, (await readJson<{ agentId?: unknown }>(request))?.agentId)
          : method === "GET" && item
            ? await chat.sharedAgent(person.uid, item)
            : method === "PATCH" && item
              ? await chat.setAgentShared(person, item, (await readJson<{ shared?: unknown }>(request))?.shared)
              : method === "DELETE" && item
                ? await chat.removeAgent(person, item)
                : null;
    if (!result) return null;
    return "status" in result ? answer(result) : json(result);
  }
  if (what === "members" && method === "POST" && !item) {
    const added = await chat.addMember(person, (await readJson<{ uid?: unknown }>(request))?.uid);
    return "status" in added ? answer(added) : json(added);
  }
  if (what === "kind" && !item && method === "GET") {
    const preview = await chat.kindPreview(person, url.searchParams.get("to"));
    return "status" in preview ? answer(preview) : json(preview);
  }
  if (what === "kind" && !item && method === "PUT") {
    const body = await readJson<{ kind?: unknown; loses?: unknown }>(request);
    const changed = await chat.changeKind(person, body?.kind, body?.loses);
    return "status" in changed ? json({ error: changed.error, ...(changed.loses && { loses: changed.loses }) }, changed.status) : json(changed);
  }
  if (what === "branch" && !item && method === "POST") {
    const branched = await chat.branchOff(person, (await readJson<{ entry?: unknown }>(request))?.entry);
    return "status" in branched ? answer(branched) : json(branched);
  }
  if (what === "invites" && method === "DELETE" && item) return answer(await chat.revokeInvite(person, item));
  if (what === "members" && method === "DELETE" && item) return answer(await chat.removeMember(person, item));
  return null;
}

/**
 * POST /api/artifacts/:id/discuss: the chat that discusses an artifact (a chat "on a page"). Its owner opens it, or makes
 * it the first time. Anyone else who may open the page (every signed-in person: pages are shared by link) joins the one
 * its owner made; until then there is none to join. Only the owner makes one: the chat's agents act as its owner.
 */
export async function discussRoute(storage: Storage, artifactId: string, signedIn: Person, create: boolean): Promise<Response> {
  const meta = await storage.artifacts.readMeta(artifactId);
  if (!meta) return json({ error: "No such artifact" }, 404);
  const owner = exports.UserDirectory.getByName(meta.ownerUid);
  const existing = await owner.pageChat(artifactId);
  const page = { id: meta.id, title: meta.title, version: meta.latest };
  const title = `About ${meta.title}`;
  if (signedIn.uid === meta.ownerUid) {
    if (existing) return json({ chatId: existing });
    // Made only once the owner confirmed (`create`): anyone who can open the page may then join, and call its agents.
    if (!create) return json({ error: "This page has no chat yet.", canStart: true }, 404);
    const chatId = newId();
    await owner.createChat(chatId, { title, kind: "page" });
    const refused = await exports.ChatAgent.getByName(chatAgentName(meta.ownerUid, chatId)).startPage(signedIn, page);
    if (refused) return json({ error: refused.error }, refused.status);
    await owner.linkPageChat(artifactId, chatId);
    // Whoever follows the page hears it has a chat they may join.
    await owner.pageChatStarted(artifactId, chatId, meta.title);
    return json({ chatId });
  }
  if (!existing) return json({ error: "Nobody discusses this page yet: its author starts the discussion from it." }, 404);
  const chatTitle = (await owner.chatTitle(existing)) ?? title;
  const refused = await exports.ChatAgent.getByName(chatAgentName(meta.ownerUid, existing)).joinPage(signedIn, artifactId, chatTitle);
  return refused ? json({ error: refused.error }, refused.status) : json({ chatId: existing });
}

/**
 * Someone's own copy of an agent shared with them (`shared`, as the chat let them open it), with the fields they
 * changed (the body), saved off in their own directory: the original stays as it is and keeps running as its owner.
 * Its owner copies their own agent the same way. The copy says where it came from, from the chat's word, not the body's.
 */
async function copyAgent(request: Request, directory: DurableObjectStub<UserDirectory>, shared: SharedAgentView): Promise<Response> {
  const body = await readJson<AgentChanges & { version?: unknown }>(request);
  if (!body || typeof body !== "object" || typeof body.version !== "number") {
    return json({ error: "Expected the copy's fields and the version read, as JSON (content-type: application/json)." }, 400);
  }
  // The copy is of the version they read: their changes never mix with a newer one's other fields.
  if (body.version !== shared.version) return json({ error: `@${shared.name} changed since you read it: open it again to see it as it is now.` }, 409);
  const saved = await directory.copyAgent(copyInput(shared, body), { owner: shared.ownerUid, id: shared.id, version: shared.version });
  return "error" in saved ? json(saved, 400) : json(saved, 201);
}
