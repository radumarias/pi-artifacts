import { crc32 as nodeCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkManifest, EXPORT_FORMAT, EXPORT_VERSION, idRemapper, importedArtifactId, type ChatDumpPart } from "../shared/data-export.ts";
import { bytesSource, readZipFile, zipDirectory } from "../shared/unzip.ts";
import { crc32, zipStream } from "../shared/zip.ts";
import { clearImported, DumpError, dumpChat, restorePart } from "../worker/chat-dump.ts";
import { memorySql } from "./fakes.ts";

const OLD = "0123456789abcdef0123456789abcdef";
const NEW = "fedcba9876543210fedcba9876543210";
const KV_KEYS = ["auto", "broughtIn"];

function memoryKv() {
  const map = new Map<string, unknown>();
  return { map, get: (key: string) => map.get(key), put: (key: string, value: unknown) => void map.set(key, value), delete: (key: string) => map.delete(key) };
}

/** A chat object's storage, roughly as pi, the Lifecycle and the chat's own tables leave it. */
function chatStorage() {
  const sql = memorySql();
  sql.db.exec(`
    CREATE TABLE pi_entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL CHECK (json_valid(record))) STRICT;
    CREATE INDEX pi_entries_by_conversation
			ON pi_entries (conversation_id, id DESC) WHERE conversation_id IS NOT NULL;
    CREATE TABLE pi_tasks_v2 (id INTEGER PRIMARY KEY, status TEXT NOT NULL, record TEXT NOT NULL) STRICT;
    ALTER TABLE pi_tasks_v2 RENAME TO pi_tasks;
    CREATE TABLE pi_blobs (id INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE chat_reactions (entry INTEGER NOT NULL, emoji TEXT NOT NULL, uid TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (entry, emoji, uid));
    CREATE TABLE chat_owner (uid TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE chat_members (uid TEXT PRIMARY KEY, name TEXT NOT NULL, joined_at INTEGER NOT NULL);
    CREATE TABLE cf_agents_jobs (id TEXT PRIMARY KEY);
  `);
  for (let id = 1; id <= 30; id++) {
    sql.exec(
      "INSERT INTO pi_entries (id, conversation_id, record) VALUES (?, 1, ?)",
      id,
      JSON.stringify({ kind: "chat.message", data: { uid: OLD, text: `message ${id} about artifact aaaabbbbccccdddd` } }),
    );
  }
  sql.exec("INSERT INTO pi_tasks VALUES (1, 'terminal', '{}')");
  sql.exec("INSERT INTO pi_tasks VALUES (2, 'running', '{\"tool\":\"write\"}')");
  sql.exec("INSERT INTO pi_blobs VALUES (1, ?)", new Uint8Array([0, 1, 2, 255]).buffer);
  sql.exec("INSERT INTO chat_reactions VALUES (3, 'thumbs', ?, 5)", OLD);
  sql.exec("INSERT INTO chat_owner VALUES (?, 'Ada')", OLD);
  sql.exec("INSERT INTO chat_members VALUES ('someone', 'Bea', 1)");
  sql.exec("INSERT INTO cf_agents_jobs VALUES ('wake')");
  const kv = memoryKv();
  kv.put("auto", true);
  kv.put("broughtIn", ["aaaabbbbccccdddd"]);
  kv.put("status", "running");
  return { sql, kv };
}

/** A new chat object: only the tables its constructor makes. */
function freshStorage() {
  const sql = memorySql();
  sql.db.exec(`
    CREATE TABLE chat_reactions (entry INTEGER NOT NULL, emoji TEXT NOT NULL, uid TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (entry, emoji, uid));
    CREATE TABLE chat_owner (uid TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE chat_members (uid TEXT PRIMARY KEY, name TEXT NOT NULL, joined_at INTEGER NOT NULL);
  `);
  return { sql, kv: memoryKv() };
}

function allParts(storage: ReturnType<typeof chatStorage>, budget?: number): ChatDumpPart[] {
  const parts: ChatDumpPart[] = [];
  let page = dumpChat(storage.sql, storage.kv, KV_KEYS, undefined, budget);
  parts.push(page.part);
  while (page.next) {
    page = dumpChat(storage.sql, storage.kv, KV_KEYS, page.next, budget);
    parts.push(page.part);
  }
  // As the browser carries them: JSON.
  return parts.map((part) => JSON.parse(JSON.stringify(part)) as ChatDumpPart);
}

describe("a chat's export", () => {
  it("carries the conversation, its reactions and settings, in parts, and nothing of its people, jobs or work in flight", () => {
    const parts = allParts(chatStorage(), 500);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts[0].kv).toEqual({ auto: true, broughtIn: ["aaaabbbbccccdddd"] });
    expect(parts.slice(1).every((part) => part.kv === undefined)).toBe(true);
    const tables = new Set(parts.flatMap((part) => part.tables.map((table) => table.name)));
    expect([...tables].sort()).toEqual(["chat_owner", "chat_reactions", "pi_blobs", "pi_entries", "pi_tasks"]);
    const rows = (name: string) => parts.flatMap((part) => part.tables.filter((table) => table.name === name).flatMap((table) => table.rows));
    expect(rows("pi_entries")).toHaveLength(30);
    expect(rows("pi_tasks")).toEqual([{ id: 1, status: "terminal", record: "{}" }]);
    expect(rows("pi_blobs")).toEqual([{ id: 1, data: { b64: "AAEC/w==" } }]);
    // The schema comes once, with a table's first rows: the table and its index.
    const schemas = parts.flatMap((part) => part.tables.filter((table) => table.name === "pi_entries" && table.schema));
    expect(schemas).toHaveLength(1);
    expect(schemas[0].schema).toHaveLength(2);
  });

  it("is restored in a new chat object with the importer's id and the artifacts' new ids in place of the old", () => {
    const parts = allParts(chatStorage(), 700);
    const target = freshStorage();
    const remap = idRemapper([
      [OLD, NEW],
      ["aaaabbbbccccdddd", "1111222233334444"],
    ]);
    for (const part of parts) restorePart(target.sql, target.kv, KV_KEYS, part, remap);
    const entries = target.sql.exec("SELECT record FROM pi_entries ORDER BY id").toArray();
    expect(entries).toHaveLength(30);
    expect(JSON.parse(String(entries[4].record))).toEqual({ kind: "chat.message", data: { uid: NEW, text: "message 5 about artifact 1111222233334444" } });
    expect(target.sql.exec("SELECT uid FROM chat_reactions").toArray()).toEqual([{ uid: NEW }]);
    expect(target.sql.exec("SELECT uid, name FROM chat_owner").toArray()).toEqual([{ uid: NEW, name: "Ada" }]);
    expect(target.sql.exec("SELECT COUNT(*) AS n FROM chat_members").toArray()).toEqual([{ n: 0 }]);
    const blob = target.sql.exec("SELECT data FROM pi_blobs").toArray()[0].data as Uint8Array;
    expect([...blob]).toEqual([0, 1, 2, 255]);
    expect(target.kv.map).toEqual(
      new Map<string, unknown>([
        ["auto", true],
        ["broughtIn", ["1111222233334444"]],
      ]),
    );
    // The renamed table kept its quoted name in its schema, and came back as pi_tasks.
    expect(target.sql.exec("SELECT status FROM pi_tasks").toArray()).toEqual([{ status: "terminal" }]);
    // A part sent twice changes nothing.
    restorePart(target.sql, target.kv, KV_KEYS, parts[1], remap);
    expect(target.sql.exec("SELECT COUNT(*) AS n FROM pi_entries").toArray()).toEqual([{ n: 30 }]);
    // An import that starts again starts from nothing.
    clearImported(target.sql, target.kv, KV_KEYS);
    expect(target.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'pi_%'").toArray()).toEqual([]);
    expect(target.kv.map.size).toBe(0);
  });

  it("refuses a part that would touch other tables or run other SQL", () => {
    const { sql, kv } = freshStorage();
    const none = (text: string) => text;
    expect(() => restorePart(sql, kv, KV_KEYS, { tables: [{ name: "chat_members", rows: [{ uid: "x", name: "X", joined_at: 1 }] }] }, none)).toThrow(DumpError);
    const sneaky = { tables: [{ name: "pi_x", schema: ["CREATE TABLE pi_x (a); DROP TABLE chat_owner"], rows: [] }] };
    expect(() => restorePart(sql, kv, KV_KEYS, sneaky, none)).toThrow(DumpError);
    const elsewhere = { tables: [{ name: "pi_x", schema: ["CREATE TABLE chat_owner2 (a)"], rows: [] }] };
    expect(() => restorePart(sql, kv, KV_KEYS, elsewhere, none)).toThrow(DumpError);
    const trigger = { tables: [{ name: "pi_x", schema: ["CREATE TRIGGER t AFTER INSERT ON pi_x BEGIN DELETE FROM chat_owner END"], rows: [] }] };
    expect(() => restorePart(sql, kv, KV_KEYS, trigger, none)).toThrow(DumpError);
    const column = { tables: [{ name: "chat_owner", rows: [{ "uid\" , name) VALUES ('a', 'b'); --": "x" }] }] };
    expect(() => restorePart(sql, kv, KV_KEYS, column, none)).toThrow(DumpError);
    // Only the settings an export carries.
    restorePart(sql, kv, KV_KEYS, { kv: { status: "running", auto: false }, tables: [] }, none);
    expect(kv.map).toEqual(new Map([["auto", false]]));
  });
});

describe("idRemapper", () => {
  it("replaces random ids wherever they are, and short ones only whole", () => {
    const remap = idRemapper([
      [OLD, NEW],
      ["ada", "bob"],
      ["same", "same"],
    ]);
    expect(remap(`{"uid":"${OLD}","name":"ada","text":"ada was here, ${OLD}:chat"}`)).toBe(`{"uid":"${NEW}","name":"bob","text":"ada was here, ${NEW}:chat"}`);
    expect(remap("ada")).toBe("bob");
    expect(remap("adam")).toBe("adam");
    expect(idRemapper([])("anything")).toBe("anything");
  });
});

describe("the export's ids and manifest", () => {
  it("gives a moved artifact the same id on every try", async () => {
    const first = await importedArtifactId("uid1", "aaaabbbbccccdddd");
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await importedArtifactId("uid1", "aaaabbbbccccdddd")).toBe(first);
    expect(await importedArtifactId("uid2", "aaaabbbbccccdddd")).not.toBe(first);
  });

  it("reads only manifests it knows", () => {
    const manifest = { format: EXPORT_FORMAT, version: EXPORT_VERSION, uid: "u", account: {}, chats: [], artifacts: [], files: [], sharedWithMe: [] };
    expect(checkManifest(manifest)).toBe(manifest);
    expect(checkManifest({ ...manifest, version: EXPORT_VERSION + 1 })).toEqual({ error: expect.stringMatching(/newer version/) });
    expect(checkManifest({ format: "other" })).toEqual({ error: expect.stringMatching(/not an export/) });
    expect(checkManifest(null)).toEqual({ error: expect.stringMatching(/not an export/) });
  });
});

describe("the browser's zip", () => {
  it("computes CRC-32 as zlib does", () => {
    const bytes = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
    expect(crc32(bytes, 0)).toBe(nodeCrc32(bytes));
    expect(crc32(bytes.subarray(10), crc32(bytes.subarray(0, 10), 0))).toBe(nodeCrc32(bytes));
  });

  it("reads back, a file at a time, what it wrote", async () => {
    const files: Record<string, Uint8Array<ArrayBuffer>> = {
      "manifest.json": new TextEncoder().encode('{"a":1}'),
      "files/q3/sales.csv": new TextEncoder().encode("a,b\n1,2\n"),
      "files/empty.txt": new Uint8Array(),
      "files/binary.bin": Uint8Array.from({ length: 70_000 }, (_, i) => i % 251),
    };
    const zip = new Uint8Array(
      await new Response(
        zipStream(
          Object.entries(files).map(([name, bytes]) => ({
            name,
            open: async () => ({ size: bytes.byteLength, modified: new Date(0), body: new Blob([bytes]).stream() }),
          })),
        ),
      ).arrayBuffer(),
    );
    const source = bytesSource(zip);
    const items = await zipDirectory(source);
    expect(items.map((item) => item.name)).toEqual(Object.keys(files));
    for (const item of items) expect([...(await readZipFile(source, item))]).toEqual([...files[item.name]]);
  });
});
