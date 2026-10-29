import { MAX_LISTED } from "../../shared/uploads.ts";
import { normalisePath } from "./paths.ts";

export interface FileEntry {
  path: string;
  size: number;
  uploaded: Date;
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

  async list(folder = ""): Promise<FileEntry[]> {
    const sub = normalisePath(folder, { allowEmpty: true });
    // Always end the prefix with "/": "users/ada" must never match "users/adam".
    const prefix = this.#prefix + (sub && !sub.endsWith("/") ? `${sub}/` : sub);
    const entries: FileEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#bucket.list({ prefix, cursor, limit: 500 });
      for (const o of page.objects) entries.push({ path: o.key.slice(this.#prefix.length), size: o.size, uploaded: o.uploaded });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && entries.length < MAX_LISTED);
    return entries;
  }

  async get(path: string, range?: { offset: number; length: number }): Promise<R2ObjectBody | null> {
    return this.#bucket.get(this.#objectKey(path), range ? { range, ssecKey: this.#key } : { ssecKey: this.#key });
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

  #objectKey(path: string): string {
    return this.#prefix + normalisePath(path);
  }
}
