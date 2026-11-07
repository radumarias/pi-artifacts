import { underUploads } from "../../shared/uploads.ts";
import { formatBytes, listSome } from "../../shared/util.ts";
import { SANDBOX_OUT } from "../chat-traces.ts";
import { normalisePath, PathError } from "../storage/paths.ts";
import type { FileEntry } from "../storage/user-files.ts";

/**
 * What the user calls a file, matched to the files they have. The user says
 * "sales.csv" or "q3/sales.csv"; the file is uploads/q3/sales.csv. A path
 * names itself; otherwise a name or the end of a path names the one file it
 * ends, and a folder names every file under it. Throws when nothing, or more
 * than one thing, matches. A name that this chat's folder (`ownFolder`, see
 * chatOutFolder) and only other folders under out/ hold names this chat's file.
 */
function match(entries: readonly FileEntry[], ref: string, ownFolder?: string): { file: string } | { folder: string[] } {
  const paths = entries.map((e) => e.path);
  for (const wanted of variants(ref)) {
    // "data/" asks for the folder even when a file is also called "data".
    const file = ref.trim().endsWith("/") ? undefined : matchFile(paths, wanted, ownFolder);
    if (file) return { file };
    const folder = matchFolder(paths, wanted);
    if (folder.length) return { folder };
  }
  throw notFound(paths, ref);
}

/** The one file `ref` names: for tools that read a single file. */
export function resolveFile(entries: readonly FileEntry[], ref: string, ownFolder?: string): string {
  const found = match(entries, ref, ownFolder);
  if ("folder" in found) throw new FileRefError(`"${ref}" is a folder; name one of its files, or list it with files_list.`);
  return found.file;
}

/** The file `ref` names, or every file in the folder it names. */
export function resolveRef(entries: readonly FileEntry[], ref: string, ownFolder?: string): string[] {
  const found = match(entries, ref, ownFolder);
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

function matchFile(paths: readonly string[], wanted: string, ownFolder?: string): string | undefined {
  if (!wanted) return undefined;
  if (paths.includes(wanted)) return wanted;
  const lower = wanted.toLowerCase();
  const exact = paths.filter((p) => p.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  // "Report.csv" and "report.csv" both match "REPORT.csv": say so, rather than that nothing does.
  if (exact.length > 1) throw new FileRefError(`"${wanted}" could be any of ${list(exact)}. Pass the exact path.`);
  const ending = paths.filter((p) => p.toLowerCase().endsWith(`/${lower}`));
  if (ending.length === 1) return ending[0];
  // Each chat saves under its own folder: "chart.png" in a chat that saved one is its own, not another chat's (or an older one at out/).
  const own = ownFolder ? ending.filter((p) => p.startsWith(ownFolder)) : [];
  if (own.length === 1 && ending.every((p) => p === own[0] || p.startsWith(SANDBOX_OUT))) return own[0];
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
  const folder = exact.length === 1 ? exact[0] : folders.size === 1 ? [...folders][0] : undefined;
  if (folder === undefined && folders.size > 1) throw new FileRefError(`"${wanted}" could be any of the folders ${list([...folders])}. Pass the full path.`);
  return folder === undefined ? [] : paths.filter((p) => p.startsWith(`${folder}/`));
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
export const sandboxPath = underUploads;

const INDEX_MAX_FILES = 150;
const INDEX_MAX_CHARS = 6_000;
const INDEX_MAX_FOLDERS = 40;

/**
 * The prompt's list of the user's files, newest first, so the agent can match
 * what the user calls a file to its path without a tool call. A long list is
 * cut; then it names the folders, with how many files each holds. It also names
 * this chat's folder (chatOutFolder): here rather than in the tool descriptions,
 * so the tools stay the same for all of a user's chats and share a prompt cache.
 */
export function filesIndex(entries: readonly FileEntry[], { sandbox = true, outFolder }: { sandbox?: boolean; outFolder: string }): string {
  const intro =
    "The user's files (uploads, and files your scripts saved). When the user names a file or folder, match it here and use its path. " +
    (sandbox
      ? "files_read, run_python and run_bash also take a file's name or the end of its path when only one file matches, and a folder for all the files in it. "
      : "files_read also takes a file's name or the end of its path when only one file matches. ") +
    `This chat's folder is ${outFolder}: ${sandbox ? "sandbox runs save ./out there, and " : ""}files you write for this chat go there too.`;
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
    const top = path.split("/").slice(0, -1).slice(0, 2).join("/") || "(top level)";
    // Other chats' folders count as one: out/ sorts before uploads/, and a folder per chat would crowd the others out.
    const folder = top.startsWith(SANDBOX_OUT) && `${top}/` !== outFolder ? SANDBOX_OUT.slice(0, -1) : top;
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  // Capped like the list itself: a user with many folders must not fill the prompt with them.
  const folders = listSome([...counts].map(([folder, n]) => `${folder} (${n})`), INDEX_MAX_FOLDERS);
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
  checkFolders(layout);
  return layout;
}

/** Refuse a layout (names under ./files/, to what each comes from) with a file where another needs a folder. */
export function checkFolders(layout: ReadonlyMap<string, string>): void {
  for (const name of layout.keys()) {
    const segments = name.split("/");
    for (let end = 1; end < segments.length; end++) {
      const folder = segments.slice(0, end).join("/");
      if (layout.has(folder)) throw new FileRefError(`"${layout.get(folder)}" is a file where "${layout.get(name)}" needs a folder; pass them in separate runs.`);
    }
  }
}

/**
 * Where a run's outputs are saved: each under `folder` (chatOutFolder), and those whose names the user's files do not
 * allow, or that would land on one path, skipped with why.
 */
export function outputPaths<T>(folder: string, outputs: readonly { name: string; bytes: T }[]): { toSave: Map<string, T>; skipped: string[] } {
  const toSave = new Map<string, T>();
  const skipped: string[] = [];
  for (const output of outputs) {
    // A name the user's files do not allow must not throw away the run's output and the files already saved.
    try {
      // Names that differ only in what normalising trims ("a.csv" and "a.csv ") would overwrite each other.
      const path = normalisePath(`${folder}${output.name}`);
      if (toSave.has(path)) skipped.push(`${output.name} (same file as ${path})`);
      else toSave.set(path, output.bytes);
    } catch (error) {
      if (!(error instanceof PathError)) throw error;
      skipped.push(`${output.name} (${error.message})`);
    }
  }
  return { toSave, skipped };
}

/**
 * Save files for the conversation a tool runs in: nothing once `signal` aborted (no result would say what was saved),
 * and `onSaving` is told the paths first (ChatScope.onSaving), so a conversation apart from the chat has them withheld
 * even when it is stopped or cut off while saving. The paths as stored.
 */
export async function saveFiles<T extends ArrayBuffer | string>(
  files: { put(path: string, body: T, contentType?: string): Promise<string> },
  toSave: ReadonlyMap<string, T>,
  options: { session: string; signal?: AbortSignal; onSaving?: (session: string, paths: readonly string[]) => void; contentType?: string },
): Promise<string[]> {
  options.signal?.throwIfAborted();
  options.onSaving?.(
    options.session,
    [...toSave.keys()].map((path) => normalisePath(path)),
  );
  return Promise.all([...toSave].map(([path, body]) => files.put(path, body, options.contentType)));
}
