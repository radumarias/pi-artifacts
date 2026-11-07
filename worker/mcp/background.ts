import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { isReadOnly, type ToolInfo } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { connectStreamableHttp, fetchWithin, REQUEST_TIMEOUT_MS } from "./connect.ts";
import { McpFailure, type McpConnection, type McpHub } from "./hub.ts";
import { McpOAuthClient, type McpAuthRecord, type McpAuthStore } from "./oauth.ts";
import type { McpServerConfig } from "./servers.ts";

/**
 * Per-user MCP sign-ins used with nobody present: by an agent's scheduled runs, and by the daily keep-alive in
 * UserDirectory. Neither Access nor the OAuth answer says when a refresh token runs out, so the app counts from the
 * sign-in: a grant lasts MCP_GRANT_DAYS (set it to the portal's "grant session duration" in Access).
 */

/** What a check of one server's sign-in found: usable now, needs the user to sign in again, or the server did not answer. */
export type SignInCheck = "ok" | "needs_sign_in" | "unavailable";

/** The grant length when MCP_GRANT_DAYS is not set: Access's default for a portal's grant session is longer; 30 days is a safe count. */
export const DEFAULT_GRANT_DAYS = 30;
/** How long before a grant ends its owner is warned, once: this, or a tenth of a shorter grant. */
export const WARN_AHEAD_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * How often a sign-in that runs use is refreshed when nothing else refreshed it: a little under a day, in case the
 * authorization server ends a session idle for 24 hours.
 */
export const KEEP_ALIVE_MS = 20 * 60 * 60 * 1000;
/** After a keep-alive the server did not answer, how soon it is tried again. */
export const KEEP_ALIVE_RETRY_MS = 60 * 60 * 1000;
/**
 * How long each request of a check may take: a token endpoint that stalls is `unavailable`, and the alarm moves on. As
 * long as a chat's MCP requests may take: a slow refresh that succeeds must not lose its rotated refresh token.
 */
export const CHECK_REQUEST_MS = REQUEST_TIMEOUT_MS;

const DAY_MS = 24 * 60 * 60 * 1000;

/** MCP_GRANT_DAYS as milliseconds: a whole number of days from 1 to 365, else the default. */
export function grantMs(env: { MCP_GRANT_DAYS?: unknown }): number {
  const days = Number(env.MCP_GRANT_DAYS);
  return (Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_GRANT_DAYS) * DAY_MS;
}

/** When to warn about a grant that started at `signedInAt`: WARN_AHEAD_MS before it ends, or a tenth of a grant shorter than 30 days before. */
export function warnAt(signedInAt: number, grant: number): number {
  return signedInAt + grant - Math.min(WARN_AHEAD_MS, grant / 10);
}

/** The callback URL a record's client was registered with: refreshes send the same one. */
export function registeredRedirect(record: McpAuthRecord): string | undefined {
  const client = record.client as { redirect_uris?: unknown } | undefined;
  const fromClient = Array.isArray(client?.redirect_uris) && typeof client.redirect_uris[0] === "string" ? client.redirect_uris[0] : undefined;
  return record.redirectUrl ?? fromClient;
}

/**
 * Check that a stored sign-in still works, with nobody present to sign in: refresh it (which also proves the grant is
 * alive and keeps an idle session going), or, with no refresh token, connect with the access token. It never opens a
 * sign-in and never registers a client. A failure that is not about the sign-in is `unavailable`, so a server that is
 * down does not ask anyone to sign in.
 */
export async function checkSignIn(
  server: McpServerConfig,
  store: McpAuthStore,
  connect: (server: McpServerConfig, client: McpOAuthClient) => Promise<McpConnection> = connectStreamableHttp,
): Promise<SignInCheck> {
  const record = await store.get();
  const redirectUrl = registeredRedirect(record);
  if (!record.tokens || !record.client || !redirectUrl) return "needs_sign_in";
  const client = new McpOAuthClient(store, server.name, { redirectUrl, interactive: false });
  try {
    if (record.tokens.refresh_token) {
      if ((await auth(client, { serverUrl: server.url, fetchFn: timedFetch })) === "AUTHORIZED") return "ok";
      // A refused grant clears the tokens (invalidateCredentials). The SDK also gives up on a refresh the server could
      // not answer (a server_error, a 5xx) and asks for a sign-in instead: with the tokens kept, that is the server.
      return (await store.get()).tokens ? "unavailable" : "needs_sign_in";
    }
    const connection = await connect(server, client);
    await connection.close().catch(() => {});
    return "ok";
  } catch (error) {
    if (error instanceof McpFailure && error.error.code === "auth_required") return "needs_sign_in";
    console.warn(`sign-in check of ${server.name}:`, errorMessage(error));
    return "unavailable";
  }
}

/** fetch, with each request given up after CHECK_REQUEST_MS (an abort the SDK asked for still works). */
const timedFetch = fetchWithin(CHECK_REQUEST_MS);

/**
 * The tools of `server` a run may use: only those the server marks read-only. A scheduled run reads; anything that
 * writes waits for its owner's approval (worker/agents/limits, later).
 */
export async function readOnlyTools(hub: Pick<McpHub, "tools">, server: string): Promise<ToolInfo[]> {
  return (await hub.tools(server)).filter(isReadOnly);
}

/** Refuse, before it reaches the server, a run's call to a tool that is not read-only (or that the server does not list). */
export async function assertReadOnly(hub: Pick<McpHub, "tools">, server: string, tool: string): Promise<void> {
  if ((await readOnlyTools(hub, server)).some((info) => info.name === tool)) return;
  throw new McpFailure({ code: "not_granted", server, message: `${tool} on ${server} is not a read-only tool; a scheduled run may only read.` });
}
