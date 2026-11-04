/**
 * The Files search box: plain text finds paths holding it, a pattern with `*` or `?` matches whole names.
 *
 * A pattern without a `/` is matched against each file's name, so `*.txt` finds text files in every folder. With a
 * `/` it is matched against the whole path: `*` and `?` stay within one folder name, and `**` crosses folders (followed
 * by a `/`, it also matches no folder at all, so `**` + `/notes.md` finds a top-level one too). Case is ignored.
 */
export function fileMatcher(query: string): (path: string) => boolean {
  const search = query.trim().toLowerCase();
  if (!search) return () => true;
  if (!/[*?]/.test(search)) return (path) => path.toLowerCase().includes(search);
  const pattern = globRegExp(search);
  if (search.includes("/")) return (path) => pattern.test(path.toLowerCase());
  return (path) => pattern.test(path.slice(path.lastIndexOf("/") + 1).toLowerCase());
}

/** `*` any run within a folder name, `?` one character of one, `**` anything; the rest literally. */
function globRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      // Several stars in a row count as two.
      while (glob[i + 1] === "*") i++;
      if (glob[i + 1] === "/") {
        source += "(?:.*/)?";
        i++;
      } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s");
}
