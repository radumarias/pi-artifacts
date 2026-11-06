/** One file of a zip: its name inside the archive, and how to read it. `open` resolves null for a file that is not there (gone since it was listed). */
export interface ZipEntry {
  name: string;
  open(): Promise<{ size: number; modified: Date; body: ReadableStream<Uint8Array> } | null>;
}

/** A running CRC-32 (as node:zlib's crc32 takes it): `chunk` added to the CRC of the bytes before it. */
export type Crc32 = (chunk: Uint8Array, previous: number) => number;

/** CRC-32's table, made on first use. */
let crcTable: Uint32Array | undefined;

/** CRC-32 in plain JavaScript, for the browser; the Worker passes node:zlib's, which is faster. */
export const crc32: Crc32 = (chunk, previous) => {
  const table = (crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = ~previous;
  for (let i = 0; i < chunk.length; i++) crc = table[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
};

// Past these a zip needs ZIP64, which this writer leaves out: callers keep well under them.
const MAX_BYTES = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

// Bit 3: the CRC follows the data, so a file streams through without being read twice. Bit 11: names are UTF-8.
const FLAGS = 0x0808;
// Made by Unix (3) with spec 2.0, so the external attributes below read as file modes.
const MADE_BY = (3 << 8) | 20;
const NEEDED = 20;
const FILE_MODE = 0o100644 << 16;
// An extended-timestamp extra field ("UT": tag, length, flags, Unix mtime): the DOS time has no zone, so unzip tools read
// it as local time; this one is UTC.
const EXTRA_LENGTH = 9;

/**
 * A zip of `entries`, streamed as the reader takes it. Files are stored as
 * they are (most uploads are compressed already, and storing keeps the CPU
 * time to a CRC); the next file is opened while one streams, so a folder of
 * small files does not wait a round trip per file. Fails the stream when the
 * files would weigh more than `maxBytes` (no cap unless given) or the archive outgrow plain zip, or
 * a file is not the size it said. `crc` computes the CRC-32s (plain JavaScript unless given).
 */
export function zipStream(entries: readonly ZipEntry[], { maxBytes = Infinity, crc = crc32 }: { maxBytes?: number; crc?: Crc32 } = {}): ReadableStream<Uint8Array> {
  const chunks = zipChunks(entries, maxBytes, crc);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

async function* zipChunks(entries: readonly ZipEntry[], maxBytes: number, crc32: Crc32): AsyncGenerator<Uint8Array, void> {
  const encoder = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;
  let content = 0;
  const counted = (bytes: Uint8Array) => {
    offset += bytes.byteLength;
    if (offset > MAX_BYTES) throw new Error("The zip would be over 4 GB.");
    return bytes;
  };
  const open = (i: number) => {
    const opening = entries[i]?.open() ?? Promise.resolve(null);
    // Awaited later; until then a failure must not count as unhandled.
    opening.catch(() => {});
    return opening;
  };
  let next = open(0);
  // The file being written, until its data is read: the zip can fail or the reader go away before its first chunk.
  let current: ReadableStream<Uint8Array> | undefined;
  try {
    for (let i = 0; i < entries.length; i++) {
      const opened = await next;
      next = open(i + 1);
      if (!opened) continue;
      current = opened.body;
      if (central.length === MAX_ENTRIES) throw new Error(`A zip holds at most ${MAX_ENTRIES} files.`);
      content += opened.size;
      if (content > maxBytes) throw new Error("The files are too big to zip together.");
      const entry = entries[i];
      const name = encoder.encode(entry.name);
      const header: Header = { name, modified: opened.modified, ...dosDateTime(opened.modified), crc: 0, size: opened.size, offset };
      yield counted(localHeader(header));
      let size = 0;
      for await (const chunk of opened.body) {
        header.crc = crc32(chunk, header.crc);
        size += chunk.byteLength;
        yield counted(chunk);
      }
      current = undefined;
      if (size !== opened.size) throw new Error(`${entry.name} changed while it was being zipped.`);
      yield counted(dataDescriptor(header));
      central.push(centralHeader(header));
    }
    const start = offset;
    yield counted(concat([...central, endOfCentralDirectory(central.length, central.reduce((sum, h) => sum + h.byteLength, 0), start)]));
  } finally {
    // A file opened and not read to its end (the zip failed or the reader went away) gives its connection back,
    // as does one opened ahead. Cancelling a stream a for-await already cancelled does nothing.
    current?.cancel().catch(() => {});
    void next.then((opened) => opened?.body.cancel()).catch(() => {});
  }
}

interface Header {
  name: Uint8Array;
  modified: Date;
  time: number;
  date: number;
  crc: number;
  size: number;
  /** Where the file's local header starts. */
  offset: number;
}

/** `length` zeroed bytes with a little-endian signature, filled in by `fill`. */
function record(signature: number, length: number, fill: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  fill(view);
  return bytes;
}

/**
 * The fields a local header and a central header share, from version-needed
 * to the extra field's length, written at `at`. Method (stored) stays 0.
 */
function common(view: DataView, at: number, { name, time, date, crc, size }: Header): void {
  view.setUint16(at, NEEDED, true);
  view.setUint16(at + 2, FLAGS, true);
  view.setUint16(at + 6, time, true);
  view.setUint16(at + 8, date, true);
  view.setUint32(at + 10, crc, true);
  view.setUint32(at + 14, size, true);
  view.setUint32(at + 18, size, true);
  view.setUint16(at + 22, name.byteLength, true);
  view.setUint16(at + 24, EXTRA_LENGTH, true);
}

/** The name, then the extended timestamp, at the end of a header that is `fixed` bytes before them. */
function nameAndExtra(bytes: Uint8Array, fixed: number, { name, modified }: Header): Uint8Array {
  bytes.set(name, fixed);
  const view = new DataView(bytes.buffer, fixed + name.byteLength);
  view.setUint16(0, 0x5455, true);
  view.setUint16(2, EXTRA_LENGTH - 4, true);
  view.setUint8(4, 1); // the modification time only
  view.setUint32(5, Math.max(0, Math.floor(modified.getTime() / 1000)), true);
  return bytes;
}

/** Its CRC is 0, as it comes in the data descriptor; the sizes are known already, and readers that stream need them for a stored file. */
function localHeader(header: Header): Uint8Array {
  const bytes = record(0x04034b50, 30 + header.name.byteLength + EXTRA_LENGTH, (view) => common(view, 4, { ...header, crc: 0 }));
  return nameAndExtra(bytes, 30, header);
}

function dataDescriptor({ crc, size }: Header): Uint8Array {
  return record(0x08074b50, 16, (view) => {
    view.setUint32(4, crc, true);
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
  });
}

function centralHeader(header: Header): Uint8Array {
  const bytes = record(0x02014b50, 46 + header.name.byteLength + EXTRA_LENGTH, (view) => {
    view.setUint16(4, MADE_BY, true);
    common(view, 6, header);
    // Comment length, disk number and internal attributes stay 0.
    view.setUint32(38, FILE_MODE, true);
    view.setUint32(42, header.offset, true);
  });
  return nameAndExtra(bytes, 46, header);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  return record(0x06054b50, 22, (view) => {
    view.setUint16(8, count, true);
    view.setUint16(10, count, true);
    view.setUint32(12, size, true);
    view.setUint32(16, offset, true);
  });
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

/** A zip's MS-DOS time and date, in UTC: two-second steps, from 1980 on. */
export function dosDateTime(when: Date): { time: number; date: number } {
  const d = when.getUTCFullYear() < 1980 ? new Date(Date.UTC(1980, 0, 1)) : when;
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}
