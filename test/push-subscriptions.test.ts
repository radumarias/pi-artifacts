import { describe, expect, it } from "vitest";
import { checkPushSubscription, MAX_PUSH_SUBS, PushSubscriptions, topicOf, vapidKeys } from "../worker/push/subscriptions.ts";
import type { sendPush } from "../worker/push/web-push.ts";
import { memorySql } from "./fakes.ts";

const P256DH = `B${"A".repeat(86)}`;
const AUTH = "A".repeat(22);
const VAPID = { publicKey: "pub", privateKey: "priv", subject: "mailto:ops@example.com" };
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, p256dh: P256DH, auth: AUTH });

describe("push subscriptions", () => {
  it("takes only endpoints at a known push service", () => {
    expect(checkPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: P256DH, auth: AUTH } })).toMatchObject({
      endpoint: expect.any(String),
    });
    expect(checkPushSubscription({ endpoint: "https://web.push.apple.com/abc", keys: { p256dh: P256DH, auth: AUTH } })).not.toHaveProperty("error");
    expect(
      checkPushSubscription({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", keys: { p256dh: P256DH, auth: AUTH } }),
    ).not.toHaveProperty("error");
    expect(checkPushSubscription({ endpoint: "https://internal.example/hook", keys: { p256dh: P256DH, auth: AUTH } })).toHaveProperty("error");
    expect(checkPushSubscription({ endpoint: "https://evilpush.apple.com.example/x", keys: { p256dh: P256DH, auth: AUTH } })).toHaveProperty("error");
  });

  it("reads the VAPID keys only when all three secrets are set", () => {
    expect(vapidKeys({})).toBeNull();
    expect(vapidKeys({ PUSH_VAPID_PUBLIC_KEY: "a", PUSH_VAPID_PRIVATE_KEY: "b" })).toBeNull();
    expect(vapidKeys({ PUSH_VAPID_PUBLIC_KEY: "a", PUSH_VAPID_PRIVATE_KEY: "b", PUSH_SUBJECT: "ops@example.com" })).toBeNull();
    expect(vapidKeys({ PUSH_VAPID_PUBLIC_KEY: "a", PUSH_VAPID_PRIVATE_KEY: "b", PUSH_SUBJECT: "mailto:ops@example.com" })).toEqual({
      publicKey: "a",
      privateKey: "b",
      subject: "mailto:ops@example.com",
    });
  });

  it("sends a topic that says nothing of the tag, and differs per tag", async () => {
    const topic = await topicOf("sign-in:Portal", VAPID);
    expect(topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(topic).not.toContain("Portal");
    expect(await topicOf("sign-in:Portal", VAPID)).toBe(topic);
    const long = "sign-in:" + "x".repeat(40);
    expect(await topicOf(`${long}a`, VAPID)).not.toBe(await topicOf(`${long}b`, VAPID));
  });

  it("pushes to every browser, forgets the gone ones, and keeps the newest few", async () => {
    const sent: string[] = [];
    const send: typeof sendPush = async (to, payload) => {
      sent.push(`${to.endpoint} ${JSON.stringify(payload)}`);
      return to.endpoint.endsWith("/2") ? { ok: false, gone: true, status: 410 } : { ok: true, gone: false, status: 201 };
    };
    const subs = new PushSubscriptions(memorySql(), send);
    for (let n = 1; n <= MAX_PUSH_SUBS + 2; n++) subs.add(sub(n), n);
    expect(subs.count()).toBe(MAX_PUSH_SUBS);
    const message = { title: "Sign in to Portal", body: "A run is waiting.", url: "/", tag: "sign-in:Portal" };
    await subs.push(message, null);
    expect(sent).toHaveLength(0);
    await subs.push(message, VAPID);
    expect(sent).toHaveLength(MAX_PUSH_SUBS);
    expect(sent[0]).toContain('"tag":"sign-in:Portal"');
    // 1 and 2 were the oldest and went with the limit. Back again, 2 pushes the oldest left out, and its push service
    // then says it is gone: it is forgotten.
    subs.add(sub(2), 99);
    expect(subs.count()).toBe(MAX_PUSH_SUBS);
    await subs.push(message, VAPID);
    expect(subs.count()).toBe(MAX_PUSH_SUBS - 1);
    subs.remove(sub(12).endpoint);
    expect(subs.count()).toBe(MAX_PUSH_SUBS - 2);
  });
});
