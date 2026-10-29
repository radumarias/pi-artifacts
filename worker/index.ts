import { exports } from "cloudflare:workers";
import { ID_PATTERN, UID_PATTERN, type ArtifactView, type ProxyRequest } from "../shared/protocol.ts";
import { errorMessage } from "../shared/util.ts";
import { artifactETag, artifactResponse, notModified } from "./artifacts/serve.ts";
import { DEMO_COOKIE, identify } from "./auth/index.ts";
import { json } from "./http.ts";
import { mcpRoute } from "./mcp-routes.ts";
import { skillsRoute } from "./skills-routes.ts";
import { chatAgentName } from "./chat-agent.ts";
import { newId, PathError, Storage } from "./storage/index.ts";

export { ChatAgent } from "./chat-agent.ts";
export { Sandbox } from "./sandbox.ts";
export { UserDirectory } from "./users.ts";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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

  const identity = await identify(request, env);
  if (path === "/api/me" && method === "GET") {
    if (!identity) return json({ error: "Not signed in", auth: env.AUTH_MODE }, 401);
    return json({ ...identity, auth: env.AUTH_MODE });
  }
  // Everything else needs a verified identity: artifacts are shared by link, but only with people the app lets in.
  if (!identity) return json({ error: "Not signed in" }, 401);
  const { uid } = identity;

  // The artifact page itself, framed by the viewer.
  const page = path.match(/^\/u\/([a-z0-9]+)\/v(\d+)$/);
  if (page && method === "GET") {
    const [id, version] = [page[1], Number(page[2])];
    if (!ID_PATTERN.test(id)) return new Response("Not found", { status: 404 });
    const etag = artifactETag(id, version);
    const cached = notModified(request, etag);
    if (cached) return cached;
    const html = await storage.artifacts.readHtml(id, version);
    return html === null ? new Response("Not found", { status: 404 }) : artifactResponse(html, etag);
  }

  // Artifact metadata and the MCP proxy.
  const artifact = path.match(/^\/api\/artifacts\/([a-z0-9]+)(\/mcp|\/tools|\/clone)?$/);
  if (artifact && ID_PATTERN.test(artifact[1])) {
    const id = artifact[1];
    // A page's tool list and live calls go to the chat that published it.
    if ((artifact[2] === "/tools" && method === "GET") || (artifact[2] === "/mcp" && method === "POST")) {
      const name = await artifactChat(storage, id);
      if (!name) return json({ error: "No such artifact" }, 404);
      const chat = exports.ChatAgent.getByName(name);
      if (artifact[2] === "/tools") {
        const tools = await chat.artifactTools(id, Number(url.searchParams.get("version")));
        return tools ? json(tools) : json({ error: "No such artifact version." }, 404);
      }
      const body = await request.json<ProxyRequest>();
      if (typeof body?.server !== "string" || typeof body.tool !== "string" || !Number.isInteger(body.version) || !["read", "call"].includes(body.mode)) {
        return json({ ok: false, error: { code: "bad_request", message: "Expected {version, mode, server, tool, input}." } }, 400);
      }
      // Counted per viewer and chat: a chat's pages share its Durable Object, whatever page they come from.
      const { success } = await env.PAGE_CALLS.limit({ key: `${uid}:${name}` });
      if (!success) return json({ ok: false, error: { code: "rate_limited", message: "Too many calls from this page.", retryAfterMs: 30_000 } }, 429);
      return json(await chat.artifactCall({ artifactId: id, viewer: uid, request: body }));
    }
    const meta = await storage.artifacts.readMeta(id);
    if (!meta) return json({ error: "No such artifact" }, 404);
    if (!artifact[2] && method === "GET") {
      const { chatId: _chatId, ...visible } = meta;
      return json({ ...visible, isOwner: uid === meta.ownerUid } satisfies ArtifactView);
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

  const directory = exports.UserDirectory.getByName(uid);
  if (path === "/api/chats" && method === "GET") return json(await directory.listChats());
  if (path === "/api/chats" && method === "POST") return json(await directory.createChat(newId()));
  if (path === "/api/artifacts" && method === "GET") return json(await directory.listArtifacts());

  const skills = await skillsRoute(request, directory);
  if (skills) return skills;

  // A chat's Durable Object is named after the verified uid, so a user can only ever reach their own chats.
  const socket = path.match(/^\/api\/chats\/([a-z0-9]+)\/ws$/);
  if (socket) {
    if (request.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket upgrade" }, 426);
    if (!ID_PATTERN.test(socket[1]) || !(await directory.hasChat(socket[1]))) return json({ error: "No such chat" }, 404);
    return exports.ChatAgent.getByName(chatAgentName(uid, socket[1])).fetch(request);
  }

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

  if (path === "/api/files" && method === "GET") {
    const files = await storage.userFiles(uid);
    return json(await files.list());
  }
  if (path === "/api/files" && method === "POST") {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "Expected a file field" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: "Files are limited to 10 MB" }, 413);
    const name = file.name.replace(/[^\w .-]/g, "_").replace(/^[.\s]+/, "").slice(0, 120) || "upload";
    const files = await storage.userFiles(uid);
    return json({ path: await files.put(`uploads/${name}`, file.stream(), file.type || undefined) });
  }

  return json({ error: "Not found" }, 404);
}

function demoCookie(url: URL, value: string, maxAge: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${DEMO_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
