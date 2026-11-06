// Files that come with a skill: a skill imported as a package (a zip with its SKILL.md) keeps the files beside it, the
// agent reads them on demand, and a page uses one by reference: <script src="skill:<name>/<path>"></script>,
// <link rel="stylesheet" href="skill:<name>/<path>">, or an image or media file as <img src="skill:<name>/<path>">.
// The page keeps the reference while it is a draft; checking and publishing it put the file in its place
// (inlineSkillFiles): a script's or stylesheet's text, an image as a data: URL, and the fonts and images a skill
// stylesheet names by relative url() as data: URLs too. So a published version holds everything it runs and never
// changes when the skill does. Reading a published page back turns those parts into references again
// (collapseSkillFiles), so the agent edits a short page, not the library inlined into it.

import { SKILL_NAME_PATTERN } from "./skills.ts";
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
// is a reference, any other is not). One pattern for both, so that inlining is one pass over the page as written.
const REF_TAG =
  /<script\b([^>]*?)\bsrc\s*=\s*(["'])skill:([^"']+)\2([^>]*)>\s*<\/script\s*>|<link\b([^>]*?)\bhref\s*=\s*(["'])skill:([^"']+)\6([^>]*)>/gi;
// A quoted value naming a skill file (skill:<name>/…): each must be in one of the tags above or MEDIA_REF's.
const ANY_REF = /["']skill:[a-z0-9-]+\//gi;
// An image or media element naming a skill file as its src (or a video's poster): the file goes in as a data: URL.
const MEDIA_TAG = /<(?:img|source|video|audio|track|image)\b[^>]*>/gi;
const MEDIA_REF = /(\s)(src|poster)\s*=\s*(["'])skill:([^"']+)\3/gi;
const isStylesheet = (attributes: string) => /\brel\s*=\s*["']?stylesheet/i.test(attributes);

/**
 * One reference in a page: where it is, the text it takes up, what it names, and what it becomes: a script, a style,
 * or (for an image or media element) the attribute naming it, with a data: URL in place of the reference.
 */
interface RefTag {
  index: number;
  tag: string;
  ref: string;
  kind: "script" | "style" | "media";
  attributes: string;
}

/** The references of a page, in order. */
function refTags(html: string): RefTag[] {
  const tags: RefTag[] = [];
  for (const match of html.matchAll(REF_TAG)) {
    const script = match[3] !== undefined;
    const attributes = script ? match[1] + match[4] : match[5] + match[8];
    if (!script && !isStylesheet(attributes)) continue;
    tags.push({ index: match.index, tag: match[0], ref: script ? match[3] : match[7], kind: script ? "script" : "style", attributes });
  }
  for (const element of html.matchAll(MEDIA_TAG)) {
    for (const match of element[0].matchAll(MEDIA_REF)) {
      tags.push({ index: element.index + match.index, tag: match[0], ref: match[4], kind: "media", attributes: match[2].toLowerCase() });
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
    throw new Error(
      `A skill file goes only in <script src="skill:…"></script>, <link rel="stylesheet" href="skill:…">, or the src of an <img>, <source>, <video>, <audio> or <track> ` +
        "(a video's poster too); nowhere else in a page. A skill stylesheet's own url()s to the skill's fonts and images come with it.",
    );
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

/** Reads a skill file's bytes, or null when the user has no such file. */
export type SkillFileBytes = (ref: SkillFileRef) => Promise<Uint8Array | null>;

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  vtt: "text/vtt",
  json: "application/json",
  css: "text/css",
  js: "text/javascript",
};

/** The media type a file's name says it is. */
export function mediaType(path: string): string {
  return MEDIA_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
}

const dataUrl = (path: string, bytes: Uint8Array) => `data:${mediaType(path)};base64,${toBase64(bytes)}`;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

// A url() in a stylesheet, its value quoted or not.
const CSS_URL = /url\(\s*(["']?)([^"')\s]+)\1\s*\)/gi;

/** A path relative to `from` (a file's path in the skill), resolved; null when it is not relative or leaves the skill. */
function relativeTo(from: string, url: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(url)) return null;
  const segments = from.split("/").slice(0, -1);
  for (const segment of url.replace(/[?#].*$/, "").split("/")) {
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
    } else if (segment && segment !== ".") segments.push(segment);
  }
  return segments.length ? segments.join("/") : null;
}

/** The skill files a stylesheet of `ref`'s skill names by relative url(): its fonts and images. */
function cssFiles(ref: SkillFileRef, css: string): SkillFileRef[] {
  const found: SkillFileRef[] = [];
  for (const match of css.matchAll(CSS_URL)) {
    const path = relativeTo(ref.path, match[2]);
    if (path) found.push({ skill: ref.skill, path });
  }
  return found;
}

/**
 * `html` with every skill file it names put in its place: a script's text inside a script element, a stylesheet's
 * inside a style element, each marked with the file it came from, and an image or media file as a data: URL beside
 * the name it came from. A skill stylesheet's relative url()s to files of its skill become data: URLs; one naming no
 * file of the skill stays as written. `read` gives a file's bytes. Throws naming every file it could not find, and a
 * script or stylesheet that is not text.
 */
export async function inlineSkillFiles(html: string, read: SkillFileBytes): Promise<InlinedPage> {
  const refs = skillRefs(html);
  if (!refs.length) return { html, pageLine: (line) => line };
  const key = (ref: SkillFileRef) => `${ref.skill}/${ref.path}`;
  const bytes = new Map<string, Uint8Array | null>();
  const readAll = (list: readonly SkillFileRef[]) =>
    Promise.all(
      list
        .filter((ref) => !bytes.has(key(ref)))
        .map(async (ref) => {
          bytes.set(key(ref), null);
          bytes.set(key(ref), await read(ref));
        }),
    );
  await readAll(refs);
  const missing = refs.filter((ref) => !bytes.get(key(ref))).map((ref) => `skill:${key(ref)}`);
  if (missing.length) throw new Error(`No such skill file: ${missing.sort().join(", ")}.`);

  const tags = refTags(html);
  const texts = new Map<string, string>();
  const notText: string[] = [];
  for (const { ref, kind } of tags) {
    if (kind === "media" || texts.has(ref)) continue;
    try {
      texts.set(ref, utf8.decode(bytes.get(ref)!));
    } catch {
      notText.push(`skill:${ref}`);
    }
  }
  if (notText.length) throw new Error(`Not a text file, so not a script or stylesheet: ${notText.join(", ")}. Name an image or font as an <img> src, or from the skill's own stylesheet.`);

  // A stylesheet's fonts and images: read once all stylesheets are known, then put in as data: URLs.
  const styles = tags.filter((tag) => tag.kind === "style").map((tag) => parseSkillRef(tag.ref)!);
  await readAll(styles.flatMap((ref) => cssFiles(ref, texts.get(key(ref))!)));
  const withAssets = (ref: SkillFileRef, css: string) =>
    css.replace(CSS_URL, (whole: string, _quote: string, url: string) => {
      const path = relativeTo(ref.path, url);
      const file = path ? bytes.get(`${ref.skill}/${path}`) : null;
      return path && file ? `url("${dataUrl(path, file)}")` : whole;
    });

  const marked = (ref: string) => `data-skill-file="${ref.replace(/"/g, "&quot;")}"`;
  // Each inlined element: the line of its tag, the lines it spans in the result, and how many lines all of them up to
  // and including it added.
  const spans: { line: number; start: number; end: number; added: number }[] = [];
  let out = "";
  let at = 0;
  let line = 1;
  let added = 0;
  for (const { index, tag, ref, kind, attributes } of tags) {
    const before = html.slice(at, index);
    line += newlines(before);
    at = index + tag.length;
    if (kind === "media") {
      // The space before the attribute stays; the name it came from goes beside the data: URL for collapseSkillFiles.
      out += `${before}${tag[0]}${attributes}="${dataUrl(ref, bytes.get(ref)!)}" data-skill-${attributes}="${ref.replace(/"/g, "&quot;")}"`;
      continue;
    }
    const source = kind === "style" ? withAssets(parseSkillRef(ref)!, texts.get(ref)!) : texts.get(ref)!;
    const text = escapeInline(source);
    const type = kind === "script" ? typeOf(attributes) : undefined;
    const element = kind === "script" ? `<script ${marked(ref)}${type ? ` type="${type}"` : ""}>${text}</script>` : `<style ${marked(ref)}>${text}</style>`;
    out += before + element;
    const start = line + added;
    added += newlines(element) - newlines(tag);
    spans.push({ line, start, end: start + newlines(element), added });
    line += newlines(tag);
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
const INLINED_MEDIA = /(src|poster)="data:[^"]*" data-skill-\1="([^"]+)"/g;
const unquote = (ref: string) => ref.replace(/&quot;/g, '"');

/** The skill files inlineSkillFiles put in a published page, each once (not the ones a stylesheet brought). */
export function inlinedSkillFiles(html: string): SkillFileRef[] {
  const found = new Map<string, SkillFileRef>();
  const named = [...[...html.matchAll(INLINED_TAG)].map((match) => match[1] ?? match[3]), ...[...html.matchAll(INLINED_MEDIA)].map((match) => match[2])];
  for (const ref of named.map((name) => parseSkillRef(unquote(name)))) if (ref) found.set(`${ref.skill}/${ref.path}`, ref);
  return [...found.values()];
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
    .replace(INLINED_MEDIA, (whole: string, attribute: string, name: string) => (keep(unquote(name)) ? whole : `${attribute}="skill:${unquote(name)}"`));
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
    `<script src="skill:${name}/<path>"></script>, <link rel="stylesheet" href="skill:${name}/<path>">, or an image or media file as <img src="skill:${name}/<path>">. ` +
    `Checking and publishing the page put the file in its place, with the fonts and images the skill's stylesheets name. Where the instructions say to copy, bundle, inline or upload the skill's files ` +
    `next to the page, a reference does that here. ${run}`
  );
}
