import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, MAX_UPLOAD_BYTES, uploadTargets } from "../shared/uploads.ts";
import { formatBytes } from "../shared/util.ts";
import { json } from "./http.ts";
import type { UserFiles } from "./storage/user-files.ts";

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
  if (pathname !== "/api/files") return undefined;
  if (request.method === "GET") return json(await (await userFiles()).list());
  if (request.method !== "POST") return undefined;

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

function tooBig(): string {
  return `One upload holds at most ${formatBytes(MAX_UPLOAD_BYTES)}; send the files in several.`;
}
