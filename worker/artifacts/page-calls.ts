import { callIdentity, stripCache } from "../../shared/canonical.ts";
import { clampStaleMs, type ProxyRequest, type ProxyResponse } from "../../shared/protocol.ts";
import { ResultCache } from "../mcp/result-cache.ts";

/** A chat's answer to one page call (ChatAgent.artifactCall). */
export interface ChatAnswer {
  response: ProxyResponse;
  /**
   * Set on a read that anyone the app lets in may be served again: a read-only tool the version declared, of a server
   * that shares results and does not sign in each user (so no viewer needs to be in the chat).
   */
  shareable?: true;
}

/** What an isolate keeps of pages' results. Workers have 128 MB; a chat object keeps 16 MB of its own. */
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
/** The oldest result served from here, whatever staleness a page accepts; older ones go to the chat. */
const MAX_AGE_MS = 10 * 60_000;
/**
 * How long the chat's yes to a version calling a tool holds without asking it again. Manifests never change, but a server
 * can drop a tool or stop marking it read-only, and an artifact can be deleted; every shareable answer from the chat
 * renews it, and any other answer ends it.
 */
const GRANT_MS = 60_000;
const MAX_GRANTS = 5_000;

/**
 * Pages' live reads, cached in the Worker so that a fresh result is served without waking the chat's Durable Object.
 * Results are keyed by chat and call (server, tool, input), so every viewer of a chat's pages shares them, and
 * identical reads that miss share one call to the chat. A result is served from here only for a page version the
 * chat already allowed to make that read, and only while it is as young as the page asks (its `staleMs`).
 *
 * The cache lives in one isolate, so each of the Worker's isolates asks the chat about once per refresh interval.
 */
export class PageCallCache {
  readonly #now: () => number;
  readonly #results: ResultCache;
  readonly #inflight = new Map<string, Promise<ChatAnswer>>();
  /** When the chat last allowed `artifact, version, server, tool`. */
  readonly #grants = new Map<string, number>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#results = new ResultCache(MAX_CACHE_BYTES, MAX_AGE_MS, now);
  }

  /** The answer to a page's call: from the cache when it may be, else from `ask` (the chat). */
  async call(chat: string, artifactId: string, request: ProxyRequest, ask: () => Promise<ChatAnswer>): Promise<ProxyResponse> {
    if (request.mode !== "read") return (await ask()).response;
    const resultKey = `${chat}\u0000${callIdentity(request.server, request.tool, request.input)}`;
    const grantKey = `${artifactId}\u0000${request.version}\u0000${request.server}\u0000${request.tool}`;
    const staleMs = clampStaleMs(request.staleMs, MAX_AGE_MS);

    if (this.#granted(grantKey)) {
      const hit = this.#fresh(resultKey, staleMs);
      if (hit) return hit;
      // The same read is on its way to the chat for another viewer: its result may be young enough for this one.
      const flight = this.#inflight.get(resultKey);
      if (flight) {
        await flight.catch(() => {});
        const shared = this.#fresh(resultKey, staleMs);
        if (shared) return shared;
      }
    }

    const flight = ask();
    if (!this.#inflight.has(resultKey)) {
      this.#inflight.set(resultKey, flight);
      const settle = () => {
        if (this.#inflight.get(resultKey) === flight) this.#inflight.delete(resultKey);
      };
      flight.then(settle, settle);
    }
    const answer = await flight;
    this.#learn(resultKey, grantKey, answer);
    return answer.response;
  }

  #granted(grantKey: string): boolean {
    const at = this.#grants.get(grantKey);
    return at !== undefined && this.#now() - at < GRANT_MS;
  }

  #fresh(resultKey: string, staleMs: number): ProxyResponse | undefined {
    const hit = this.#results.fresh(resultKey, staleMs);
    return hit && { ok: true, ...hit };
  }

  /** Remember what the chat said: a shareable result and its yes, or, for any other answer, that its yes is gone. */
  #learn(resultKey: string, grantKey: string, { response, shareable }: ChatAnswer): void {
    this.#grants.delete(grantKey);
    if (!response.ok || !shareable) return;
    if (this.#grants.size >= MAX_GRANTS) this.#grants.delete(this.#grants.keys().next().value!);
    this.#grants.set(grantKey, this.#now());
    // Answers can arrive out of order: never replace a newer result with an older one.
    if ((this.#results.get(resultKey)?.storedAt ?? -Infinity) < response.storedAt) {
      this.#results.set(resultKey, { result: stripCache(response.result), storedAt: response.storedAt });
    }
  }
}
