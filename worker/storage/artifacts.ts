import { isOwnedBy, type ArtifactManifest, type ArtifactMeta, type ArtifactVersion, type CloneAccess } from "../../shared/protocol.ts";
import { randomHex } from "../../shared/util.ts";
import { commitAndPush, tokenSecret, type GitHttp } from "./git.ts";
import { deletePrefix } from "./r2.ts";

const BRANCH = "main";
const PAGE_FILE = "index.html";
const META_FILE = "artifact.json";
/** How long a write token minted for one publish lives. It is revoked as soon as the push is done. */
const PUBLISH_TOKEN_TTL_S = 300;
/** How long a read token for `git clone` lives. */
const CLONE_TOKEN_TTL_S = 900;
/** The longest a version's message is kept: its first line, cut to this. */
export const MAX_VERSION_MESSAGE = 200;

const repoName = (id: string) => `artifact-${id}`;
const tagFor = (version: number) => `v${version}`;
// The R2 read cache keeps the layout artifacts had before repos, so artifacts
// published then still serve from it.
const cachePrefix = (id: string) => `artifacts/${id}/`;
const metaKey = (id: string) => `${cachePrefix(id)}meta.json`;
const htmlKey = (id: string, version: number) => `${cachePrefix(id)}v${version}/index.html`;

/** A new artifact or chat id: 16 lowercase hex characters. */
export function newId(): string {
  return randomHex(8);
}

/**
 * Published artifacts, one Git repo each in Cloudflare Artifacts: every
 * publish is a commit tagged v<n> holding index.html and artifact.json (the
 * metadata, manifests included). The repo is the source of truth; R2 keeps a
 * copy of each version and of the latest metadata, so page views and live
 * calls never touch Git.
 *
 * Artifacts are shared by link (anyone the app lets in can view one), so they
 * are not encrypted per user; writes check that the caller owns the artifact.
 */
export class ArtifactStore {
  readonly #repos: Artifacts;
  readonly #cache: R2Bucket;
  readonly #http?: GitHttp;

  constructor(repos: Artifacts, cache: R2Bucket, options: { http?: GitHttp } = {}) {
    this.#repos = repos;
    this.#cache = cache;
    this.#http = options.http;
  }

  async readMeta(id: string): Promise<ArtifactMeta | null> {
    const cached = await this.#cache.get(metaKey(id));
    if (cached) return (await cached.json()) as ArtifactMeta;
    const meta = await this.#readRepoMeta(id);
    if (meta) await this.#cacheMeta(meta);
    return meta;
  }

  async readHtml(id: string, version: number): Promise<string | null> {
    const cached = await this.#cache.get(htmlKey(id, version));
    if (cached) return cached.text();
    const html = await this.#withRepo(id, async (repo) => {
      const file = await repo.readFile({ ref: tagFor(version), path: PAGE_FILE });
      return file ? file.text() : null;
    });
    if (html !== null) await this.#cacheHtml(id, version, html);
    return html;
  }

  /** A short-lived read token for `git clone`. The caller checks that the user owns the artifact. */
  async cloneAccess(id: string): Promise<CloneAccess | null> {
    return this.#withRepo(id, async (repo) => {
      const [info, token] = await Promise.all([repo.info(), repo.createToken("read", CLONE_TOKEN_TTL_S)]);
      return { remote: info.remote, token: tokenSecret(token.plaintext), expiresAt: token.expiresAt };
    });
  }

  /**
   * Delete an artifact, every version, for good: its repo, then its cached copies, so that a failure part way leaves
   * it still readable and the next try finishes the job. Only the chat that owns it may: false for anyone else's. An
   * artifact already gone is deleted.
   */
  async delete(id: string, ownerUid: string, chatId: string): Promise<boolean> {
    // Not readMeta: it would cache a copy of what is about to go.
    const cached = await this.#cache.get(metaKey(id));
    const meta = cached ? ((await cached.json()) as ArtifactMeta) : await this.#readRepoMeta(id);
    if (meta && !isOwnedBy(meta, ownerUid, chatId)) return false;
    await this.#repos.delete(repoName(id));
    await deletePrefix(this.#cache, cachePrefix(id));
    return true;
  }

  /**
   * Commit a new version and push it. Only the chat that created an artifact
   * publishes to it, and a chat's Durable Object handles one call at a time,
   * so two publishes to one repo cannot race.
   */
  async publishVersion(input: {
    id?: string;
    ownerUid: string;
    chatId: string;
    title: string;
    html: string;
    manifest: ArtifactManifest;
    message?: string;
  }): Promise<ArtifactMeta> {
    const now = Date.now();
    let meta: ArtifactMeta;
    let createdToken: string | undefined;
    if (input.id) {
      const existing = (await this.#readRepoMeta(input.id)) ?? (await this.#importFromCache(input.id, input.ownerUid, input.chatId));
      if (!existing) throw new Error(`No artifact ${input.id}.`);
      if (!isOwnedBy(existing, input.ownerUid, input.chatId)) {
        throw new Error(`Artifact ${input.id} belongs to another chat; publish a new artifact instead.`);
      }
      meta = existing;
    } else {
      meta = { id: newId(), title: input.title, ownerUid: input.ownerUid, chatId: input.chatId, createdAt: now, updatedAt: now, latest: 0, versions: [] };
      createdToken = (await this.#repos.create(repoName(meta.id), { description: input.title, setDefaultBranch: BRANCH })).token;
    }

    return this.#addVersion(meta, input.title, { version: meta.latest + 1, publishedAt: now, manifest: input.manifest, message: input.message }, input.html, createdToken);
  }

  /** Commit `version` after the ones `meta` has, push it, and cache it. Its message is cut to its first line. */
  async #addVersion(before: ArtifactMeta, title: string, version: ArtifactVersion, html: string, createdToken?: string): Promise<ArtifactMeta> {
    const message = version.message?.trim().split("\n")[0].slice(0, MAX_VERSION_MESSAGE) || undefined;
    const meta: ArtifactMeta = {
      ...before,
      title,
      updatedAt: version.publishedAt,
      latest: version.version,
      versions: [...before.versions, { version: version.version, publishedAt: version.publishedAt, manifest: version.manifest, ...(message && { message }) }],
    };
    await this.#commit(meta, html, version.publishedAt, createdToken);
    await Promise.all([this.#cacheHtml(meta.id, version.version, html), this.#cacheMeta(meta)]);
    return meta;
  }

  /**
   * Add one version an import brings, as it was published (its time, manifest and message), to artifact `id` of the
   * user's chat `chatId`: versions come in order, the first making the repo. A version that is here already is skipped,
   * so an import that stopped part way goes on. Throws an ArtifactImportError for an id that is another chat's here, or a
   * version out of order.
   */
  async importVersion(input: { id: string; ownerUid: string; chatId: string; title: string; createdAt: number; version: ArtifactVersion; html: string }): Promise<ArtifactMeta> {
    const { id, ownerUid, chatId, version } = input;
    // One published before repos has only its read cache: it is replayed into a repo first, as a publish does.
    const existing = (await this.#readRepoMeta(id)) ?? (await this.#importFromCache(id, ownerUid, chatId));
    if (existing && !isOwnedBy(existing, ownerUid, chatId)) throw new ArtifactImportError(`Artifact ${id} belongs to another chat here.`);
    if (existing && existing.latest >= version.version) return existing;
    const next = (existing?.latest ?? 0) + 1;
    if (next !== version.version) throw new ArtifactImportError(`Artifact ${id} needs version ${next} before ${version.version}.`);
    let createdToken: string | undefined;
    if (!existing) {
      // A repo without artifact.json holds nothing yet (an import that stopped before its first push): start it again.
      await this.#repos.delete(repoName(id)).catch(() => false);
      createdToken = (await this.#repos.create(repoName(id), { description: input.title, setDefaultBranch: BRANCH })).token;
    }
    const before = existing ?? { id, title: input.title, ownerUid, chatId, createdAt: input.createdAt, updatedAt: input.createdAt, latest: 0, versions: [] };
    return this.#addVersion(before, input.title, version, input.html, createdToken);
  }

  /**
   * Commit one version (index.html and artifact.json as of that version) with
   * a write token minted for this push only. `createdToken` is the write token
   * create() hands back, valid for a day: it is revoked here too, unused.
   */
  async #commit(meta: ArtifactMeta, html: string, at: number, createdToken?: string): Promise<void> {
    const entry = meta.versions[meta.versions.length - 1];
    await this.#withRepo(meta.id, async (repo) => {
      const [info, token] = await Promise.all([repo.info(), repo.createToken("write", PUBLISH_TOKEN_TTL_S)]);
      try {
        await commitAndPush({
          remote: info.remote,
          token: token.plaintext,
          branch: BRANCH,
          empty: entry.version === 1,
          files: { [PAGE_FILE]: html, [META_FILE]: `${JSON.stringify(meta, null, 2)}\n` },
          message: `${tagFor(entry.version)}: ${entry.message ?? meta.title}`,
          tag: tagFor(entry.version),
          at,
          http: this.#http,
        });
      } finally {
        await repo.revokeToken(token.id).catch(() => false);
        if (createdToken) await repo.revokeToken(createdToken).catch(() => false);
      }
    }, { required: true });
  }

  /**
   * An artifact published before repos existed has only its R2 copy. Replay
   * its versions into a new repo, one commit each, before adding to it. Only
   * for the chat that owns it: anyone else's is returned untouched, for the
   * caller to refuse.
   */
  async #importFromCache(id: string, ownerUid: string, chatId: string): Promise<ArtifactMeta | null> {
    const cached = await this.#cache.get(metaKey(id));
    if (!cached) return null;
    const legacy = (await cached.json()) as ArtifactMeta;
    if (!isOwnedBy(legacy, ownerUid, chatId)) return legacy;
    // A repo without artifact.json on main holds nothing yet (an import that
    // stopped before its first push): start it again.
    await this.#repos.delete(repoName(id)).catch(() => false);
    let createdToken: string | undefined = (await this.#repos.create(repoName(id), { description: legacy.title, setDefaultBranch: BRANCH })).token;
    for (const entry of legacy.versions) {
      const html = await (await this.#cache.get(htmlKey(id, entry.version)))?.text();
      if (html === undefined) throw new Error(`Artifact ${id} is missing version ${entry.version}; it cannot be imported.`);
      const asOf: ArtifactMeta = { ...legacy, latest: entry.version, updatedAt: entry.publishedAt, versions: legacy.versions.filter((v) => v.version <= entry.version) };
      await this.#commit(asOf, html, entry.publishedAt, createdToken);
      createdToken = undefined;
    }
    return legacy;
  }

  async #readRepoMeta(id: string): Promise<ArtifactMeta | null> {
    return this.#withRepo(id, async (repo) => {
      const file = await repo.readFile({ ref: BRANCH, path: META_FILE });
      return file ? (JSON.parse(await file.text()) as ArtifactMeta) : null;
    });
  }

  /** Run `use` with the artifact's repo handle, then release it. Null when there is no repo, unless it is required. */
  async #withRepo<T>(id: string, use: (repo: ArtifactsRepo) => Promise<T>, options: { required?: boolean } = {}): Promise<T | null> {
    let repo: ArtifactsRepo;
    try {
      repo = await this.#repos.get(repoName(id));
    } catch (error) {
      if (!options.required && (error as { code?: string }).code === "NOT_FOUND") return null;
      throw error;
    }
    try {
      return await use(repo);
    } finally {
      repo[Symbol.dispose]();
    }
  }

  // The cache is only ever a copy of what the repo holds. If writing it fails,
  // drop the metadata so the next read refills it from the repo, rather than
  // serving a stale latest version.
  async #cacheMeta(meta: ArtifactMeta): Promise<void> {
    try {
      await this.#cache.put(metaKey(meta.id), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
    } catch {
      await this.#cache.delete(metaKey(meta.id)).catch(() => {});
    }
  }

  async #cacheHtml(id: string, version: number, html: string): Promise<void> {
    await this.#cache.put(htmlKey(id, version), html, { httpMetadata: { contentType: "text/html; charset=utf-8" } }).catch(() => {});
  }
}

/** A version an import brings that cannot go where it says. */
export class ArtifactImportError extends Error {}
