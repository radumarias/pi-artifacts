/** A JSON response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

/**
 * A request's JSON body, or null when it has none or it is not JSON. Only with a JSON content type: that cannot be
 * sent cross-site without a CORS preflight, so a plain form on another site cannot post it as the signed-in user.
 */
export async function readJson<T>(request: Request): Promise<T | null> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return null;
  return request.json<T>().catch(() => null);
}

/**
 * A WebSocket upgrade answered by a socket that closes at once with `code`. A refused upgrade (a plain 4xx) reaches
 * the browser only as an anonymous close; a close code tells the app to stop reconnecting.
 */
export function closedSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}
