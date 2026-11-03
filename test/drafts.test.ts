import { describe, expect, it } from "vitest";
import { ChatDrafts, MAX_DRAFTS, type DraftPage } from "../worker/storage/drafts.ts";
import { deriveUserKey } from "../worker/storage/keys.ts";
import { FakeBucket, MASTER_KEY } from "./fakes.ts";

const CHAT = "0123456789abcdef";
const draftId = (n: number) => n.toString(16).padStart(16, "0");
const page = (n: number, extra: Partial<DraftPage> = {}): DraftPage => ({ id: draftId(n), html: `<p>${n}</p>`, manifest: {}, ...extra });
const failed = { errors: 1, warnings: 0 };

async function setup() {
  const key = await deriveUserKey(MASTER_KEY, "ada");
  const bucket = new FakeBucket();
  return { key, bucket, drafts: new ChatDrafts(bucket.r2, "ada", CHAT, key) };
}

describe("ChatDrafts", () => {
  it("keeps each draft under the owner's drafts folder for the chat, every read and write with the owner's key", async () => {
    const { key, bucket, drafts } = await setup();
    const saved = await drafts.save(page(1), failed);
    expect(await drafts.get(draftId(1))).toEqual(saved);
    expect(saved).toMatchObject({ ...page(1), ...failed });
    expect([...bucket.objects.keys()].sort()).toEqual([`users/ada/drafts/${CHAT}/${draftId(1)}.json`, `users/ada/drafts/${CHAT}/index.json`]);
    const keyed = bucket.calls.filter((call) => call.op === "get" || call.op === "put");
    expect(keyed.length).toBeGreaterThan(0);
    expect(keyed.every((call) => call.ssecKey === key)).toBe(true);
  });

  it("lists drafts newest first, without their pages, and a page saved again as the newest", async () => {
    const { drafts } = await setup();
    await drafts.save(page(1), failed);
    await drafts.save(page(2, { artifactId: "a1" }), failed);
    await drafts.save(page(1), { errors: 0, warnings: 2 });
    const list = await drafts.list();
    expect(list.map((entry) => entry.id)).toEqual([draftId(1), draftId(2)]);
    expect(list[0]).toMatchObject({ id: draftId(1), errors: 0, warnings: 2, bytes: 8 });
    expect(list[1].artifactId).toBe("a1");
    expect(await drafts.summary(draftId(2))).toEqual(list[1]);
  });

  it("keeps a page's artifact, and its pass, when it is saved again without them", async () => {
    const { drafts } = await setup();
    await drafts.save(page(1, { artifactId: "a1" }), { errors: 0, warnings: 1 });
    expect(await drafts.save(page(1), null)).toMatchObject({ artifactId: "a1", errors: 0, warnings: 1 });
    expect(await drafts.save(page(2), null)).toMatchObject({ errors: null, warnings: 0 });
  });

  it(`keeps the newest ${MAX_DRAFTS}, deleting the pages of the ones it drops`, async () => {
    const { bucket, drafts } = await setup();
    for (let n = 1; n <= MAX_DRAFTS + 2; n++) await drafts.save(page(n), failed);
    const list = await drafts.list();
    expect(list).toHaveLength(MAX_DRAFTS);
    expect(list.at(-1)!.id).toBe(draftId(3));
    expect(await drafts.get(draftId(2))).toBeNull();
    expect(bucket.objects.has(`users/ada/drafts/${CHAT}/${draftId(1)}.json`)).toBe(false);
  });

  it("loses no draft to saves and removes made at once, as a round's tool calls are", async () => {
    const { drafts } = await setup();
    await drafts.save(page(9), failed);
    await Promise.all([drafts.save(page(1), failed), drafts.save(page(2), failed), drafts.remove(draftId(9)), drafts.save(page(3), failed)]);
    expect((await drafts.list()).map((entry) => entry.id).sort()).toEqual([draftId(1), draftId(2), draftId(3)]);
  });

  it("removes a published draft, and deletes everything of the chat's", async () => {
    const { bucket, drafts } = await setup();
    await drafts.save(page(1), failed);
    await drafts.save(page(2), failed);
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
    await expect(drafts.save(page(1, { id: "index" }), failed)).rejects.toThrow("Invalid draft id");
    expect(bucket.calls).toEqual([]);
    expect(() => new ChatDrafts(bucket.r2, "ada", "../bob", new ArrayBuffer(32))).toThrow("Invalid chat id");
  });
});
