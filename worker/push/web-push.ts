import { fromBase64url, isObject, toBase64url, tryFromBase64url } from "../../shared/util.ts";

// Web Push from a Worker with WebCrypto alone: the message is encrypted for the browser's subscription (RFC 8291, the
// aes128gcm content coding of RFC 8188), and the push service is told who sends it with a VAPID token (RFC 8292).

/** A browser's push subscription: its endpoint, and its keys base64url as `PushSubscription.toJSON().keys` gives them. */
export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * The application server's VAPID key pair: `publicKey` is base64url of the 65-byte uncompressed P-256 point,
 * `privateKey` base64url of the 32-byte scalar d, and `subject` a "mailto:" or "https:" contact for the push service.
 */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** The one record's size, written in the header. */
const RECORD_SIZE = 4096;
/** The largest payload: a 4096-byte message less the 86-byte header, the 16-byte tag and the padding delimiter. */
const MAX_PAYLOAD = 3993;
/** How long a VAPID token lasts: RFC 8292 allows at most 24 hours. */
const VAPID_TTL_S = 12 * 60 * 60;
/** How long the push service keeps a message for a browser that is offline, unless the caller says otherwise. */
const DEFAULT_TTL_S = 24 * 60 * 60;
const MAX_ENDPOINT = 2048;

const encoder = new TextEncoder();

/** The UTF-8 bytes of `text`, typed as WebCrypto takes them: TextEncoder always returns a fresh ArrayBuffer. */
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

/** ECDH's parameters, typed for both the Workers types (which call `public` `$public`) and the DOM's. */
function ecdhParams(publicKey: CryptoKey): Parameters<SubtleCrypto["deriveBits"]>[0] {
  return { name: "ECDH", public: publicKey } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0];
}

/**
 * The full aes128gcm body for `plaintext`, encrypted for a subscription's keys (RFC 8291): salt (16) | record size (4) |
 * key id length (1) | the sender's public key (65) | one record, the payload with the delimiter 0x02 and no padding.
 * `test` injects the sender's ECDH key pair and the salt, which are otherwise new for each message.
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  keys: Pick<PushSubscriptionKeys, "p256dh" | "auth">,
  test?: { senderKeys?: CryptoKeyPair; salt?: Uint8Array },
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.byteLength > MAX_PAYLOAD) throw new Error(`A push payload can be at most ${MAX_PAYLOAD} bytes, not ${plaintext.byteLength}.`);
  const uaPublic = fromBase64url(keys.p256dh);
  const authSecret = fromBase64url(keys.auth);
  if (uaPublic.byteLength !== 65 || uaPublic[0] !== 0x04) throw new Error("The subscription's p256dh is not an uncompressed P-256 key.");
  if (authSecret.byteLength !== 16) throw new Error("The subscription's auth secret is not 16 bytes.");

  const sender =
    test?.senderKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer);
  const salt = test?.salt ? copy(test.salt) : crypto.getRandomValues(new Uint8Array(16));
  if (salt.byteLength !== 16) throw new Error("The salt must be 16 bytes.");

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const ecdhSecret = await crypto.subtle.deriveBits(ecdhParams(uaKey), sender.privateKey, 256);

  // RFC 8291 section 3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public, 32),
  // then CEK and NONCE from HKDF(salt, IKM, ...) as RFC 8188 section 2.2 and 2.3 have them.
  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, new Uint8Array(ecdhSecret), keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const record = concat(plaintext, Uint8Array.of(0x02));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.byteLength);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.byteLength;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/**
 * The Authorization header for a push to `endpoint` (RFC 8292): `vapid t=<jwt>, k=<public key>`, the JWT signed with
 * ES256 for the endpoint's origin, lasting 12 hours from `now` (milliseconds, the clock by default).
 */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_TTL_S, sub: vapid.subject };
  const unsigned = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  const key = await importVapidPrivateKey(vapid);
  // WebCrypto's ECDSA signature is already the raw r || s (64 bytes) a JWT wants.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned));
  return `vapid t=${unsigned}.${toBase64url(new Uint8Array(signature))}, k=${vapid.publicKey}`;
}

/** How long a push service may take to take a push: the alarm that sends one waits for it. */
const PUSH_TIMEOUT_MS = 15_000;

/**
 * Sends one push message: `payload` as JSON, encrypted for `sub`, with a VAPID token. `gone` is a 404 or 410 from the
 * push service: the subscription has ended, and the caller should forget it. A `topic` that is not 1 to 32 characters
 * of the base64url alphabet is left out.
 */
export async function sendPush(
  sub: PushSubscriptionKeys,
  payload: unknown,
  vapid: VapidKeys,
  options: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string; fetch?: typeof fetch; now?: number } = {},
): Promise<{ ok: boolean; gone: boolean; status: number }> {
  const body = await encryptPushPayload(utf8(JSON.stringify(payload ?? null)), sub);
  const ttl = options.ttl !== undefined && Number.isFinite(options.ttl) ? Math.max(0, Math.floor(options.ttl)) : DEFAULT_TTL_S;
  const headers: Record<string, string> = {
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(ttl),
    urgency: options.urgency ?? "normal",
    authorization: await vapidAuthorization(sub.endpoint, vapid, options.now),
  };
  if (options.topic !== undefined && /^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) headers.topic = options.topic;
  // A timer cleared once the answer came, not AbortSignal.timeout's, which stays pending (keeping the object awake).
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(`no answer within ${PUSH_TIMEOUT_MS / 1000} s`)), PUSH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(sub.endpoint, { method: "POST", headers, body, signal: timeout.signal });
  } finally {
    clearTimeout(timer);
  }
  // Nothing in the push service's answer is needed: let the connection go.
  await response.body?.cancel().catch(() => {});
  const { status } = response;
  return { ok: status >= 200 && status < 300, gone: status === 404 || status === 410, status };
}

/**
 * A subscription as a browser sends it (`PushSubscription.toJSON()`, or its endpoint and keys flat), when it is
 * plausible: an https endpoint, a p256dh that is a 65-byte uncompressed P-256 point, and a 16-byte auth secret.
 */
export function checkSubscription(input: unknown): PushSubscriptionKeys | { error: string } {
  if (!isObject(input)) return { error: "A subscription must be an object." };
  const keys = isObject(input.keys) ? input.keys : input;
  const { endpoint } = input;
  const { p256dh, auth } = keys;
  if (typeof endpoint !== "string" || !endpoint) return { error: "The subscription has no endpoint." };
  if (endpoint.length > MAX_ENDPOINT) return { error: "The subscription's endpoint is too long." };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { error: "The subscription's endpoint is not a URL." };
  }
  if (url.protocol !== "https:") return { error: "The subscription's endpoint must be https." };
  if (url.username || url.password) return { error: "The subscription's endpoint must not hold credentials." };
  if (typeof p256dh !== "string" || typeof auth !== "string") return { error: "The subscription has no p256dh and auth keys." };
  const point = tryFromBase64url(p256dh);
  if (!point || point.byteLength !== 65 || point[0] !== 0x04) return { error: "The subscription's p256dh is not an uncompressed P-256 key." };
  const secret = tryFromBase64url(auth);
  if (!secret || secret.byteLength !== 16) return { error: "The subscription's auth secret is not 16 bytes." };
  return { endpoint, p256dh, auth };
}

/** A new VAPID key pair, base64url as `VapidKeys` holds them: the 65-byte public point and the 32-byte private scalar. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (!jwk.d) throw new Error("The generated private key has no d.");
  return { publicKey: toBase64url(publicKey), privateKey: jwk.d };
}

/** Imported VAPID keys by their pair: a push to several browsers imports the key once, not once per browser. */
const vapidKeyCache = new Map<string, Promise<CryptoKey>>();

/** The VAPID private key, imported as a JWK: d from `privateKey`, x and y from the public point. */
function importVapidPrivateKey(vapid: VapidKeys): Promise<CryptoKey> {
  const id = `${vapid.publicKey}.${vapid.privateKey}`;
  let key = vapidKeyCache.get(id);
  if (!key) {
    key = importVapidKey(vapid);
    vapidKeyCache.set(id, key);
    key.catch(() => vapidKeyCache.delete(id));
  }
  return key;
}

async function importVapidKey(vapid: VapidKeys): Promise<CryptoKey> {
  const point = fromBase64url(vapid.publicKey);
  const d = fromBase64url(vapid.privateKey);
  if (point.byteLength !== 65 || point[0] !== 0x04) throw new Error("The VAPID public key is not an uncompressed P-256 key.");
  if (d.byteLength !== 32) throw new Error("The VAPID private key is not 32 bytes.");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: toBase64url(d),
    x: toBase64url(point.subarray(1, 33)),
    y: toBase64url(point.subarray(33, 65)),
    ext: false,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** HKDF-SHA-256 of `ikm` with `salt` and `info`, `length` bytes. */
async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function base64urlJson(value: unknown): string {
  return toBase64url(utf8(JSON.stringify(value)));
}
