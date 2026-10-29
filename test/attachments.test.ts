import { describe, expect, it } from "vitest";
import { FILE_TEXT_CHARS, IMAGE_BASE64, IMAGES_BASE64, imageBudget, MAX_ATTACHMENTS, TEXT_CHARS } from "../shared/attachments.ts";
import { attachmentContent, parseAttachments, withoutImageData, type AttachmentFiles } from "../worker/agent/attachments.ts";

/** Files by path, read the way UserFiles reads them: a range cuts the bytes, the size is always the whole file's. */
function files(contents: Record<string, string | Uint8Array>): AttachmentFiles & { reads: { path: string; range?: { offset: number; length: number } }[] } {
  const reads: { path: string; range?: { offset: number; length: number } }[] = [];
  return {
    reads,
    async get(path, range) {
      reads.push({ path, range });
      const value = contents[path];
      if (value === undefined) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const cut = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
      return { size: bytes.byteLength, arrayBuffer: async () => cut.buffer.slice(cut.byteOffset, cut.byteOffset + cut.byteLength) as ArrayBuffer };
    },
  };
}

const PNG = { data: "iVBORw0KGgo=", mimeType: "image/png" };
const THUMB = "data:image/jpeg;base64,/9j/4AAQ";

describe("attachments", () => {
  it("gives the model an image as an image, introduced by its path, and records its thumbnail", async () => {
    const { content, attachments } = await attachmentContent([{ path: "uploads/cat.png", image: PNG, thumb: THUMB }], files({ "uploads/cat.png": "x".repeat(2048) }));
    expect(content).toEqual([
      { type: "text", text: "[Attached image: uploads/cat.png, 2.0 KB]" },
      { type: "image", ...PNG },
    ]);
    expect(attachments).toEqual([{ path: "uploads/cat.png", size: 2048, shown: "image", thumb: THUMB }]);
  });

  it("gives a text file as its text, and reads only as much of it as it can show", async () => {
    const store = files({ "uploads/q3/sales.csv": "region,total\nEU,12\n" });
    const { content, attachments } = await attachmentContent([{ path: "uploads/q3/sales.csv" }], store);
    expect(content).toEqual([{ type: "text", text: '<attachment path="uploads/q3/sales.csv" size="19 B">\nregion,total\nEU,12\n\n</attachment>' }]);
    expect(attachments[0].shown).toBe("text");
    expect(store.reads[0].range).toEqual({ offset: 0, length: FILE_TEXT_CHARS * 4 });
  });

  it("cuts a long text file, and says where the whole file is", async () => {
    const { content } = await attachmentContent([{ path: "uploads/big.log" }], files({ "uploads/big.log": "q".repeat(FILE_TEXT_CHARS + 10) }));
    const text = (content[0] as { text: string }).text;
    expect(text).toContain("… [cut here; the whole file is uploads/big.log]");
    expect(text.match(/q+/)![0].length).toBe(FILE_TEXT_CHARS);
  });

  it("shares the text budget across a message's files, naming the ones past it", async () => {
    const big = "b".repeat(FILE_TEXT_CHARS);
    const { content, attachments } = await attachmentContent(
      [{ path: "uploads/1.txt" }, { path: "uploads/2.txt" }, { path: "uploads/3.txt" }],
      files({ "uploads/1.txt": big, "uploads/2.txt": big, "uploads/3.txt": big }),
    );
    const shown = content.map((block) => (block as { text: string }).text.match(/b+/)?.[0].length ?? 0);
    expect(shown).toEqual([FILE_TEXT_CHARS, TEXT_CHARS - FILE_TEXT_CHARS, 0]);
    expect(attachments.map((a) => a.shown)).toEqual(["text", "text", "path"]);
  });

  it("converts a PDF to Markdown, and names it only when that fails or no converter is there", async () => {
    const pdf = files({ "uploads/report.pdf": new Uint8Array([37, 80, 68, 70]) });
    const converted = await attachmentContent([{ path: "uploads/report.pdf" }], pdf, async (name, bytes) => `# ${name} (${bytes.byteLength} bytes)`);
    expect(converted.content).toEqual([{ type: "text", text: '<attachment path="uploads/report.pdf" size="4 B" converted="markdown">\n# report.pdf (4 bytes)\n</attachment>' }]);
    expect(pdf.reads[0].range).toBeUndefined();

    const failing = await attachmentContent([{ path: "uploads/report.pdf" }], pdf, async () => {
      throw new Error("down");
    });
    expect(failing.attachments[0].shown).toBe("path");
    expect((failing.content[0] as { text: string }).text).toContain("converting it to text failed");
    expect((await attachmentContent([{ path: "uploads/report.pdf" }], pdf)).attachments[0].shown).toBe("path");
  });

  it("names other files, and a missing one, without reading them", async () => {
    const store = files({ "uploads/data.zip": new Uint8Array(10) });
    const { content, attachments } = await attachmentContent([{ path: "uploads/data.zip" }, { path: "uploads/gone.txt" }], store);
    expect(content.map((block) => (block as { text: string }).text)).toEqual([
      "[Attached file: uploads/data.zip, 10 B. Not shown: the model cannot take this kind of file directly. It is in the user's files.]",
      "[Attached file uploads/gone.txt was not found in the user's files.]",
    ]);
    expect(attachments).toEqual([{ path: "uploads/data.zip", size: 10, shown: "path" }]);
    expect(store.reads[0].range).toEqual({ offset: 0, length: 1 });
  });

  it("names a binary file with a text extension rather than show it as text", async () => {
    const { attachments } = await attachmentContent([{ path: "uploads/odd.txt" }], files({ "uploads/odd.txt": new Uint8Array([0, 1, 2]) }));
    expect(attachments[0].shown).toBe("path");
  });

  it("refuses an image that is not base64 of a type providers take, or over the budgets", async () => {
    const store = files({ "uploads/a.png": "x", "uploads/b.png": "x", "uploads/c.png": "x" });
    const bad = await attachmentContent([{ path: "uploads/a.png", image: { data: "<svg/>", mimeType: "image/png" } }], store);
    expect(bad.attachments[0].shown).toBe("path");
    const svg = await attachmentContent([{ path: "uploads/a.png", image: { data: PNG.data, mimeType: "image/svg+xml" } }], store);
    expect(svg.attachments[0].shown).toBe("path");

    const large = { data: "A".repeat(IMAGE_BASE64), mimeType: "image/jpeg" };
    const over = await attachmentContent(
      [
        { path: "uploads/a.png", image: large },
        { path: "uploads/b.png", image: large },
        { path: "uploads/c.png", image: { data: "A".repeat(IMAGE_BASE64 + 4), mimeType: "image/jpeg" } },
      ],
      store,
    );
    // The first fits; the second would take the message past IMAGES_BASE64; the third is over IMAGE_BASE64 itself.
    expect(IMAGE_BASE64 * 2).toBeGreaterThan(IMAGES_BASE64);
    expect(over.attachments.map((a) => a.shown)).toEqual(["image", "path", "path"]);
  });

  it("gives each of a message's images a share of the budget", () => {
    expect(imageBudget(1)).toBe(IMAGE_BASE64);
    expect(imageBudget(4) * 4).toBeLessThanOrEqual(IMAGES_BASE64);
  });

  it("checks what the browser sends", () => {
    expect(parseAttachments(undefined)).toEqual([]);
    expect(() => parseAttachments("uploads/a.png")).toThrow();
    expect(() => parseAttachments([{}])).toThrow();
    expect(() => parseAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ path: "a" })))).toThrow();
    // A thumbnail must be a small image data URL: anything else is dropped.
    expect(parseAttachments([{ path: "uploads/a.png", thumb: "javascript:alert(1)" }])).toEqual([{ path: "uploads/a.png", image: undefined, thumb: undefined }]);
    expect(parseAttachments([{ path: "uploads/a.png", image: PNG, thumb: THUMB }])).toEqual([{ path: "uploads/a.png", image: PNG, thumb: THUMB }]);
  });
});

describe("withoutImageData", () => {
  it("empties image data anywhere in an event, and leaves everything else as it is", () => {
    const text = { type: "text", text: "hi" };
    const event = {
      type: "snapshot",
      entries: [
        { id: 1, model: [{ role: "user", content: [text, { type: "image", data: "AAAA", mimeType: "image/png" }] }] },
        { id: 2, model: [{ role: "assistant", content: [text] }] },
      ],
    };
    const stripped = withoutImageData(event);
    expect(stripped.entries[0].model[0].content[1]).toEqual({ type: "image", data: "", mimeType: "image/png" });
    expect(event.entries[0].model[0].content[1]).toHaveProperty("data", "AAAA");
    // Untouched parts are the same objects: nothing to copy.
    expect(stripped.entries[1]).toBe(event.entries[1]);
    const plain = { type: "message_update", changes: [{ type: "text_delta", delta: "x" }] };
    expect(withoutImageData(plain)).toBe(plain);
  });
});
