import { exports, waitUntil } from "cloudflare:workers";
import { DICTATION_ROUTE } from "../shared/dictation.ts";
import { ID_PATTERN, isSecondSeatUid, UID_PATTERN, type ArtifactView, type ProxyRequest } from "../shared/protocol.ts";
import { errorMessage } from "../shared/util.ts";
import { PageCallCache } from "./artifacts/page-calls.ts";
import { pageAiRoute, pageFailed, pageStorageRoute, type PageHome } from "./artifacts/page-routes.ts";
import { artifactETag, artifactResponse, notModified, sourceETag, sourceResponse } from "./artifacts/serve.ts";
import { DEMO_COOKIE, identify } from "./auth/index.ts";
import { dataRoute } from "./data-routes.ts";
import { dictationRoute } from "./dictation.ts";
import { filesRoute } from "./files-routes.ts";
import { json, readJson } from "./http.ts";
import type { UserDirectory } from "./users.ts";
import type { MemoryKind, MemoryScope, ServerCoverage } from "../shared/memory.ts";
import { chatRoute, discussRoute } from "./chat-routes.ts";
import { mcpRoute } from "./mcp-routes.ts";
import { pushRoute } from "./push-routes.ts";
import { mcpServers } from "./mcp/servers.ts";
import { catalogSource, loadCatalog } from "./models.ts";
import { skillsRoute } from "./skills-routes.ts";
import { agentsRoute } from "./agents-routes.ts";
import { memoryRoute } from "./memory-routes.ts";
import { runsRoute } from "./runs-routes.ts";
import { feedRoute } from "./feed-routes.ts";
import type { FeedInput } from "../shared/feed.ts";
import { chatAgentName } from "./chat-agent.ts";
import { newestShown } from "./agents/roster.ts";
import { newId, PathError, Storage } from "./storage/index.ts";

export { ChatAgent } from "./chat-agent.ts";
export { Sandbox } from "./sandbox.ts";
export { UserDirectory } from "./users.ts";
export { Source } from "./source.ts";

/**
 * Where each artifact lives. That never changes once an artifact exists, so a
 * page's live calls, the hottest path, skip the R2 read after the first one in
 * this isolate.
 */
const artifactHomes = new Map<string, PageHome>();
const MAX_ARTIFACT_HOMES = 5_000;

async function artifactHome(storage: Storage, id: string): Promise<PageHome | undefined> {
  let home = artifactHomes.get(id);
  if (!home) {
    const meta = await storage.artifacts.readMeta(id);
    if (!meta) return undefined;
    home = { ownerUid: meta.ownerUid, chat: chatAgentName(meta.ownerUid, meta.chatId) };
    if (artifactHomes.size >= MAX_ARTIFACT_HOMES) artifactHomes.delete(artifactHomes.keys().next().value!);
    artifactHomes.set(id, home);
  }
  return home;
}

/** Pages' live reads, shared by every viewer of a chat's pages this isolate serves (worker/artifacts/page-calls.ts). */
const pageCalls = new PageCallCache();

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof PathError) return json({ error: error.message }, 400);
      console.error(error);
      return json({ error: "Internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const storage = new Storage(env);

  // A form or script on another site could otherwise post as the signed-in user: run a page's write tools, upload
  // files, or open a chat's socket. Browsers name the page a request comes from in Origin on all of these; requests
  // without one (not from a browser) are not forms.
  if ((method !== "GET" && method !== "HEAD") || request.headers.get("upgrade") === "websocket") {
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return json({ error: "Cross-site request refused" }, 403);
  }

  // Demo sign-in: a name and a cookie. Only in local demo mode; deployed, Cloudflare Access signs people in.
  if (path === "/api/session" && env.AUTH_MODE === "demo") {
    if (method === "POST") {
      const { name } = await request.json<{ name?: string }>();
      const slug = String(name ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
      if (!UID_PATTERN.test(slug)) return json({ error: "Pick a name of 2–32 letters or digits." }, 400);
      if (isSecondSeatUid(slug)) return json({ error: "That name is taken; pick another." }, 400);
      return json({ uid: slug }, 200, { "set-cookie": demoCookie(url, slug, 60 * 60 * 24 * 365) });
    }
    if (method === "DELETE") return json({}, 200, { "set-cookie": demoCookie(url, "", 0) });
  }

  const identity = await identify(request, env);
  if (path === "/api/me" && method === "GET") {
    if (!identity) return json({ error: "Not signed in", auth: env.AUTH_MODE }, 401);
    return json({ ...identity, auth: env.AUTH_MODE });
  }
  // Everything else needs a verified identity: artifacts are shared by link, but only with people the app lets in.
  if (!identity) return json({ error: "Not signed in" }, 401);
  const { uid } = identity;

  // The artifact page itself, framed by the viewer, or (/source) the page as written, to read. Whoever may view the page may read it.
  const page = path.match(/^\/u\/([a-z0-9]+)\/v(\d+)(\/source)?$/);
  if (page && method === "GET") return artifactPage(request, storage, uid, page[1], Number(page[2]), !!page[3]);

  // Artifact metadata, the MCP proxy, and what a page saves and asks its model.
  const artifact = path.match(/^\/api\/artifacts\/([a-z0-9]+)(\/mcp|\/tools|\/clone|\/seen|\/storage|\/ai|\/discuss)?$/);
  if (artifact && ID_PATTERN.test(artifact[1])) {
    const id = artifact[1];
    // The owner opened a version of one of their artifacts: only their own sidebar entry changes.
    if (artifact[2] === "/seen" && method === "POST") {
      const version = (await readJson<{ version?: unknown }>(request))?.version;
      if (!Number.isInteger(version)) return json({ error: "Expected {version}." }, 400);
      await exports.UserDirectory.getByName(uid).markArtifactSeen(id, version as number);
      return json({});
    }
    // The chat that discusses the page (worker/chat-routes.ts).
    if (artifact[2] === "/discuss" && method === "POST") {
      const create = (await readJson<{ create?: unknown }>(request))?.create === true;
      return discussRoute(storage, id, { uid, name: identity.email ?? uid }, create);
    }
    // A page's saved values and its model run as the viewer (worker/artifacts/page-routes.ts).
    if ((artifact[2] === "/storage" || artifact[2] === "/ai") && method === "POST") {
      const home = await artifactHome(storage, id);
      if (!home) return pageFailed({ code: "bad_request", message: "No such artifact." }, 404);
      return artifact[2] === "/storage" ? pageStorageRoute(request, env, uid, id, home) : pageAiRoute(request, env, storage, uid);
    }
    // A page's tool list and live calls go to the chat that published it.
    if ((artifact[2] === "/tools" && method === "GET") || (artifact[2] === "/mcp" && method === "POST")) {
      const name = (await artifactHome(storage, id))?.chat;
      if (!name) return json({ error: "No such artifact" }, 404);
      const chat = exports.ChatAgent.getByName(name);
      if (artifact[2] === "/tools") {
        const tools = await chat.artifactTools(id, Number(url.searchParams.get("version")), uid);
        return tools ? json(tools) : json({ error: "No such artifact version." }, 404);
      }
      const body = await readJson<ProxyRequest>(request);
      if (typeof body?.server !== "string" || typeof body.tool !== "string" || !Number.isInteger(body.version) || !["read", "call"].includes(body.mode)) {
        return json({ ok: false, error: { code: "bad_request", message: "Expected {version, mode, server, tool, input}." } }, 400);
      }
      // Counted per viewer and chat: a chat's pages share its Durable Object, whatever page they come from.
      const { success } = await env.PAGE_CALLS.limit({ key: `${uid}:${name}` });
      if (!success) return json({ ok: false, error: { code: "rate_limited", message: "Too many calls from this page.", retryAfterMs: 30_000 } }, 429);
      // A fresh result another viewer's call brought in is served without waking the chat.
      return json(await pageCalls.call(name, id, body, () => chat.artifactCall({ artifactId: id, viewer: uid, request: body })));
    }
    const meta = await storage.artifacts.readMeta(id);
    if (!meta) return json({ error: "No such artifact" }, 404);
    if (!artifact[2] && method === "GET") {
      // Not who owns it, only whether the viewer does. The chat it lives in only when asked (?chat), and only to people
      // in that chat, so they can go back to building it there.
      const { chatId, ownerUid: _ownerUid, ...visible } = meta;
      const isOwner = uid === meta.ownerUid;
      const chat = exports.ChatAgent.getByName(chatAgentName(meta.ownerUid, chatId));
      // Not what turns apart from the chat published with their replies not posted: someone else sees the newest
      // version that is the chat's.
      const [withheld, inChat] = await Promise.all([
        isOwner ? undefined : chat.withheldFrom(id, uid),
        url.searchParams.has("chat") && chat.isInChat(uid),
      ]);
      if (withheld?.page) return json({ error: "No such artifact" }, 404);
      const hidden = new Set(withheld?.versions);
      const latest = newestShown(visible.latest, hidden);
      if (!latest) return json({ error: "No such artifact" }, 404);
      const versions = visible.versions.filter((version) => !hidden.has(version.version));
      // Nor when a withheld one came out.
      const updatedAt =
        latest === visible.latest ? visible.updatedAt : (versions.find((version) => version.version === latest)?.publishedAt ?? visible.updatedAt);
      return json({ ...visible, latest, updatedAt, versions, isOwner, ...(inChat && { chatId }) } satisfies ArtifactView);
    }
    // A read-only Git token for the artifact's repo, for `git clone`. Only the owner gets one:
    // the repo also holds the version history and the metadata.
    if (artifact[2] === "/clone" && method === "POST") {
      if (uid !== meta.ownerUid) return json({ error: "Only the artifact's owner can clone it." }, 403);
      const access = await storage.artifacts.cloneAccess(meta.id);
      return access ? json(access) : json({ error: "This artifact has no repository yet; it gets one when it is next published." }, 404);
    }
  }

  const mcp = await mcpRoute(request, env, uid);
  if (mcp) return mcp;
  const push = await pushRoute(request, env, uid);
  if (push) return push;

  const directory = exports.UserDirectory.getByName(uid);
  // The sidebar's socket: it hears which of the chat, artifact and skill lists changed (worker/users.ts).
  if (path === "/api/me/ws" && method === "GET") {
    if (request.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket upgrade" }, 426);
    return directory.fetch(request);
  }
  // Speech to text for browsers whose own recognition is missing or cannot reach its service (worker/dictation.ts).
  if (path === DICTATION_ROUTE && method === "POST") return dictationRoute(request, env, uid, directory);
  if (path === "/api/chats" && method === "GET") return json(await directory.listChats());
  // The people this user shares chats with: whom "@" offers to add to a chat.
  if (path === "/api/me/people" && method === "GET") return json(await directory.knownPeople());
  if (path === "/api/chats" && method === "POST") return json(await directory.createChat(newId()));
  if (path === "/api/artifacts" && method === "GET") return json(await directory.listArtifacts());
  // The model picker's choices: the models AI Gateway's providers list (for those it holds a key for), and Workers AI's.
  // POST asks the providers again now, for a key added since.
  if (path === "/api/models" && (method === "GET" || method === "POST")) {
    return json(await loadCatalog(catalogSource(env, storage.models, waitUntil), { refresh: method === "POST" }), 200, { "cache-control": "private, no-cache" });
  }

  // The user's own system prompt, added to the built-in one in all their chats. PUT {text}; empty clears it. readJson
  // takes only a JSON content type, so another site cannot set it for a signed-in user.
  if (path === "/api/me/system-prompt" && method === "GET") return json(await directory.systemPrompt());
  if (path === "/api/me/system-prompt" && method === "PUT") {
    const saved = await directory.setSystemPrompt((await readJson<{ text?: unknown }>(request))?.text);
    return json(saved, "error" in saved ? 400 : 200);
  }

  // Export and import of everything the user has (worker/data-routes.ts).
  const data = await dataRoute(request, uid, directory, storage);
  if (data) return data;

  const skills = await skillsRoute(request, directory, () => storage.skillFiles(uid));
  if (skills) return skills;

  const agents = await agentsRoute(
    request,
    directory,
    // A chat of someone else's the agent's owner brought it into as a member is named after that chat's owner.
    ({ chatId, ownerUid }, agentId) => exports.ChatAgent.getByName(chatAgentName(ownerUid ?? uid, chatId)).agentDeleted(agentId, uid),
    mcpServers(env),
  );
  if (agents) return agents;
  const runs = await runsRoute(request, uid, directory, env.DEV_TOOLS === "true");
  if (runs) return runs;
  // The feed, and follows of others' pages and agents (worker/feed-routes.ts).
  const feed = await feedRoute(request, uid, directory, storage);
  if (feed) return feed;

  const memory = await memoryRoute(request, directory);
  if (memory) return memory;

  // A chat's Durable Object is named after its owner's verified uid; others reach it only once they joined by an invite.
  const chat = await chatRoute(request, directory, { uid, name: identity.email ?? uid }, (owner) => storage.userFiles(owner));
  if (chat) return chat;

  // Publish a page without the model, to try the live-data path locally. Needs DEV_TOOLS=true.
  const devPublish = path.match(/^\/api\/dev\/chats\/([a-z0-9]+)\/publish$/);
  if (devPublish && method === "POST" && env.DEV_TOOLS === "true") {
    if (!(await directory.hasChat(devPublish[1]))) return json({ error: "No such chat" }, 404);
    try {
      return json(await exports.ChatAgent.getByName(chatAgentName(uid, devPublish[1])).devPublish(await request.json()));
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Save an agent as the model proposes one (off, for review), to try its draft card and page without the model.
  if (path === "/api/dev/agents/propose" && method === "POST" && env.DEV_TOOLS === "true") {
    const saved = await directory.saveAgent(await readJson(request), "agent", false);
    return json(saved, "error" in saved ? 400 : 201);
  }

  // Save notes as agents learn them in a chat, and what servers cover, to try the Memory view without the model. Needs DEV_TOOLS=true.
  if (path === "/api/dev/memory" && method === "POST" && env.DEV_TOOLS === "true") return devMemory(request, directory);
  // Add an item to the caller's own feed, to try the feed without runs or a model. Needs DEV_TOOLS=true.
  if (path === "/api/dev/feed" && method === "POST" && env.DEV_TOOLS === "true") {
    const item = await readJson<FeedInput>(request);
    if (!item || typeof item.ref !== "string" || typeof item.title !== "string" || !item.open) {
      return json({ error: "Expected a feed item (shared/feed.ts)." }, 400);
    }
    return json({ kept: await directory.addFeed({ ...item, ref: `dev:${item.ref}`, at: item.at || Date.now() }) });
  }

  const files = await filesRoute(request, () => storage.userFiles(uid));
  if (files) return files;

  return json({ error: "Not found" }, 404);
}

/**
 * One version of a published page, or with `source` its HTML as plain text. Versions never change, so a repeat view
 * is a 304 without reading R2.
 */
async function artifactPage(request: Request, storage: Storage, uid: string, id: string, version: number, source: boolean): Promise<Response> {
  if (!ID_PATTERN.test(id)) return new Response("Not found", { status: 404 });
  const [etag, respond] = source ? [sourceETag(id, version), sourceResponse] : [artifactETag(id, version), artifactResponse];
  const cached = notModified(request, etag);
  if (cached) return cached;
  // Not a version a turn apart from the chat published with its reply not posted, but for the owner. Asked while the
  // page is read: what it holds is not sent unless the viewer may see it.
  const shown = artifactHome(storage, id).then(async (home) => {
    if (!home) return false;
    if (home.ownerUid === uid) return true;
    const withheld = await exports.ChatAgent.getByName(home.chat).withheldFrom(id, uid);
    return !withheld.page && !withheld.versions.includes(version);
  });
  const [html, may] = await Promise.all([storage.artifacts.readHtml(id, version), shown]);
  return html === null || !may ? new Response("Not found", { status: 404 }) : respond(html, etag);
}

function demoCookie(url: URL, value: string, maxAge: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${DEMO_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/** See /api/dev/memory: {learn?: [{chatId, text, scope, kind, agentId?, learnedBy?, byOwner?}], coverage?: [ServerCoverage]}. */
async function devMemory(request: Request, directory: DurableObjectStub<UserDirectory>): Promise<Response> {
  const body = await readJson<{ learn?: Record<string, unknown>[]; coverage?: ServerCoverage[] }>(request);
  if (!body) return json({ error: "Expected JSON." }, 400);
  if (Array.isArray(body.coverage)) await directory.noteCoverage(body.coverage);
  const learned = [];
  for (const note of body.learn ?? []) {
    const chatId = String(note.chatId);
    const kind = await directory.chatKind(chatId);
    const agentId = typeof note.agentId === "string" ? note.agentId : undefined;
    learned.push(
      await directory.learnNote(
        { chatId, kinds: [kind], alone: kind === "private", byOwner: note.byOwner !== false, learnedBy: String(note.learnedBy ?? "pi"), ...(agentId && { agentId }) },
        { text: note.text, scope: note.scope as MemoryScope, kind: note.kind as MemoryKind },
      ),
    );
  }
  return json(learned);
}
