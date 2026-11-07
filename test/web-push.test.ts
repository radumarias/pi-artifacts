import { describe, expect, it } from "vitest";
import { checkSubscription, encryptPushPayload, generateVapidKeys, sendPush, vapidAuthorization, type VapidKeys } from "../worker/push/web-push.ts";

type Bytes = Uint8Array<ArrayBuffer>;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64url = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

// RFC 8291 appendix A: the example message's keys and result.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** An ECDH key pair from a private scalar and its uncompressed public point, imported as JWKs. */
async function ecdhPair(d: string, point: string): Promise<CryptoKeyPair> {
  const p = unb64url(point);
  const jwk = { kty: "EC", crv: "P-256", x: b64url(p.subarray(1, 33)), y: b64url(p.subarray(33, 65)) };
  const algorithm = { name: "ECDH", namedCurve: "P-256" };
  return {
    privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d }, algorithm, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("jwk", jwk, algorithm, true, []),
  };
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** What a browser does with a push body: RFC 8291 decryption with its own private key and auth secret. */
async function decrypt(body: Bytes, uaPrivate: CryptoKey, uaPublic: Bytes, auth: Bytes): Promise<Bytes> {
  const enc = new TextEncoder();
  const salt = body.subarray(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  expect(rs).toBe(4096);
  expect(ciphertext.byteLength).toBeLessThanOrEqual(rs);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  expect(record[end]).toBe(0x02); // the last record's delimiter
  return record.subarray(0, end);
}

/** A browser's subscription: a fresh ECDH key pair and auth secret. */
async function browser(endpoint = "https://push.example.com/send/abc123?x=1") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, publicKey, authBytes: auth, sub: { endpoint, p256dh: b64url(publicKey), auth: b64url(auth) } };
}

async function vapidKeys(): Promise<VapidKeys> {
  return { ...(await generateVapidKeys()), subject: "mailto:ops@example.com" };
}

function decodeJwt(authorization: string) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  expect(match).not.toBeNull();
  const [, jwt, k] = match!;
  const [header, claims, signature] = jwt.split(".");
  return {
    jwt,
    k,
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    claims: JSON.parse(Buffer.from(claims, "base64url").toString()),
    signature: unb64url(signature),
    signed: new TextEncoder().encode(`${header}.${claims}`),
  };
}

describe("encryptPushPayload", () => {
  it("gives RFC 8291's example message for its keys and salt", async () => {
    const body = await encryptPushPayload(
      new TextEncoder().encode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { senderKeys: await ecdhPair(RFC.asPrivate, RFC.asPublic), salt: unb64url(RFC.salt) },
    );
    expect(b64url(body)).toBe(RFC.message);
  });

  it("encrypts so that the subscription's browser can read it", async () => {
    const { pair, publicKey, authBytes, sub } = await browser();
    const plaintext = crypto.getRandomValues(new Uint8Array(1000));
    const body = await encryptPushPayload(plaintext, sub);
    expect(body.byteLength).toBe(86 + plaintext.byteLength + 1 + 16);
    expect(await decrypt(body, pair.privateKey, publicKey, authBytes)).toEqual(plaintext);
    // A new salt and sender key each time.
    expect(b64url(await encryptPushPayload(plaintext, sub))).not.toBe(b64url(body));
  });

  it("takes up to 3993 bytes, and refuses more", async () => {
    const { sub } = await browser();
    expect((await encryptPushPayload(new Uint8Array(3993), sub)).byteLength).toBe(4096);
    await expect(encryptPushPayload(new Uint8Array(3994), sub)).rejects.toThrow(/at most 3993/);
  });
});

describe("vapidAuthorization", () => {
  it("signs an ES256 JWT for the endpoint's origin", async () => {
    const vapid = await vapidKeys();
    const now = Date.UTC(2026, 10, 7, 12);
    const authorization = await vapidAuthorization("https://push.example.com:8443/wpush/v2/xyz?q=1", vapid, now);
    const { header, claims, signature, signed, k } = decodeJwt(authorization);
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(claims).toEqual({ aud: "https://push.example.com:8443", exp: now / 1000 + 12 * 3600, sub: "mailto:ops@example.com" });
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(24 * 3600);
    expect(k).toBe(vapid.publicKey);
    expect(signature.byteLength).toBe(64);
    const key = await crypto.subtle.importKey("raw", unb64url(vapid.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signed)).toBe(true);
    const other = await vapidKeys();
    const otherKey = await crypto.subtle.importKey("raw", unb64url(other.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, otherKey, signature, signed)).toBe(false);
  });

  it("expires 12 hours from the clock by default", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { claims } = decodeJwt(await vapidAuthorization("https://push.example.com/x", await vapidKeys()));
    expect(claims.exp).toBeGreaterThanOrEqual(before + 12 * 3600);
    expect(claims.exp).toBeLessThanOrEqual(before + 12 * 3600 + 5);
  });
});

describe("generateVapidKeys", () => {
  it("gives a 65-byte public point and a 32-byte private scalar", async () => {
    const { publicKey, privateKey } = await generateVapidKeys();
    expect(unb64url(publicKey).byteLength).toBe(65);
    expect(unb64url(publicKey)[0]).toBe(0x04);
    expect(unb64url(privateKey).byteLength).toBe(32);
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("sendPush", () => {
  const capture = (status: number) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 201 ? "" : "nope", { status });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  };

  it("posts the encrypted JSON with the push headers", async () => {
    const { pair, publicKey, authBytes, sub } = await browser();
    const vapid = await vapidKeys();
    const { calls, fetch } = capture(201);
    const payload = { title: "Hello", body: "A new message", url: "/chats/1" };
    const result = await sendPush(sub, payload, vapid, { ttl: 600, urgency: "high", topic: "chat-1", fetch, now: Date.UTC(2026, 0, 1) });
    expect(result).toEqual({ ok: true, gone: false, status: 201 });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe(sub.endpoint);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers.ttl).toBe("600");
    expect(headers.urgency).toBe("high");
    expect(headers.topic).toBe("chat-1");
    const { claims, k } = decodeJwt(headers.authorization);
    expect(claims.aud).toBe("https://push.example.com");
    expect(claims.exp).toBe(Date.UTC(2026, 0, 1) / 1000 + 12 * 3600);
    expect(k).toBe(vapid.publicKey);
    const body = init.body as Bytes;
    const json = new TextEncoder().encode(JSON.stringify(payload));
    expect(body.byteLength).toBe(86 + json.byteLength + 1 + 16);
    expect(new TextDecoder().decode(await decrypt(body, pair.privateKey, publicKey, authBytes))).toBe(JSON.stringify(payload));
  });

  it("defaults the TTL and urgency, and leaves out a topic push services would refuse", async () => {
    const { sub } = await browser();
    const vapid = await vapidKeys();
    for (const topic of ["has spaces", "x".repeat(33), "dot.ted", ""]) {
      const { calls, fetch } = capture(201);
      await sendPush(sub, "hi", vapid, { topic, fetch });
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.topic).toBeUndefined();
      expect(headers.ttl).toBe(String(24 * 3600));
      expect(headers.urgency).toBe("normal");
    }
    const { calls, fetch } = capture(201);
    await sendPush(sub, "hi", vapid, { topic: "A_b-9".padEnd(32, "z"), fetch });
    expect((calls[0].init.headers as Record<string, string>).topic).toHaveLength(32);
  });

  it("says a subscription is gone on 404 and 410, and not on other failures", async () => {
    const { sub } = await browser();
    const vapid = await vapidKeys();
    for (const [status, expected] of [
      [404, { ok: false, gone: true, status: 404 }],
      [410, { ok: false, gone: true, status: 410 }],
      [429, { ok: false, gone: false, status: 429 }],
      [500, { ok: false, gone: false, status: 500 }],
      [201, { ok: true, gone: false, status: 201 }],
    ] as const) {
      expect(await sendPush(sub, { n: 1 }, vapid, { fetch: capture(status).fetch })).toEqual(expected);
    }
  });
});

describe("checkSubscription", () => {
  it("takes a browser's subscription JSON, nested or flat", async () => {
    const { sub } = await browser();
    expect(checkSubscription({ endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } })).toEqual(sub);
    expect(checkSubscription(sub)).toEqual(sub);
  });

  it("refuses what is not a plausible subscription", async () => {
    const { sub } = await browser();
    const short = b64url(new Uint8Array(64).fill(4));
    const compressed = b64url(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 0x02 : i)));
    const bad: unknown[] = [
      null,
      "https://push.example.com",
      [],
      {},
      { ...sub, endpoint: "http://push.example.com/x" },
      { ...sub, endpoint: "not a url" },
      { ...sub, endpoint: "https://user:pass@push.example.com/x" },
      { ...sub, endpoint: `https://push.example.com/${"x".repeat(3000)}` },
      { ...sub, endpoint: 42 },
      { ...sub, p256dh: undefined },
      { ...sub, p256dh: short },
      { ...sub, p256dh: compressed },
      { ...sub, p256dh: "not base64url!" },
      { ...sub, auth: b64url(new Uint8Array(15)) },
      { ...sub, auth: b64url(new Uint8Array(17)) },
      { ...sub, auth: 16 },
    ];
    for (const input of bad) expect(checkSubscription(input)).toHaveProperty("error");
  });
});
