import { extension } from "./attachments.ts";
import { formatBytes } from "./util.ts";
/** What one file may weigh. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** What one upload request may hold. The Worker refuses more; the app splits a bigger pick into several requests. */
export const MAX_FILES_PER_UPLOAD = 50;
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

/** Where uploads go in the user's files. */
export const UPLOADS = "uploads";

/** What a user file path may be: at most this long, in these characters and "/" (worker/storage/paths.ts checks both). */
export const MAX_PATH = 200;
const NAME_CHARS = "A-Za-z0-9 ._\\-";
export const PATH_CHARS = new RegExp(`^[${NAME_CHARS}/]+$`);
/** What an uploaded name's segments lose: any character a path may not have. */
const NOT_NAME_CHAR = new RegExp(`[^${NAME_CHARS}]`, "g");
const MAX_SEGMENT = 120;

/** UserFiles lists at most this many files; an upload picks no more at once. */
export const MAX_LISTED = 2_000;

/**
 * Where an uploaded file is kept: its name, or its path inside a picked or
 * dropped folder, under uploads/. Each segment keeps only the characters user
 * file paths allow. A path too long loses folders from the top, never its
 * file name. Null when nothing is left of it.
 */
export function uploadPath(relative: string): string | null {
  const segments = relative.split(/[/\\]/).map(cleanSegment).filter(Boolean);
  if (segments.length === 0) return null;
  while (segments.length > 1 && UPLOADS.length + 1 + segments.join("/").length > MAX_PATH) segments.shift();
  return `${UPLOADS}/${segments.join("/")}`;
}

function cleanSegment(segment: string): string {
  return segment
    .normalize("NFC")
    .replace(NOT_NAME_CHAR, "_")
    .replace(/^[.\s]+|\s+$/g, "")
    .slice(0, MAX_SEGMENT)
    .trimEnd();
}

/**
 * Where each of `names` is kept (see uploadPath), named over the whole list:
 * two names that clean up to one path ("a?.csv" and "a*.csv") get -2, -3…
 * rather than lose a file. A name with nothing left of it is "upload". With `existing`, none takes one of those either.
 */
export function uploadTargets(names: readonly string[], existing: Iterable<string> = []): string[] {
  const taken = new Set(existing);
  return names.map((name) => {
    const path = freePath(uploadPath(name) ?? `${UPLOADS}/upload`, taken);
    taken.add(path);
    return path;
  });
}

/** `path` without its leading uploads/, if it has one: "uploads/q3/sales.csv" is "q3/sales.csv". */
export function underUploads(path: string): string {
  return path.startsWith(`${UPLOADS}/`) ? path.slice(UPLOADS.length + 1) : path;
}

/** Inside a folder, files and folders whose names start with a dot (.git, .DS_Store) are left out of an upload. */
export function isHidden(relative: string): boolean {
  return relative.split(/[/\\]/).some((segment) => segment.startsWith("."));
}

/**
 * `path`, or the same path with -2, -3… before its extension, whichever `taken`
 * does not have yet. The name loses characters before the number rather than
 * grow past MAX_SEGMENT or the path past MAX_PATH, so uploadPath keeps it as it is.
 */
export function freePath(path: string, taken: ReadonlySet<string>): string {
  if (!taken.has(path)) return path;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const cut = dot > slash + 1 ? dot : path.length;
  // How far the name may still grow.
  const room = Math.min(MAX_SEGMENT - (path.length - slash - 1), MAX_PATH - path.length);
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const over = Math.max(0, suffix.length - room);
    const stemEnd = Math.max(slash + 1, cut - over);
    // A stem too short to give up enough ("a.<long extension>") leaves the rest to the end of the extension.
    const extEnd = path.length - Math.max(0, over - (cut - stemEnd));
    const candidate = `${path.slice(0, stemEnd)}${suffix}${path.slice(cut, extEnd)}`.trimEnd();
    if (!taken.has(candidate)) return candidate;
  }
}

/** Split files into requests the Worker accepts: at most MAX_FILES_PER_UPLOAD files and MAX_UPLOAD_BYTES each. */
export function uploadBatches<T>(files: readonly T[], size: (file: T) => number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const file of files) {
    const fileBytes = size(file);
    if (current.length && (current.length === MAX_FILES_PER_UPLOAD || bytes + fileBytes > MAX_UPLOAD_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += fileBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * The image types a user file opens as in the browser, by extension. Raster
 * formats and SVG, which the Worker serves with a sandboxing CSP so its scripts cannot run.
 */
const IMAGE_TYPES: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
  ["svg", "image/svg+xml"],
]);

/** The content type an image `path` opens as in the browser, or undefined when it is no image (and only downloads from a plain link). */
export function previewType(path: string): string | undefined {
  return IMAGE_TYPES.get(extension(path));
}

/** Sound and video the app plays, by extension, as the types browsers play. */
const MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/aac"],
  ["flac", "audio/flac"],
  ["mp4", "video/mp4"],
  ["m4v", "video/mp4"],
  ["webm", "video/webm"],
  ["ogv", "video/ogg"],
  ["mov", "video/quicktime"],
]);

/** Other types a file is served or embedded as (a data: URL), by extension: fonts, captions and the text of a web page's parts. */
const OTHER_TYPES: ReadonlyMap<string, string> = new Map([
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["ttf", "font/ttf"],
  ["otf", "font/otf"],
  ["eot", "application/vnd.ms-fontobject"],
  ["vtt", "text/vtt"],
  ["css", "text/css"],
  ["js", "text/javascript"],
  ["json", "application/json"],
  ["pdf", "application/pdf"],
  ["html", "text/html"],
  ["txt", "text/plain"],
]);

/** The content type `path` is by its extension: an image, sound, video, font…; application/octet-stream for one not known. */
export function contentType(path: string): string {
  const ext = extension(path);
  return IMAGE_TYPES.get(ext) ?? MEDIA_TYPES.get(ext) ?? OTHER_TYPES.get(ext) ?? "application/octet-stream";
}

/**
 * How the app previews a user file: an image as itself, sound and video in the browser's player, a web page in a sandboxed frame, a PDF in the browser's
 * viewer, Markdown rendered, a CSV or TSV as a table, and plain text and code as text (highlighted where the app
 * knows the language). A file of another kind is read as text when it is text.
 */
export type PreviewKind = "image" | "audio" | "video" | "html" | "pdf" | "markdown" | "table" | "text";

const TEXT_EXTENSIONS =
  "txt text log out err json jsonl ndjson geojson yaml yml toml ini cfg conf env properties xml rss plist " +
  "sql js mjs cjs jsx ts mts cts tsx py pyi ipynb r rb go rs java kt kts scala swift c h cc cpp cxx hpp hh cs fs php pl lua dart zig " +
  "ex exs erl hs ml clj sh bash zsh fish ps1 bat cmd css scss sass less vue svelte astro graphql gql proto tf hcl " +
  "mk cmake gradle diff patch tex bib rst adoc org htmlpart jsblock";
const KINDS: ReadonlyMap<string, PreviewKind> = new Map([
  ...[...IMAGE_TYPES.keys()].map((ext) => [ext, "image"] as const),
  ...[...MEDIA_TYPES].map(([ext, type]) => [ext, type.startsWith("audio/") ? "audio" : "video"] as const),
  ...TEXT_EXTENSIONS.split(" ").map((ext) => [ext, "text"] as const),
  ["html", "html"],
  ["htm", "html"],
  ["pdf", "pdf"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["mdx", "markdown"],
  ["csv", "table"],
  ["tsv", "table"],
]);

/** How the app previews `path`, by its extension; undefined for one it does not know, which may still be text. */
export function previewKind(path: string): PreviewKind | undefined {
  return KINDS.get(extension(path));
}

/** Whether `path` holds UTF-8 text, by its extension: text and code, Markdown, a table, a web page or an SVG. */
export function isTextFile(path: string): boolean {
  const kind = previewKind(path);
  return kind === "text" || kind === "markdown" || kind === "table" || kind === "html" || extension(path) === "svg";
}

/**
 * The content type `path` is served as for viewing (FILE_ROUTE with VIEW_PARAM): an image, sound or video as itself, a web page as
 * HTML (under a sandboxing policy, see worker/files-routes.ts), a PDF as a PDF, and a text file as plain text.
 * Undefined for a file of another kind, which downloads.
 */
export function viewType(path: string): string | undefined {
  const kind = previewKind(path);
  if (kind === "image") return previewType(path);
  if (kind === "audio" || kind === "video") return MEDIA_TYPES.get(extension(path));
  if (kind === "html") return "text/html; charset=utf-8";
  if (kind === "pdf") return "application/pdf";
  return kind ? "text/plain; charset=utf-8" : undefined;
}

/**
 * How a web page from the user's files runs: scripts only, in an opaque origin. Unlike an artifact's (ARTIFACT_SANDBOX)
 * it opens no popups: a file may come from anywhere (an upload, a page the agent built from a tool's output), and a
 * popup escapes the sandbox and the page's policy, so it could carry what the page shows to another site.
 */
export const FILE_PAGE_SANDBOX = "allow-scripts";

/** The query parameter that asks FILE_ROUTE to show a file in the browser (viewType) rather than download it. */
export const VIEW_PARAM = "view";

/** Where a user file is served from (`<prefix><path>`): an image opens in the browser, anything else downloads unless VIEW_PARAM asks to view it. */
export const FILE_ROUTE = "/api/files/raw/";
/**
 * Where a user folder downloads from (GET `<prefix><path>`), as a zip named after it with the folder itself at its
 * root; POSTed bare, a form of picked `file` and `folder` fields downloads as one zip (worker/files-routes.ts serveSelection).
 */
export const ZIP_ROUTE = "/api/files/zip/";

/** Where a chat's files (its owner's, attached in it or saved by its agent) are served to the people in it, by path. */
export function chatFileRoute(chatId: string): string {
  return `/api/chats/${chatId}/files/`;
}

/** What one zip may hold, of a folder or a pick: past either, the Worker refuses and the user downloads less at a time. */
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
export const MAX_ZIP_FILES = MAX_LISTED;

/** Why `count` files of `bytes` cannot be zipped together, or undefined when they can. */
export function zipRefusal(count: number, bytes: number): string | undefined {
  if (count > MAX_ZIP_FILES) return `Too many files to zip (over ${MAX_ZIP_FILES.toLocaleString("en")}); download fewer at a time.`;
  if (bytes > MAX_ZIP_BYTES) return `Too big to zip (${formatBytes(bytes)}, over ${formatBytes(MAX_ZIP_BYTES)}); download fewer at a time.`;
  return undefined;
}

/**
 * What a zip of picked `files` and `folders` is rooted at: the deepest folder holding them all, a picked folder
 * counting as its own (so one folder roots at itself, as its own download does), or "" when only the top level does.
 */
export function commonFolder(files: readonly string[], folders: readonly string[]): string {
  const parents = [...files.map((path) => path.split("/").slice(0, -1)), ...folders.map((path) => path.split("/"))];
  const first = parents[0] ?? [];
  let depth = 0;
  while (depth < first.length && parents.every((parent) => parent[depth] === first[depth])) depth++;
  return first.slice(0, depth).join("/");
}
