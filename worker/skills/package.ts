import { MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES, MAX_SKILL_PACKAGE_BYTES } from "../../shared/skill-files.ts";
import { SkillError } from "../../shared/skills.ts";
import { isHidden } from "../../shared/uploads.ts";
import { literalPath } from "../storage/paths.ts";
import { unzip, UnzipError } from "../../shared/unzip.ts";

/** A skill package read out of its zip: the SKILL.md, the files beside it (marked when not UTF-8 text), and what was left out and why. */
export interface SkillPackage {
  markdown: string;
  files: { path: string; bytes: Uint8Array; binary?: true }[];
  skipped: string[];
}

const SKILL_FILE = "SKILL.md";
// What operating systems leave in a folder they zip, besides hidden files.
const CLUTTER = /(^|\/)(__MACOSX|Thumbs\.db|desktop\.ini)(\/|$)/;

/**
 * The skill in a zip: its SKILL.md at the top, or in the one folder the zip holds (as zipping a folder makes), and the
 * files beside it, kept by their paths from there, each marked when it is not UTF-8 text (an image, a font…). Hidden
 * files and operating-system clutter are not read; files outside the skill's folder and files with characters user
 * paths do not allow are left out and named in `skipped`. Nothing in the zip is run here. Throws a SkillError with what
 * to fix.
 */
export async function readSkillPackage(zip: Uint8Array): Promise<SkillPackage> {
  let entries;
  try {
    const include = (name: string) => !CLUTTER.test(name) && !isHidden(name);
    entries = await unzip(zip, { maxFiles: MAX_SKILL_FILES + 1, maxFileBytes: MAX_SKILL_FILE_BYTES, maxTotalBytes: MAX_SKILL_PACKAGE_BYTES, include });
  } catch (error) {
    if (error instanceof UnzipError) throw new SkillError(error.message);
    throw error;
  }
  const depth = (name: string) => name.split("/").length;
  const top = entries.filter((entry) => entry.name === SKILL_FILE || entry.name.endsWith(`/${SKILL_FILE}`)).sort((a, b) => depth(a.name) - depth(b.name))[0];
  if (!top) throw new SkillError(`The zip has no ${SKILL_FILE}: zip the skill's folder, with its ${SKILL_FILE} at the top.`);
  const root = top.name.slice(0, -SKILL_FILE.length);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const isText = (bytes: Uint8Array) => {
    try {
      decoder.decode(bytes);
      return true;
    } catch {
      return false;
    }
  };
  const files: SkillPackage["files"] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (entry === top) continue;
    if (!entry.name.startsWith(root)) {
      skipped.push(`${entry.name} (outside the skill's folder)`);
      continue;
    }
    const relative = entry.name.slice(root.length);
    const path = literalPath(relative);
    if (path === undefined) skipped.push(`${relative} (a name with characters other than letters, digits, spaces, . - _ and /)`);
    else files.push({ path, bytes: entry.bytes, ...(!isText(entry.bytes) && { binary: true as const }) });
  }
  if (!isText(top.bytes)) throw new SkillError(`${SKILL_FILE} is not a text file.`);
  if (files.length > MAX_SKILL_FILES) throw new SkillError(`The skill has more than ${MAX_SKILL_FILES} files.`);
  return { markdown: decoder.decode(top.bytes), files: files.sort((a, b) => a.path.localeCompare(b.path)), skipped };
}
