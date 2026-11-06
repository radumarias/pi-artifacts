import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../worker/members.ts";

/** A FILES_MASTER_KEY for tests. */
export const MASTER_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

/** An in-memory R2 bucket for the stores: keeps string bodies and records every call it gets. */
export class FakeBucket {
  readonly objects = new Map<string, string>();
  readonly calls: { op: string; key?: string; prefix?: string; ssecKey?: unknown }[] = [];

  constructor(keys: string[] = []) {
    for (const key of keys) this.objects.set(key, "");
  }

  /**
   * Pages as R2 does: keys in order, at most `limit` objects, and a cursor while more remain. The cursor is where the
   * page ended, not a count, so a page deleted before the next is listed moves nothing on.
   */
  async list({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) {
    this.calls.push({ op: "list", prefix });
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor)).sort();
    const page = keys.slice(0, limit);
    const truncated = limit < keys.length;
    return {
      objects: page.map((key) => ({ key, size: new TextEncoder().encode(this.objects.get(key)!).byteLength, uploaded: new Date(0) })),
      truncated,
      cursor: truncated ? page.at(-1) : undefined,
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
    return { text: async () => value, json: async () => JSON.parse(value), arrayBuffer: async () => part.slice().buffer, size: bytes.byteLength, uploaded: new Date(0), body: new Blob([part]).stream() };
  }

  async put(key: string, body: unknown, options?: { ssecKey?: unknown }) {
    this.calls.push({ op: "put", key, ssecKey: options?.ssecKey });
    this.objects.set(key, typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : "");
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

/** A Durable Object's SQL API over an in-memory node:sqlite database. */
export function memorySql(): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec(query, ...bindings) {
      if (bindings.length === 0 && query.trim().split(";").filter((part) => part.trim()).length > 1) {
        db.exec(query);
        return { toArray: () => [], rowsWritten: 0 };
      }
      const statement = db.prepare(query);
      if (/^\s*SELECT|\bRETURNING\b/i.test(query)) {
        const rows = statement.all(...bindings) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const { changes } = statement.run(...bindings);
      return { toArray: () => [], rowsWritten: Number(changes) };
    },
  };
}
