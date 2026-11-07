import { fromBase64 } from "../../shared/util.ts";

/**
 * Each user's files are encrypted at rest with their own key (R2 SSE-C).
 * The key is derived, never stored: HKDF-SHA-256 over one master secret,
 * with the uid as context. Reading an object with another user's key fails
 * inside R2, so a mistake in a prefix can't turn into a leak.
 */
export async function deriveUserKey(masterSecret: string, uid: string): Promise<ArrayBuffer> {
  return deriveBits(masterSecret, "FILES_MASTER_KEY", "pi-artifacts/user-files/v1", uid);
}

/**
 * A user's own AES-GCM key for one kind of record, derived as deriveUserKey is, under its own `label` (the HKDF salt),
 * so it never equals the user's file key even when both come from the same master secret. `name` names the secret in
 * errors.
 */
export async function deriveUserAesKey(masterSecret: string, name: string, label: string, uid: string): Promise<CryptoKey> {
  const bits = await deriveBits(masterSecret, name, label, uid);
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function deriveBits(masterSecret: string, name: string, label: string, uid: string): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey("raw", decodeMaster(masterSecret, name), "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(label), info: new TextEncoder().encode(uid) }, base, 256);
}

/** A master secret is 32+ random bytes, base64-encoded. */
function decodeMaster(secret: string, name: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(secret.trim());
  } catch {
    throw new Error(`${name} is not valid base64.`);
  }
  if (bytes.byteLength < 32) throw new Error(`${name} must be at least 32 random bytes.`);
  return bytes;
}
