import { baseName } from "../shared/attachments.ts";
import {
  commonFolder,
  FILE_PAGE_SANDBOX,
  FILE_ROUTE,
  MAX_FILE_BYTES,
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BYTES,
  MAX_ZIP_BYTES,
  MAX_ZIP_FILES,
  previewKind,
  type PreviewKind,
  uploadTargets,
  VIEW_PARAM,
  viewType,
  ZIP_ROUTE,
  zipRefusal,
} from "../shared/uploads.ts";
import { formatBytes } from "../shared/util.ts";
import { PAGE_HEADERS, PAGE_POLICY } from "./artifacts/serve.ts";
import { json } from "./http.ts";
import { normalisePath, PathError } from "./storage/paths.ts";
import type { ByteRange, FileEntry, UserFiles } from "./storage/user-files.ts";
import { zipStream } from "./zip.ts";

/** Room for the multipart boundaries and headers around the files themselves. */
const FORM_OVERHEAD = 1024 * 1024;

/**
 * The user's files: list them, or upload several at once. An upload is a form
 * with a `file` field and a `path` field per file, in the same order. The path
 * is the file's name, or its path inside a picked or dropped folder, so the
 * folder's layout is kept under uploads/. `userFiles` are the signed-in user's.
 */
export async function filesRoute(request: Request, userFiles: () => Promise<UserFiles>): Promise<Response | undefined> {
  const { pathname, searchParams } = new URL(request.url);
  if (request.method === "GET" && pathname.startsWith(FILE_ROUTE)) {
    return serveFile(request, await userFiles(), urlPath(pathname.slice(FILE_ROUTE.length)), searchParams.has(VIEW_PARAM));
  }
  if (request.method === "GET" && pathname.startsWith(ZIP_ROUTE)) return serveZip(await userFiles(), urlPath(pathname.slice(ZIP_ROUTE.length)));
  if (request.method === "POST" && pathname === ZIP_ROUTE) return serveSelection(request, await userFiles());
  if (pathname !== "/api/files") return undefined;
  if (request.method === "GET") return json(await (await userFiles()).list());
  if (request.method !== "POST") return undefined;
  return storeUpload(request, userFiles);
}

/**
 * One of a chat owner's files, for someone in the chat, served as the owner's own are: `encoded` is its path from the
 * URL (after chatFileRoute), and `mayOpen` says whether this person may open it through the chat. A file they may not
 * open answers as a missing one does.
 */
export async function serveChatFile(request: Request, encoded: string, files: () => Promise<UserFiles>, mayOpen: (path: string) => Promise<boolean>): Promise<Response> {
  const path = urlPath(encoded);
  if (!(await mayOpen(path))) return json({ error: "No such file" }, 404);
  return serveFile(request, await files(), path, new URL(request.url).searchParams.has(VIEW_PARAM));
}

/**
 * Store an upload's files under uploads/ in `userFiles`, and answer with the
 * paths they got: the files route's POST, and a chat's attachments, which go
 * to the chat owner's files.
 */
export async function storeUpload(request: Request, userFiles: () => Promise<UserFiles>): Promise<Response> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_UPLOAD_BYTES + FORM_OVERHEAD) return json({ error: tooBig() }, 413);
  const form = await request.formData();
  const files = form.getAll("file");
  const paths = form.getAll("path");
  if (files.length === 0 || !files.every((file): file is File => file instanceof File)) return json({ error: "Expected one or more file fields" }, 400);
  if (files.length > MAX_FILES_PER_UPLOAD) return json({ error: `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.` }, 413);
  const large = files.find((file) => file.size > MAX_FILE_BYTES);
  if (large) return json({ error: `${large.name} is over ${formatBytes(MAX_FILE_BYTES)}; files are limited to that.` }, 413);
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) return json({ error: tooBig() }, 413);

  const targets = uploadTargets(
    files.map((file, i) => {
      const given = paths[i];
      return typeof given === "string" && given ? given : file.name;
    }),
  );
  const store = await userFiles();
  const stored = await Promise.all(files.map((file, i) => store.put(targets[i], file.stream(), file.type || undefined)));
  return json({ paths: stored });
}

/**
 * What every served file carries. Files are the user's own, but they come from
 * uploads and the sandbox, so none may run on the app's origin: no sniffing a
 * type, a sandboxing CSP (an SVG's scripts stay off), and no embedding by other sites.
 */
const SERVED_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "private, no-store",
};

/**
 * A path from a URL, its segments decoded and normalised as UserFiles keys it,
 * so a listing's paths start with it and its last segment is safe in a header.
 * Throws PathError (a 400) for anything a user file path may not be.
 */
function urlPath(encoded: string): string {
  let path: string;
  try {
    path = encoded.split("/").map(decodeURIComponent).join("/");
  } catch {
    throw new PathError("Invalid path in the URL.");
  }
  return normalisePath(path.replace(/\/+$/, ""));
}

/**
 * How a file of each kind the app previews is served for viewing, past SERVED_HEADERS. A web page runs as an artifact
 * does (worker/artifacts/serve.ts), but without popups (shared/uploads.ts FILE_PAGE_SANDBOX): in an opaque origin
 * whether framed by the preview or opened in a tab of its own, with scripts only inline or from the usual CDNs, and no
 * network of its own, so it can neither act as the user in the app nor send their data anywhere. A PDF opens in the browser's own viewer, and sound and video in its player,
 * which a sandbox (an opaque origin) would block; they run no script of the app's, and load nothing else.
 */
const MEDIA_HEADERS = { ...SERVED_HEADERS, "content-security-policy": "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'" };
const VIEW_HEADERS: Partial<Record<PreviewKind, Record<string, string>>> = {
  html: {
    ...SERVED_HEADERS,
    ...PAGE_HEADERS,
    "content-security-policy": `sandbox ${FILE_PAGE_SANDBOX}; ${PAGE_POLICY}`,
    "cache-control": SERVED_HEADERS["cache-control"],
  },
  pdf: { ...SERVED_HEADERS, "content-security-policy": "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'" },
  audio: MEDIA_HEADERS,
  video: MEDIA_HEADERS,
};

/**
 * The one byte range of a Range header ("bytes=0-", "bytes=100-199", "bytes=-500") as R2 reads it (it stops at the
 * file's end). Undefined without one, or for one this does not serve (several ranges): the whole file answers that.
 */
function byteRange(header: string | null): ByteRange | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !Number(match[2]))) return undefined;
  if (!match[1]) return { suffix: Number(match[2]) };
  const offset = Number(match[1]);
  if (!match[2]) return { offset };
  const last = Number(match[2]);
  return last >= offset ? { offset, length: last - offset + 1 } : undefined;
}

/** Where `range` starts in a file of `size` bytes. */
const rangeStart = (range: ByteRange, size: number) => ("suffix" in range ? Math.max(0, size - range.suffix) : range.offset);

/** A range that starts past the file's end. */
const unsatisfiable = (size: number) => new Response(null, { status: 416, headers: { ...SERVED_HEADERS, "content-range": `bytes */${size}` } });

/**
 * One user file: an image shows in the browser (shared/uploads.ts previewType), anything else downloads. With
 * `view` (the app's preview, or opening it in a tab) a file of a kind the app previews shows too, as viewType says.
 * A Range header gets that part (206): players seek in sound and video so, and Safari plays no video without it.
 */
async function serveFile(request: Request, files: UserFiles, path: string, view: boolean): Promise<Response> {
  const range = byteRange(request.headers.get("range"));
  let object: R2ObjectBody | null;
  try {
    object = await files.get(path, range);
  } catch (error) {
    // R2 refuses a range that starts past the end. Any other failure stays one: answered 416, the preview (api.fileStart)
    // would show the file as empty.
    if (!range) throw error;
    const whole = await files.get(path);
    if (!whole) return json({ error: "No such file" }, 404);
    void whole.body.cancel();
    if (rangeStart(range, whole.size) < whole.size) throw error;
    return unsatisfiable(whole.size);
  }
  if (!object) return json({ error: "No such file" }, 404);
  const kind = previewKind(path);
  const inline = view || kind === "image" ? viewType(path) : undefined;
  const headers = {
    ...((inline && kind && VIEW_HEADERS[kind]) || SERVED_HEADERS),
    "content-type": inline ?? "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${baseName(path)}"`,
    "accept-ranges": "bytes",
  };
  const size = object.size;
  if (!range) return new Response(object.body, { headers: { ...headers, "content-length": String(size) } });
  const start = rangeStart(range, size);
  if (start >= size) {
    void object.body.cancel();
    return unsatisfiable(size);
  }
  const end = Math.min(size, start + (("length" in range && range.length) || size)) - 1;
  return new Response(object.body, {
    status: 206,
    headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
  });
}

/**
 * A user folder as a zip named after it, with the folder itself at the zip's
 * root ("q3.zip" holds "q3/sales.csv", "q3/2024/…"), everything under it
 * included, within shared/uploads.ts zipRefusal's limits.
 */
async function serveZip(files: UserFiles, folder: string): Promise<Response> {
  // One more than a zip may hold, to tell a full folder from one over the limit.
  const entries = await files.list(folder, MAX_ZIP_FILES + 1);
  if (entries.length === 0) return json({ error: "No such folder" }, 404);
  const refusal = zipRefusal(
    entries.length,
    entries.reduce((sum, entry) => sum + entry.size, 0),
  );
  if (refusal) return json({ error: `${folder}: ${refusal}` }, 413);
  return zipResponse(
    files,
    folder,
    entries.map((entry) => entry.path),
  );
}

/** What a selection's form may weigh: its paths, at most MAX_ZIP_FILES of them. */
const MAX_SELECTION_FORM = 1024 * 1024;

/**
 * Picked files and folders as one zip: a form (posted by the sidebar into a
 * hidden frame, so the browser saves the answer) with a `file` field per file
 * and a `folder` field per folder. The zip is named after the folder holding
 * them all (shared/uploads.ts commonFolder), which is its root, as for one
 * folder ("q3.zip" with "q3/sales.csv" and "q3/2024/…"); with nothing in
 * common it is "files.zip" with the top folders at its root. It reads only, and only the signed-in user's files, so
 * another site posting the form gets nothing it can read.
 */
async function serveSelection(request: Request, files: UserFiles): Promise<Response> {
  if (Number(request.headers.get("content-length")) > MAX_SELECTION_FORM) return json({ error: "Too many files picked." }, 413);
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Expected a form of file and folder fields." }, 400);
  // A field that is not a string (an uploaded file) is no path: normalisePath refuses it as an empty one.
  const fields = (name: string) => form.getAll(name).map((value) => normalisePath(typeof value === "string" ? value : ""));
  const picked = fields("file");
  // A folder inside another picked folder is in it already: listing it again would count its files twice.
  const folders = [...new Set(fields("folder"))].filter((folder, _, all) => !all.some((other) => folder.startsWith(`${other}/`)));
  const count = picked.length + folders.length;
  if (count === 0) return json({ error: "Pick at least one file or folder." }, 400);
  const tooMany = zipRefusal(count, 0);
  if (tooMany) return json({ error: tooMany }, 413);
  // One budget for all the folders, one more than a zip may hold: past it the pick is refused, so listing further is waste.
  const inFolders: FileEntry[] = [];
  for (const folder of folders) {
    inFolders.push(...(await files.list(folder, MAX_ZIP_FILES + 1 - inFolders.length)));
    if (inFolders.length > MAX_ZIP_FILES) break;
  }
  // A file or folder inside a picked folder is in it once. Files picked one by one count towards the size as they are
  // read (zipStream's maxBytes): the sidebar checked them against its listing already.
  const paths = [...new Set([...inFolders.map((entry) => entry.path), ...picked])].sort();
  if (paths.length === 0) return json({ error: "No such files" }, 404);
  const refusal = zipRefusal(
    paths.length,
    inFolders.reduce((sum, entry) => sum + entry.size, 0),
  );
  if (refusal) return json({ error: refusal }, 413);
  return zipResponse(files, commonFolder(picked, folders), paths);
}

/**
 * `paths` as a zip named after `root` (the folder holding them all), with
 * that folder at its root; "files.zip" with the paths as they are when `root`
 * is empty. Each file is read when its turn comes; a missing one is left out.
 */
function zipResponse(files: UserFiles, root: string, paths: readonly string[]): Response {
  const name = root ? baseName(root) : "files";
  const zip = zipStream(
    paths.map((path) => ({
      name: root ? `${name}/${path.slice(root.length + 1)}` : path,
      open: async () => {
        const object = await files.get(path);
        return object && { size: object.size, modified: object.uploaded, body: object.body };
      },
    })),
    { maxBytes: MAX_ZIP_BYTES },
  );
  return new Response(zip, {
    headers: { ...SERVED_HEADERS, "content-type": "application/zip", "content-disposition": `attachment; filename="${name}.zip"` },
  });
}

function tooBig(): string {
  return `One upload holds at most ${formatBytes(MAX_UPLOAD_BYTES)}; send the files in several.`;
}
