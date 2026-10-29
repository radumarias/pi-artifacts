import { UPLOADS } from "../../shared/uploads.ts";
import { formatBytes, listSome } from "../../shared/util.ts";
import type { FileEntry } from "../storage/user-files.ts";

/**
 * What the user calls a file, matched to the files they have. The user says
 * "sales.csv" or "q3/sales.csv"; the file is uploads/q3/sales.csv. A path
 * names itself; otherwise a name or the end of a path names the one file it
 * ends, and a folder names every file under it. Throws when nothing, or more
 * than one thing, matches.
 */
function match(entries: readonly FileEntry[], ref: string): { file: string } | { folder: string[] } {
  const paths = entries.map((e) => e.path);
  for (const wanted of variants(ref)) {
    // "data/" asks for the folder even when a file is also called "data".
    const file = ref.trim().endsWith("/") ? undefined : matchFile(paths, wanted);
    if (file) return { file };
    const folder = matchFolder(paths, wanted);
    if (folder.length) return { folder };
  }
  throw notFound(paths, ref);
}

/** The one file `ref` names: for tools that read a single file. */
export function resolveFile(entries: readonly FileEntry[], ref: string): string {
  const found = match(entries, ref);
  if ("folder" in found) throw new FileRefError(`"${ref}" is a folder; name one of its files, or list it with files_list.`);
  return found.file;
}

/** The file `ref` names, or every file in the folder it names. */
export function resolveRef(entries: readonly FileEntry[], ref: string): string[] {
  const found = match(entries, ref);
  return "folder" in found ? found.folder : [found.file];
}

/**
 * The path as the model may write it ("/uploads/x.csv", "x.csv ", "data/"), and
 * then, for a path it saw in a sandbox run ("./files/q3/x.csv"), the same path
 * without the sandbox's files/.
 */
function variants(ref: string): string[] {
  const path = ref.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  return path.startsWith("files/") ? [path, path.slice("files/".length)] : [path];
}

function matchFile(paths: readonly string[], wanted: string): string | undefined {
  if (!wanted) return undefined;
  if (paths.includes(wanted)) return wanted;
  const lower = wanted.toLowerCase();
  const exact = paths.filter((p) => p.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const ending = paths.filter((p) => p.toLowerCase().endsWith(`/${lower}`));
  if (ending.length === 1) return ending[0];
  if (ending.length > 1) {
    throw new FileRefError(`"${wanted}" could be any of ${list(ending)}. Pass the full path, or ask the user which one.`);
  }
  return undefined;
}

/** Every file under the one folder `wanted` names: the folder's path, or the end of it. */
function matchFolder(paths: readonly string[], wanted: string): string[] {
  const lower = wanted.toLowerCase();
  if (!lower) return [];
  const folders = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/").slice(0, -1);
    for (let end = 1; end <= segments.length; end++) {
      const folder = segments.slice(0, end).join("/");
      const f = folder.toLowerCase();
      if (f === lower || f.endsWith(`/${lower}`)) folders.add(folder);
    }
  }
  // A folder's full path names it, as a file's does, even when other folders end the same way ("out" and "uploads/out").
  const exact = folders.has(wanted) ? [wanted] : [...folders].filter((folder) => folder.toLowerCase() === lower);
  if (exact.length === 1) return paths.filter((p) => p.startsWith(`${exact[0]}/`));
  if (folders.size > 1) throw new FileRefError(`"${wanted}" could be any of the folders ${list([...folders])}. Pass the full path.`);
  const [folder] = folders;
  return folder ? paths.filter((p) => p.startsWith(`${folder}/`)) : [];
}

function notFound(paths: readonly string[], ref: string): FileRefError {
  // Near misses: files whose name shares the wanted name's stem ("sales" for "sales.xlsx").
  const stem = variants(ref).pop()!.split("/").pop()!.toLowerCase().replace(/\.[^.]*$/, "");
  const near = stem ? paths.filter((p) => p.split("/").pop()!.toLowerCase().includes(stem)).slice(0, 5) : [];
  return new FileRefError(`No file or folder "${ref}" in the user's files.${near.length ? ` Similar: ${list(near)}.` : " files_list shows them all."}`);
}

function list(paths: readonly string[]): string {
  return listSome(paths.map((p) => `"${p}"`), 8);
}

export class FileRefError extends Error {}

/** Where a user file lands in a sandbox run, under ./files/: its path without the leading uploads/. */
export function sandboxPath(path: string): string {
  return path.startsWith(`${UPLOADS}/`) ? path.slice(UPLOADS.length + 1) : path;
}

const INDEX_MAX_FILES = 150;
const INDEX_MAX_CHARS = 6_000;

/**
 * The prompt's list of the user's files, newest first, so the agent can match
 * what the user calls a file to its path without a tool call. A long list is
 * cut; then it names the folders, with how many files each holds.
 */
export function filesIndex(entries: readonly FileEntry[]): string {
  const intro =
    "The user's files (uploads, and files your scripts saved). When the user names a file or folder, match it here and use its path. " +
    "files_read, run_python and run_bash also take a file's name or the end of its path when only one file matches, and a folder for all the files in it.";
  if (entries.length === 0) return `${intro}\nThe user has no files yet; they upload them from the sidebar, or by dropping them on the app.`;
  const newest = [...entries].sort((a, b) => +b.uploaded - +a.uploaded);
  const lines: string[] = [];
  let chars = 0;
  for (const entry of newest) {
    const line = `${entry.path}\t${formatBytes(entry.size)}`;
    if (lines.length === INDEX_MAX_FILES || chars + line.length > INDEX_MAX_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const rest = entries.length - lines.length;
  if (rest === 0) return `${intro}\n${lines.join("\n")}`;
  const counts = new Map<string, number>();
  for (const { path } of entries) {
    const folder = path.split("/").slice(0, -1).slice(0, 2).join("/") || "(top level)";
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const folders = [...counts].map(([folder, n]) => `${folder} (${n})`).join(", ");
  return `${intro}\n${lines.join("\n")}\n… and ${rest} more (files_list shows them, by folder). All files by folder: ${folders}.`;
}

/**
 * At most this many files, and this many bytes, go into one sandbox run. The
 * bytes travel to the Sandbox in one RPC call, which takes at most 32 MiB.
 */
export const MAX_SANDBOX_FILES = 200;
export const MAX_SANDBOX_BYTES = 25 * 1024 * 1024;

/**
 * Where each file goes in a sandbox run: ./files/<sandbox path> for each
 * stored path, which must not repeat. Throws when two files would land on one
 * path, or a file where another needs a folder.
 */
export function sandboxLayout(paths: readonly string[]): Map<string, string> {
  if (paths.length > MAX_SANDBOX_FILES) throw new FileRefError(`That is ${paths.length} files; one run takes at most ${MAX_SANDBOX_FILES}. Pass fewer, or a smaller folder.`);
  const layout = new Map<string, string>();
  for (const path of paths) {
    const name = sandboxPath(path);
    const other = layout.get(name);
    if (other !== undefined) throw new FileRefError(`"${other}" and "${path}" would both be ./files/${name}; pass them in separate runs.`);
    layout.set(name, path);
  }
  for (const name of layout.keys()) {
    const segments = name.split("/");
    for (let end = 1; end < segments.length; end++) {
      const folder = segments.slice(0, end).join("/");
      if (layout.has(folder)) throw new FileRefError(`"${layout.get(folder)}" is a file where "${layout.get(name)}" needs a folder; pass them in separate runs.`);
    }
  }
  return layout;
}
