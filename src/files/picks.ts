/** What a pick in the Files panel is: a file, or a folder with everything under it. */
export type Kind = "file" | "folder";

/** Picked files and folders, by path. */
export type Picks = ReadonlyMap<string, Kind>;

/** Whether a folder above `path` is picked, which picks `path` too. */
export function inPickedFolder(picked: Picks, path: string): boolean {
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    if (picked.get(path.slice(0, slash)) === "folder") return true;
  }
  return false;
}

/** Whether `path` is picked, itself or by a folder above it. */
export const isPicked = (picked: Picks, path: string) => picked.has(path) || inPickedFolder(picked, path);
