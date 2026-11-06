import { isObject, text } from "../shared/util.ts";

/**
 * Readable errors from streamed answers. OpenAI's Responses API can end a stream with an `error` event whose code and
 * message sit in a nested `error` object (`{ type: "error", error: { code, message } }`), where pi-ai (1.4) reads them
 * from the event itself, so the chat said only "Error Code undefined: undefined". Around the AI binding, every streamed
 * answer, whether run (`run`, AI Gateway's catalog) or fetched (`fetch`, a provider's own path), has such an event's code
 * and message put on the event, or, when it has neither anywhere, the event itself as its message. Remove it once
 * pi-ai reads the nested error.
 */
export function withReadableStreamErrors<T extends object>(ai: T): T {
  return new Proxy(ai, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      const bound = value.bind(target) as (...args: unknown[]) => unknown;
      if (key !== "run" && key !== "fetch") return bound;
      return async (...args: unknown[]) => readable(await bound(...args));
    },
  });
}

/** `answer`, when it is a streamed response, with its error events made readable; anything else as it is. */
function readable(answer: unknown): unknown {
  if (!(answer instanceof Response) || !answer.body || !answer.headers.get("content-type")?.includes("text/event-stream")) return answer;
  return new Response(answer.body.pipeThrough(errorReader()), answer);
}

/** How much of an error event with no message anywhere becomes its message. */
const MAX_EVENT_CHARS = 300;

/** A pass-through for a stream's lines that rewrites only error events missing their code or message. */
function errorReader(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  // The start of a line the network split.
  let partial = "";
  return new TransformStream({
    transform(bytes, controller) {
      const lines = (partial + decoder.decode(bytes, { stream: true })).split("\n");
      partial = lines.pop()!;
      if (lines.length) controller.enqueue(encoder.encode(lines.map(readableLine).join("\n") + "\n"));
    },
    flush(controller) {
      const last = partial + decoder.decode();
      if (last) controller.enqueue(encoder.encode(readableLine(last)));
    },
  });
}

/** A `data:` line of an error event with its code and message on the event; any other line as it is. */
export function readableLine(line: string): string {
  if (!line.startsWith("data:") || !line.includes('"error"')) return line;
  let event: unknown;
  try {
    event = JSON.parse(line.slice("data:".length));
  } catch {
    return line;
  }
  if (!isObject(event) || event.type !== "error") return line;
  const inner = isObject(event.error) ? event.error : {};
  const message = text(event.message) ?? text(inner.message) ?? text(event.error) ?? JSON.stringify(event).slice(0, MAX_EVENT_CHARS);
  const code = codeOf(event.code) ?? codeOf(inner.code) ?? codeOf(inner.type) ?? codeOf(event.status) ?? "unknown";
  if (message === event.message && code === event.code) return line;
  return `data: ${JSON.stringify({ ...event, code, message })}`;
}

function codeOf(value: unknown): string | undefined {
  return typeof value === "number" ? String(value) : text(value);
}
