import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, MAX_LISTED, MAX_UPLOAD_BYTES, MAX_ZIP_BYTES, previewType, uploadTargets } from "../shared/uploads.ts";
import { formatBytes } from "../shared/util.ts";
import { json } from "./http.ts";
import { normalisePath, PathError } from "./storage/paths.ts";
import type { UserFiles } from "./storage/user-files.ts";
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
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method === "GET" && pathname.startsWith(RAW)) return serveFile(await userFiles(), urlPath(pathname.slice(RAW.length)), url.searchParams.has("download"));
  if (request.method === "GET" && pathname.startsWith(ZIP)) return serveZip(await userFiles(), urlPath(pathname.slice(ZIP.length)));
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

const RAW = "/api/files/raw/";
const ZIP = "/api/files/zip/";

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

/** A path from a URL, its segments decoded; UserFiles checks what it may be. */
function urlPath(encoded: string): string {
  try {
    return encoded.split("/").map(decodeURIComponent).join("/");
  } catch {
    throw new PathError("Invalid path in the URL.");
  }
}

/** One user file: shown in the browser when it is an image (shared/uploads.ts previewType), saved otherwise or when `download` is asked. */
async function serveFile(files: UserFiles, path: string, download: boolean): Promise<Response> {
  const object = await files.get(path);
  if (!object) return json({ error: "No such file" }, 404);
  const name = baseName(path);
  const inline = download ? undefined : previewType(path);
  return new Response(object.body, {
    headers: {
      ...SERVED_HEADERS,
      "content-type": inline ?? "application/octet-stream",
      "content-length": String(object.size),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
    },
  });
}

/**
 * A user folder as a zip named after it, with the folder itself at the zip's
 * root ("q3.zip" holds "q3/sales.csv", "q3/2024/…"), everything under it
 * included. Up to MAX_ZIP_BYTES and as many files as UserFiles lists.
 */
async function serveZip(files: UserFiles, path: string): Promise<Response> {
  // As UserFiles keys it, so the paths it lists start with it.
  const folder = normalisePath(path.replace(/\/+$/, ""));
  const entries = await files.list(folder);
  if (entries.length === 0) return json({ error: "No such folder" }, 404);
  if (entries.length >= MAX_LISTED) return json({ error: `${folder} holds over ${MAX_LISTED.toLocaleString("en")} files; download its folders one at a time.` }, 413);
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > MAX_ZIP_BYTES) return json({ error: `${folder} holds ${formatBytes(total)}, over the ${formatBytes(MAX_ZIP_BYTES)} a zip may hold; download its folders one at a time.` }, 413);
  const name = baseName(folder);
  const inside = folder.length + 1;
  const zip = zipStream(
    entries.map((entry) => ({
      name: `${name}/${entry.path.slice(inside)}`,
      modified: entry.uploaded,
      open: async () => {
        const object = await files.get(entry.path);
        return object && { size: object.size, body: object.body };
      },
    })),
  );
  return new Response(zip, {
    headers: { ...SERVED_HEADERS, "content-type": "application/zip", "content-disposition": `attachment; filename="${name}.zip"` },
  });
}

/** The last segment of a path, as a file name for content-disposition. User file paths have no quotes or controls in them (worker/storage/paths.ts); anything else becomes "_". */
function baseName(path: string): string {
  return (path.split("/").pop() || "download").replace(/[^A-Za-z0-9 ._-]/g, "_");
}

function tooBig(): string {
  return `One upload holds at most ${formatBytes(MAX_UPLOAD_BYTES)}; send the files in several.`;
}
