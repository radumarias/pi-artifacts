import { exports } from "cloudflare:workers";
import { json, readJson } from "./http.ts";
import { checkPushSubscription, vapidKeys } from "./push/subscriptions.ts";

/**
 * Web Push for the signed-in `uid` (worker/push/):
 *   GET  /api/push/key          the VAPID public key the app subscribes with; 404 when this deployment has no push
 *   POST /api/push/subscribe    { endpoint, keys: { p256dh, auth } }, as PushSubscription.toJSON() gives it
 *   POST /api/push/unsubscribe  { endpoint }
 * Returns null for any other path.
 */
export async function pushRoute(request: Request, env: Env, uid: string): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/push/")) return null;
  const vapid = vapidKeys(env);
  if (path === "/api/push/key" && request.method === "GET") {
    return vapid ? json({ publicKey: vapid.publicKey }) : json({ error: "This app does not send push notifications." }, 404);
  }
  const directory = exports.UserDirectory.getByName(uid);
  if (path === "/api/push/subscribe" && request.method === "POST") {
    if (!vapid) return json({ error: "This app does not send push notifications." }, 404);
    const checked = checkPushSubscription(await readJson(request));
    if ("error" in checked) return json(checked, 400);
    await directory.addPushSubscription(checked);
    return json({ ok: true });
  }
  if (path === "/api/push/unsubscribe" && request.method === "POST") {
    const body = await readJson<{ endpoint?: unknown }>(request);
    if (typeof body?.endpoint !== "string") return json({ error: "Say which endpoint." }, 400);
    await directory.removePushSubscription(body.endpoint);
    return json({ ok: true });
  }
  return null;
}
