import { crc32 } from "node:zlib";

/** One file of a zip: its name inside the archive, and how to read it. `open` resolves null for a file gone since it was listed. */
export interface ZipEntry {
  name: string;
  modified: Date;
  open(): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
}

// Past these a zip needs ZIP64, which this writer leaves out: callers keep well under them.
const MAX_BYTES = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

// Bit 3: the CRC follows the data, so a file streams through without being read twice. Bit 11: names are UTF-8.
const FLAGS = 0x0808;
// Made by Unix (3) with spec 2.0, so the external attributes below read as file modes.
const MADE_BY = (3 << 8) | 20;
const NEEDED = 20;
const FILE_MODE = 0o100644 << 16;

/**
 * A zip of `entries`, streamed as the reader takes it. Files are stored as
 * they are (most uploads are compressed already, and storing keeps the CPU
 * time to a CRC); the next file is opened while one streams, so a folder of
 * small files does not wait a round trip per file. Fails the stream when the
 * archive would outgrow plain zip, or a file is not the size it said.
 */
export function zipStream(entries: readonly ZipEntry[]): ReadableStream<Uint8Array> {
  const chunks = zipChunks(entries);
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

async function* zipChunks(entries: readonly ZipEntry[]): AsyncGenerator<Uint8Array, void> {
  const encoder = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;
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
  try {
    for (let i = 0; i < entries.length; i++) {
      const opened = await next;
      next = open(i + 1);
      if (!opened) continue;
      if (central.length === MAX_ENTRIES) throw new Error(`A zip holds at most ${MAX_ENTRIES} files.`);
      const entry = entries[i];
      const name = encoder.encode(entry.name);
      const header: Header = { name, ...dosDateTime(entry.modified), crc: 0, size: opened.size, offset };
      yield counted(localHeader(header));
      let size = 0;
      for await (const chunk of opened.body) {
        header.crc = crc32(chunk, header.crc);
        size += chunk.byteLength;
        yield counted(chunk);
      }
      if (size !== opened.size) throw new Error(`${entry.name} changed while it was being zipped.`);
      yield counted(dataDescriptor(header));
      central.push(centralHeader(header));
    }
    const start = offset;
    yield counted(concat([...central, endOfCentralDirectory(central.length, central.reduce((sum, h) => sum + h.byteLength, 0), start)]));
  } finally {
    // A file opened ahead and never read (the zip failed or the reader went away) gives its connection back.
    void next.then((opened) => opened?.body.cancel()).catch(() => {});
  }
}

interface Header {
  name: Uint8Array;
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
 * to the name's length, written at `at`. Method (stored) and the extra field's
 * length stay 0.
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
}

/** Its CRC is 0, as it comes in the data descriptor; the sizes are known already, and readers that stream need them for a stored file. */
function localHeader(header: Header): Uint8Array {
  const bytes = record(0x04034b50, 30 + header.name.byteLength, (view) => common(view, 4, { ...header, crc: 0 }));
  bytes.set(header.name, 30);
  return bytes;
}

function dataDescriptor({ crc, size }: Header): Uint8Array {
  return record(0x08074b50, 16, (view) => {
    view.setUint32(4, crc, true);
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
  });
}

function centralHeader(header: Header): Uint8Array {
  const bytes = record(0x02014b50, 46 + header.name.byteLength, (view) => {
    view.setUint16(4, MADE_BY, true);
    common(view, 6, header);
    // Comment length, disk number and internal attributes stay 0.
    view.setUint32(38, FILE_MODE, true);
    view.setUint32(42, header.offset, true);
  });
  bytes.set(header.name, 46);
  return bytes;
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
