import { baseName } from "../shared/attachments.ts";
import {
  commonFolder,
  FILE_ROUTE,
  MAX_FILE_BYTES,
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BYTES,
  MAX_ZIP_BYTES,
  MAX_ZIP_FILES,
  previewKind,
  previewType,
  uploadTargets,
  VIEW_PARAM,
  viewType,
  ZIP_ROUTE,
  zipRefusal,
} from "../shared/uploads.ts";
import { formatBytes } from "../shared/util.ts";
import { ARTIFACT_CSP } from "./artifacts/serve.ts";
import { json } from "./http.ts";
import { normalisePath, PathError } from "./storage/paths.ts";
import type { FileEntry, UserFiles } from "./storage/user-files.ts";
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
    return serveFile(await userFiles(), urlPath(pathname.slice(FILE_ROUTE.length)), searchParams.has(VIEW_PARAM));
  }
  if (request.method === "GET" && pathname.startsWith(ZIP_ROUTE)) return serveZip(await userFiles(), urlPath(pathname.slice(ZIP_ROUTE.length)));
  if (request.method === "POST" && pathname === ZIP_ROUTE) return serveSelection(request, await userFiles());
  if (pathname !== "/api/files") return undefined;
  if (request.method === "GET") return json(await (await userFiles()).list());
  if (request.method !== "POST") return undefined;
  return storeUpload(request, userFiles);
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
 * A web page viewed from the user's files runs as an artifact does (worker/artifacts/serve.ts): in an opaque origin
 * whether framed by the preview or opened in a tab of its own, with scripts only inline or from the usual CDNs, and
 * no network of its own, so it can neither act as the user in the app nor send their data anywhere.
 */
const PAGE_HEADERS = {
  ...SERVED_HEADERS,
  "content-security-policy": ARTIFACT_CSP,
  "referrer-policy": "no-referrer",
};

/**
 * A PDF opens in the browser's own viewer, which a sandbox (header or frame) would block. It runs no script of
 * the app's: the viewer is the browser's, and the policy still keeps the document from loading anything.
 */
const PDF_HEADERS = { ...SERVED_HEADERS, "content-security-policy": "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'" };

/**
 * One user file: an image shows in the browser (shared/uploads.ts previewType), anything else downloads. With
 * `view` (the app's preview, or opening it in a tab) a file of a kind the app previews shows too, as viewType says.
 */
async function serveFile(files: UserFiles, path: string, view: boolean): Promise<Response> {
  const object = await files.get(path);
  if (!object) return json({ error: "No such file" }, 404);
  const inline = view ? viewType(path) : previewType(path);
  const kind = inline && previewKind(path);
  return new Response(object.body, {
    headers: {
      ...(kind === "html" ? PAGE_HEADERS : kind === "pdf" ? PDF_HEADERS : SERVED_HEADERS),
      "content-type": inline ?? "application/octet-stream",
      "content-length": String(object.size),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${baseName(path)}"`,
    },
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
