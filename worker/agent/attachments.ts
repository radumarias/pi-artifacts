import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  baseName,
  checkThumb,
  FILE_TEXT_CHARS,
  IMAGE_BASE64,
  IMAGE_TYPES,
  IMAGES_BASE64,
  MAX_ATTACHMENTS,
  TEXT_CHARS,
  type Attachment,
  type AttachmentInput,
} from "../../shared/attachments.ts";
import { formatBytes } from "../../shared/util.ts";

/** What attachments are read from: the chat owner's files (UserFiles), or a stand-in in tests. */
export interface AttachmentFiles {
  get(path: string, range?: { offset: number; length: number }): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** Turns a document (PDF, Word, Excel…) into Markdown: Workers AI's toMarkdown in the Worker. */
export type ToMarkdown = (name: string, bytes: ArrayBuffer) => Promise<string>;

export type MessageContent = (TextContent | ImageContent)[];

/** Read as UTF-8 text. Other files whose type says text are too (see isText). */
const TEXT_EXTENSIONS = new Set(
  "txt md markdown csv tsv json jsonl ndjson yaml yml toml ini cfg conf env log xml html htm css scss svg js mjs cjs jsx ts tsx py rb rs go java kt swift c h cc cpp hpp cs php sh bash zsh sql r lua pl tex rst ipynb".split(
    " ",
  ),
);
/** What Workers AI's toMarkdown converts without a model (images it would describe with one, at a cost). */
const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "xlsm", "xlsb", "xls", "et", "ods", "odt", "numbers"]);

function extension(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A message's attachments from the browser, checked for shape. Throws on anything else. */
export function parseAttachments(raw: unknown): AttachmentInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("Attachments must be a list.");
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`A message takes at most ${MAX_ATTACHMENTS} attachments.`);
  return raw.map((item: Partial<AttachmentInput> | null): AttachmentInput => {
    if (typeof item?.path !== "string" || !item.path) throw new Error("Each attachment needs the path its upload returned.");
    const image = item.image;
    const valid = image && typeof image.data === "string" && typeof image.mimeType === "string";
    return { path: item.path, image: valid ? { data: image.data, mimeType: image.mimeType } : undefined, thumb: checkThumb(item.thumb) };
  });
}

/**
 * What the model gets with a message's attachments, in the order given, and
 * what its transcript entry records of them. Each is introduced by its path,
 * so the agent can also open it with its tools; one that cannot be shown is
 * named only, with why. A model without vision gets pi-ai's placeholder for
 * an image, after the line naming it.
 */
export async function attachmentContent(
  inputs: readonly AttachmentInput[],
  files: AttachmentFiles,
  toMarkdown?: ToMarkdown,
): Promise<{ content: MessageContent; attachments: Attachment[] }> {
  // Fetched at once; the budgets are then spent in order.
  const read = await Promise.all(inputs.map((input) => fetchAttachment(input, files, toMarkdown)));
  const content: MessageContent = [];
  const attachments: Attachment[] = [];
  let imageBytes = 0;
  let textChars = 0;
  for (const [i, input] of inputs.entries()) {
    const found = read[i];
    const { path } = input;
    if (!found) {
      content.push(note(`[Attached file ${path} was not found in the user's files.]`));
      continue;
    }
    const size = formatBytes(found.size);
    const record = (shown: Attachment["shown"]) => attachments.push({ path, size: found.size, shown, ...(input.thumb && { thumb: input.thumb }) });
    const pathOnly = (why: string) => {
      content.push(note(`[Attached file: ${path}, ${size}. ${why} It is in the user's files.]`));
      record("path");
    };

    if (found.kind === "image") {
      const { data, mimeType } = found.image;
      if (data.length > IMAGE_BASE64 || imageBytes + data.length > IMAGES_BASE64) {
        pathOnly("Not shown: the message's images are over the size it takes.");
        continue;
      }
      imageBytes += data.length;
      content.push(note(`[Attached image: ${path}, ${size}]`), { type: "image", data, mimeType });
      record("image");
    } else if (found.kind === "text") {
      const room = Math.min(FILE_TEXT_CHARS, TEXT_CHARS - textChars);
      if (room <= 0) {
        pathOnly("Not shown: the message's attachments are over the text they may add.");
        continue;
      }
      const shown = found.text.slice(0, room);
      const cut = shown.length < found.text.length || found.partial;
      textChars += shown.length;
      const tail = cut ? `\n… [cut here; the whole file is ${path}]` : "";
      content.push(note(`<attachment path="${path}" size="${size}"${found.converted ? ' converted="markdown"' : ""}>\n${shown}${tail}\n</attachment>`));
      record("text");
    } else {
      pathOnly(found.why);
    }
  }
  return { content, attachments };
}

type Fetched =
  | { kind: "image"; size: number; image: { data: string; mimeType: string } }
  | { kind: "text"; size: number; text: string; partial: boolean; converted?: boolean }
  | { kind: "path"; size: number; why: string };

/** One attachment's content, or null when there is no such file. */
async function fetchAttachment(input: AttachmentInput, files: AttachmentFiles, toMarkdown?: ToMarkdown): Promise<Fetched | null> {
  const ext = extension(input.path);
  const isDocument = DOCUMENT_EXTENSIONS.has(ext);
  // A text file is read only as far as FILE_TEXT_CHARS can reach (4 bytes a character at most), a document whole, and anything else not at all.
  const range = isDocument ? undefined : { offset: 0, length: TEXT_EXTENSIONS.has(ext) && !input.image ? FILE_TEXT_CHARS * 4 : 1 };
  const object = await files.get(input.path, range).catch(() => null);
  if (!object) return null;
  const size = object.size;

  if (input.image) {
    const { data, mimeType } = input.image;
    if (!IMAGE_TYPES.has(mimeType) || !isBase64(data)) return { kind: "path", size, why: "Not shown: the image the app sent could not be read." };
    return { kind: "image", size, image: { data, mimeType } };
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    const bytes = await object.arrayBuffer();
    const text = new TextDecoder().decode(bytes);
    if (text.includes("\u0000")) return { kind: "path", size, why: "Not shown: it is not text." };
    return { kind: "text", size, text, partial: bytes.byteLength < size };
  }
  if (isDocument) {
    if (!toMarkdown) return { kind: "path", size, why: "Not shown: documents cannot be converted here." };
    try {
      const markdown = await toMarkdown(baseName(input.path), await object.arrayBuffer());
      if (!markdown.trim()) return { kind: "path", size, why: "Not shown: no text could be taken from it (a scanned document?)." };
      return { kind: "text", size, text: markdown, partial: false, converted: true };
    } catch (error) {
      console.error("attachment:", error);
      return { kind: "path", size, why: "Not shown: converting it to text failed." };
    }
  }
  return { kind: "path", size, why: "Not shown: the model cannot take this kind of file directly." };
}

function note(text: string): TextContent {
  return { type: "text", text };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isBase64(data: string): boolean {
  return data.length > 0 && data.length % 4 === 0 && BASE64.test(data);
}

/**
 * `value` with the data of every image block in it emptied: what the chat's
 * sockets send. A transcript can hold megabytes of images the model saw, and
 * every connect sends the whole transcript; the app shows each attachment's
 * thumbnail from the message's entry instead.
 */
export function withoutImageData<T>(value: T): T {
  if (Array.isArray(value)) {
    const stripped = value.map(withoutImageData);
    return (stripped.some((item, i) => item !== value[i]) ? stripped : value) as T;
  }
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (object.type === "image" && typeof object.data === "string") return { ...object, data: "" } as T;
  let copy: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(object)) {
    const stripped = withoutImageData(item);
    if (stripped !== item) (copy ??= { ...object })[key] = stripped;
  }
  return (copy ?? value) as T;
}
