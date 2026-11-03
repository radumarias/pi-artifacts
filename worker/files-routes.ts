import { baseName } from "../shared/attachments.ts";
import { FILE_ROUTE, MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, MAX_UPLOAD_BYTES, MAX_ZIP_FILES, previewType, uploadTargets, ZIP_ROUTE, zipRefusal } from "../shared/uploads.ts";
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
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname.startsWith(FILE_ROUTE)) return serveFile(await userFiles(), urlPath(pathname.slice(FILE_ROUTE.length)));
  if (request.method === "GET" && pathname.startsWith(ZIP_ROUTE)) return serveZip(await userFiles(), urlPath(pathname.slice(ZIP_ROUTE.length)));
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

/** One user file: shown in the browser when it is an image (shared/uploads.ts previewType), saved otherwise. */
async function serveFile(files: UserFiles, path: string): Promise<Response> {
  const object = await files.get(path);
  if (!object) return json({ error: "No such file" }, 404);
  const inline = previewType(path);
  return new Response(object.body, {
    headers: {
      ...SERVED_HEADERS,
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

function tooBig(): string {
  return `One upload holds at most ${formatBytes(MAX_UPLOAD_BYTES)}; send the files in several.`;
}
