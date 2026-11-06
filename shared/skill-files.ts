// Files that come with a skill: a skill imported as a package (a zip with its SKILL.md) keeps the files beside it, the
// agent reads them on demand, and a page uses one by reference: <script src="skill:<name>/<path>"></script>,
// <link rel="stylesheet" href="skill:<name>/<path>">, or as another attribute's whole value: <img src="skill:<name>/<path>">.
// The page keeps the reference while it is a draft; checking and publishing it put the file in its place
// (inlineSkillFiles): a script's or stylesheet's text, any other as a data: URL, and the fonts and images a skill
// stylesheet names by relative url() as data: URLs too. So a published version holds everything it runs and never
// changes when the skill does. Reading a published page back turns those parts into references again
// (collapseSkillFiles), so the agent edits a short page, not the library inlined into it.

import { SKILL_NAME_PATTERN } from "./skills.ts";
import { contentType } from "./uploads.ts";
import { formatBytes, toBase64 } from "./util.ts";

/** One file of a skill, as the app lists it. */
export interface SkillFileInfo {
  path: string;
  size: number;
  /** Not UTF-8 text: an image, a font, a PDF… Used in a page as a data: URL, copied into the sandbox as it is. */
  binary?: true;
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
// is a reference; any other link's is an attribute, below).
const REF_TAG =
  /<script\b([^>]*?)\bsrc\s*=\s*(["'])skill:([^"']+)\2([^>]*)>\s*<\/script\s*>|<link\b([^>]*?)\bhref\s*=\s*(["'])skill:([^"']+)\6([^>]*)>/gi;
// Any other tag (not a script's) with an attribute whose whole value names a skill file: an <img src>, a <video
// poster>, a <link rel="icon"> href… The file goes in as a data: URL.
const ANY_TAG = /<(?!script\b)[a-z][a-z0-9-]*\b[^>]*>/gi;
const ATTRIBUTE_REF = /(\s)([a-z][a-z0-9-]*)\s*=\s*(["'])skill:([^"']+)\3/gi;
// A quoted value naming a skill file (skill:<name>/…): each must be one of the references above.
const ANY_REF = /["']skill:[a-z0-9-]+\//gi;
const isStylesheet = (attributes: string) => /\brel\s*=\s*["']?stylesheet/i.test(attributes);

/**
 * One reference in a page: where it is, the text it takes up, and what it names; then what it becomes: a script or a
 * style (with the tag's attributes), or a data: URL in its `attribute`.
 */
type RefTag = { index: number; tag: string; ref: string } & ({ kind: "script" | "style"; attributes: string } | { kind: "attribute"; attribute: string });

/** The references of a page, in order. */
function refTags(html: string): RefTag[] {
  const tags: RefTag[] = [];
  for (const match of html.matchAll(REF_TAG)) {
    const script = match[3] !== undefined;
    const attributes = script ? match[1] + match[4] : match[5] + match[8];
    if (!script && !isStylesheet(attributes)) continue;
    tags.push({ index: match.index, tag: match[0], ref: script ? match[3] : match[7], kind: script ? "script" : "style", attributes });
  }
  for (const element of html.matchAll(ANY_TAG)) {
    if (/^<link\b/i.test(element[0]) && isStylesheet(element[0])) continue;
    for (const match of element[0].matchAll(ATTRIBUTE_REF)) {
      tags.push({ index: element.index + match.index, tag: match[0], ref: match[4], kind: "attribute", attribute: match[2].toLowerCase() });
    }
  }
  return tags.sort((a, b) => a.index - b.index);
}

/** A tag's type attribute, quoted or not. */
const typeOf = (attributes: string) => {
  const match = attributes.match(/(?:^|\s)type\s*=\s*(?:(["'])([^"']*)\1|([^\s"'=<>`]+))/i);
  return match?.[2] ?? match?.[3];
};
const isModule = (attributes: string) => typeOf(attributes)?.trim().toLowerCase() === "module";

/** A page's references, checked: throws naming a reference that is not one, or one in a place it cannot be. */
function checkedRefTags(html: string): RefTag[] {
  const bad: string[] = [];
  const deferred: string[] = [];
  const tags = refTags(html);
  for (const tag of tags) {
    if (!parseSkillRef(tag.ref)) bad.push(tag.ref);
    // The file's text takes the tag's place, and an inline classic script runs where it is: defer would be lost.
    if (tag.kind === "script" && /(?:^|\s)defer\b/i.test(tag.attributes) && !isModule(tag.attributes)) deferred.push(tag.ref);
  }
  if (bad.length) throw new Error(`Not a skill file: ${bad.map((ref) => `"skill:${ref}"`).join(", ")}. Name one as skill:<skill name>/<path in the skill>.`);
  if (deferred.length)
    throw new Error(
      `A skill file's script runs where its tag is, so defer does nothing for ${deferred.map((ref) => `"skill:${ref}"`).join(", ")}: ` +
        "drop defer and put the tag where the script should run (the end of the body).",
    );
  if ((html.match(ANY_REF)?.length ?? 0) > tags.length)
    throw new Error(
      `A skill file goes only in <script src="skill:…"></script>, <link rel="stylesheet" href="skill:…">, or as the whole value of another tag's attribute ` +
        `(<img src="skill:…">, a video's poster, an icon's href); nowhere else in a page, such as a script's text or a url() in the page's own styles. ` +
        "A skill stylesheet's own url()s to the skill's fonts and images come with it.",
    );
  return tags;
}

/** The skill files a page names, each once, in the order it names them. Throws naming a reference that is not one. */
export function skillRefs(html: string): SkillFileRef[] {
  return uniqueRefs(checkedRefTags(html).map((tag) => tag.ref));
}

/** The files `names` name (skill/path), each once, in order; a name that is not one is left out. */
function uniqueRefs(names: readonly string[]): SkillFileRef[] {
  const found = new Map<string, SkillFileRef>();
  for (const name of names) {
    const ref = parseSkillRef(name);
    if (ref && !found.has(name)) found.set(name, ref);
  }
  return [...found.values()];
}

/** Text that may not appear inside an inlined script or style: it would end the element, or start a comment that hides its end. */
const escapeInline = (text: string) => text.replace(/<\/(script|style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
const escapeAttribute = (value: string) => value.replace(/"/g, "&quot;");
const unquote = (value: string) => value.replace(/&quot;/g, '"');

const newlines = (text: string) => text.split("\n").length - 1;

/** A page with the skill files it names put in it, and the line of the page as written each of its lines comes from. */
export interface InlinedPage {
  html: string;
  /** A line of `html` as a line of the page with references: a line of an inlined file is the line of its tag. */
  pageLine: (line: number) => number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

// A url() in a stylesheet, its value quoted or not.
const CSS_URL = /url\(\s*(["']?)([^"')\s]+)\1\s*\)/gi;

/** A url() of a skill's stylesheet `from` as a file of the skill (skill/path), or null when it names none: not relative, or outside the skill. */
function cssFile(from: string, url: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(url)) return null;
  const segments = from.split("/").slice(0, -1);
  for (const segment of url.replace(/[?#].*$/, "").split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  // The skill's name is the first segment: a path that climbs past it leaves the skill.
  const named = segments.join("/");
  return segments.length > 1 && parseSkillRef(named)?.skill === from.slice(0, from.indexOf("/")) ? named : null;
}

/**
 * `html` with every skill file it names put in its place: a script's text inside a script element, a stylesheet's
 * inside a style element, each marked with the file it came from, and a file named by another attribute as a data:
 * URL, with the name it came from beside it. A skill stylesheet's relative url()s to files of its skill become data:
 * URLs; one naming no file of the skill stays as written. `read` gives a file's bytes, or null when the user has no
 * such file. Throws naming every file it could not find, and a script or stylesheet that is not text.
 */
export async function inlineSkillFiles(html: string, read: (ref: SkillFileRef) => Promise<Uint8Array | null>): Promise<InlinedPage> {
  const tags = checkedRefTags(html);
  if (!tags.length) return { html, pageLine: (line) => line };
  // Each file's bytes, by skill/path, read once.
  const bytes = new Map<string, Uint8Array | null>();
  const readAll = async (names: readonly string[]) => {
    const refs = uniqueRefs(names.filter((name) => !bytes.has(name)));
    const read_ = await Promise.all(refs.map(read));
    refs.forEach((ref, i) => bytes.set(`${ref.skill}/${ref.path}`, read_[i]));
  };
  await readAll(tags.map((tag) => tag.ref));
  const missing = [...bytes].filter(([, file]) => !file).map(([name]) => `skill:${name}`);
  if (missing.length) throw new Error(`No such skill file: ${missing.sort().join(", ")}.`);

  const texts = new Map<string, string>();
  const notText: string[] = [];
  for (const tag of tags) {
    if (tag.kind === "attribute" || texts.has(tag.ref)) continue;
    try {
      texts.set(tag.ref, utf8.decode(bytes.get(tag.ref)!));
    } catch {
      notText.push(`skill:${tag.ref}`);
    }
  }
  if (notText.length) throw new Error(`Not a text file, so not a script or stylesheet: ${notText.join(", ")}. Name an image or font as an <img> src, or from the skill's own stylesheet.`);

  // A data: URL per file, made once however often the page and its stylesheets name it.
  const urls = new Map<string, string>();
  const dataUrl = (name: string) => {
    let url = urls.get(name);
    if (url === undefined) urls.set(name, (url = `data:${contentType(name)};base64,${toBase64(bytes.get(name)!)}`));
    return url;
  };
  // A stylesheet's fonts and images: read once all stylesheets are known, then put in as data: URLs.
  const styles = tags.filter((tag) => tag.kind === "style").map((tag) => tag.ref);
  await readAll(styles.flatMap((style) => [...texts.get(style)!.matchAll(CSS_URL)].flatMap((match) => cssFile(style, match[2]) ?? [])));
  const withAssets = (style: string, css: string) =>
    css.replace(CSS_URL, (whole: string, _quote: string, url: string) => {
      const name = cssFile(style, url);
      return name && bytes.get(name) ? `url("${dataUrl(name)}")` : whole;
    });

  const marked = (ref: string) => `data-skill-file="${escapeAttribute(ref)}"`;
  // Each inlined element: the line of its tag, the lines it spans in the result, and how many lines all of them up to
  // and including it added.
  const spans: { line: number; start: number; end: number; added: number }[] = [];
  let out = "";
  let at = 0;
  let line = 1;
  let added = 0;
  for (const tag of tags) {
    const before = html.slice(at, tag.index);
    line += newlines(before);
    at = tag.index + tag.tag.length;
    if (tag.kind === "attribute") {
      // The space before the attribute stays; the name it came from goes beside the data: URL for collapseSkillFiles.
      out += `${before}${tag.tag[0]}${tag.attribute}="${dataUrl(tag.ref)}" data-skill-${tag.attribute}="${escapeAttribute(tag.ref)}"`;
      continue;
    }
    const text = escapeInline(tag.kind === "style" ? withAssets(tag.ref, texts.get(tag.ref)!) : texts.get(tag.ref)!);
    const type = tag.kind === "script" ? typeOf(tag.attributes) : undefined;
    const element = tag.kind === "script" ? `<script ${marked(tag.ref)}${type ? ` type="${type}"` : ""}>${text}</script>` : `<style ${marked(tag.ref)}>${text}</style>`;
    out += before + element;
    const start = line + added;
    added += newlines(element) - newlines(tag.tag);
    spans.push({ line, start, end: start + newlines(element), added });
    line += newlines(tag.tag);
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
const INLINED_ATTRIBUTE = /([a-z][a-z0-9-]*)="data:[^"]*" data-skill-\1="([^"]+)"/g;

/** The skill files inlineSkillFiles put in a published page, each once (not the ones a stylesheet brought). */
export function inlinedSkillFiles(html: string): SkillFileRef[] {
  const names: string[] = [];
  for (const match of html.matchAll(INLINED_TAG)) names.push(unquote(match[1] ?? match[3]));
  for (const match of html.matchAll(INLINED_ATTRIBUTE)) names.push(unquote(match[2]));
  return uniqueRefs(names);
}

/**
 * A published page with the skill files inlineSkillFiles put in it turned back into references: what the agent reads
 * and edits. A file `collapse` says no to stays inlined (one the skill no longer has, say). A page with none comes back
 * as it is. Inlined text never holds "</script" or "</style" (escapeInline), so the first closing tag is the element's own.
 */
export function collapseSkillFiles(html: string, collapse: (ref: SkillFileRef) => boolean = () => true): string {
  const keep = (named: string) => {
    const ref = parseSkillRef(named);
    return !ref || !collapse(ref);
  };
  return html
    .replace(INLINED_TAG, (element: string, script?: string, type?: string, style?: string) => {
      const named = unquote(script ?? style!);
      if (keep(named)) return element;
      return script !== undefined ? `<script${type ? ` type="${type}"` : ""} src="skill:${named}"></script>` : `<link rel="stylesheet" href="skill:${named}">`;
    })
    .replace(INLINED_ATTRIBUTE, (whole: string, attribute: string, name: string) => (keep(unquote(name)) ? whole : `${attribute}="skill:${unquote(name)}"`));
}

/** What `activate_skill` adds about a skill's files: how to read them, how a page uses them, how its scripts run. Empty for none. */
export function skillFilesNote(name: string, files: readonly SkillFileInfo[], sandbox: boolean): string {
  if (!files.length) return "";
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const run = sandbox
    ? `Its scripts run in the sandbox: pass skills: ["${name}"] to run_python or run_bash, and the skill's folder (SKILL.md and every file) is at ./skills/${name}/, ` +
      `the skill's base directory, so a path the instructions give relative to the skill is ./skills/${name}/<path>. The sandbox has no internet.`
    : "Its scripts cannot run in this chat (no sandbox).";
  return (
    `\n\nThis skill comes with ${files.length} files (${formatBytes(total)}), listed in <skill_resources>. Read one with read_skill_resource when ` +
    `the instructions call for it. A page uses a file of the skill by reference, never by copying it: ` +
    `<script src="skill:${name}/<path>"></script>, <link rel="stylesheet" href="skill:${name}/<path>">, or an image, font or other file as another attribute's whole value: <img src="skill:${name}/<path>">. ` +
    `Checking and publishing the page put the file in its place, with the fonts and images the skill's stylesheets name. Where the instructions say to copy, bundle, inline or upload the skill's files ` +
    `next to the page, a reference does that here. ${run}`
  );
}
