import { describe, expect, it } from "vitest";
import { grammarFor, highlight } from "../src/files/highlight.ts";
import { parseTable, readText, resolveLink } from "../src/files/preview.ts";

const stream = (...chunks: (string | Uint8Array)[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      controller.close();
    },
  });

describe("file preview", () => {
  it("reads text up to a limit, and tells binary from text", async () => {
    expect(await readText(stream("héllo ", "world"))).toEqual({ text: "héllo world", cut: false });
    expect(await readText(stream("abcdef", "ghi"), 4)).toEqual({ text: "abcd", cut: true });
    expect(await readText(stream("abcd"), 4)).toEqual({ text: "abcd", cut: false });
    // "é" split across two chunks still decodes.
    const e = new TextEncoder().encode("é");
    expect(await readText(stream(e.subarray(0, 1), e.subarray(1)))).toEqual({ text: "é", cut: false });
    expect(await readText(stream(new Uint8Array([0x50, 0x4b, 0x00, 0x03])))).toBeNull();
    expect(await readText(stream(new Uint8Array([0xff, 0xfe, 0x41])))).toBeNull();
    // A file ending in half a character is not UTF-8 text.
    expect(await readText(stream(e.subarray(0, 1)))).toBeNull();
  });

  it("resolves a file's links among the user's files", () => {
    expect(resolveLink("notes/wiki/a.md", "b.md")).toBe("notes/wiki/b.md");
    expect(resolveLink("notes/wiki/a.md", "../raw/c%20d.png")).toBe("notes/raw/c d.png");
    expect(resolveLink("notes/wiki/a.md", "./b.md#part")).toBe("notes/wiki/b.md");
    expect(resolveLink("notes/wiki/a.md", "/out/x.html")).toBe("out/x.html");
    expect(resolveLink("a.md", "../../etc/passwd")).toBeNull();
    for (const href of ["https://x.test/a.md", "mailto:a@b.test", "javascript:alert(1)", "//x.test/a", "#top", "?q", "%E0%A4%A"]) {
      expect(resolveLink("notes/a.md", href)).toBeNull();
    }
  });

  it("parses CSV and TSV, quoted fields included", () => {
    expect(parseTable('a,b\n1,"x, ""y"""\r\n2,"multi\nline"\n', ",").rows).toEqual([
      ["a", "b"],
      ["1", 'x, "y"'],
      ["2", "multi\nline"],
    ]);
    expect(parseTable("a\tb\n1\t2", "\t").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseTable("h\n1\n2\n3\n", ",", 2)).toEqual({ rows: [["h"], ["1"]], cut: true });
    expect(parseTable("h\n1\n", ",", 2)).toEqual({ rows: [["h"], ["1"]], cut: false });
  });

  it("highlights code by extension or a code block's language, escaping the code's own markup", async () => {
    expect(grammarFor("sql")).toBe("sql");
    expect(grammarFor("PY")).toBe("python");
    expect(grammarFor("tsx")).toBe("typescript");
    expect(grammarFor("Makefile")).toBe("makefile");
    expect(grammarFor("htmlpart")).toBe("xml");
    expect(grammarFor("jsblock")).toBe("javascript");
    expect(grammarFor("txt")).toBeUndefined();
    expect(grammarFor("constructor")).toBeUndefined();
    const html = await highlight('const a = "<img src=x onerror=alert(1)>";', "javascript");
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });
});
