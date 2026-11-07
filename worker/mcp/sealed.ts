import { fromBase64, toBase64 } from "../../shared/util.ts";
import type { McpAuthRecord } from "./oauth.ts";

/**
 * A user's MCP sign-in records at rest. The refresh token in one is the real credential (the app is a public OAuth
 * client, with no secret of its own), so each record is encrypted with AES-GCM under the user's own key
 * (`mcpTokensKey` in worker/storage/), with the server's name as additional data: a copy of the storage alone reads
 * nothing, and a record moved to another server's row does not open.
 *
 * Stored as `{"sealed":"v1.<base64 of iv | ciphertext>"}`: JSON, so code from before encryption (a rollback) reads it as
 * a record with no sign-in, and the user can sign in again. A record written before encryption is plain JSON and still
 * opens, as does one sealed as a bare `v1.…` string (`plain` says so for both, so the caller writes it again sealed).
 */
const PREFIX = "v1.";
const IV_BYTES = 12;

export async function sealAuthRecord(key: CryptoKey, server: string, record: McpAuthRecord): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(JSON.stringify(record));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(server) }, key, data));
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(sealed, IV_BYTES);
  return JSON.stringify({ sealed: PREFIX + toBase64(out) });
}

/**
 * `plain`: to be written again sealed. `olderSignIn`: code from before encryption signed in (its sign-in starts a record
 * afresh, so no `sealed` is left in it), or the record was never sealed: when its grant started is not known.
 */
export async function openAuthRecord(
  key: CryptoKey,
  server: string,
  stored: string,
): Promise<{ record: McpAuthRecord; plain: boolean; olderSignIn: boolean }> {
  // `v1.…` alone, not in JSON: sealed before records were wrapped. It opens, and is written again in the JSON form.
  if (stored.startsWith(PREFIX)) return { record: await open(key, server, stored), plain: true, olderSignIn: false };
  const { sealed, ...rest } = JSON.parse(stored) as McpAuthRecord & { sealed?: unknown };
  if (typeof sealed !== "string") return { record: rest, plain: true, olderSignIn: true };
  // Fields beside `sealed` are what code from before encryption changed in it (a refresh): those are the newer.
  if (Object.keys(rest).length > 0) return { record: rest, plain: true, olderSignIn: false };
  return { record: await open(key, server, sealed), plain: false, olderSignIn: false };
}

async function open(key: CryptoKey, server: string, sealed: string): Promise<McpAuthRecord> {
  if (!sealed.startsWith(PREFIX)) throw new Error("Unknown sealed record version.");
  const bytes = fromBase64(sealed.slice(PREFIX.length));
  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: aad(server) },
    key,
    bytes.subarray(IV_BYTES),
  );
  return JSON.parse(new TextDecoder().decode(data)) as McpAuthRecord;
}

const aad = (server: string) => new TextEncoder().encode(`pi-artifacts/mcp-auth/${server}`);
