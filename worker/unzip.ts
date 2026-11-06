/** One file read out of a zip: its name in the archive and its bytes. */
export interface UnzippedFile {
  name: string;
  bytes: Uint8Array;
}

/** A zip that cannot be read as given; the message says why. */
export class UnzipError extends Error {
  override name = "UnzipError";
}

export interface UnzipLimits {
  /** At most this many files (folders do not count). */
  maxFiles: number;
  /** No file may unpack to more than this. */
  maxFileBytes: number;
  /** All the files together may unpack to no more than this. */
  maxTotalBytes: number;
  /** Which files to read, by name: the others are neither inflated nor counted. All by default. */
  include?: (name: string) => boolean;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/**
 * The files of a zip held in memory: stored or deflated entries, as zip tools and operating systems write them. Folders
 * are left out. Encrypted entries, ZIP64 and other methods are refused. Sizes come from the central directory and are
 * enforced while inflating, so an archive that lies about them (a zip bomb) stops at the limit rather than filling memory.
 */
export async function unzip(data: Uint8Array, limits: UnzipLimits): Promise<UnzippedFile[]> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const end = findEnd(view);
  const count = u16(end + 10);
  const size = u32(end + 12);
  let at = u32(end + 16);
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff) throw new UnzipError("ZIP64 archives are not supported.");
  if (at + size > end) throw new UnzipError("The zip's directory is damaged.");
  const decoder = new TextDecoder();
  const files: UnzippedFile[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== CENTRAL) throw new UnzipError("The zip's directory is damaged.");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const compressed = u32(at + 20);
    const unpacked = u32(at + 24);
    const nameLength = u16(at + 28);
    const next = at + 46 + nameLength + u16(at + 30) + u16(at + 32);
    const local = u32(at + 42);
    const name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength));
    at = next;
    if (name.endsWith("/") || (limits.include && !limits.include(name))) continue;
    if (flags & 1) throw new UnzipError(`"${name}" is encrypted; zip it without a password.`);
    if (method !== STORED && method !== DEFLATED) throw new UnzipError(`"${name}" uses a compression zip tools rarely write; zip it again.`);
    if (files.length >= limits.maxFiles) throw new UnzipError(`The zip holds more than ${limits.maxFiles} files.`);
    if (unpacked > limits.maxFileBytes) throw new UnzipError(`"${name}" is over the limit for one file.`);
    total += unpacked;
    if (total > limits.maxTotalBytes) throw new UnzipError("The files unpack to more than the limit for a package.");
    if (local + 30 > data.byteLength || u32(local) !== LOCAL) throw new UnzipError(`"${name}" is damaged.`);
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start + compressed > data.byteLength) throw new UnzipError(`"${name}" is cut short.`);
    const raw = data.subarray(start, start + compressed);
    const bytes = method === STORED ? raw : await inflate(raw, unpacked, name);
    if (bytes.byteLength !== unpacked) throw new UnzipError(`"${name}" is not the size the zip says.`);
    files.push({ name, bytes });
  }
  return files;
}

/** The end-of-central-directory record: in the last 64 KB and 22 bytes, after any comment. */
function findEnd(view: DataView): number {
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === EOCD) return at;
  }
  throw new UnzipError("This is not a zip file.");
}

/** Inflate raw deflate data, stopping as soon as it grows past `expected` bytes. */
async function inflate(raw: Uint8Array, expected: number, name: string): Promise<Uint8Array> {
  const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.byteLength > expected) throw new UnzipError(`"${name}" is not the size the zip says.`);
      out.set(value, length);
      length += value.byteLength;
    }
  } catch (error) {
    if (error instanceof UnzipError) throw error;
    throw new UnzipError(`"${name}" is damaged.`);
  } finally {
    reader.cancel().catch(() => {});
  }
  return out.subarray(0, length);
}
