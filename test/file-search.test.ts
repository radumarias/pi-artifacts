import { describe, expect, it } from "vitest";
import { fileMatcher } from "../src/files/search.ts";

const PATHS = ["test.txt", "notes/text.txt", "notes/Test.TXT", "notes/tests.txt", "a/b/test.md", "uploads/report 2026.csv", "x.txt.bak"];
const found = (query: string) => PATHS.filter(fileMatcher(query));

describe("Files search", () => {
  it("lists everything without a query", () => {
    expect(found("")).toEqual(PATHS);
    expect(found("   ")).toEqual(PATHS);
  });

  it("finds plain text anywhere in the path, ignoring case", () => {
    expect(found("TEST")).toEqual(["test.txt", "notes/Test.TXT", "notes/tests.txt", "a/b/test.md"]);
    expect(found("notes/")).toEqual(["notes/text.txt", "notes/Test.TXT", "notes/tests.txt"]);
    expect(found(" report 2026 ")).toEqual(["uploads/report 2026.csv"]);
  });

  it("matches * and ? against whole file names in every folder", () => {
    expect(found("*.txt")).toEqual(["test.txt", "notes/text.txt", "notes/Test.TXT", "notes/tests.txt"]);
    expect(found("te?t.txt")).toEqual(["test.txt", "notes/text.txt", "notes/Test.TXT"]);
    expect(found("*test*")).toEqual(["test.txt", "notes/Test.TXT", "notes/tests.txt", "a/b/test.md"]);
    expect(found("test.*")).toEqual(["test.txt", "notes/Test.TXT", "a/b/test.md"]);
    expect(found("????.txt")).toEqual(["test.txt", "notes/text.txt", "notes/Test.TXT"]);
  });

  it("takes the other pattern characters literally", () => {
    expect(found("x.txt*")).toEqual(["x.txt.bak"]);
    expect(found("x?txt")).toEqual([]);
    expect(found("report (2026).*")).toEqual([]);
    expect(fileMatcher("[ab]*.txt")("[ab]c.txt")).toBe(true);
    expect(fileMatcher("[ab]*.txt")("a.txt")).toBe(false);
    expect(fileMatcher("a+b?.txt")("a+bc.txt")).toBe(true);
  });

  it("matches a pattern with a slash against the whole path, * within one folder and ** across them", () => {
    expect(found("notes/*.txt")).toEqual(["notes/text.txt", "notes/Test.TXT", "notes/tests.txt"]);
    expect(found("*/test.*")).toEqual(["notes/Test.TXT"]);
    expect(found("a/*.md")).toEqual([]);
    // A ** inside a folder name is just a *.
    expect(found("a/**.md")).toEqual([]);
    expect(found("a/*/**.md")).toEqual(["a/b/test.md"]);
    expect(found("**/test.*")).toEqual(["test.txt", "notes/Test.TXT", "a/b/test.md"]);
    expect(found("a/**/test.md")).toEqual(["a/b/test.md"]);
    expect(fileMatcher("a/**/test.md")("a/test.md")).toBe(true);
    expect(fileMatcher("?/test.md")("a/b/test.md")).toBe(false);
    expect(fileMatcher("**")("a/b/test.md")).toBe(true);
    expect(fileMatcher("a/**")("a/b/test.md")).toBe(true);
    expect(fileMatcher("**/b/**")("a/b/test.md")).toBe(true);
    expect(fileMatcher("**/c/**")("a/b/test.md")).toBe(false);
  });

  it("stays fast on patterns that make a regular expression backtrack", () => {
    const name = `${"a".repeat(5_000)}.txt`;
    const started = performance.now();
    expect(fileMatcher("*a*a*a*a*a*a*a*a*z")(name)).toBe(false);
    expect(fileMatcher("**/*a*a*a*a*a*a*a*z/**")(`x/${name}/y`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
