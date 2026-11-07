import { errorMessage, toBase64url } from "../../shared/util.ts";
import type { Sql } from "../members.ts";
import { checkSubscription, sendPush, type PushSubscriptionKeys, type VapidKeys } from "./web-push.ts";

/** What a push shows: `body` says only that something arrived, never what (no data leaves through the push service). */
export interface PushMessage {
  title: string;
  body: string;
  /** A path in this app the notification opens. */
  url: string;
  /** Notifications with one tag replace each other. */
  tag: string;
}

/** Subscriptions kept per user: one per browser they turned notifications on in; the one least recently subscribed goes past this (the app subscribes again on each load). */
export const MAX_PUSH_SUBS = 10;

/**
 * The push services browsers use. A subscription's endpoint is where the Worker sends a request, so only these are
 * taken: anything else would let a client point the Worker at any address.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];

/** The VAPID keys from the Worker's secrets, or null when the deployment has none (then nothing is pushed). */
export function vapidKeys(env: object): VapidKeys | null {
  // Optional secrets, so not in the generated Env.
  const { PUSH_VAPID_PUBLIC_KEY: publicKey, PUSH_VAPID_PRIVATE_KEY: privateKey, PUSH_SUBJECT: subject } = env as Record<string, string | undefined>;
  if (!publicKey || !privateKey || !subject || !/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/** A subscription the app sent, checked: its keys, and an endpoint at a known push service. */
export function checkPushSubscription(input: unknown): PushSubscriptionKeys | { error: string } {
  const checked = checkSubscription(input);
  if ("error" in checked) return checked;
  const host = new URL(checked.endpoint).hostname;
  return PUSH_HOSTS.some((pattern) => pattern.test(host)) ? checked : { error: "That endpoint is not a known push service." };
}

/** One user's push subscriptions (`push_subs`), in their UserDirectory's SQLite. */
export class PushSubscriptions {
  readonly #sql: Sql;
  readonly #send: typeof sendPush;

  constructor(sql: Sql, send: typeof sendPush = sendPush) {
    this.#sql = sql;
    this.#send = send;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
  }

  add(sub: PushSubscriptionKeys, now = Date.now()): void {
    this.#sql.exec(
      "INSERT INTO push_subs (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at",
      sub.endpoint,
      sub.p256dh,
      sub.auth,
      now,
    );
    this.#sql.exec("DELETE FROM push_subs WHERE endpoint NOT IN (SELECT endpoint FROM push_subs ORDER BY created_at DESC LIMIT ?)", MAX_PUSH_SUBS);
  }

  remove(endpoint: string): void {
    this.#sql.exec("DELETE FROM push_subs WHERE endpoint = ?", endpoint);
  }

  count(): number {
    return this.#sql.exec("SELECT COUNT(*) AS n FROM push_subs").toArray()[0]?.n as number;
  }

  /** Push `message` to every browser of the user's, forgetting the ones the push service says are gone. */
  async push(message: PushMessage, vapid: VapidKeys | null): Promise<void> {
    if (!vapid) return;
    const subs = this.#sql.exec("SELECT endpoint, p256dh, auth FROM push_subs").toArray() as unknown as PushSubscriptionKeys[];
    if (subs.length === 0) return;
    const topic = await topicOf(message.tag, vapid);
    await Promise.all(
      subs.map(async (sub) => {
        try {
          const sent = await this.#send(sub, message, vapid, { topic, urgency: "normal" });
          if (sent.gone) this.remove(sub.endpoint);
          else if (!sent.ok) console.warn("push:", sent.status);
        } catch (error) {
          console.warn("push:", errorMessage(error));
        }
      }),
    );
  }
}

/**
 * The push service's topic for a tag (a newer push with the same topic replaces one not yet delivered): base64url, at
 * most 32. The push service sees it, so it is an HMAC of the tag under the VAPID private key, never the tag (a server's
 * name, a chat id), and two tags do not collide.
 */
export async function topicOf(tag: string, vapid: VapidKeys): Promise<string> {
  const key = await topicKey(vapid.privateKey);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(tag));
  return toBase64url(new Uint8Array(mac)).slice(0, 32);
}

/** The HMAC key for topics, imported once per VAPID key. */
let topicKeyFor: { privateKey: string; key: Promise<CryptoKey> } | undefined;
function topicKey(privateKey: string): Promise<CryptoKey> {
  if (topicKeyFor?.privateKey !== privateKey) topicKeyFor = { privateKey, key: importTopicKey(privateKey) };
  return topicKeyFor.key;
}

function importTopicKey(privateKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`pi-artifacts/push-topic/${privateKey}`), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}
