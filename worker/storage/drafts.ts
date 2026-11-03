import { ID_PATTERN, type ArtifactManifest } from "../../shared/protocol.ts";

/** How many drafts one chat keeps: saving one more drops the oldest. */
export const MAX_DRAFTS = 20;

const DRAFT_ID = /^[0-9a-f]{16}$/;

/**
 * A page the agent checked or tried to publish, kept until it is published: what a fix starts again from, and what a
 * passed check publishes by its id, also after the chat object restarted.
 */
export interface Draft {
  /** The start of a SHA-256 of the manifest and the page (see draftId): the same page saved again is the same draft. */
  id: string;
  html: string;
  manifest: ArtifactManifest;
  /** The artifact of this chat the page is a new version of, when the agent said. */
  artifactId?: string;
  savedAt: number;
  /** What the check found; errors is null when no browser could check the page. */
  errors: number | null;
  warnings: number;
}

export type DraftSummary = Omit<Draft, "html" | "manifest"> & { bytes: number };

/** Whether a draft passed its check: only those may be published by their id. */
export const passed = (draft: Pick<Draft, "errors">) => draft.errors === 0;

/**
 * One chat's drafts, in its owner's folder and encrypted with the owner's key like their files (UserFiles), but kept
 * apart from them: users/<uid>/drafts/<chatId>/<id>.json, with index.json listing them. A chat's object makes one tool
 * call at a time, so the index's read-modify-write does not race.
 */
export class ChatDrafts {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  readonly #key: ArrayBuffer;

  /** Use `Storage.chatDrafts(uid, chatId)`; the uid must come from a verified identity. */
  constructor(bucket: R2Bucket, uid: string, chatId: string, key: ArrayBuffer) {
    if (!ID_PATTERN.test(chatId)) throw new Error("Invalid chat id.");
    this.#bucket = bucket;
    this.#prefix = `users/${uid}/drafts/${chatId}/`;
    this.#key = key;
  }

  /** Newest first. */
  async list(): Promise<DraftSummary[]> {
    return (await this.#index()).reverse();
  }

  async get(id: string): Promise<Draft | null> {
    if (!DRAFT_ID.test(id)) return null;
    const object = await this.#bucket.get(this.#draftKey(id), { ssecKey: this.#key });
    return object ? ((await object.json()) as Draft) : null;
  }

  /** Save a draft, or save it again as the newest; beyond MAX_DRAFTS the oldest go. */
  async save(draft: Draft): Promise<void> {
    if (!DRAFT_ID.test(draft.id)) throw new Error("Invalid draft id.");
    const body = JSON.stringify(draft);
    await this.#bucket.put(this.#draftKey(draft.id), body, { ssecKey: this.#key, httpMetadata: { contentType: "application/json" } });
    const { html: _html, manifest: _manifest, ...summary } = draft;
    const index = [...(await this.#index()).filter((entry) => entry.id !== draft.id), { ...summary, bytes: new TextEncoder().encode(draft.html).byteLength }];
    const dropped = index.splice(0, Math.max(0, index.length - MAX_DRAFTS));
    await this.#writeIndex(index);
    if (dropped.length) await this.#bucket.delete(dropped.map((entry) => this.#draftKey(entry.id)));
  }

  /** Drop a draft: it was published. A draft that is not there is skipped. */
  async remove(id: string): Promise<void> {
    if (!DRAFT_ID.test(id)) return;
    const index = await this.#index();
    if (index.some((entry) => entry.id === id)) await this.#writeIndex(index.filter((entry) => entry.id !== id));
    await this.#bucket.delete(this.#draftKey(id));
  }

  /** Every draft of the chat and its index, for deleting the chat; by listing, so a draft the index lost goes too. */
  async deleteAll(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.#bucket.list({ prefix: this.#prefix, cursor });
      const keys: string[] = page.objects.map((object: R2Object) => object.key);
      if (keys.length) await this.#bucket.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  /** Oldest first. */
  async #index(): Promise<DraftSummary[]> {
    const object = await this.#bucket.get(`${this.#prefix}index.json`, { ssecKey: this.#key });
    return object ? ((await object.json()) as DraftSummary[]) : [];
  }

  async #writeIndex(index: DraftSummary[]): Promise<void> {
    await this.#bucket.put(`${this.#prefix}index.json`, JSON.stringify(index), { ssecKey: this.#key, httpMetadata: { contentType: "application/json" } });
  }

  #draftKey(id: string): string {
    return `${this.#prefix}${id}.json`;
  }
}
