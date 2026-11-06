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

/** A zip read where it lies, a part at a time: in memory, or a file the browser reads from disk (a Blob). */
export interface ZipSource {
  size: number;
  /** The bytes from `start` up to (not including) `end`. */
  read(start: number, end: number): Promise<Uint8Array<ArrayBuffer>>;
}

/** A zip in memory, as a ZipSource. */
export function bytesSource(data: Uint8Array): ZipSource {
  const bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  return { size: bytes.byteLength, read: async (start, end) => bytes.subarray(start, end) };
}

/** One file of a zip as its central directory lists it: enough to read it (readZipFile). */
export interface ZipItem {
  name: string;
  /** What it unpacks to, in bytes. */
  size: number;
  encrypted: boolean;
  method: number;
  compressed: number;
  /** Where its local header starts. */
  local: number;
}

/**
 * The files a zip's central directory lists, folders left out. ZIP64 is refused. Reads only the end of the zip and its
 * directory, so a zip of any size is listed in two reads.
 */
export async function zipDirectory(source: ZipSource): Promise<ZipItem[]> {
  const tailStart = Math.max(0, source.size - 22 - 0xffff);
  const tail = await source.read(tailStart, source.size);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const endAt = findEnd(tailView);
  const count = tailView.getUint16(endAt + 10, true);
  const size = tailView.getUint32(endAt + 12, true);
  const start = tailView.getUint32(endAt + 16, true);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new UnzipError("ZIP64 archives are not supported.");
  if (start + size > tailStart + endAt) throw new UnzipError("The zip's directory is damaged.");
  const directory = await source.read(start, start + size);
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const decoder = new TextDecoder();
  const items: ZipItem[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > directory.byteLength || u32(at) !== CENTRAL) throw new UnzipError("The zip's directory is damaged.");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const nameLength = u16(at + 28);
    const next = at + 46 + nameLength + u16(at + 30) + u16(at + 32);
    if (next > directory.byteLength) throw new UnzipError("The zip's directory is damaged.");
    const name = decoder.decode(directory.subarray(at + 46, at + 46 + nameLength));
    if (!name.endsWith("/")) items.push({ name, encrypted: (flags & 1) === 1, method, compressed: u32(at + 20), size: u32(at + 24), local: u32(at + 42) });
    at = next;
  }
  return items;
}

/**
 * One file's bytes, unpacked: stored or deflated, as zip tools and operating systems write them; encrypted files and other
 * methods are refused. Its size comes from the central directory and is enforced while inflating, so an archive that
 * lies about it (a zip bomb) stops at that size rather than filling memory.
 */
export async function readZipFile(source: ZipSource, item: ZipItem): Promise<Uint8Array<ArrayBuffer>> {
  const start = await dataStart(source, item);
  const raw = await source.read(start, start + item.compressed);
  const bytes = item.method === STORED ? raw : await inflate(raw, item.size, item.name);
  if (bytes.byteLength !== item.size) throw new UnzipError(`"${item.name}" is not the size the zip says.`);
  return bytes;
}

/**
 * Where a stored (not compressed) file's bytes lie in the zip, from and up to, so that they can be read as a part of
 * it (Blob.slice) without a copy; null for a compressed one, which readZipFile unpacks. Refuses what readZipFile does.
 */
export async function storedRange(source: ZipSource, item: ZipItem): Promise<[number, number] | null> {
  const start = await dataStart(source, item);
  if (item.method !== STORED) return null;
  if (item.compressed !== item.size) throw new UnzipError(`"${item.name}" is not the size the zip says.`);
  return [start, start + item.size];
}

/** Where a file's data starts, past its local header, once it is one this reader can read. */
async function dataStart(source: ZipSource, { name, local, compressed, method, encrypted }: ZipItem): Promise<number> {
  if (encrypted) throw new UnzipError(`"${name}" is encrypted; zip it without a password.`);
  if (method !== STORED && method !== DEFLATED) throw new UnzipError(`"${name}" uses a compression zip tools rarely write; zip it again.`);
  if (local + 30 > source.size) throw new UnzipError(`"${name}" is damaged.`);
  const header = await source.read(local, local + 30);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== LOCAL) throw new UnzipError(`"${name}" is damaged.`);
  const start = local + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  if (start + compressed > source.size) throw new UnzipError(`"${name}" is cut short.`);
  return start;
}

/** The files of a zip held in memory (see zipDirectory and readZipFile), within `limits`. */
export async function unzip(data: Uint8Array, limits: UnzipLimits): Promise<UnzippedFile[]> {
  const source = bytesSource(data);
  const files: UnzippedFile[] = [];
  let total = 0;
  for (const item of await zipDirectory(source)) {
    if (limits.include && !limits.include(item.name)) continue;
    if (files.length >= limits.maxFiles) throw new UnzipError(`The zip holds more than ${limits.maxFiles} files.`);
    if (item.size > limits.maxFileBytes) throw new UnzipError(`"${item.name}" is over the limit for one file.`);
    total += item.size;
    if (total > limits.maxTotalBytes) throw new UnzipError("The files unpack to more than the limit for a package.");
    files.push({ name: item.name, bytes: await readZipFile(source, item) });
  }
  return files;
}

/** The end-of-central-directory record in `view` (the zip's last 64 KB and 22 bytes): after any comment. */
function findEnd(view: DataView): number {
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === EOCD) return at;
  }
  throw new UnzipError("This is not a zip file.");
}

/** Inflate raw deflate data, stopping as soon as it grows past `expected` bytes. */
async function inflate(raw: Uint8Array<ArrayBuffer>, expected: number, name: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
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
