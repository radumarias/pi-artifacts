/**
 * Files attached to a chat message. Each is uploaded to the chat owner's files
 * first (the agent acts as the owner, so its tools and sandbox find it there),
 * then the message names it, and the model gets its content with the message:
 * an image as an image, a text file as its text, a PDF or office document as
 * Markdown. Anything else is named, for the agent's tools to open.
 *
 * Images are scaled down in the browser: the Worker never decodes them. All of
 * a message's content is kept in one transcript row, which holds at most 2 MB,
 * so its images share IMAGES_BASE64 and its texts TEXT_CHARS.
 */

/** Attachments one message may carry. */
export const MAX_ATTACHMENTS = 10;

/** Image types every provider takes inline. Others (HEIC, BMP, TIFF) go through the browser, which re-encodes them as JPEG. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** The longest side of an image the model sees: what Anthropic recommends; larger ones it scales down itself. */
export const IMAGE_MAX_SIDE = 1568;
/** Base64 bytes of one image, and of all of one message's images. */
export const IMAGE_BASE64 = 800_000;
export const IMAGES_BASE64 = 1_100_000;

/** A thumbnail the transcript shows: a small JPEG as a data URL. */
export const THUMB_SIDE = 160;
export const THUMB_CHARS = 16_000;
const THUMB_URL = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

/** Characters of text one message's attachments may add, and one attachment. */
export const TEXT_CHARS = 150_000;
export const FILE_TEXT_CHARS = 100_000;

/** The base64 one image may take when a message carries `count` of them. */
export function imageBudget(count: number): number {
  return Math.min(IMAGE_BASE64, Math.floor(IMAGES_BASE64 / Math.max(1, count)));
}

/** An attachment as the browser sends it with its message. */
export interface AttachmentInput {
  /** Where the upload stored it in the chat owner's files. */
  path: string;
  /** For an image: the copy the model sees, scaled to IMAGE_MAX_SIDE and imageBudget(). */
  image?: { data: string; mimeType: string };
  /** For an image: what the transcript shows (see THUMB_SIDE). */
  thumb?: string;
}

/** An attachment as the message's transcript entry records it. A type, not an interface, so it is JSON pi can store. */
export type Attachment = {
  path: string;
  size: number;
  /** How the model got it: as an image, as text, or only by its path. */
  shown: "image" | "text" | "path";
  thumb?: string;
};

/** `value` when it is a thumbnail data URL the transcript may show. */
export function checkThumb(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= THUMB_CHARS && THUMB_URL.test(value) ? value : undefined;
}

/** A file's name: the last segment of its path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
