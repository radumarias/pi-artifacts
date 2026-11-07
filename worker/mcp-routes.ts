import { exports } from "cloudflare:workers";
import { errorMessage } from "../shared/util.ts";
import { json, readJson } from "./http.ts";
import { mcpAuthStore } from "./users.ts";
import { finishSignIn, OAUTH_CALLBACK_PATH, serverOfState, SIGN_IN_PATH, startSignIn } from "./mcp/oauth.ts";
import { oauthServers } from "./mcp/servers.ts";

/**
 * Sign-in to an MCP server that signs in each user, for a verified `uid`:
 *   GET /api/mcp/sign-in/:name     the link the agent gives in chat: starts the MCP OAuth flow and redirects to it
 *   GET /api/mcp/oauth/callback    where the authorization server sends the browser back
 *   GET /api/mcp/sign-ins          the account menu's list: each such server, signed in or not, and since when
 *   DELETE /api/mcp/sign-ins/:name Disconnect: forget the stored sign-in, tokens and registration
 *   DELETE /api/mcp/notices/:name  dismiss the sidebar's notice about a sign-in
 * With DEV_TOOLS=true, to try the notices without scheduled runs:
 *   POST /api/mcp/dev/:name/runs     { chatId }: that chat's runs use the server (UserDirectory.setRunServers)
 *   POST /api/mcp/dev/:name/needed   { chatId?, what? }: a run needs a new sign-in (UserDirectory.notifySignInNeeded)
 * Returns null for any other path.
 */
export async function mcpRoute(request: Request, env: Env, uid: string): Promise<Response | null> {
  const url = new URL(request.url);
  const servers = oauthServers(env);
  const directory = () => exports.UserDirectory.getByName(uid);

  if (url.pathname === SIGN_INS_PATH && request.method === "GET") return json(await directory().mcpSignIns());
  const change = /^\/api\/mcp\/(sign-ins|notices)\/([^/]+)$/.exec(url.pathname);
  if (change && request.method === "DELETE") {
    const server = servers.find((s) => s.name === decodeURIComponent(change[2]!));
    if (!server) return json({ error: "No server by that name signs in here." }, 404);
    return json(change[1] === "sign-ins" ? await directory().disconnectMcp(server.name) : await directory().dismissSignInNotice(server.name));
  }
  const dev = /^\/api\/mcp\/dev\/([^/]+)\/(runs|needed)$/.exec(url.pathname);
  if (dev && request.method === "POST" && env.DEV_TOOLS === "true") {
    const server = servers.find((s) => s.name === decodeURIComponent(dev[1]!));
    const body = (await readJson<{ chatId?: unknown; what?: unknown }>(request)) ?? {};
    const chatId = typeof body.chatId === "string" ? body.chatId : undefined;
    if (!server) return json({ error: "No server by that name signs in here." }, 404);
    if (dev[2] === "runs") {
      if (!chatId || !(await directory().hasChat(chatId))) return json({ error: "No such chat" }, 404);
      await directory().setRunServers(chatId, [server.name]);
    } else await directory().notifySignInNeeded(server.name, { chatId, what: typeof body.what === "string" ? body.what : undefined });
    return json(await directory().mcpSignIns());
  }
  if (request.method !== "GET") return null;

  const name = url.pathname.startsWith(SIGN_IN_PATH) ? url.pathname.slice(SIGN_IN_PATH.length) : undefined;
  if (name && !name.includes("/")) {
    const server = servers.find((s) => s.name === decodeURIComponent(name));
    if (!server) return page("Sign-in failed", "This app has no server by that name to sign in to.", 404);
    try {
      const started = await startSignIn(server.url, server.name, mcpAuthStore(uid, server.name), `${url.origin}${OAUTH_CALLBACK_PATH}`);
      if ("url" in started) return Response.redirect(started.url, 302);
      return page(`Signed in to ${server.name}`, "You already were. Go back to the chat and ask again.");
    } catch (error) {
      const reason = errorMessage(error);
      return page("Sign-in failed", `${server.name} did not start a sign-in (${server.url} should be an MCP server or portal address): ${reason}`, 502);
    }
  }

  if (url.pathname === OAUTH_CALLBACK_PATH) {
    const state = url.searchParams.get("state") ?? "";
    const server = servers.find((s) => s.name === serverOfState(state));
    const denied = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (!server) return page("Sign-in failed", "This sign-in link is not for a server this app knows.", 400);
    if (denied || !code) return page("Sign-in failed", denied ?? "The sign-in returned no code.", 400);
    try {
      await finishSignIn(server.url, server.name, mcpAuthStore(uid, server.name), code, state);
      // A new grant starts: the notices go, and chats with runs waiting on this server hear it.
      await directory().onSignedIn(server.name);
      return page(`Signed in to ${server.name}`, "Go back to the chat and ask again. You can close this tab.");
    } catch (error) {
      return page("Sign-in failed", errorMessage(error), 400);
    }
  }

  return null;
}

const SIGN_INS_PATH = "/api/mcp/sign-ins";

function page(title: string, message: string, status = 200): Response {
  const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>
<body style="font: 15px system-ui, sans-serif; padding: 32px; max-width: 560px"><h1 style="font-size: 18px">${escape(title)}</h1><p>${escape(message)}</p></body>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "cache-control": "no-store" },
  });
}
