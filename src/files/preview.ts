/** How much of a text file the preview reads and shows; the rest is left for the download. */
export const TEXT_LIMIT = 1024 * 1024;
/** Text longer than this shows unhighlighted: highlighting it would hold the page up. */
export const HIGHLIGHT_LIMIT = 200_000;
/** A table shows at most this many rows. */
export const TABLE_ROWS = 1_000;

/** A file's text, as much of it as `limit` allows; `cut` when there was more. */
export interface FileText {
  text: string;
  cut: boolean;
}

/**
 * The text of a response's body, reading at most `limit` bytes; null when the body is not UTF-8 text (it holds a NUL
 * byte, or bytes UTF-8 cannot decode), which the preview cannot show. Stops reading at the limit, or at the first
 * sign of binary, so a large file is never read whole.
 */
export async function readText(body: ReadableStream<Uint8Array>, limit = TEXT_LIMIT): Promise<FileText | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (read === limit) return { text, cut: !done && value.length > 0 };
      const chunk = done ? undefined : value.subarray(0, limit - read);
      if (chunk?.includes(0)) return null;
      try {
        // Streaming, a character cut off at the chunk's end waits for the next chunk; at the limit it is left out.
        text += chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
      } catch {
        return null;
      }
      if (!chunk) return { text, cut: false };
      read += chunk.length;
      if (chunk.length < value!.length) return { text, cut: true };
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/**
 * Where a link or image in a user file at `from` points among the user's files: a relative path ("../raw/a.png",
 * "notes.md#top") resolved against the file's folder, or an absolute one ("/out/a.html") from the files' root.
 * Null for a link elsewhere (a URL, "mailto:", "#part" alone) or one that climbs above the root.
 */
export function resolveLink(from: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#|^\?/i.test(href)) return null;
  let path: string;
  try {
    path = decodeURIComponent(href.replace(/[?#].*$/s, ""));
  } catch {
    return null;
  }
  const segments = path.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }
  return segments.length ? segments.join("/") : null;
}

/**
 * The rows of a CSV (or, with "\t", TSV) text: fields split on `delimiter`, a quoted field ("a, b" or "say ""hi""")
 * kept whole across delimiters and line breaks. At most `maxRows` rows; `cut` when there were more.
 */
export function parseTable(text: string, delimiter: string, maxRows = TABLE_ROWS + 1): { rows: string[][]; cut: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else field += char;
      i++;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      endRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
      if (rows.length === maxRows) return { rows, cut: i + 1 < text.length };
    } else field += char;
    i++;
  }
  if (field !== "" || row.length) endRow();
  return { rows, cut: false };
}
