import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { errorMessage, randomHex } from "../../shared/util.ts";

/**
 * One user's OAuth state for one MCP server. It lives in that user's
 * UserDirectory object, so every chat of theirs shares one sign-in and no
 * other user can reach it.
 */
export interface McpAuthRecord {
  /** What dynamic client registration returned. */
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** The redirect URL the client was registered with; refreshes reuse it. */
  redirectUrl?: string;
  /** A sign-in in progress: its PKCE verifier and state. */
  verifier?: string;
  state?: string;
}

/**
 * One change to a record, applied in a single step by the store, so that a
 * sign-in and the token refreshes of several chats cannot overwrite each other.
 */
export type McpAuthChange =
  | { set: Partial<McpAuthRecord> }
  | { clear: (keyof McpAuthRecord)[] | "all" }
  /**
   * Clear the tokens, but only while they are still these. Every chat of a
   * user shares them, and another chat may have refreshed them since.
   */
  | { clearTokensIf: OAuthTokens }
  /** Start a sign-in for this redirect URL: drop everything but a client registered for the same URL. */
  | { restart: string };

export interface McpAuthStore {
  get(): Promise<McpAuthRecord>;
  update(change: McpAuthChange): Promise<void>;
}

/** The record after a change. The store runs this where the record lives, in one step. */
export function applyAuthChange(stored: McpAuthRecord, change: McpAuthChange): McpAuthRecord {
  if ("set" in change) return { ...stored, ...change.set };
  if ("restart" in change) {
    const redirectUrl = change.restart;
    return stored.client && stored.redirectUrl === redirectUrl ? { client: stored.client, redirectUrl } : { redirectUrl };
  }
  if ("clear" in change) {
    if (change.clear === "all") return {};
    const record = { ...stored };
    for (const key of change.clear) delete record[key];
    return record;
  }
  const { tokens, ...rest } = stored;
  return sameTokens(tokens, change.clearTokensIf) ? rest : stored;
}

/** The callback path the authorization server sends the browser back to. */
export const OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

/** Where a user starts signing in to a server: a same-origin link the agent passes on in chat. */
export const SIGN_IN_PATH = "/api/mcp/sign-in/";
export function signInPath(server: string): string {
  return `${SIGN_IN_PATH}${encodeURIComponent(server)}`;
}

/** OAuth state is `<server>~<random>`, so the callback knows which server's sign-in it finishes. */
export function serverOfState(state: string): string | undefined {
  const at = state.lastIndexOf("~");
  return at > 0 ? state.slice(0, at) : undefined;
}

/**
 * The MCP SDK's OAuth client, backed by one user's stored record: discovery,
 * dynamic client registration, PKCE, and token refresh happen in the SDK.
 *
 * It never sends anyone anywhere itself. When the SDK wants a sign-in,
 * `redirectToAuthorization` only records the URL, and the sign-in route
 * redirects the browser to it. A chat's connection is not `interactive`: if
 * its refresh fails, it records nothing, so it cannot overwrite a sign-in the
 * user has open, and the call fails with auth_required.
 */
export class McpOAuthClient implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  readonly #store: McpAuthStore;
  readonly #server: string;
  readonly #redirectUrl: string;
  readonly #interactive: boolean;
  /** The tokens this client last read or saved: the ones a failed refresh was about. */
  #readTokens: OAuthTokens | undefined;

  constructor(store: McpAuthStore, server: string, options: { redirectUrl: string; interactive: boolean }) {
    this.#store = store;
    this.#server = server;
    // The SDK takes a missing redirect URL for a machine-to-machine flow, so there always is one.
    this.#redirectUrl = options.redirectUrl;
    this.#interactive = options.interactive;
  }

  get redirectUrl(): string {
    return this.#redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "pi-artifacts",
      redirect_uris: [this.#redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async state(): Promise<string> {
    const state = `${this.#server}~${randomHex(16)}`;
    if (this.#interactive) await this.#store.update({ set: { state, redirectUrl: this.#redirectUrl } });
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.#store.get()).client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    await this.#store.update({ set: { client } });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    this.#readTokens = (await this.#store.get()).tokens;
    return this.#readTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.#readTokens = tokens;
    await this.#store.update({ set: { tokens } });
  }

  redirectToAuthorization(url: URL): void {
    if (this.#interactive) this.authorizationUrl = url;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (this.#interactive) await this.#store.update({ set: { verifier } });
  }

  async codeVerifier(): Promise<string> {
    const { verifier } = await this.#store.get();
    if (!verifier) throw new Error("No sign-in is in progress.");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") await this.#store.update({ clear: "all" });
    else if (scope === "client" || scope === "verifier") await this.#store.update({ clear: [scope] });
    // When another chat has refreshed the tokens since this one read them, the rejected refresh token was the old one:
    // keep the new tokens rather than signing the user out.
    else if (scope === "tokens" && this.#readTokens) await this.#store.update({ clearTokensIf: this.#readTokens });
  }
}

function sameTokens(a: OAuthTokens | undefined, b: OAuthTokens | undefined): boolean {
  return a?.access_token === b?.access_token && a?.refresh_token === b?.refresh_token;
}

/**
 * Start a sign-in: returns the URL to send the browser to, or `signedIn` when the
 * stored tokens still work. Any old tokens are dropped first, so the user
 * always gets the login screen; a client registration made for this same
 * redirect URL is kept.
 */
export async function startSignIn(serverUrl: string, server: string, store: McpAuthStore, redirectUrl: string): Promise<{ url: string } | { signedIn: true }> {
  await store.update({ restart: redirectUrl });
  const client = new McpOAuthClient(store, server, { redirectUrl, interactive: true });
  const trace = tracedFetch();
  const result = await auth(client, { serverUrl, fetchFn: trace.fetch }).catch(trace.explain);
  if (result === "AUTHORIZED") return { signedIn: true };
  if (!client.authorizationUrl) throw new Error(`${server} did not return a sign-in page.`);
  return { url: client.authorizationUrl.href };
}

/** Finish a sign-in from the callback: check the state, exchange the code for tokens, clear the sign-in in progress. */
export async function finishSignIn(serverUrl: string, server: string, store: McpAuthStore, code: string, state: string): Promise<void> {
  const record = await store.get();
  if (!record.state || record.state !== state || !record.redirectUrl) throw new Error("This sign-in did not start here, or a newer one replaced it. Open the sign-in link again.");
  const client = new McpOAuthClient(store, server, { redirectUrl: record.redirectUrl, interactive: true });
  const trace = tracedFetch();
  await auth(client, { serverUrl, authorizationCode: code, fetchFn: trace.fetch }).catch(trace.explain);
  await store.update({ clear: ["state", "verifier"] });
}

/**
 * A fetch for the SDK's OAuth requests that remembers the last one that did
 * not succeed, so a failed sign-in says which request failed: method, URL
 * without its query, status, and Cloudflare's Ray ID when there is one.
 */
function tracedFetch() {
  let failed: string | undefined;
  return {
    fetch: async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const response = await fetch(input, init);
      if (!response.ok) {
        const url = new URL(String(input));
        const ray = response.headers.get("cf-ray");
        failed = `${init?.method ?? "GET"} ${url.origin}${url.pathname} answered ${response.status}${ray ? ` (Cloudflare Ray ID ${ray})` : ""}`;
      }
      return response;
    },
    explain: (error: unknown): never => {
      const message = errorMessage(error);
      throw new Error(failed ? `${message} [${failed}]` : message);
    },
  };
}
