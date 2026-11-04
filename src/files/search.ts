import { baseName } from "../../shared/attachments.ts";

/** The search box's tooltip: what `fileMatcher` does, in short. */
export const SEARCH_HELP =
  "Text in a path, or a pattern: * for any run, ? for one character (*.txt, te?t.txt); with a /, the whole path (docs/**/*.md)";

/**
 * The Files search box: plain text finds paths holding it, a pattern with `*` or `?` matches whole names.
 *
 * A pattern without a `/` is matched against each file's name, so `*.txt` finds text files in every folder. With a
 * `/` it is matched against the whole path, a folder name at a time: `*` and `?` stay within one, and a `**` of its own
 * between slashes stands for any number of folders, none included. A leading `/` changes nothing (paths start at the
 * top anyway), a trailing one means what is inside the folders it names (as if `**` followed), and a trailing `**`
 * still needs a file name after it, so `docs/**` does not match a file called `docs`. `?` is one character, an emoji
 * included. Case is ignored.
 *
 * Matching backtracks only to the last star, so no pattern can take more than about name length times pattern length
 * steps per file (a pattern compiled to a regular expression could take exponentially long).
 */
export function fileMatcher(query: string): (path: string) => boolean {
  const search = query.trim().toLowerCase();
  if (!search) return () => true;
  if (!/[*?]/.test(search)) return (path) => path.toLowerCase().includes(search);
  if (!search.includes("/")) {
    const glob = chars(search);
    return (path) => nameMatches(chars(baseName(path).toLowerCase()), glob);
  }
  const folders = search
    .replace(/\/$/, "/**")
    .split("/")
    .filter(Boolean)
    .map((folder) => (folder === "**" ? ANY_FOLDERS : chars(folder)));
  if (folders[folders.length - 1] === ANY_FOLDERS) folders.push(["*"]);
  return (path) => wildcard(path.toLowerCase().split("/").map(chars), folders, ANY_FOLDERS, nameMatches);
}

/** Code points, so `?` takes an emoji whole. */
const chars = (text: string): string[] => [...text];

/** A `**` between slashes, told apart from a folder pattern by identity. */
const ANY_FOLDERS: readonly string[] = ["*", "*"];

/** Whether a name matches a glob, both split into `chars`. */
const nameMatches = (name: readonly string[], glob: readonly string[]): boolean =>
  wildcard(name, glob, "*", (char, one) => one === "?" || one === char);

/**
 * Whether `items` match `pattern` item by item, where `star` stands for any run of items and `matches` says whether one
 * item matches one pattern item: the greedy wildcard match, which on a miss retries the last star one item further on.
 */
function wildcard<T>(items: ArrayLike<T>, pattern: ArrayLike<T>, star: T, matches: (item: T, pattern: T) => boolean): boolean {
  let i = 0;
  let p = 0;
  let starAt = -1;
  let resumeAt = 0;
  while (i < items.length) {
    if (p < pattern.length && pattern[p] === star) {
      starAt = p++;
      resumeAt = i;
    } else if (p < pattern.length && matches(items[i], pattern[p])) {
      i++;
      p++;
    } else if (starAt >= 0) {
      p = starAt + 1;
      i = ++resumeAt;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === star) p++;
  return p === pattern.length;
}
