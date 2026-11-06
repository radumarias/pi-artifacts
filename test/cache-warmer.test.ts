import { describe, expect, it } from "vitest";
import { CacheWarmer, KEEP_WARM_MS, MIN_WARM_CHARS, PING_EVERY_MS } from "../worker/cache-warmer.ts";

/** A clock and timers the test moves by hand. */
function clock() {
  let now = 0;
  let pending: { run: () => void; at: number } | undefined;
  return {
    now: () => now,
    timers: {
      set: (run: () => void, ms: number) => (pending = { run, at: now + ms }),
      clear: (timer: unknown) => {
        if (pending === timer) pending = undefined;
      },
    },
    /** Move to the next timer, run it, and let its ping settle. */
    async next(): Promise<boolean> {
      const timer = pending;
      if (!timer) return false;
      pending = undefined;
      now = timer.at;
      timer.run();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return true;
    },
    advance: (ms: number) => (now += ms),
  };
}

function binding(answer: () => Response = () => new Response("{}")) {
  const calls: { model: string; input: Record<string, unknown>; options?: Record<string, unknown> }[] = [];
  const ai = {
    aiGatewayLogId: "log-1",
    async run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>) {
      calls.push({ model, input, options });
      return answer();
    },
  };
  return { ai, calls };
}

const tools = [{ name: "artifact_read", description: "Reads a page.", input_schema: { type: "object" } }];
const large = { messages: [{ role: "user", content: "x".repeat(MIN_WARM_CHARS) }], tools, max_tokens: 64_000, stream: true };

describe("CacheWarmer", () => {
  it("sends a large Claude request again with max_tokens 0 and no stream, every PING_EVERY_MS until KEEP_WARM_MS", async () => {
    const time = clock();
    const { ai, calls } = binding();
    const warmed = new CacheWarmer(time.now, time.timers).binding(ai);
    await warmed.run("anthropic/claude-opus-5.5", large, { gateway: { id: "g" }, returnRawResponse: true });
    while (await time.next());
    // A ping at 4.5, 9 and 13.5 minutes; at 18 the chat has been quiet too long.
    expect(calls).toHaveLength(1 + Math.floor(KEEP_WARM_MS / PING_EVERY_MS));
    const ping = calls[1];
    expect(ping.model).toBe("anthropic/claude-opus-5.5");
    expect(ping.input).toMatchObject({ max_tokens: 0, stream: false, messages: large.messages });
    expect(ping.options).toMatchObject({ gateway: { id: "g" }, returnRawResponse: true });
    // The binding's other members are the binding's own.
    expect(warmed.aiGatewayLogId).toBe("log-1");
  });

  it("starts again from each real call", async () => {
    const time = clock();
    const { ai, calls } = binding();
    const warmed = new CacheWarmer(time.now, time.timers).binding(ai);
    await warmed.run("anthropic/claude-sonnet-5.5", large);
    await time.next();
    time.advance(60_000);
    await warmed.run("anthropic/claude-sonnet-5.5", { ...large, messages: [...large.messages, { role: "user", content: "more" }] });
    while (await time.next());
    const pings = calls.filter((call) => call.input.max_tokens === 0);
    expect(pings.at(-1)?.input.messages).toHaveLength(2);
  });

  it("leaves small requests, other providers, calls without tools and its own pings alone", async () => {
    const time = clock();
    const { ai } = binding();
    const warmed = new CacheWarmer(time.now, time.timers).binding(ai);
    await warmed.run("anthropic/claude-haiku-5.5", { messages: [{ role: "user", content: "name this chat" }], max_tokens: 40 });
    await warmed.run("openai/gpt-6-sol", large);
    await warmed.run("anthropic/claude-opus-5.5", { ...large, max_tokens: 0 });
    // A summary of the conversation: as large, but no tools.
    await warmed.run("anthropic/claude-opus-5.5", { messages: large.messages, max_tokens: 13_000 });
    expect(await time.next()).toBe(false);
  });

  it("stops after a failed ping", async () => {
    const time = clock();
    let ok = true;
    const { ai, calls } = binding(() => (ok ? new Response("{}") : new Response("nope", { status: 400 })));
    const warmed = new CacheWarmer(time.now, time.timers).binding(ai);
    await warmed.run("anthropic/claude-opus-5.5", large);
    ok = false;
    await time.next();
    expect(await time.next()).toBe(false);
    expect(calls).toHaveLength(2);
  });
});
