import { exports } from "cloudflare:workers";
import { ID_PATTERN, UID_PATTERN, type ArtifactView, type ProxyRequest } from "../shared/protocol.ts";
import { errorMessage } from "../shared/util.ts";
import { artifactETag, artifactResponse, notModified } from "./artifacts/serve.ts";
import { DEMO_COOKIE, identify } from "./auth/index.ts";
import { filesRoute } from "./files-routes.ts";
import { json, readJson } from "./http.ts";
import { chatRoute } from "./chat-routes.ts";
import { mcpRoute } from "./mcp-routes.ts";
import { modelCatalog, modelSources } from "./models.ts";
import { skillsRoute } from "./skills-routes.ts";
import { chatAgentName } from "./chat-agent.ts";
import { newId, PathError, Storage } from "./storage/index.ts";

export { ChatAgent } from "./chat-agent.ts";
export { Sandbox } from "./sandbox.ts";
export { UserDirectory } from "./users.ts";

/**
 * Which chat each artifact lives in. That never changes once an artifact
 * exists, so a page's live calls, the hottest path, skip the R2 read after
 * the first one in this isolate.
 */
const artifactChats = new Map<string, string>();
const MAX_ARTIFACT_CHATS = 5_000;

async function artifactChat(storage: Storage, id: string): Promise<string | undefined> {
  let name = artifactChats.get(id);
  if (!name) {
    const meta = await storage.artifacts.readMeta(id);
    if (!meta) return undefined;
    name = chatAgentName(meta.ownerUid, meta.chatId);
    if (artifactChats.size >= MAX_ARTIFACT_CHATS) artifactChats.delete(artifactChats.keys().next().value!);
    artifactChats.set(id, name);
  }
  return name;
}

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
      return json({ uid: slug }, 200, { "set-cookie": demoCookie(url, slug, 60 * 60 * 24 * 365) });
    }
    if (method === "DELETE") return json({}, 200, { "set-cookie": demoCookie(url, "", 0) });
  }

  // The artifact page itself, framed by the viewer: public, and the same for everyone, so it needs no identity.
  const page = path.match(/^\/u\/([a-z0-9]+)\/v(\d+)$/);
  if (page && method === "GET") return artifactPage(request, storage, page[1], Number(page[2]));

  const identity = await identify(request, env);
  if (path === "/api/me" && method === "GET") {
    if (!identity) return json({ error: "Not signed in", auth: env.AUTH_MODE }, 401);
    return json({ ...identity, auth: env.AUTH_MODE });
  }
  // Published artifacts are public: anyone with a link may view a page and load its live data, signed in or not.
  // Only what a page needs is here; the chat it came from, its owner and everything else need a sign-in below.
  const [, matchedId, artifactSub] = path.match(/^\/api\/artifacts\/([a-z0-9]+)(\/mcp|\/tools|\/clone)?$/) ?? [];
  const artifactId = matchedId && ID_PATTERN.test(matchedId) ? matchedId : undefined;
  if (artifactId && artifactSub !== "/clone") {
    const response = await publicArtifactRoute(request, url, env, storage, artifactId, artifactSub, identity?.uid ?? null);
    if (response) return response;
  }

  // Everything else needs a verified identity.
  if (!identity) return json({ error: "Not signed in" }, 401);
  const { uid } = identity;

  // A read-only Git token for the artifact's repo, for `git clone`. Only the owner gets one:
  // the repo also holds the version history and the metadata.
  if (artifactId && artifactSub === "/clone" && method === "POST") {
    const meta = await storage.artifacts.readMeta(artifactId);
    if (!meta) return json({ error: "No such artifact" }, 404);
    if (uid !== meta.ownerUid) return json({ error: "Only the artifact's owner can clone it." }, 403);
    const access = await storage.artifacts.cloneAccess(meta.id);
    return access ? json(access) : json({ error: "This artifact has no repository yet; it gets one when it is next published." }, 404);
  }

  const mcp = await mcpRoute(request, env, uid);
  if (mcp) return mcp;

  const directory = exports.UserDirectory.getByName(uid);
  if (path === "/api/chats" && method === "GET") return json(await directory.listChats());
  if (path === "/api/chats" && method === "POST") return json(await directory.createChat(newId()));
  if (path === "/api/artifacts" && method === "GET") return json(await directory.listArtifacts());
  // The model picker's choices. The cloud's change only with a deploy; a local runtime's whenever a model is loaded.
  if (path === "/api/models" && method === "GET") {
    const cacheControl = env.LOCAL_MODELS_URL ? "no-store" : "private, max-age=3600";
    return json(modelCatalog(await modelSources(env)), 200, { "cache-control": cacheControl });
  }

  const skills = await skillsRoute(request, directory);
  if (skills) return skills;

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

  const files = await filesRoute(request, () => storage.userFiles(uid));
  if (files) return files;

  return json({ error: "Not found" }, 404);
}

/** One version of a published page. Versions never change, so a repeat view is a 304 without reading R2. */
async function artifactPage(request: Request, storage: Storage, id: string, version: number): Promise<Response> {
  if (!ID_PATTERN.test(id)) return new Response("Not found", { status: 404 });
  const etag = artifactETag(id, version);
  const cached = notModified(request, etag);
  if (cached) return cached;
  const html = await storage.artifacts.readHtml(id, version);
  return html === null ? new Response("Not found", { status: 404 }) : artifactResponse(html, etag);
}

/**
 * An artifact's metadata, its declared tools and its live calls (`sub` "", "/tools" or "/mcp"): open to viewers who
 * are not signed in (`viewer` null), counted per IP address. Undefined for any other method.
 */
async function publicArtifactRoute(request: Request, url: URL, env: Env, storage: Storage, id: string, sub: string | undefined, viewer: string | null): Promise<Response | undefined> {
  const method = request.method;
  const isTools = sub === "/tools" && method === "GET";
  const isCall = sub === "/mcp" && method === "POST";
  const isMeta = !sub && method === "GET";
  if (!isTools && !isCall && !isMeta) return undefined;
  // Viewers who are not signed in are counted by IP address.
  const who = viewer ?? `ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
  // Anyone may ask for any id here, and an unknown one misses the R2 cache and looks for its repo: limit that per IP.
  if (viewer === null && !isCall) {
    const { success } = await env.PAGE_CALLS.limit({ key: `${who}:public` });
    if (!success) return json({ error: "Too many requests." }, 429);
  }
  // A page's tool list and live calls go to the chat that published it, which decides what this viewer may call.
  if (isTools || isCall) {
    const name = await artifactChat(storage, id);
    if (!name) return json({ error: "No such artifact" }, 404);
    const chat = exports.ChatAgent.getByName(name);
    if (sub === "/tools") {
      const tools = await chat.artifactTools(id, Number(url.searchParams.get("version")), viewer);
      return tools ? json(tools) : json({ error: "No such artifact version." }, 404);
    }
    const body = await readJson<ProxyRequest>(request);
    if (typeof body?.server !== "string" || typeof body.tool !== "string" || !Number.isInteger(body.version) || !["read", "call"].includes(body.mode)) {
      return json({ ok: false, error: { code: "bad_request", message: "Expected {version, mode, server, tool, input}." } }, 400);
    }
    // Counted per viewer and chat: a chat's pages share its Durable Object, whatever page they come from.
    const { success } = await env.PAGE_CALLS.limit({ key: `${who}:${name}` });
    if (!success) return json({ ok: false, error: { code: "rate_limited", message: "Too many calls from this page.", retryAfterMs: 30_000 } }, 429);
    return json(await chat.artifactCall({ artifactId: id, viewer, request: body }));
  }
  const meta = await storage.artifacts.readMeta(id);
  if (!meta) return json({ error: "No such artifact" }, 404);
  // Not the chat it lives in, nor who owns it: only whether the viewer does.
  const { chatId: _chatId, ownerUid: _ownerUid, ...visible } = meta;
  return json({ ...visible, isOwner: viewer === meta.ownerUid } satisfies ArtifactView);
}

function demoCookie(url: URL, value: string, maxAge: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${DEMO_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
