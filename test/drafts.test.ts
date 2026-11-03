import { describe, expect, it } from "vitest";
import { ChatDrafts, MAX_DRAFTS, type Draft } from "../worker/storage/drafts.ts";
import { deriveUserKey } from "../worker/storage/keys.ts";
import { FakeBucket, MASTER_KEY } from "./fakes.ts";

const CHAT = "0123456789abcdef";
const draftId = (n: number) => n.toString(16).padStart(16, "0");
const draft = (n: number, extra: Partial<Draft> = {}): Draft => ({
  id: draftId(n),
  html: `<p>${n}</p>`,
  manifest: {},
  savedAt: n,
  errors: 1,
  warnings: 0,
  ...extra,
});

async function setup() {
  const key = await deriveUserKey(MASTER_KEY, "ada");
  const bucket = new FakeBucket();
  return { key, bucket, drafts: new ChatDrafts(bucket.r2, "ada", CHAT, key) };
}

describe("ChatDrafts", () => {
  it("keeps each draft under the owner's drafts folder for the chat, every read and write with the owner's key", async () => {
    const { key, bucket, drafts } = await setup();
    await drafts.save(draft(1));
    expect(await drafts.get(draftId(1))).toEqual(draft(1));
    expect([...bucket.objects.keys()].sort()).toEqual([`users/ada/drafts/${CHAT}/${draftId(1)}.json`, `users/ada/drafts/${CHAT}/index.json`]);
    const keyed = bucket.calls.filter((call) => call.op === "get" || call.op === "put");
    expect(keyed.length).toBeGreaterThan(0);
    expect(keyed.every((call) => call.ssecKey === key)).toBe(true);
  });

  it("lists drafts newest first, without their pages, and a page saved again as the newest", async () => {
    const { drafts } = await setup();
    await drafts.save(draft(1));
    await drafts.save(draft(2, { artifactId: "a1" }));
    await drafts.save(draft(1, { errors: 0, savedAt: 3 }));
    const list = await drafts.list();
    expect(list.map((entry) => entry.id)).toEqual([draftId(1), draftId(2)]);
    expect(list[0]).toEqual({ id: draftId(1), savedAt: 3, errors: 0, warnings: 0, bytes: 8 });
    expect(list[1].artifactId).toBe("a1");
  });

  it(`keeps the newest ${MAX_DRAFTS}, deleting the pages of the ones it drops`, async () => {
    const { bucket, drafts } = await setup();
    for (let n = 1; n <= MAX_DRAFTS + 2; n++) await drafts.save(draft(n));
    const list = await drafts.list();
    expect(list).toHaveLength(MAX_DRAFTS);
    expect(list.at(-1)!.id).toBe(draftId(3));
    expect(await drafts.get(draftId(2))).toBeNull();
    expect(bucket.objects.has(`users/ada/drafts/${CHAT}/${draftId(1)}.json`)).toBe(false);
  });

  it("removes a published draft, and deletes everything of the chat's", async () => {
    const { bucket, drafts } = await setup();
    await drafts.save(draft(1));
    await drafts.save(draft(2));
    await drafts.remove(draftId(1));
    expect((await drafts.list()).map((entry) => entry.id)).toEqual([draftId(2)]);
    expect(await drafts.get(draftId(1))).toBeNull();
    await drafts.deleteAll();
    expect(bucket.objects.size).toBe(0);
  });

  it("refuses ids that are not draft ids, and a chat id that is not one", async () => {
    const { bucket, drafts } = await setup();
    expect(await drafts.get("../index")).toBeNull();
    await drafts.remove("index");
    await expect(drafts.save(draft(1, { id: "index" }))).rejects.toThrow("Invalid draft id");
    expect(bucket.calls).toEqual([]);
    expect(() => new ChatDrafts(bucket.r2, "ada", "../bob", new ArrayBuffer(32))).toThrow("Invalid chat id");
  });
});
