import { errorMessage } from "../shared/util.ts";

/** How often a ping goes out: just inside the 5 minutes Anthropic keeps a prompt cache entry after it was last used. */
export const PING_EVERY_MS = 270_000;
/** How long after a chat's last model call its cache is kept warm: a run's long tool steps, and a reply's reader writing back. */
export const KEEP_WARM_MS = 15 * 60_000;
/**
 * The smallest request worth keeping warm, in characters of its body (about 25K tokens). Below it a cold write costs
 * cents, while three pings to keep it would cost about as much.
 */
export const MIN_WARM_CHARS = 100_000;

/** The part of the AI binding a ping needs: Anthropic's models run through `run`, with the Messages body as input. */
type Run = (model: string, input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;

type Timers = { set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void };

/**
 * Keeps a chat's Claude prompt cache from expiring between its model calls. Each call sends the whole conversation;
 * Anthropic reads what it saw in the last 5 minutes from its cache (at a twentieth of the input price) and writes the
 * rest again (at 1.25 times it), so a pause of just over 5 minutes, a slow tool step or a long reply made the next call
 * write the whole conversation again: a quarter of what chats cost (AI Gateway logs, Nov 2026). Around the AI binding,
 * CacheWarmer keeps the chat's last large Claude request, and every PING_EVERY_MS, until KEEP_WARM_MS after the last
 * real call, sends it again with `max_tokens: 0`: Anthropic reads the cache, which keeps it, and writes nothing. A
 * 1-hour cache instead would write every new token at twice the price, which cost more than it saved on the logs.
 *
 * Only the conversation's own calls are kept: they carry its tools, which a summary, a title or a router pick does not,
 * so a ping never warms a prompt nobody sends again. The pings are not in the chat's spend ledger (they are about 1% of
 * the cost they save). They stop when the chat object is put to sleep, which takes its timers; a ping that fails stops
 * them until the next call, and the kept request is let go once the chat has been quiet KEEP_WARM_MS.
 */
export class CacheWarmer {
  /** The last large conversation call, made ready to ping, and when it was made. */
  #last: { model: string; input: Record<string, unknown>; options: Record<string, unknown>; at: number } | undefined;
  #timer: unknown;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer as number) },
  ) {}

  /** `ai` (the AI binding), with its large Claude requests kept to ping. */
  binding<T extends object>(ai: T): T {
    return new Proxy(ai, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        const bound = value.bind(target) as Run;
        if (key !== "run") return bound;
        return (model: string, input: Record<string, unknown>, options?: Record<string, unknown>) => {
          if (worthWarming(model, input)) this.#keep(bound, model, input, options ?? {});
          return bound(model, input, options);
        };
      },
    });
  }

  #keep(run: Run, model: string, input: Record<string, unknown>, options: Record<string, unknown>): void {
    // The same request, answered with nothing: no output, no stream to read. Past AI Gateway's own cache, which would
    // answer the second identical ping itself and never reach Anthropic's.
    const gateway = typeof options.gateway === "object" && options.gateway !== null ? { ...options.gateway, skipCache: true } : options.gateway;
    this.#last = { model, input: { ...input, max_tokens: 0, stream: false }, options: { ...options, gateway, signal: undefined }, at: this.now() };
    this.#schedule(run);
  }

  #schedule(run: Run): void {
    if (this.#timer !== undefined) this.timers.clear(this.#timer);
    this.#timer = this.timers.set(() => void this.#ping(run), PING_EVERY_MS);
  }

  async #ping(run: Run): Promise<void> {
    this.#timer = undefined;
    const last = this.#last;
    if (!last) return;
    if (this.now() - last.at >= KEEP_WARM_MS) {
      this.#last = undefined;
      return;
    }
    try {
      const response = await run(last.model, last.input, last.options);
      // returnRawResponse: the body is the provider's answer, unread; read it so the connection is let go.
      if (response instanceof Response) {
        const body = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
      }
    } catch (error) {
      console.error("cache warmer: a ping failed, so this chat's pings stop until its next call:", errorMessage(error));
      if (this.#last === last) this.#last = undefined;
      return;
    }
    if (this.#last === last) this.#schedule(run);
  }
}

/**
 * A Claude conversation call (it has tools) large enough that its cache is worth keeping, and not a ping. Not one with
 * budget thinking (`thinking.type: "enabled"`): Anthropic wants its max_tokens above the budget, so a ping would be
 * refused, and changing the thinking settings to get past that would miss the cache it is meant to keep.
 */
function worthWarming(model: string, input: Record<string, unknown>): boolean {
  if (!model.startsWith("anthropic/") || input.max_tokens === 0) return false;
  if ((input.thinking as { type?: unknown } | undefined)?.type === "enabled") return false;
  if (!Array.isArray(input.messages) || !Array.isArray(input.tools) || input.tools.length === 0) return false;
  return atLeastChars([input.system, input.tools, input.messages], MIN_WARM_CHARS);
}

/**
 * Whether the strings in `value` add up to `min` characters: the size of a request without serializing it again on
 * every call (the binding does that once to send it), stopping as soon as the count gets there. An image's base64
 * source is left out: hundreds of thousands of characters for a screenshot of about 1,200 tokens.
 */
function atLeastChars(value: unknown, min: number): boolean {
  let count = 0;
  const walk = (node: unknown): boolean => {
    if (typeof node === "string") return (count += node.length) >= min;
    if (Array.isArray(node)) return node.some(walk);
    if (typeof node !== "object" || node === null || (node as { type?: unknown }).type === "base64") return false;
    return Object.values(node).some(walk);
  };
  return walk(value);
}
