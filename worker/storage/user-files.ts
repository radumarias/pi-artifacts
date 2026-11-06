import { MAX_LISTED, UPLOADS } from "../../shared/uploads.ts";
import { normalisePath } from "./paths.ts";
import { deletePrefix } from "./r2.ts";

/** A part of a file, as R2 reads it: from an offset (for a length), or its last `suffix` bytes. */
export type ByteRange = { offset: number; length?: number } | { suffix: number };

export interface FileEntry {
  path: string;
  size: number;
  uploaded: Date;
}

/** Files as the app lists them: newest first, by path and size. */
export function newestFirst(files: FileEntry[]): { path: string; size: number }[] {
  return files.sort((a, b) => +b.uploaded - +a.uploaded).map(({ path, size }) => ({ path, size }));
}

/**
 * One user's files, and nothing else. Every key is built here from the uid
 * this object was created with, and every read and write carries that user's
 * encryption key. Code that holds a UserFiles cannot name another user's key.
 */
export class UserFiles {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  readonly #key: ArrayBuffer;

  /** Use `Storage.userFiles(uid)`; the uid must come from a verified identity. */
  constructor(bucket: R2Bucket, uid: string, key: ArrayBuffer) {
    this.#bucket = bucket;
    this.#prefix = `users/${uid}/files/`;
    this.#key = key;
  }

  /** The files under `folder` (all of them when empty), at most `limit`. */
  async list(folder = "", limit = MAX_LISTED): Promise<FileEntry[]> {
    const sub = normalisePath(folder, { allowEmpty: true });
    // Always end the prefix with "/": "users/ada" must never match "users/adam".
    const prefix = this.#prefix + (sub && !sub.endsWith("/") ? `${sub}/` : sub);
    const entries: FileEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#bucket.list({ prefix, cursor, limit: 500 });
      for (const o of page.objects) entries.push({ path: o.key.slice(this.#prefix.length), size: o.size, uploaded: o.uploaded });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && entries.length < limit);
    return entries.slice(0, limit);
  }

  /** Every path under uploads/, however many: what a file put beside them rather than over one must not take (freePath). */
  async uploadPaths(): Promise<Set<string>> {
    return new Set((await this.list(`${UPLOADS}/`, Number.POSITIVE_INFINITY)).map((file) => file.path));
  }

  async get(path: string, range?: ByteRange): Promise<R2ObjectBody | null> {
    return this.#bucket.get(this.#objectKey(path), range ? { range, ssecKey: this.#key } : { ssecKey: this.#key });
  }

  /** Whether there is a file at `path`. */
  async has(path: string): Promise<boolean> {
    return (await this.#bucket.head(this.#objectKey(path))) !== null;
  }

  /** Returns the path as stored: normalised, so it may differ from the one passed in. */
  async put(path: string, body: ReadableStream | ArrayBuffer | string, contentType?: string): Promise<string> {
    const key = this.#objectKey(path);
    await this.#bucket.put(key, body, {
      ssecKey: this.#key,
      httpMetadata: contentType ? { contentType } : undefined,
    });
    return key.slice(this.#prefix.length);
  }

  /** Delete files by their paths; a path with no file is skipped. */
  async delete(paths: readonly string[]): Promise<void> {
    const keys = paths.map((path) => this.#objectKey(path));
    // R2 deletes at most 1,000 keys a call.
    for (let i = 0; i < keys.length; i += 1000) await this.#bucket.delete(keys.slice(i, i + 1000));
  }

  /** Delete `folder` (never all the files: #objectKey refuses an empty path) and everything under it, however many files. */
  async deleteFolder(folder: string): Promise<void> {
    // Always end the prefix with "/": deleting "uploads/q3" must never touch "uploads/q30".
    await deletePrefix(this.#bucket, `${this.#objectKey(folder)}/`);
  }

  #objectKey(path: string): string {
    return this.#prefix + normalisePath(path);
  }
}
