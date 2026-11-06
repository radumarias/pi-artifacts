import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { api } from "../src/api.ts";
import { commonFolder, MAX_ZIP_FILES, previewKind, previewType, viewType, ZIP_ROUTE } from "../shared/uploads.ts";
import { filesRoute, storeUpload } from "../worker/files-routes.ts";
import { deriveUserKey } from "../worker/storage/keys.ts";
import { UserFiles } from "../worker/storage/user-files.ts";
import { dosDateTime, zipStream } from "../worker/zip.ts";
import { FakeBucket, MASTER_KEY as MASTER } from "./fakes.ts";

/** The files of a zip, read from its central directory, each checked against its local header and CRC. */
function readZip(zip: Uint8Array): Map<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + nameLength + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, decoder.decode(data));
    at += 46 + nameLength + extraLength;
  }
  return files;
}

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `unzip -t` agreeing that the zip is sound, where unzip is installed. */
function unzipAgrees(zip: Uint8Array): boolean | undefined {
  if (spawnSync("unzip", ["-v"]).error) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  try {
    writeFileSync(join(dir, "a.zip"), zip);
    return spawnSync("unzip", ["-tq", join(dir, "a.zip")]).status === 0;
  } finally {
    rmSync(dir, { recursive: true });
  }
}

const text = (value: string) => new Blob([value]).stream();

describe("zipStream", () => {
  it("stores each file with its name and CRC, readable by unzip", async () => {
    const zip = await bytes(
      zipStream([
        { name: "q3/sales.csv", open: async () => ({ modified: new Date(Date.UTC(2026, 10, 3, 9, 30, 12)), size: 9, body: text("a,b\n1,2\n\n") }) },
        { name: "q3/2024/empty.txt", open: async () => ({ modified: new Date(0), size: 0, body: text("") }) },
        { name: "q3/gone.txt", open: async () => null },
      ]),
    );
    expect(readZip(zip)).toEqual(
      new Map([
        ["q3/sales.csv", "a,b\n1,2\n\n"],
        ["q3/2024/empty.txt", ""],
      ]),
    );
    expect(unzipAgrees(zip) ?? true).toBe(true);
  });

  it("fails the stream when a file is not the size it said", async () => {
    const zip = zipStream([{ name: "a.txt", open: async () => ({ modified: new Date(), size: 3, body: text("abcd") }) }]);
    await expect(bytes(zip)).rejects.toThrow(/changed/);
  });

  it("fails the stream when a file cannot be opened, and gives back a file opened ahead when the reader goes away", async () => {
    const failing = zipStream([
      { name: "a.txt", open: async () => ({ modified: new Date(), size: 1, body: text("a") }) },
      { name: "b.txt", open: async () => Promise.reject(new Error("R2 is down")) },
    ]);
    await expect(bytes(failing)).rejects.toThrow("R2 is down");

    let cancelled = false;
    const ahead = new ReadableStream<Uint8Array>({ cancel: () => void (cancelled = true) });
    const zip = zipStream([
      { name: "a.txt", open: async () => ({ modified: new Date(), size: 1, body: text("a") }) },
      { name: "b.txt", open: async () => ({ modified: new Date(), size: 1, body: ahead }) },
    ]);
    const reader = zip.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it("gives back the file being written when the reader goes away after its header", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => void (cancelled = true) });
    const reader = zipStream([{ name: "a.txt", open: async () => ({ modified: new Date(), size: 1, body }) }]).getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it("dates entries in DOS time, from 1980 on", () => {
    expect(dosDateTime(new Date(Date.UTC(2026, 10, 3, 9, 30, 12)))).toEqual({ time: (9 << 11) | (30 << 5) | 6, date: (46 << 9) | (11 << 5) | 3 });
    expect(dosDateTime(new Date(0))).toEqual({ time: 0, date: (1 << 5) | 1 });
  });
});

describe("file and folder downloads", () => {
  async function route(path: string, bucket: FakeBucket): Promise<Response> {
    const files = new UserFiles(bucket.r2, "ada", await deriveUserKey(MASTER, "ada"));
    return (await filesRoute(new Request(`https://app.test${path}`), async () => files))!;
  }

  const bucket = () => {
    const b = new FakeBucket();
    b.objects.set("users/ada/files/uploads/q3/sales.csv", "a,b\n");
    b.objects.set("users/ada/files/uploads/q3/2024/old sales.csv", "c,d\n");
    b.objects.set("users/ada/files/uploads/q3/chart.png", "png");
    b.objects.set("users/ada/files/out/page.html", "<p>hi</p>");
    b.objects.set("users/ada/files/out/report.pdf", "%PDF");
    b.objects.set("users/ada/files/out/notes.md", "# Notes");
    b.objects.set("users/ada/files/out/blob.bin", "bytes");
    b.objects.set("users/ada/files/uploads/q30/other.csv", "no");
    b.objects.set("users/bob/files/uploads/q3/secret.csv", "bob's");
    return b;
  };

  it("opens an image in the browser, sandboxed", async () => {
    const response = await route(api.fileUrl("uploads/q3/chart.png"), bucket());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="chart.png"');
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("png");
  });

  it("downloads any other file", async () => {
    const csv = await route(api.fileUrl("uploads/q3/2024/old sales.csv"), bucket());
    expect(csv.headers.get("content-type")).toBe("application/octet-stream");
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="old sales.csv"');
    expect(await csv.text()).toBe("c,d\n");
  });

  it("shows a file of a kind the preview knows when asked to view it, and downloads the rest", async () => {
    const page = await route(api.fileViewUrl("out/page.html"), bucket());
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-disposition")).toBe('inline; filename="page.html"');
    // Sandboxed with the artifact policy: an opaque origin with no network of its own, even opened in a tab.
    const policy = page.headers.get("content-security-policy")!;
    // Scripts only: no popups, which would escape the sandbox.
    expect(policy).toMatch(/^sandbox allow-scripts; /);
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("connect-src 'none'");
    expect(await page.text()).toBe("<p>hi</p>");

    const pdf = await route(api.fileViewUrl("out/report.pdf"), bucket());
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-security-policy")).toContain("default-src 'none'");

    const notes = await route(api.fileViewUrl("out/notes.md"), bucket());
    expect(notes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(notes.headers.get("content-security-policy")).toContain("sandbox");

    const image = await route(api.fileViewUrl("uploads/q3/chart.png"), bucket());
    expect(image.headers.get("content-type")).toBe("image/png");

    const other = await route(api.fileViewUrl("out/blob.bin"), bucket());
    expect(other.headers.get("content-type")).toBe("application/octet-stream");
    expect(other.headers.get("content-disposition")).toBe('attachment; filename="blob.bin"');

    // Without asking to view it, a page downloads as before.
    const download = await route(api.fileUrl("out/page.html"), bucket());
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="page.html"');
  });

  it("answers a byte range, as players ask for sound and video", async () => {
    const b = bucket();
    b.objects.set("users/ada/files/out/clip.mp4", "0123456789");
    const get = async (range: string) => {
      const files = new UserFiles(b.r2, "ada", await deriveUserKey(MASTER, "ada"));
      return (await filesRoute(new Request(`https://app.test${api.fileViewUrl("out/clip.mp4")}`, { headers: { range } }), async () => files))!;
    };
    const part = await get("bytes=2-5");
    expect(part.status).toBe(206);
    expect(part.headers.get("content-type")).toBe("video/mp4");
    // Its own player page (opened in a tab) loads it from its URL, which a sandbox would forbid.
    expect(part.headers.get("content-security-policy")).toBe("default-src 'none'; media-src 'self'; style-src 'unsafe-inline'");
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("content-length")).toBe("4");
    expect(await part.text()).toBe("2345");
    const rest = await get("bytes=7-");
    expect([rest.headers.get("content-range"), await rest.text()]).toEqual(["bytes 7-9/10", "789"]);
    const tail = await get("bytes=-3");
    expect([tail.headers.get("content-range"), await tail.text()]).toEqual(["bytes 7-9/10", "789"]);
    const past = await get("bytes=8-50");
    expect([past.headers.get("content-range"), await past.text()]).toEqual(["bytes 8-9/10", "89"]);
    const beyond = await get("bytes=10-");
    expect([beyond.status, beyond.headers.get("content-range")]).toEqual([416, "bytes */10"]);
    // Several ranges, or none that parses, get the whole file.
    const whole = await get("bytes=0-1,4-5");
    expect([whole.status, await whole.text()]).toEqual([200, "0123456789"]);
    expect((await get("bytes=5-2")).status).toBe(200);
  });

  it("zips a folder under its own name, with only what is inside it, and only the user's", async () => {
    const response = await route(api.folderZipUrl("uploads/q3"), bucket());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="q3.zip"');
    const zip = new Uint8Array(await response.arrayBuffer());
    expect(readZip(zip)).toEqual(
      new Map([
        ["q3/sales.csv", "a,b\n"],
        ["q3/2024/old sales.csv", "c,d\n"],
        ["q3/chart.png", "png"],
      ]),
    );
    expect(unzipAgrees(zip) ?? true).toBe(true);
  });

  async function pick(bucket: FakeBucket, fields: [string, string][] | FormData): Promise<Response> {
    const files = new UserFiles(bucket.r2, "ada", await deriveUserKey(MASTER, "ada"));
    const body = fields instanceof FormData ? fields : new URLSearchParams(fields);
    const request = new Request(`https://app.test${ZIP_ROUTE}`, { method: "POST", body });
    return (await filesRoute(request, async () => files))!;
  }

  it("zips picked files and folders under the folder holding them, each file once", async () => {
    const b = bucket();
    b.objects.set("users/ada/files/out/report.json", "{}");
    const response = await pick(b, [
      ["file", "uploads/q3/sales.csv"],
      ["folder", "uploads/q3/2024"],
      ["file", "uploads/q3/2024/old sales.csv"],
    ]);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="q3.zip"');
    expect(readZip(new Uint8Array(await response.arrayBuffer()))).toEqual(
      new Map([
        ["q3/2024/old sales.csv", "c,d\n"],
        ["q3/sales.csv", "a,b\n"],
      ]),
    );
    const across = await pick(b, [
      ["file", "out/report.json"],
      ["file", "uploads/q3/chart.png"],
      ["file", "uploads/gone.csv"],
    ]);
    expect(across.headers.get("content-disposition")).toBe('attachment; filename="files.zip"');
    expect([...readZip(new Uint8Array(await across.arrayBuffer())).keys()]).toEqual(["out/report.json", "uploads/q3/chart.png"]);
    // A folder inside another picked folder is listed once.
    const nested = await pick(b, [
      ["folder", "uploads/q3"],
      ["folder", "uploads/q3/2024"],
      ["folder", "uploads/q3"],
    ]);
    expect(nested.headers.get("content-disposition")).toBe('attachment; filename="q3.zip"');
    expect([...readZip(new Uint8Array(await nested.arrayBuffer())).keys()]).toEqual(["q3/2024/old sales.csv", "q3/chart.png", "q3/sales.csv"]);
  });

  it("refuses an empty pick, one that climbs, or one of only missing files", async () => {
    expect((await pick(bucket(), [])).status).toBe(400);
    await expect(pick(bucket(), [["file", "../bob/files/secret.csv"]])).rejects.toThrow(/not allowed|Invalid/);
    expect((await pick(bucket(), [["folder", "uploads/nope"]])).status).toBe(404);
    // A file sent as a folder field is no path, not the top of every file.
    const form = new FormData();
    form.append("folder", new File(["x"], "x.txt"));
    await expect(pick(bucket(), form)).rejects.toThrow(/empty/);
  });

  it("names a pick after the deepest folder holding it all", () => {
    expect(commonFolder(["uploads/q3/a.csv"], ["uploads/q3/2024"])).toBe("uploads/q3");
    expect(commonFolder(["uploads/q3/a.csv", "uploads/q4/b.csv"], [])).toBe("uploads");
    expect(commonFolder(["uploads/a.csv", "out/b.json"], [])).toBe("");
    expect(commonFolder([], ["uploads/q3/2024"])).toBe("uploads/q3/2024");
    expect(commonFolder([], ["uploads/q3", "uploads/q4"])).toBe("uploads");
  });

  it("zips a folder of exactly the most files a zip holds, and refuses one more", async () => {
    const full = new FakeBucket();
    for (let i = 0; i < MAX_ZIP_FILES; i++) full.objects.set(`users/ada/files/uploads/many/${i}.txt`, "x");
    expect((await route(api.folderZipUrl("uploads/many"), full)).status).toBe(200);
    full.objects.set("users/ada/files/uploads/many/one-more.txt", "x");
    const over = await route(api.folderZipUrl("uploads/many"), full);
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: string }).error).toMatch(/Too many files/);
  });

  it("answers 404 for a missing file or folder, and 400 for a path that climbs", async () => {
    expect((await route(api.fileUrl("uploads/nope.csv"), bucket())).status).toBe(404);
    expect((await route(api.fileUrl("uploads/q3"), bucket())).status).toBe(404);
    expect((await route(api.folderZipUrl("uploads/nope"), bucket())).status).toBe(404);
    await expect(route("/api/files/raw/uploads/..%2F..%2Fbob/files/x", bucket())).rejects.toThrow(/not allowed|Invalid/);
    await expect(route("/api/files/zip/%E0%A4%A", bucket())).rejects.toThrow(/Invalid path/);
  });

  it("opens only images in the browser", () => {
    expect(previewType("uploads/a.PNG")).toBe("image/png");
    expect(previewType("uploads/a.svg")).toBe("image/svg+xml");
    expect(previewType("uploads/page.html")).toBeUndefined();
    expect(previewType("uploads/png")).toBeUndefined();
    expect(previewType("uploads/x.png/readme")).toBeUndefined();
    expect(previewType("uploads/.png")).toBeUndefined();
    expect(previewType("uploads/a.constructor")).toBeUndefined();
  });

  it("knows how to preview a file by its extension", () => {
    expect(previewKind("out/a.HTML")).toBe("html");
    expect(previewKind("notes/index.md")).toBe("markdown");
    expect(previewKind("out/budget.sql")).toBe("text");
    expect(previewKind("out/all.js")).toBe("text");
    expect(previewKind("out/sales.csv")).toBe("table");
    expect(previewKind("out/a.pdf")).toBe("pdf");
    expect(previewKind("out/a.svg")).toBe("image");
    expect(previewKind("out/a.mp3")).toBe("audio");
    expect(previewKind("out/a.webm")).toBe("video");
    expect(viewType("out/a.mov")).toBe("video/quicktime");
    // Page and script fragments read as text: a fragment of a page never runs. Encoded data is no known kind (the
    // preview still shows it when it is text), so it stays out of the model's attachments.
    expect(previewKind("out/page.htmlpart")).toBe("text");
    expect(previewKind("out/script.jsblock")).toBe("text");
    expect(previewKind("out/data.b64")).toBeUndefined();
    expect(previewKind("out/Makefile")).toBeUndefined();
    expect(previewKind("out/a.constructor")).toBeUndefined();
    expect(viewType("out/a.sql")).toBe("text/plain; charset=utf-8");
    expect(viewType("out/a.zip")).toBeUndefined();
  });
});

describe("uploads into someone else's files", () => {
  const upload = (names: string[]) => {
    const form = new FormData();
    for (const name of names) form.append("file", new File([`new ${name}`], name));
    return new Request("https://app.test/api/chats/c1/attachments", { method: "POST", body: form });
  };

  it("keep each file beside one of the same name, where the owner's own upload replaces it", async () => {
    const bucket = new FakeBucket();
    bucket.objects.set("users/ada/files/uploads/budget.xlsx", "ada's");
    bucket.objects.set("users/ada/files/uploads/budget-2.xlsx", "ada's too");
    const files = new UserFiles(bucket.r2, "ada", await deriveUserKey(MASTER, "ada"));

    const beside = await storeUpload(upload(["budget.xlsx", "budget.xlsx", "notes.md"]), async () => files, true);
    expect(await beside.json()).toEqual({ paths: ["uploads/budget-3.xlsx", "uploads/budget-4.xlsx", "uploads/notes.md"] });
    expect(await (await files.get("uploads/budget.xlsx"))!.text()).toBe("ada's");

    const own = await storeUpload(upload(["budget.xlsx"]), async () => files);
    expect(await own.json()).toEqual({ paths: ["uploads/budget.xlsx"] });
    // The fake keeps a streamed body as "": the owner's file was put over.
    expect(await (await files.get("uploads/budget.xlsx"))!.text()).toBe("");
  });
});

describe("deleting files", () => {
  const bucket = () => {
    const b = new FakeBucket();
    b.objects.set("users/ada/files/uploads/q3/sales.csv", "a");
    b.objects.set("users/ada/files/uploads/q3/2024/old.csv", "b");
    b.objects.set("users/ada/files/uploads/q30/other.csv", "c");
    b.objects.set("users/ada/files/out/c1/report.md", "d");
    b.objects.set("users/ada/files/out/c1/chart.png", "e");
    b.objects.set("users/bob/files/uploads/q3/secret.csv", "bob's");
    return b;
  };
  const remove = async (b: FakeBucket, body: unknown, contentType = "application/json") => {
    const files = new UserFiles(b.r2, "ada", await deriveUserKey(MASTER, "ada"));
    const request = new Request("https://app.test/api/files", {
      method: "DELETE",
      headers: { "content-type": contentType },
      body: JSON.stringify(body),
    });
    return (await filesRoute(request, async () => files))!;
  };
  const left = (b: FakeBucket) => [...b.objects.keys()].sort();

  it("deletes picked files and folders, everything under a folder and nothing beside it, only the user's", async () => {
    const b = bucket();
    // sales.csv and 2024/ are in a picked folder too: deleting them again is harmless.
    const response = await remove(b, { files: ["out/c1/report.md", "uploads/q3/sales.csv"], folders: ["uploads/q3", "uploads/q3/2024"] });
    expect(response.status).toBe(200);
    expect(left(b)).toEqual(["users/ada/files/out/c1/chart.png", "users/ada/files/uploads/q30/other.csv", "users/bob/files/uploads/q3/secret.csv"]);
  });

  it("deletes a folder of more files than one listing holds", async () => {
    const b = new FakeBucket();
    for (let i = 0; i < 2_500; i++) b.objects.set(`users/ada/files/out/big/${i}.txt`, "x");
    b.objects.set("users/ada/files/out/keep.txt", "x");
    expect((await remove(b, { folders: ["out/big"] })).status).toBe(200);
    expect(left(b)).toEqual(["users/ada/files/out/keep.txt"]);
  });

  it("refuses an empty pick, a path that climbs or names every file, and a body that is not JSON, deleting nothing", async () => {
    const b = bucket();
    expect((await remove(b, { files: [], folders: [] })).status).toBe(400);
    expect((await remove(b, { files: "uploads/q3/sales.csv" })).status).toBe(400);
    // A form another site could post is not read.
    expect((await remove(b, { files: ["uploads/q3/sales.csv"] }, "text/plain")).status).toBe(400);
    await expect(remove(b, { folders: ["../bob/files"] })).rejects.toThrow(/not allowed|Invalid/);
    await expect(remove(b, { folders: [""] })).rejects.toThrow(/empty/);
    await expect(remove(b, { folders: ["/"] })).rejects.toThrow(/relative/);
    await expect(remove(b, { folders: [{}] })).rejects.toThrow(/empty/);
    // A bad path anywhere in the pick stops it all.
    await expect(remove(b, { files: ["uploads/q3/sales.csv", "../x"] })).rejects.toThrow(/not allowed|Invalid/);
    expect(left(b)).toEqual(left(bucket()));
  });
});
