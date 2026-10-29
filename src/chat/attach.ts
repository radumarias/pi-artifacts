import { IMAGE_MAX_SIDE, IMAGE_TYPES, THUMB_CHARS, THUMB_SIDE, type AttachmentInput } from "../../shared/attachments.ts";

/** A file waiting in the composer to go with the next message. */
export interface Pending {
  id: string;
  file: File;
  /** An object URL showing it, for an image the browser can decode. */
  preview?: string;
}

/**
 * Pasted images all come named "image.png": name each after the moment it was pasted, so one does not replace the
 * last in the user's files.
 */
export function pastedName(file: File, at = new Date()): File {
  if (file.name && file.name !== "image.png") return file;
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return new File([file], `pasted-${stamp}.${ext}`, { type: file.type, lastModified: file.lastModified });
}

/**
 * What goes with a message for one uploaded file: for an image, the copy the model sees and a thumbnail for the
 * transcript. Images are scaled down here, so the Worker never decodes one (see shared/attachments.ts). A file the
 * browser cannot decode as an image goes as a path only.
 */
export async function attachmentInput(file: File, path: string, imageBudget: number): Promise<AttachmentInput> {
  if (!file.type.startsWith("image/")) return { path };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { path };
  }
  try {
    const [image, thumb] = await Promise.all([modelImage(file, bitmap, imageBudget), thumbnail(bitmap)]);
    return { path, image, thumb };
  } finally {
    bitmap.close();
  }
}

/** The image as the model sees it: as it is when it fits, else as a JPEG scaled and compressed until it does. */
async function modelImage(file: File, bitmap: ImageBitmap, budget: number): Promise<AttachmentInput["image"]> {
  if (IMAGE_TYPES.has(file.type) && Math.max(bitmap.width, bitmap.height) <= IMAGE_MAX_SIDE && base64Length(file.size) <= budget) {
    return { data: await toBase64(file), mimeType: file.type };
  }
  let scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = await toBlob(draw(bitmap, scale), quality);
      if (base64Length(blob.size) <= budget) return { data: await toBase64(blob), mimeType: "image/jpeg" };
    }
  }
  return undefined;
}

/** A small JPEG of the image, as a data URL, for the transcript. */
async function thumbnail(bitmap: ImageBitmap): Promise<string | undefined> {
  const canvas = draw(bitmap, Math.min(1, THUMB_SIDE / Math.max(bitmap.width, bitmap.height)));
  const url = canvas.toDataURL("image/jpeg", 0.7);
  return url.length <= THUMB_CHARS ? url : undefined;
}

/** The image drawn at `scale`, on white: a JPEG has no transparency. */
function draw(bitmap: ImageBitmap, scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))), "image/jpeg", quality));
}

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** A blob's bytes as base64, without the data URL's prefix. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
