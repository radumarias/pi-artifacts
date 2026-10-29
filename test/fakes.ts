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

  async list({ prefix }: { prefix: string }) {
    this.calls.push({ op: "list", prefix });
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    return { objects: keys.map((key) => ({ key, size: 1, uploaded: new Date(0) })), truncated: false };
  }

  async get(key: string, options?: { ssecKey?: unknown }) {
    this.calls.push({ op: "get", key, ssecKey: options?.ssecKey });
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value, json: async () => JSON.parse(value) };
  }

  async put(key: string, body: unknown, options?: { ssecKey?: unknown }) {
    this.calls.push({ op: "put", key, ssecKey: options?.ssecKey });
    this.objects.set(key, typeof body === "string" ? body : "");
  }

  async delete(key: string) {
    this.calls.push({ op: "delete", key });
    this.objects.delete(key);
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
