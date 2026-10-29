import { isHidden } from "../../shared/uploads.ts";

/** A file to upload, with its name or its path inside the folder it was picked or dropped with. */
export interface Picked {
  file: File;
  path: string;
}

/** More than the sidebar and the agent's list can make use of in one go. */
export const MAX_PICKED = 2_000;

/** Files from a file input; a folder input names each with its path inside the folder. Hidden files inside a folder are left out. */
export function fromInput(list: FileList | null): Picked[] {
  return [...(list ?? [])]
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
    .filter(({ file, path }) => !(file.webkitRelativePath && isHidden(path)))
    .slice(0, MAX_PICKED);
}

/**
 * Files and folders dropped on the app, folders walked for their files.
 * Call it inside the drop handler: the browser empties the drop's items once
 * the handler returns, so the entries are taken before the first await.
 */
export function fromDrop(data: DataTransfer): Promise<Picked[]> {
  const entries = [...data.items].filter((item) => item.kind === "file").map((item) => item.webkitGetAsEntry());
  // Without entries (an older browser), dropped folders are lost but files still come through.
  if (entries.some((entry) => !entry)) return Promise.resolve([...data.files].map((file) => ({ file, path: file.name })));
  return walk(entries as FileSystemEntry[]);
}

async function walk(roots: FileSystemEntry[]): Promise<Picked[]> {
  const picked: Picked[] = [];
  const queue = [...roots];
  while (queue.length && picked.length < MAX_PICKED) {
    const entry = queue.shift()!;
    // The entry's own path starts with "/" and the dropped folder's name: "/reports/q3/sales.csv".
    const path = entry.fullPath.replace(/^\/+/, "") || entry.name;
    // What the user dropped themselves is uploaded whatever its name; inside a folder, hidden files and folders are not.
    if (!roots.includes(entry) && entry.name.startsWith(".")) continue;
    if (entry.isFile) picked.push({ file: await fileOf(entry as FileSystemFileEntry), path });
    else if (entry.isDirectory) queue.push(...(await children(entry as FileSystemDirectoryEntry)));
  }
  return picked;
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** A folder's entries. A reader hands them out in batches, until an empty one. */
async function children(folder: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = folder.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/** Whether a drag carries files (not text or a link), so the app shows its drop target only for those. */
export function carriesFiles(data: DataTransfer | null): boolean {
  return !!data && [...data.types].includes("Files");
}
