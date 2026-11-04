import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A FILES_MASTER_KEY for tests. */
export const MASTER_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

/** An in-memory R2 bucket for the stores: keeps string bodies and records every call it gets. */
export class FakeBucket {
  readonly objects = new Map<string, string>();
  readonly calls: { op: string; key?: string; prefix?: string; ssecKey?: unknown }[] = [];

  constructor(keys: string[] = []) {
    for (const key of keys) this.objects.set(key, "");
  }

  /** Pages as R2 does: at most `limit` objects, and a cursor while more remain. */
  async list({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) {
    this.calls.push({ op: "list", prefix });
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    const start = Number(cursor ?? 0);
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((key) => ({ key, size: new TextEncoder().encode(this.objects.get(key)!).byteLength, uploaded: new Date(0) })),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }

  /** With a range as R2 takes it: from an offset (for a length) or the last `suffix` bytes; one past the end throws, as R2 does. */
  async get(key: string, options?: { ssecKey?: unknown; range?: { offset?: number; length?: number; suffix?: number } }) {
    this.calls.push({ op: "get", key, ssecKey: options?.ssecKey });
    const value = this.objects.get(key);
    if (value === undefined) return null;
    const bytes = new TextEncoder().encode(value);
    const range = options?.range;
    const start = range?.suffix !== undefined ? Math.max(0, bytes.byteLength - range.suffix) : (range?.offset ?? 0);
    if (range && start >= bytes.byteLength) throw new Error("The requested range is not satisfiable");
    const part = bytes.subarray(start, range?.length !== undefined ? start + range.length : undefined);
    return { text: async () => value, json: async () => JSON.parse(value), size: bytes.byteLength, uploaded: new Date(0), body: new Blob([part]).stream() };
  }

  async put(key: string, body: unknown, options?: { ssecKey?: unknown }) {
    this.calls.push({ op: "put", key, ssecKey: options?.ssecKey });
    this.objects.set(key, typeof body === "string" ? body : "");
  }

  /** One key or several, as R2 takes them. */
  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) {
      this.calls.push({ op: "delete", key });
      this.objects.delete(key);
    }
  }

  get r2(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

/** Start `server` on a free local port; resolves with its origin. */
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
