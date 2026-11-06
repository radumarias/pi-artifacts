import { SKILL_NAME_PATTERN } from "../../shared/skills.ts";
import { mapLimit, randomHex } from "../../shared/util.ts";
import { normalisePath } from "./paths.ts";
import { deletePrefix } from "./r2.ts";

/** How many files are written to, or read from, R2 at once. */
const PARALLEL = 8;
const SET_PATTERN = /^[0-9a-f]{16}$/;

/**
 * The files of one user's skills, encrypted with that user's key like their files (UserFiles) and kept apart from them:
 * users/<uid>/skills/<name>/<set>/<path>. Each import writes a new set, and the skill's row (UserDirectory) names the
 * set it uses, so a failed import never leaves a skill with half of its old files and half of its new ones; the sets a
 * skill no longer names are deleted after.
 */
export class SkillFiles {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  readonly #key: ArrayBuffer;

  /** Use `Storage.skillFiles(uid)`; the uid must come from a verified identity. */
  constructor(bucket: R2Bucket, uid: string, key: ArrayBuffer) {
    this.#bucket = bucket;
    this.#prefix = `users/${uid}/skills/`;
    this.#key = key;
  }

  /** Write a skill's files as a new set; returns the set's id, for the skill's row to name. */
  async write(skill: string, files: readonly { path: string; bytes: Uint8Array }[]): Promise<string> {
    const set = randomHex(8);
    try {
      await mapLimit(files, PARALLEL, (file) => this.#bucket.put(this.#objectKey(skill, set, file.path), file.bytes, { ssecKey: this.#key }));
    } catch (error) {
      await this.drop(skill, set).catch(() => {});
      throw error;
    }
    return set;
  }

  /** A file's bytes, or null when the set has no such file. */
  async read(skill: string, set: string, path: string): Promise<Uint8Array | null> {
    let key: string;
    try {
      key = this.#objectKey(skill, set, path);
    } catch {
      return null;
    }
    const object = await this.#bucket.get(key, { ssecKey: this.#key });
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  /** Several files' bytes, read a few at a time: null for each the set has no such file. */
  readAll(skill: string, set: string, paths: readonly string[]): Promise<(Uint8Array | null)[]> {
    return mapLimit(paths, PARALLEL, (path) => this.read(skill, set, path));
  }

  /** Delete one set of a skill's files. */
  async drop(skill: string, set: string): Promise<void> {
    await deletePrefix(this.#bucket, `${this.#skillPrefix(skill)}${checkSet(set)}/`);
  }

  /** Delete every set of a skill's files but `keep` (none kept when it is undefined). */
  async dropAllBut(skill: string, keep?: string): Promise<void> {
    const prefix = this.#skillPrefix(skill);
    await deletePrefix(this.#bucket, prefix, keep === undefined ? undefined : `${prefix}${checkSet(keep)}/`);
  }

  #skillPrefix(skill: string): string {
    if (!SKILL_NAME_PATTERN.test(skill)) throw new Error("Invalid skill name.");
    return `${this.#prefix}${skill}/`;
  }

  #objectKey(skill: string, set: string, path: string): string {
    return `${this.#skillPrefix(skill)}${checkSet(set)}/${normalisePath(path)}`;
  }
}

function checkSet(set: string): string {
  if (!SET_PATTERN.test(set)) throw new Error("Invalid skill file set.");
  return set;
}
