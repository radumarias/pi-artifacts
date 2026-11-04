import { describe, expect, it } from "vitest";
import type { ProxyRequest } from "../shared/protocol.ts";
import { PageCallCache, type ChatAnswer } from "../worker/artifacts/page-calls.ts";

const read = (input: unknown = { ids: "btc" }, staleMs = 30_000, version = 1): ProxyRequest => ({
  version,
  mode: "read",
  server: "S",
  tool: "t",
  input,
  staleMs,
});

function shared(storedAt: number, payload: unknown = { at: storedAt }): ChatAnswer {
  return { response: { ok: true, result: { content: [], payload }, storedAt, nextRefreshAt: storedAt + 30_000 }, shareable: true };
}

/** A cache on a fake clock, and a stand-in for the chat that counts how often it is woken. */
function setup(answer: (request: ProxyRequest, now: number) => ChatAnswer | Promise<ChatAnswer> = (_, now) => shared(now)) {
  const clock = { now: 1_000_000 };
  const asked: ProxyRequest[] = [];
  const cache = new PageCallCache(() => clock.now);
  const call = (request: ProxyRequest, { chat = "ann:chat1", artifact = "art00001" } = {}) =>
    cache.call(chat, artifact, request, async () => {
      asked.push(request);
      return answer(request, clock.now);
    });
  return { call, asked, clock, advance: (ms: number) => (clock.now += ms) };
}

describe("PageCallCache", () => {
  it("serves a young shareable result to every viewer without asking the chat again", async () => {
    const t = setup();
    const first = await t.call(read());
    t.advance(10_000);
    const second = await t.call(read({ ids: "btc" }));
    expect(t.asked).toHaveLength(1);
    expect(first.ok && first.result.cache).toBeFalsy();
    expect(second).toEqual({
      ok: true,
      result: { content: [], payload: { at: 1_000_000 }, cache: { storedAt: 1_000_000, revalidating: false } },
      storedAt: 1_000_000,
      nextRefreshAt: 1_030_000,
    });
  });

  it("asks the chat once the result is older than the page accepts", async () => {
    const t = setup();
    await t.call(read());
    t.advance(30_000);
    await t.call(read());
    expect(t.asked).toHaveLength(2);
    // A page that accepts older data still gets the cached copy.
    t.advance(20_000);
    await t.call(read(undefined, 60_000));
    expect(t.asked).toHaveLength(2);
  });

  it("never serves a refresh (staleMs 0), a one-shot call or an unshareable read from the cache", async () => {
    const own = (request: ProxyRequest) => (request.input as { own?: boolean }).own;
    const t = setup((request, now) => (own(request) ? { response: shared(now).response } : shared(now)));
    await t.call(read());
    await t.call(read(undefined, 0));
    await t.call({ ...read(), mode: "call" });
    await t.call({ ...read(), mode: "call" });
    await t.call(read({ own: true }));
    await t.call(read({ own: true }));
    expect(t.asked).toHaveLength(6);
  });

  it("never serves a refresh, even when the chat's clock runs ahead of the Worker's", async () => {
    const t = setup((_, now) => shared(now + 50));
    await t.call(read());
    const refreshed = await t.call(read(undefined, 0));
    expect(t.asked).toHaveLength(2);
    expect(refreshed.ok && refreshed.result.cache).toBeFalsy();
  });

  it("serves only page versions the chat allowed, and stops once it refuses", async () => {
    let refuse = false;
    const t = setup((_, now) => (refuse ? { response: { ok: false, error: { code: "not_in_manifest", message: "no" } } } : shared(now)));
    await t.call(read());
    // Another artifact, or another version, of the same chat has to ask for itself first.
    await t.call(read(), { artifact: "art00002" });
    await t.call(read(undefined, 30_000, 2));
    expect(t.asked).toHaveLength(3);
    // Another chat never sees this chat's results.
    await t.call(read(), { chat: "bob:chat2" });
    expect(t.asked).toHaveLength(4);

    // The chat's yes holds for a minute; then it is asked again, and its no sticks.
    t.advance(60_000);
    refuse = true;
    expect((await t.call(read(undefined, 120_000))).ok).toBe(false);
    expect((await t.call(read(undefined, 120_000))).ok).toBe(false);
    expect(t.asked).toHaveLength(6);
  });

  it("shares one call to the chat among identical reads that miss", async () => {
    let gate: Promise<void> | undefined;
    const t = setup(async (_, now) => {
      await gate;
      return shared(now);
    });
    // A first answer allows the read; 30 s later its result is stale, and the next answer waits, as a cold upstream call would.
    await t.call(read());
    t.advance(30_000);
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    const calls = [t.call(read()), t.call(read()), t.call(read())];
    release();
    const answers = await Promise.all(calls);
    expect(t.asked).toHaveLength(2);
    expect(answers.map((a) => a.ok && a.storedAt)).toEqual([t.clock.now, t.clock.now, t.clock.now]);
  });

  it("keeps the newest result when answers arrive out of order", async () => {
    let lag = 0;
    const t = setup((_, now) => shared(now - lag));
    await t.call(read());
    lag = 5_000;
    await t.call(read(undefined, 0));
    const hit = await t.call(read());
    expect(t.asked).toHaveLength(2);
    expect(hit.ok && hit.storedAt).toBe(t.clock.now);
  });
});
