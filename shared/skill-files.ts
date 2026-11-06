// Files that come with a skill: a skill imported as a package (a zip with its SKILL.md) keeps the files beside it, the
// agent reads them on demand, and a page uses one by reference: <script src="skill:<name>/<path>"></script> or
// <link rel="stylesheet" href="skill:<name>/<path>">. The page keeps the reference while it is a draft; checking and
// publishing it put the file's text in its place (inlineSkillFiles), so a published version holds everything it runs
// and never changes when the skill does. Reading a published page back turns those parts into references again
// (collapseSkillFiles), so the agent edits a short page, not the library inlined into it.

import { SKILL_NAME_PATTERN } from "./skills.ts";
import { formatBytes } from "./util.ts";

/** One file of a skill, as the app lists it. */
export interface SkillFileInfo {
  path: string;
  size: number;
}

/** What a skill package may hold: the zip as uploaded, its files, each file and all of them unpacked. */
export const MAX_SKILL_ZIP_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_FILES = 300;
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_PACKAGE_BYTES = 10 * 1024 * 1024;

/** A file of one of the user's skills, by the skill's name and the file's path in it. */
export interface SkillFileRef {
  skill: string;
  path: string;
}

/** What a page's reference names, or null when it is not a skill name followed by a path. */
export function parseSkillRef(ref: string): SkillFileRef | null {
  const slash = ref.indexOf("/");
  const [skill, path] = [ref.slice(0, slash), ref.slice(slash + 1)];
  if (slash < 0 || !SKILL_NAME_PATTERN.test(skill)) return null;
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return { skill, path };
}

// A script tag naming a skill file as its src, with nothing inside it; or a link naming one as its href (a stylesheet's
// is a reference, any other is not). One pattern for both, so that inlining is one pass over the page as written.
const REF_TAG =
  /<script\b([^>]*?)\bsrc\s*=\s*(["'])skill:([^"']+)\2([^>]*)>\s*<\/script\s*>|<link\b([^>]*?)\bhref\s*=\s*(["'])skill:([^"']+)\6([^>]*)>/gi;
// A quoted value naming a skill file (skill:<name>/…): each must be in one of the tags above.
const ANY_REF = /["']skill:[a-z0-9-]+\//gi;
const isStylesheet = (attributes: string) => /\brel\s*=\s*["']?stylesheet/i.test(attributes);

/** One reference in a page: where its tag is, the tag, what it names, and whether it becomes a script or a style. */
interface RefTag {
  index: number;
  tag: string;
  ref: string;
  kind: "script" | "style";
  attributes: string;
}

/** The tags of a page that name a skill file, in order. */
function refTags(html: string): RefTag[] {
  const tags: RefTag[] = [];
  for (const match of html.matchAll(REF_TAG)) {
    const script = match[3] !== undefined;
    const attributes = script ? match[1] + match[4] : match[5] + match[8];
    if (!script && !isStylesheet(attributes)) continue;
    tags.push({ index: match.index, tag: match[0], ref: script ? match[3] : match[7], kind: script ? "script" : "style", attributes });
  }
  return tags;
}

/** A tag's type attribute, quoted or not. */
const typeOf = (attributes: string) => {
  const match = attributes.match(/(?:^|\s)type\s*=\s*(?:(["'])([^"']*)\1|([^\s"'=<>`]+))/i);
  return match?.[2] ?? match?.[3];
};
const isModule = (attributes: string) => typeOf(attributes)?.trim().toLowerCase() === "module";

/** The skill files a page names, each once, in the order it names them. Throws naming a reference that is not one. */
export function skillRefs(html: string): SkillFileRef[] {
  const found = new Map<string, SkillFileRef>();
  const bad: string[] = [];
  const deferred: string[] = [];
  const tags = refTags(html);
  for (const { ref: named, kind, attributes } of tags) {
    const ref = parseSkillRef(named);
    if (ref) found.set(`${ref.skill}/${ref.path}`, ref);
    else bad.push(named);
    // The file's text takes the tag's place, and an inline classic script runs where it is: defer would be lost.
    if (kind === "script" && /(?:^|\s)defer\b/i.test(attributes) && !isModule(attributes)) deferred.push(named);
  }
  if (bad.length) throw new Error(`Not a skill file: ${bad.map((ref) => `"skill:${ref}"`).join(", ")}. Name one as skill:<skill name>/<path in the skill>.`);
  if (deferred.length)
    throw new Error(
      `A skill file's script runs where its tag is, so defer does nothing for ${deferred.map((ref) => `"skill:${ref}"`).join(", ")}: ` +
        "drop defer and put the tag where the script should run (the end of the body).",
    );
  if ((html.match(ANY_REF)?.length ?? 0) > tags.length)
    throw new Error(`A skill file goes only in <script src="skill:…"></script> or <link rel="stylesheet" href="skill:…">; nowhere else in a page.`);
  return [...found.values()];
}

/** Text that may not appear inside an inlined script or style: it would end the element, or start a comment that hides its end. */
const escapeInline = (text: string) => text.replace(/<\/(script|style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

const newlines = (text: string) => text.split("\n").length - 1;

/** A page with the skill files it names put in it, and the line of the page as written each of its lines comes from. */
export interface InlinedPage {
  html: string;
  /** A line of `html` as a line of the page with references: a line of an inlined file is the line of its tag. */
  pageLine: (line: number) => number;
}

/**
 * `html` with every skill file it names put in its place: a script's text inside a script element, a stylesheet's
 * inside a style element, each marked with the file it came from. `read` gives a file's text, or null when the user
 * has no such file. Throws naming every file it could not find.
 */
export async function inlineSkillFiles(html: string, read: (ref: SkillFileRef) => Promise<string | null>): Promise<InlinedPage> {
  const refs = skillRefs(html);
  if (!refs.length) return { html, pageLine: (line) => line };
  const texts = new Map<string, string>();
  const missing: string[] = [];
  await Promise.all(
    refs.map(async (ref) => {
      const text = await read(ref);
      if (text === null) missing.push(`skill:${ref.skill}/${ref.path}`);
      else texts.set(`${ref.skill}/${ref.path}`, text);
    }),
  );
  if (missing.length) throw new Error(`No such skill file: ${missing.sort().join(", ")}.`);
  const marked = (ref: string) => `data-skill-file="${ref.replace(/"/g, "&quot;")}"`;
  // Each inlined element: the line of its tag, the lines it spans in the result, and how many lines all of them up to
  // and including it added.
  const spans: { line: number; start: number; end: number; added: number }[] = [];
  let out = "";
  let at = 0;
  let line = 1;
  let added = 0;
  for (const { index, tag, ref, kind, attributes } of refTags(html)) {
    const before = html.slice(at, index);
    line += newlines(before);
    const text = escapeInline(texts.get(ref)!);
    const type = kind === "script" ? typeOf(attributes) : undefined;
    const element = kind === "script" ? `<script ${marked(ref)}${type ? ` type="${type}"` : ""}>${text}</script>` : `<style ${marked(ref)}>${text}</style>`;
    out += before + element;
    const start = line + added;
    added += newlines(element) - newlines(tag);
    spans.push({ line, start, end: start + newlines(element), added });
    line += newlines(tag);
    at = index + tag.length;
  }
  out += html.slice(at);
  const pageLine = (inlined: number) => {
    let shift = 0;
    for (const span of spans) {
      if (inlined < span.start) break;
      if (inlined <= span.end) return span.line;
      shift = span.added;
    }
    return inlined - shift;
  };
  return { html: out, pageLine };
}

const INLINED_TAG = /<script data-skill-file="([^"]+)"(?: type="([^"]*)")?>[\s\S]*?<\/script>|<style data-skill-file="([^"]+)">[\s\S]*?<\/style>/g;
const unquote = (ref: string) => ref.replace(/&quot;/g, '"');

/** The skill files inlineSkillFiles put in a published page, each once. */
export function inlinedSkillFiles(html: string): SkillFileRef[] {
  const found = new Map<string, SkillFileRef>();
  for (const match of html.matchAll(INLINED_TAG)) {
    const ref = parseSkillRef(unquote(match[1] ?? match[3]));
    if (ref) found.set(`${ref.skill}/${ref.path}`, ref);
  }
  return [...found.values()];
}

/**
 * A published page with the skill files inlineSkillFiles put in it turned back into references: what the agent reads
 * and edits. A file `collapse` says no to stays inlined (one the skill no longer has, say). A page with none comes back
 * as it is. Inlined text never holds "</script" or "</style" (escapeInline), so the first closing tag is the element's own.
 */
export function collapseSkillFiles(html: string, collapse: (ref: SkillFileRef) => boolean = () => true): string {
  return html.replace(INLINED_TAG, (element: string, script?: string, type?: string, style?: string) => {
    const named = unquote(script ?? style!);
    const ref = parseSkillRef(named);
    if (!ref || !collapse(ref)) return element;
    return script !== undefined ? `<script${type ? ` type="${type}"` : ""} src="skill:${named}"></script>` : `<link rel="stylesheet" href="skill:${named}">`;
  });
}

/** What `activate_skill` adds about a skill's files: how to read them and how a page uses them. Empty for none. */
export function skillFilesNote(name: string, files: readonly SkillFileInfo[]): string {
  if (!files.length) return "";
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return (
    `\n\nThis skill comes with ${files.length} files (${formatBytes(total)}), listed in <skill_resources>. Read one with read_skill_resource when ` +
    `the instructions call for it. A page uses a script or stylesheet of the skill by reference, never by copying it: ` +
    `<script src="skill:${name}/<path>"></script> or <link rel="stylesheet" href="skill:${name}/<path>">. ` +
    `Checking and publishing the page put the file in its place. Where the instructions say to copy, bundle, inline or upload the skill's files ` +
    `next to the page, a reference does that here; its scripts and tools are not run.`
  );
}
