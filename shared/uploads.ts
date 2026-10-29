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
 * rather than lose a file. A name with nothing left of it is "upload".
 */
export function uploadTargets(names: readonly string[]): string[] {
  const taken = new Set<string>();
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
