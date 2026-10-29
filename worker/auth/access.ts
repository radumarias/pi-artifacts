/**
 * Verify the JWT Cloudflare Access signs for every request it lets through.
 * Access sends it as the `Cf-Access-Jwt-Assertion` header; the Worker checks
 * the signature against the team's published keys, plus issuer, audience and
 * expiry, before trusting who the user is.
 */
import { fromBase64 } from "../../shared/util.ts";

export interface AccessClaims {
  /** Stable id of the user within the Access organization. */
  sub: string;
  email?: string;
}

export interface AccessConfig {
  /** e.g. "xorio42.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's audience (AUD) tag. */
  aud: string;
  now?: () => number;
  fetchKeys?: (teamDomain: string) => Promise<JsonWebKey[]>;
}

export class AccessError extends Error {}

const KEYS_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_S = 60;
const KEYS_REFETCH_MS = 10_000;
let cachedKeys: { teamDomain: string; keys: JsonWebKey[]; fetchedAt: number } | undefined;
let lastRefetchAt = -Infinity;
// Every request is verified, so each published key is imported once, not per request. Keyed by the JWK object, which
// lives as long as the key set it came from.
const importedKeys = new WeakMap<JsonWebKey, Promise<CryptoKey>>();

function importKey(jwk: JsonWebKey): Promise<CryptoKey> {
  let key = importedKeys.get(jwk);
  if (!key) {
    key = crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    importedKeys.set(jwk, key);
    key.catch(() => importedKeys.delete(jwk));
  }
  return key;
}

export async function verifyAccessJwt(token: string, config: AccessConfig): Promise<AccessClaims> {
  const now = config.now ?? Date.now;
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("Malformed token.");
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeJson(headerB64) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new AccessError(`Unexpected algorithm ${header.alg}.`);

  const jwk = await findKey(config, header.kid, now());
  const key = await importKey(jwk);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) throw new AccessError("Bad signature.");

  const claims = decodeJson(payloadB64) as { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; sub?: string; email?: string };
  if (claims.iss !== `https://${config.teamDomain}`) throw new AccessError("Wrong issuer.");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.aud)) throw new AccessError("Wrong audience.");
  const seconds = now() / 1000;
  if (typeof claims.exp !== "number" || claims.exp < seconds - CLOCK_SKEW_S) throw new AccessError("Token expired.");
  if (typeof claims.nbf === "number" && claims.nbf > seconds + CLOCK_SKEW_S) throw new AccessError("Token not yet valid.");
  if (!claims.sub) throw new AccessError("Token has no subject.");
  return { sub: claims.sub, email: claims.email };
}

/** The signing key named by `kid`, refetching when it is unknown (Access rotates keys). */
async function findKey(config: AccessConfig, kid: string | undefined, now: number): Promise<JsonWebKey> {
  const load = async () => {
    cachedKeys = { teamDomain: config.teamDomain, keys: await (config.fetchKeys ?? fetchTeamKeys)(config.teamDomain), fetchedAt: now };
  };
  const lookup = () => cachedKeys!.keys.find((k) => (k as { kid?: string }).kid === kid);
  const fresh = cachedKeys && cachedKeys.teamDomain === config.teamDomain && now - cachedKeys.fetchedAt < KEYS_TTL_MS;
  if (!fresh) await load();
  let key = lookup();
  // Any request can name an unknown key before its signature is checked, so this refetch is limited to once in 10 s.
  if (!key && fresh && now - lastRefetchAt >= KEYS_REFETCH_MS) {
    lastRefetchAt = now;
    await load();
    key = lookup();
  }
  if (!key) throw new AccessError("Unknown signing key.");
  return key;
}

async function fetchTeamKeys(teamDomain: string): Promise<JsonWebKey[]> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new AccessError(`Could not fetch Access keys (${response.status}).`);
  return ((await response.json()) as { keys: JsonWebKey[] }).keys;
}

/** For tests: forget the cached signing keys. */
export function resetAccessKeyCache(): void {
  cachedKeys = undefined;
  lastRefetchAt = -Infinity;
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
  } catch {
    throw new AccessError("Malformed token.");
  }
}

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  try {
    return fromBase64(base64);
  } catch {
    // atob's own error would make a garbled token a 500 instead of a rejected sign-in.
    throw new AccessError("Malformed token.");
  }
}
