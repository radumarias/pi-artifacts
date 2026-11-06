import { canonicalJson } from "../../shared/canonical.ts";
import { ID_PATTERN, type ArtifactManifest } from "../../shared/protocol.ts";
import { sha256Hex } from "../../shared/util.ts";
import { deletePrefix } from "./r2.ts";

/** How many drafts one chat keeps: saving one more drops the oldest. */
export const MAX_DRAFTS = 20;

const ID_LENGTH = 16;
const DRAFT_ID = new RegExp(`^[0-9a-f]{${ID_LENGTH}}$`);

/**
 * The id a page is saved as a draft by: the start of a SHA-256 of its manifest, the page and the sets of skill files
 * it names, so the same page naming a skill imported again is another draft, with its own check.
 */
export async function draftId(html: string, manifest: ArtifactManifest, skillSets: SkillSets = {}): Promise<string> {
  const sets = Object.keys(skillSets).length ? `\u0000${canonicalJson(skillSets)}` : "";
  return (await sha256Hex(`${canonicalJson(manifest)}\u0000${html}${sets}`)).slice(0, ID_LENGTH);
}

/** The set of files (SkillFiles) of each skill a page names files of, by the skill's name: what checking and publishing it read. */
export type SkillSets = Record<string, string>;

/** A page as it is saved: by its draftId, with the artifact of this chat it is a new version of, when the agent said. */
export interface DraftPage {
  id: string;
  html: string;
  manifest: ArtifactManifest;
  artifactId?: string;
  /** The skill files the page names are read from these sets, which never change: what was checked is what is published. */
  skillSets?: SkillSets;
}

/** What a page's check found: errors is null when no browser could check it. */
export interface DraftCheck {
  errors: number | null;
  warnings: number;
  /** What the look at a check's screenshot stopped this draft for (worker/artifacts/look.ts): it stops a draft once. */
  lookStopped?: string;
}

/**
 * A page the agent wrote (artifact_write), kept until it is published: what a fix starts again from, and what a
 * passed check publishes by its id, also after the chat object restarted. Its check is kept in the index only, so
 * recording one does not write the page again.
 */
export type Draft = DraftPage & DraftCheck & { savedAt: number };

export type DraftSummary = Omit<Draft, "html" | "manifest" | "skillSets"> & { bytes: number };

/** Whether a draft passed its check: only those may be published by their id. */
export const passed = (draft: Pick<DraftCheck, "errors">) => draft.errors === 0;

/**
 * One chat's drafts, in its owner's folder and encrypted with the owner's key like their files (UserFiles), but kept
 * apart from them: users/<uid>/drafts/<chatId>/<id>.json, with index.json listing them. The agent runs a round's tool
 * calls at once (pi's default `toolExecution` is "parallel"), so saves and removes take turns (#serial): the index's
 * read-modify-write would otherwise lose a draft. A chat's object keeps one ChatDrafts for this (ChatScope.drafts).
 */
export class ChatDrafts {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  readonly #key: ArrayBuffer;
  /** The last write in line: each save or remove starts once it has settled. */
  #writes: Promise<unknown> = Promise.resolve();

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

  /** A draft, with how its check went (not checked, when the index lost it). */
  async get(id: string): Promise<Draft | null> {
    if (!DRAFT_ID.test(id)) return null;
    const [object, index] = await Promise.all([this.#bucket.get(this.#draftKey(id), { ssecKey: this.#key }), this.#index()]);
    if (!object) return null;
    const { html, manifest, artifactId, skillSets, savedAt } = (await object.json()) as Draft;
    const entry = index.find((e) => e.id === id);
    const stopped = entry?.lookStopped;
    return { id, html, manifest, artifactId, skillSets, savedAt, errors: entry?.errors ?? null, warnings: entry?.warnings ?? 0, ...(stopped && { lookStopped: stopped }) };
  }

  /**
   * Save a page as the newest draft, with what its check found (`check`; null when it was not checked). A page saved
   * before keeps the artifact it was for, and its check when this save has none. Beyond MAX_DRAFTS the oldest go.
   */
  async save(page: DraftPage, check: DraftCheck | null): Promise<Draft & { bytes: number }> {
    if (!DRAFT_ID.test(page.id)) throw new Error("Invalid draft id.");
    return this.#serial(() => this.#save(page, check));
  }

  /** Keep what a check of a saved draft found: in the index only, where it stays in its place. A draft not listed is skipped. */
  async recordCheck(id: string, check: DraftCheck): Promise<void> {
    await this.#serial(async () => {
      const index = await this.#index();
      const entry = index.find((e) => e.id === id);
      if (!entry) return;
      Object.assign(entry, check);
      await this.#putJson(this.#indexKey, index);
    });
  }

  async #save(page: DraftPage, check: DraftCheck | null): Promise<Draft & { bytes: number }> {
    const index = await this.#index();
    const before = index.find((entry) => entry.id === page.id);
    const draft: Draft = {
      ...page,
      artifactId: page.artifactId ?? before?.artifactId,
      savedAt: Date.now(),
      ...(check ?? { errors: before?.errors ?? null, warnings: before?.warnings ?? 0, ...(before?.lookStopped && { lookStopped: before.lookStopped }) }),
    };
    const { html, manifest, skillSets, ...summary } = draft;
    const bytes = new TextEncoder().encode(html).byteLength;
    const kept = [...index.filter((entry) => entry.id !== page.id), { ...summary, bytes }];
    const dropped = kept.splice(0, Math.max(0, kept.length - MAX_DRAFTS));
    await Promise.all([
      this.#putJson(this.#draftKey(page.id), { id: page.id, html, manifest, artifactId: draft.artifactId, skillSets, savedAt: draft.savedAt }),
      this.#putJson(this.#indexKey, kept),
      dropped.length && this.#bucket.delete(dropped.map((entry) => this.#draftKey(entry.id))),
    ]);
    return { ...draft, bytes };
  }

  /** Drop a draft: it was published. A draft that is not there is skipped. */
  async remove(id: string): Promise<void> {
    if (!DRAFT_ID.test(id)) return;
    await this.#serial(async () => {
      const index = await this.#index();
      const kept = index.filter((entry) => entry.id !== id);
      await Promise.all([kept.length < index.length && this.#putJson(this.#indexKey, kept), this.#bucket.delete(this.#draftKey(id))]);
    });
  }

  /** Run `write` once the writes before it settled, failed or not. */
  #serial<T>(write: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(write);
    this.#writes = run.catch(() => {});
    return run;
  }

  /** Every draft of the chat and its index, for deleting the chat; by listing, so a draft the index lost goes too. */
  async deleteAll(): Promise<void> {
    await deletePrefix(this.#bucket, this.#prefix);
  }

  /** Oldest first. */
  async #index(): Promise<DraftSummary[]> {
    const object = await this.#bucket.get(this.#indexKey, { ssecKey: this.#key });
    return object ? ((await object.json()) as DraftSummary[]) : [];
  }

  async #putJson(key: string, value: unknown): Promise<void> {
    await this.#bucket.put(key, JSON.stringify(value), { ssecKey: this.#key, httpMetadata: { contentType: "application/json" } });
  }

  get #indexKey(): string {
    return `${this.#prefix}index.json`;
  }

  #draftKey(id: string): string {
    return `${this.#prefix}${id}.json`;
  }
}
