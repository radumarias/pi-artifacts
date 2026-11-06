/** What runs a Workers AI model: the AI binding (env.AI), or a stand-in for it in tests. */
export interface ModelRunner {
  run(model: string, input: object, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/**
 * A `fetch` for pi-ai's Workers AI clients (such as its System One `classify`) that runs the model through the AI
 * binding: on Cloudflare's own network, with no API token. pi-ai posts `{ model, input }` to Workers AI's REST API; the
 * binding runs it instead, and its answer goes back in the REST API's envelope. The binding is handed the request's
 * signal, so a call past its time stops (and stops billing); the race covers a binding that does not stop on it.
 */
export function viaAIBinding(ai: ModelRunner): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (_url, init) => {
    const { model, input } = JSON.parse(String(init?.body)) as { model: string; input: Record<string, unknown> };
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal!.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([ai.run(model, input, { signal }), aborted]);
      return Response.json({ success: true, result });
    } finally {
      signal?.removeEventListener("abort", onAbort!);
    }
  };
}
