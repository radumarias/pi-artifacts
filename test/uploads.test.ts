import { describe, expect, it } from "vitest";
import { freePath, isHidden, MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, MAX_UPLOAD_BYTES, uploadBatches, uploadPath } from "../shared/uploads.ts";
import { FileRefError, filesIndex, MAX_SANDBOX_FILES, resolveFile, resolveRef, sandboxLayout, sandboxPath } from "../worker/agent/file-refs.ts";
import { filesRoute } from "../worker/files-routes.ts";
import { deriveUserKey } from "../worker/storage/keys.ts";
import { normalisePath } from "../worker/storage/paths.ts";
import { UserFiles, type FileEntry } from "../worker/storage/user-files.ts";
import { FakeBucket } from "./fakes.ts";

describe("uploadPath", () => {
  it("keeps a file's name, or its path inside a folder, under uploads/", () => {
    expect(uploadPath("prices.csv")).toBe("uploads/prices.csv");
    expect(uploadPath("reports/q3/sales.csv")).toBe("uploads/reports/q3/sales.csv");
    expect(uploadPath("reports\\q3\\sales.csv")).toBe("uploads/reports/q3/sales.csv");
  });

  it("cleans each segment into a path the user's files accept", () => {
    for (const given of ["Café/notes (1).txt", "../../etc/passwd", "./a//b/", " .hidden/x.txt", "a?*/b|c.csv"]) {
      const path = uploadPath(given)!;
      expect(normalisePath(path)).toBe(path);
    }
    expect(uploadPath("../../etc/passwd")).toBe("uploads/etc/passwd");
    expect(uploadPath("Café/notes (1).txt")).toBe("uploads/Caf_/notes _1_.txt");
  });

  it("drops folders from the top of a path too long, never the file name", () => {
    const path = uploadPath(`${"a".repeat(100)}/${"b".repeat(100)}/data.csv`)!;
    expect(path).toBe(`uploads/${"b".repeat(100)}/data.csv`);
    expect(path.length).toBeLessThanOrEqual(200);
  });

  it("is null when nothing is left", () => {
    expect(uploadPath("../..")).toBeNull();
    expect(uploadPath("")).toBeNull();
  });
});

describe("upload helpers", () => {
  it("finds hidden files and folders", () => {
    expect(isHidden("project/.git/config")).toBe(true);
    expect(isHidden("project/.DS_Store")).toBe(true);
    expect(isHidden("project/src/main.py")).toBe(false);
  });

  it("numbers a path that is taken, before its extension", () => {
    expect(freePath("uploads/a.csv", new Set())).toBe("uploads/a.csv");
    expect(freePath("uploads/a.csv", new Set(["uploads/a.csv", "uploads/a-2.csv"]))).toBe("uploads/a-3.csv");
    expect(freePath("uploads/v1.2/README", new Set(["uploads/v1.2/README"]))).toBe("uploads/v1.2/README-2");
  });

  it("numbers a name at its longest without growing it past what uploadPath keeps", () => {
    for (const given of [`${"a".repeat(116)}.csv`, `${"x".repeat(60)}/${"y".repeat(60)}/${"z".repeat(66)}.csv`]) {
      const path = uploadPath(given)!;
      const free = freePath(path, new Set([path]));
      expect(free).toMatch(/-2\.csv$/);
      expect(uploadPath(free.slice("uploads/".length))).toBe(free);
    }
  });

  it("splits files into requests the Worker accepts", () => {
    const many = Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, () => ({ size: 1 }));
    expect(uploadBatches(many, (f) => f.size).map((b) => b.length)).toEqual([MAX_FILES_PER_UPLOAD, 1]);
    const big = Array.from({ length: 5 }, () => ({ size: MAX_FILE_BYTES }));
    const batches = uploadBatches(big, (f) => f.size);
    expect(batches.every((b) => b.reduce((sum, f) => sum + f.size, 0) <= MAX_UPLOAD_BYTES)).toBe(true);
    expect(batches.flat()).toHaveLength(5);
  });
});

const entry = (path: string, size = 10, uploaded = 0): FileEntry => ({ path, size, uploaded: new Date(uploaded) });
const files = [
  entry("uploads/prices.csv"),
  entry("uploads/reports/q3/sales.csv"),
  entry("uploads/reports/q4/sales.csv"),
  entry("uploads/reports/q4/notes.md"),
  entry("out/summary.json"),
].map((e, i) => ({ ...e, uploaded: new Date(i) }));

describe("resolveFile", () => {
  it("takes a path as it is", () => {
    expect(resolveFile(files, "uploads/prices.csv")).toBe("uploads/prices.csv");
  });

  it("matches a name or the end of a path to the one file it names, ignoring case", () => {
    expect(resolveFile(files, "prices.csv")).toBe("uploads/prices.csv");
    expect(resolveFile(files, "PRICES.CSV")).toBe("uploads/prices.csv");
    expect(resolveFile(files, "q3/sales.csv")).toBe("uploads/reports/q3/sales.csv");
    expect(resolveFile(files, "notes.md")).toBe("uploads/reports/q4/notes.md");
    expect(resolveFile(files, "/uploads/prices.csv")).toBe("uploads/prices.csv");
  });

  it("takes a path the agent saw inside the sandbox", () => {
    expect(resolveFile(files, "./files/q3/sales.csv")).toBe("uploads/reports/q3/sales.csv");
    expect(resolveFile(files, "files/out/summary.json")).toBe("out/summary.json");
  });

  it("names the candidates when a name matches several files", () => {
    expect(() => resolveFile(files, "sales.csv")).toThrow(/could be any of "uploads\/reports\/q3\/sales.csv", "uploads\/reports\/q4\/sales.csv"/);
  });

  it("does not match part of a name", () => {
    expect(() => resolveFile(files, "ices.csv")).toThrow(FileRefError);
  });

  it("suggests near misses", () => {
    expect(() => resolveFile(files, "prices.xlsx")).toThrow(/Similar: "uploads\/prices.csv"/);
  });

  it("refuses a folder", () => {
    expect(() => resolveFile(files, "q4")).toThrow(/is a folder/);
  });
});

describe("resolveRef", () => {
  it("expands a folder to every file in it", () => {
    expect(resolveRef(files, "reports/q4")).toEqual(["uploads/reports/q4/sales.csv", "uploads/reports/q4/notes.md"]);
    expect(resolveRef(files, "uploads/reports/")).toHaveLength(3);
  });

  it("takes a folder's full path even when another folder ends the same way", () => {
    const entry = (path: string): FileEntry => ({ path, size: 1, uploaded: new Date(0) });
    expect(resolveRef([entry("out/a.csv"), entry("uploads/out/b.csv")], "out")).toEqual(["out/a.csv"]);
  });

  it("names one file as a list of one", () => {
    expect(resolveRef(files, "prices.csv")).toEqual(["uploads/prices.csv"]);
  });

  it("throws for what it cannot find", () => {
    expect(() => resolveRef(files, "missing.csv")).toThrow(FileRefError);
    expect(() => resolveRef(files, "")).toThrow(FileRefError);
  });
});

describe("sandboxLayout", () => {
  it("puts files in their folders under ./files, without uploads/", () => {
    expect(sandboxPath("uploads/reports/q3/sales.csv")).toBe("reports/q3/sales.csv");
    expect(sandboxPath("out/summary.json")).toBe("out/summary.json");
    expect([...sandboxLayout(["uploads/prices.csv", "uploads/reports/q3/sales.csv", "uploads/reports/q4/sales.csv"])]).toEqual([
      ["prices.csv", "uploads/prices.csv"],
      ["reports/q3/sales.csv", "uploads/reports/q3/sales.csv"],
      ["reports/q4/sales.csv", "uploads/reports/q4/sales.csv"],
    ]);
  });

  it("refuses two files on one path, and a file where a folder must be", () => {
    expect(() => sandboxLayout(["uploads/a.csv", "a.csv"])).toThrow(/would both be .\/files\/a.csv/);
    expect(() => sandboxLayout(["uploads/data", "uploads/data/x.csv"])).toThrow(/needs a folder/);
  });

  it("caps the files of one run", () => {
    expect(() => sandboxLayout(Array.from({ length: MAX_SANDBOX_FILES + 1 }, (_, i) => `uploads/${i}.csv`))).toThrow(/at most/);
  });
});

describe("filesIndex", () => {
  it("lists the files newest first, with sizes", () => {
    const index = filesIndex(files);
    const lines = index.split("\n").slice(1);
    expect(lines[0]).toBe("out/summary.json\t10 B");
    expect(lines.at(-1)).toBe("uploads/prices.csv\t10 B");
  });

  it("says when there are none", () => {
    expect(filesIndex([])).toContain("no files yet");
  });

  it("cuts a long list and counts the files per folder", () => {
    const many = Array.from({ length: 400 }, (_, i) => entry(`uploads/batch/${i}.csv`, 2048, i));
    const index = filesIndex([...many, entry("uploads/one.csv")]);
    expect(index).toContain("uploads/batch/399.csv\t2.0 KB");
    expect(index).not.toContain("uploads/batch/0.csv");
    expect(index).toMatch(/and \d+ more/);
    expect(index).toContain("uploads/batch (400), uploads (1)");
    expect(index.length).toBeLessThan(8_000);
  });
});

describe("filesRoute", () => {
  const MASTER = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

  async function setup() {
    const bucket = new FakeBucket();
    const userFiles = new UserFiles(bucket.r2, "ada", await deriveUserKey(MASTER, "ada"));
    return { bucket, storage: async () => userFiles };
  }

  function upload(items: [content: string, path: string][]): Request {
    const form = new FormData();
    for (const [content, path] of items) {
      form.append("file", new File([content], path.split("/").pop()!));
      form.append("path", path);
    }
    return new Request("https://app.test/api/files", { method: "POST", body: form });
  }

  it("stores several files at once, keeping a folder's layout", async () => {
    const { bucket, storage } = await setup();
    const response = (await filesRoute(upload([["a", "prices.csv"], ["b", "reports/q3/sales.csv"]]), storage))!;
    expect(await response.json()).toEqual({ paths: ["uploads/prices.csv", "uploads/reports/q3/sales.csv"] });
    expect([...bucket.objects.keys()]).toEqual(["users/ada/files/uploads/prices.csv", "users/ada/files/uploads/reports/q3/sales.csv"]);
  });

  it("numbers files whose names clean up to the same path", async () => {
    const { storage } = await setup();
    const response = (await filesRoute(upload([["a", "a?.csv"], ["b", "a*.csv"]]), storage))!;
    expect(await response.json()).toEqual({ paths: ["uploads/a_.csv", "uploads/a_-2.csv"] });
  });

  it("refuses too many files, and a form without files", async () => {
    const { bucket, storage } = await setup();
    const many = Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, (_, i): [string, string] => ["x", `${i}.txt`]);
    expect((await filesRoute(upload(many), storage))!.status).toBe(413);
    const empty = new Request("https://app.test/api/files", { method: "POST", body: new FormData() });
    expect((await filesRoute(empty, storage))!.status).toBe(400);
    expect(bucket.objects.size).toBe(0);
  });

  it("leaves other routes alone", async () => {
    const { storage } = await setup();
    expect(await filesRoute(new Request("https://app.test/api/chats"), storage)).toBeUndefined();
  });
});
