/** What runs a Workers AI model: the AI binding (env.AI), or a stand-in for it in tests. */
export interface ModelRunner {
  run(model: string, input: object, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/**
 * A `fetch` for pi-ai's Workers AI clients (such as its System One `classify`) that runs the model through the AI
 * binding: on Cloudflare's own network, with no API token. pi-ai posts `{ model, input }` to Workers AI's REST API; the
 * binding runs it instead, handed the request's signal (so a call no longer waited for stops, and stops billing), and
 * its answer goes back in the REST API's envelope. A caller that must not wait on a binding that ignores the signal
 * bounds the call itself (see `deadline`).
 */
export function viaAIBinding(ai: ModelRunner): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (_url, init) => {
    const { model, input } = JSON.parse(String(init?.body)) as { model: string; input: Record<string, unknown> };
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    return Response.json({ success: true, result: await ai.run(model, input, { signal }) });
  };
}
