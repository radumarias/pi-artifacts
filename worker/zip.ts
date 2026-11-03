import { crc32 } from "node:zlib";

/** One file of a zip: its name inside the archive, and how to read it. `open` resolves null for a file gone since it was listed. */
export interface ZipEntry {
  name: string;
  modified: Date;
  open(): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
}

/** Past these a zip needs ZIP64, which this writer leaves out: callers keep under them. */
export const ZIP_MAX_BYTES = 0xffff_ffff;
export const ZIP_MAX_ENTRIES = 0xffff;

// Bit 3: the CRC follows the data, so a file streams through without being read twice. Bit 11: names are UTF-8.
const FLAGS = 0x0808;
// Made by Unix (3) with spec 2.0, so the external attributes below read as file modes.
const MADE_BY = (3 << 8) | 20;
const NEEDED = 20;
const FILE_MODE = 0o100644 << 16;

/**
 * A zip of `entries`, streamed: each file is opened only when the one before
 * it has been written, and stored as it is (most uploads are compressed
 * already, and storing keeps the CPU time to a CRC). Fails the stream when the
 * archive would outgrow plain zip, or a file is not the size it said.
 */
export function zipStream(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  void (async () => {
    const central: Uint8Array[] = [];
    let offset = 0;
    const write = async (bytes: Uint8Array) => {
      offset += bytes.byteLength;
      if (offset > ZIP_MAX_BYTES) throw new Error("The zip would be over 4 GB.");
      await writer.write(bytes);
    };
    for await (const entry of entries) {
      const opened = await entry.open();
      if (!opened) continue;
      if (central.length === ZIP_MAX_ENTRIES) throw new Error(`A zip holds at most ${ZIP_MAX_ENTRIES} files.`);
      const name = encoder.encode(entry.name);
      const { time, date } = dosDateTime(entry.modified);
      const start = offset;
      await write(localHeader(name, time, date, opened.size));
      let crc = 0;
      let size = 0;
      for await (const chunk of opened.body) {
        crc = crc32(chunk, crc);
        size += chunk.byteLength;
        await write(chunk);
      }
      if (size !== opened.size) throw new Error(`${entry.name} changed while it was being zipped.`);
      await write(dataDescriptor(crc, size));
      central.push(centralHeader(name, time, date, crc, size, start));
    }
    const centralStart = offset;
    for (const header of central) await write(header);
    await write(endOfCentralDirectory(central.length, offset - centralStart, centralStart));
    await writer.close();
  })().catch((error: unknown) => writer.abort(error).catch(() => {}));
  return readable;
}

function localHeader(name: Uint8Array, time: number, date: number, size: number): Uint8Array {
  const bytes = new Uint8Array(30 + name.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, NEEDED, true);
  view.setUint16(6, FLAGS, true);
  view.setUint16(8, 0, true); // stored
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  // The CRC comes in the data descriptor. The sizes are known already, and readers that stream need them for a stored file.
  view.setUint32(14, 0, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.byteLength, true);
  view.setUint16(28, 0, true);
  bytes.set(name, 30);
  return bytes;
}

function dataDescriptor(crc: number, size: number): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, crc, true);
  view.setUint32(8, size, true);
  view.setUint32(12, size, true);
  return bytes;
}

function centralHeader(name: Uint8Array, time: number, date: number, crc: number, size: number, offset: number): Uint8Array {
  const bytes = new Uint8Array(46 + name.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, MADE_BY, true);
  view.setUint16(6, NEEDED, true);
  view.setUint16(8, FLAGS, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, time, true);
  view.setUint16(14, date, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.byteLength, true);
  // Extra field, comment, disk number and internal attributes stay 0.
  view.setUint32(38, FILE_MODE, true);
  view.setUint32(42, offset, true);
  bytes.set(name, 46);
  return bytes;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
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
