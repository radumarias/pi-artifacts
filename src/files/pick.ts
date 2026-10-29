import { isHidden, MAX_LISTED } from "../../shared/uploads.ts";

/** A file to upload, with its name or its path inside the folder it was picked or dropped with. */
export interface Picked {
  file: File;
  path: string;
}

/**
 * Files from a file input; a folder input names each with its path inside the folder. Hidden files inside a folder are
 * left out, but not the folder the user picked, whatever its name (as with a drop). useUploads caps how many it takes.
 */
export function fromInput(list: FileList | null): Picked[] {
  return [...(list ?? [])]
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
    .filter(({ file }) => !isHidden(file.webkitRelativePath.split("/").slice(1).join("/")));
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
  const files: Promise<Picked>[] = [];
  const queue = [...roots];
  // Walked by index: shifting the queue would copy it for every entry. One file past MAX_LISTED, so useUploads can say
  // the drop held more than it takes, without walking all of a huge folder.
  for (let i = 0; i < queue.length && files.length <= MAX_LISTED; i++) {
    const entry = queue[i];
    // What the user dropped themselves is uploaded whatever its name; inside a folder, hidden files and folders are not.
    if (i >= roots.length && isHidden(entry.name)) continue;
    // The entry's own path starts with "/" and the dropped folder's name: "/reports/q3/sales.csv".
    const path = entry.fullPath.replace(/^\/+/, "") || entry.name;
    if (entry.isFile) files.push(fileOf(entry as FileSystemFileEntry).then((file) => ({ file, path })));
    else if (entry.isDirectory) queue.push(...(await children(entry as FileSystemDirectoryEntry)));
  }
  return Promise.all(files);
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
