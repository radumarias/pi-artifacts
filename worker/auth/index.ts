import { UID_PATTERN } from "../../shared/protocol.ts";
import { toHex } from "../../shared/util.ts";
import { AccessError, verifyAccessJwt } from "./access.ts";

export interface Identity {
  uid: string;
  email?: string;
}

export const DEMO_COOKIE = "pi_uid";

/**
 * Who is making this request, or null. With AUTH_MODE "access" (deployed)
 * the identity comes only from a verified Cloudflare Access token; the demo
 * name cookie is ignored. AUTH_MODE "demo" is for local development.
 */
export async function identify(request: Request, env: Env): Promise<Identity | null> {
  if (env.AUTH_MODE === "demo") {
    const uid = cookieValue(request, DEMO_COOKIE);
    return uid && UID_PATTERN.test(uid) ? { uid } : null;
  }

  const token = request.headers.get("cf-access-jwt-assertion") ?? cookieValue(request, "CF_Authorization");
  if (!token) return null;
  try {
    const claims = await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
    return { uid: await uidFor(env.ACCESS_TEAM_DOMAIN, claims.sub), email: claims.email };
  } catch (error) {
    if (error instanceof AccessError) {
      console.warn(`Rejected Access token: ${error.message}`);
      return null;
    }
    throw error;
  }
}

/** A stable, opaque uid per Access user: 32 hex characters of SHA-256 over the team and subject. */
export async function uidFor(teamDomain: string, sub: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${teamDomain}:${sub}`));
  return toHex(digest).slice(0, 32);
}

function cookieValue(request: Request, name: string): string | null {
  const match = (request.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}
