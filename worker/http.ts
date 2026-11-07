/** A JSON response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

/** A Durable Object's answer as JSON: a refusal ({status, error}) with its status, anything else with `status`. */
export function answerJson<T extends object>(result: T | { status: number; error: string }, status = 200): Response {
  return "status" in result && "error" in result ? json({ error: result.error }, result.status) : json(result, status);
}

/**
 * A request's JSON body, or null when it has none or it is not JSON. Only with a JSON content type: that cannot be
 * sent cross-site without a CORS preflight, so a plain form on another site cannot post it as the signed-in user.
 */
export async function readJson<T>(request: Request): Promise<T | null> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return null;
  return (request.json() as Promise<T>).catch(() => null);
}
