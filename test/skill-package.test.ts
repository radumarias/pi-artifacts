import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { collapseSkillFiles, inlineSkillFiles, parseSkillRef, skillFilesNote, skillRefs } from "../shared/skill-files.ts";
import { SkillError, type SkillInfo } from "../shared/skills.ts";
import { MAX_SKILL_FILE_READ, skillSource } from "../worker/agent/skills.ts";
import { readSkillPackage } from "../worker/skills/package.ts";
import { SkillFiles } from "../worker/storage/skill-files.ts";
import { unzip, UnzipError } from "../worker/unzip.ts";
import { FakeBucket } from "./fakes.ts";

/** A zip as zip tools write it: each file deflated (or stored), local headers, then the central directory. */
function zip(files: Record<string, string | Uint8Array>, { store = false, lie = false } = {}): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const header = (signature: number, size: number) => {
      const b = Buffer.alloc(size);
      b.writeUInt32LE(signature, 0);
      return b;
    };
    const local = header(0x04034b50, 30);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(lie ? 1 : data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = header(0x02014b50, 46);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(store ? 0 : 8, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(lie ? 1 : data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

const SKILL_MD = "---\nname: quiet-kit\ndescription: Use for dashboards.\n---\nCopy dist/ next to the page.\n";
const limits = { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 2000 };

describe("unzip", () => {
  it("reads deflated and stored files and leaves folders out", async () => {
    for (const store of [false, true]) {
      const files = await unzip(zip({ "a/": "", "a/b.txt": "hello ".repeat(20), "c.js": "x" }, { store }), limits);
      expect(files.map((f) => [f.name, new TextDecoder().decode(f.bytes)])).toEqual([
        ["a/b.txt", "hello ".repeat(20)],
        ["c.js", "x"],
      ]);
    }
  });

  it("refuses what is not a zip, too many or too big files, and a file bigger than the zip says", async () => {
    await expect(unzip(new TextEncoder().encode("not a zip at all, sorry"), limits)).rejects.toThrow(UnzipError);
    await expect(unzip(zip(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, "x"]))), limits)).rejects.toThrow(/more than 10 files/);
    await expect(unzip(zip({ big: "x".repeat(1001) }), limits)).rejects.toThrow(/over the limit/);
    await expect(unzip(zip({ a: "x".repeat(900), b: "x".repeat(900), c: "x".repeat(900) }), limits)).rejects.toThrow(/more than the limit/);
    await expect(unzip(zip({ bomb: "x".repeat(900) }, { lie: true }), limits)).rejects.toThrow(/not the size/);
  });
});

describe("readSkillPackage", () => {
  it("finds the SKILL.md in the zip's one folder and keeps text files by their paths from there", async () => {
    const pkg = await readSkillPackage(
      zip({
        "quiet-kit/SKILL.md": SKILL_MD,
        "quiet-kit/dist/ds.js": "window.DS = {};",
        "quiet-kit/references/tokens.md": "# Tokens",
        "quiet-kit/assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
        "quiet-kit/.hidden": "x",
        "quiet-kit/odd+name.js": "x",
        "__MACOSX/quiet-kit/._SKILL.md": "x",
        "other/readme.txt": "x",
      }),
    );
    expect(pkg.markdown).toBe(SKILL_MD);
    expect(pkg.files.map((f) => [f.path, new TextDecoder().decode(f.bytes)])).toEqual([
      ["dist/ds.js", "window.DS = {};"],
      ["references/tokens.md", "# Tokens"],
    ]);
    expect(pkg.skipped).toEqual([
      "assets/logo.png (not a text file)",
      expect.stringMatching(/^odd\+name\.js \(a name with characters/),
      "other/readme.txt (outside the skill's folder)",
    ]);
  });

  it("refuses a zip without a SKILL.md, or one that is not a zip", async () => {
    await expect(readSkillPackage(zip({ "a.txt": "x" }))).rejects.toThrow(SkillError);
    await expect(readSkillPackage(new Uint8Array(40))).rejects.toThrow(SkillError);
  });
});

describe("skill file references", () => {
  const files: Record<string, string> = { "kit/dist/ds.js": "if (a <!-- b) x('</script>');", "kit/dist/ds.css": "a{content:'</style>'}" };
  const read = async ({ skill, path }: { skill: string; path: string }) => files[`${skill}/${path}`] ?? null;
  const page =
    '<head><link rel="stylesheet" href="skill:kit/dist/ds.css"><script type="module" src="skill:kit/dist/ds.js"></script>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"></head><body><script>DS()</script></body>';

  it("parses a reference as a skill name and a path inside it", () => {
    expect(parseSkillRef("kit/dist/ds.js")).toEqual({ skill: "kit", path: "dist/ds.js" });
    for (const bad of ["Kit/a.js", "kit", "kit/../x.js", "kit//a.js", "kit/./a.js"]) expect(parseSkillRef(bad)).toBeNull();
  });

  it("lists each file a page names once, and refuses one named anywhere but a script src or stylesheet href", () => {
    expect(skillRefs(page + '<script src="skill:kit/dist/ds.js"></script>')).toEqual([
      { skill: "kit", path: "dist/ds.css" },
      { skill: "kit", path: "dist/ds.js" },
    ]);
    expect(() => skillRefs('<img src="skill:kit/logo.svg">')).toThrow(/nowhere else/);
    expect(() => skillRefs('<script src="skill:kit"></script>')).toThrow(/Not a skill file: "skill:kit"/);
  });

  it("inlines the files so they cannot end their element early, and turns them back into references", async () => {
    const { html: full } = await inlineSkillFiles(page, read);
    expect(full).toContain(`<style data-skill-file="kit/dist/ds.css">a{content:'<\\/style>'}</style>`);
    expect(full).toContain(`<script data-skill-file="kit/dist/ds.js" type="module">if (a <\\!-- b) x('<\\/script>');</script>`);
    expect(full).toContain('<link rel="preconnect" href="https://fonts.googleapis.com">');
    expect(collapseSkillFiles(full)).toBe(
      '<head><link rel="stylesheet" href="skill:kit/dist/ds.css"><script type="module" src="skill:kit/dist/ds.js"></script>' +
        '<link rel="preconnect" href="https://fonts.googleapis.com"></head><body><script>DS()</script></body>',
    );
    expect(collapseSkillFiles(page)).toBe(page);
  });

  it("names every file it cannot find, and leaves a page that names none as it is", async () => {
    await expect(inlineSkillFiles('<script src="skill:kit/a.js"></script><script src="skill:kit/b.js"></script>', read)).rejects.toThrow(
      /skill:kit\/a\.js, skill:kit\/b\.js/,
    );
    expect((await inlineSkillFiles("<p>plain</p>", read)).html).toBe("<p>plain</p>");
  });

  it("maps the lines of the page as it runs to the lines of the page as written", async () => {
    const lines = { "kit/a.js": "one\ntwo\nthree", "kit/b.css": "x\ny" };
    const readLines = async ({ skill, path }: { skill: string; path: string }) => lines[`${skill}/${path}` as keyof typeof lines] ?? null;
    const written = 'line 1\n<script src="skill:kit/a.js"></script>\nline 3\n<link rel="stylesheet"\n href="skill:kit/b.css">\nline 6';
    const { html, pageLine } = await inlineSkillFiles(written, readLines);
    const at = (text: string) => html.slice(0, html.indexOf(text)).split("\n").length;
    expect([at("line 1"), at("two"), at("line 3"), at("y</style>"), at("line 6")].map(pageLine)).toEqual([1, 2, 3, 4, 6]);
  });

  it("keeps a module's type, quoted or not, and refuses a deferred classic script", async () => {
    const { html } = await inlineSkillFiles('<script type=module src="skill:kit/dist/ds.js"></script>', read);
    expect(html).toMatch(/^<script data-skill-file="kit\/dist\/ds\.js" type="module">/);
    expect(() => skillRefs('<script defer src="skill:kit/dist/ds.js"></script>')).toThrow(/defer does nothing/);
    expect(skillRefs('<script defer type="module" src="skill:kit/dist/ds.js"></script>')).toHaveLength(1);
  });

  it("counts only quoted skill:<name>/ values as references, so ordinary text is no reference", () => {
    expect(skillRefs(`<script>const label = "Skill: " + name; const tag = 'skill:level';</script>`)).toEqual([]);
  });

  it("leaves inlined a file that collapse says no to", async () => {
    const { html: full } = await inlineSkillFiles(page, read);
    const kept = collapseSkillFiles(full, ({ path }) => path !== "dist/ds.js");
    expect(kept).toContain('<link rel="stylesheet" href="skill:kit/dist/ds.css">');
    expect(kept).toContain('<script data-skill-file="kit/dist/ds.js" type="module">');
  });
});

describe("skillSource with files", () => {
  const kit: SkillInfo = {
    name: "quiet-kit",
    description: "Use for dashboards.",
    instructions: "Copy dist/.",
    tools: [],
    origin: "user",
    enabled: true,
    updatedAt: 2,
    files: [
      { path: "dist/ds.js", size: 100_000 },
      { path: "references/tokens.md", size: 8 },
      { path: "tools/build.py", size: 3 },
    ],
    fileSet: "0123456789abcdef",
  };
  const texts: Record<string, string> = { "dist/ds.js": "x".repeat(100_000), "references/tokens.md": "# Tokens" };
  const source = skillSource([kit], "v", async (_, path) => texts[path] ?? null);

  it("lists the files when the skill is activated, with how pages use them", async () => {
    const content = await source.load("quiet-kit");
    expect(content?.resources?.map((r) => [r.path, r.kind])).toEqual([
      ["dist/ds.js", "asset"],
      ["references/tokens.md", "reference"],
      ["tools/build.py", "script"],
    ]);
    expect(content?.body).toContain('<script src="skill:quiet-kit/<path>"></script>');
    expect(skillFilesNote("x", [])).toBe("");
  });

  it("reads a listed file, cutting a long one, and nothing it does not list", async () => {
    expect((await source.readResource!("quiet-kit", "references/tokens.md"))?.content).toBe("# Tokens");
    const long = await source.readResource!("quiet-kit", "dist/ds.js");
    expect(long?.content.length).toBeLessThan(MAX_SKILL_FILE_READ + 300);
    expect(long?.content).toContain("by reference, skill:quiet-kit/dist/ds.js");
    expect(await source.readResource!("quiet-kit", "secret.txt")).toBeNull();
    expect(await source.readResource!("quiet-kit", "tools/build.py")).toBeNull();
  });

  it("offers no files without a reader", async () => {
    const plain = await skillSource([kit], "v").load("quiet-kit");
    expect(plain?.resources).toBeUndefined();
    expect(plain?.body).toBe("Copy dist/.");
  });
});

describe("SkillFiles", () => {
  it("writes a set per import under the user's skills, encrypted, and drops the others", async () => {
    const bucket = new FakeBucket();
    const files = new SkillFiles(bucket.r2, "ada", new ArrayBuffer(32));
    const bytes = (text: string) => new TextEncoder().encode(text);
    const first = await files.write("kit", [{ path: "dist/ds.js", bytes: bytes("one") }]);
    const second = await files.write("kit", [{ path: "dist/ds.js", bytes: bytes("two") }]);
    expect(await files.read("kit", first, "dist/ds.js")).toBe("one");
    expect(await files.read("kit", second, "dist/ds.js")).toBe("two");
    expect(await files.read("kit", second, "../x")).toBeNull();
    expect(bucket.calls.filter((c) => c.op === "put").every((c) => c.key?.startsWith("users/ada/skills/kit/") && c.ssecKey)).toBe(true);
    await files.dropAllBut("kit", second);
    expect([...bucket.objects.keys()]).toEqual([`users/ada/skills/kit/${second}/dist/ds.js`]);
    await files.dropAllBut("kit");
    expect(bucket.objects.size).toBe(0);
  });
});
