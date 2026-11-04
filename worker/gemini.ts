import type { Api, AssistantMessage, Context, Model, Models, ToolCall } from "@earendil-works/pi-ai";
import type { ProviderId } from "../shared/models.ts";
import { isObject, text, type Json } from "../shared/util.ts";
import type { GatewayFetcher } from "./gateway-models.ts";
import { tapStream } from "./streams.ts";

/**
 * What Gemini needs on the OpenAI-compatible API the app reaches it by (see GATEWAY_PROVIDERS["google-ai-studio"]),
 * which the chat-completions wire of agents/models/pi-ai (0.31) and pi-ai (1.4) do not do. Remove it once that wire
 * keeps and sends back `extra_content.google.thought_signature`.
 *
 * Thought signatures: a Gemini model that reasons signs each step that calls tools, and refuses with HTTP 400 a request
 * whose earlier tool calls come back without their signatures, so every chat with it failed right after its first tool
 * call. The signature rides on the tool call as `extra_content.google.thought_signature`, which the wire neither keeps
 * nor sends back. Around the AI binding, GeminiCompat reads the signatures off Gemini's streamed answers; around the
 * models, it puts each on its tool call in the reply (pi-ai's `thoughtSignature`, kept with the transcript), and puts
 * them back on the tool calls of every later request to the same model. A step with none (made by another model, or cut
 * off) gets the placeholder Google documents for tool calls no Gemini model signed.
 *
 * Errors: Google sends them as a one-item array, `[{ error: { message } }]`, which the wire does not read, so a refusal
 * showed only as "HTTP 400". GeminiCompat hands the wire the `{ error }` inside.
 */
export class GeminiCompat {
  /** Signatures read off answers, by tool call id, until the reply takes them. */
  readonly #read = new Map<string, string>();

  /** `ai` (the AI binding, whose `fetch` reaches AI Gateway's provider paths), with Gemini's chat answers read. */
  binding<T extends object>(ai: T): T {
    const fetcher = ai as unknown as GatewayFetcher;
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const response = await fetcher.fetch(url, init);
      if (!GEMINI_CHAT.test(new URL(url).pathname)) return response;
      if (!response.ok) return readableError(response);
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
      return new Response(response.body.pipeThrough(this.#reader()), response);
    };
    return new Proxy(ai, {
      get: (target, key) => {
        if (key === "fetch") return fetch;
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** `models`, signing Gemini's requests and keeping the signatures of its replies. */
  models(models: Models): Models {
    const streamSimple = models.streamSimple.bind(models);
    // completeSimple (the calls that summarize a long conversation) goes through streamSimple too.
    models.streamSimple = (model, context, options) => {
      if (model.provider !== GEMINI) return streamSimple(model, context, options);
      const onPayload = options?.onPayload;
      const signed = streamSimple(model, context, {
        ...options,
        onPayload: (payload, payloadModel) => {
          sign(payload, signaturesOf(context, model));
          return onPayload?.(payload, payloadModel);
        },
      });
      return tapStream(
        signed,
        (event) => {
          if (event.type === "toolcall_end") this.#take(event.toolCall);
          // A signature that came after its call closed: taken here for a reader of events that never asks for result().
          else if (event.type === "done") this.#takeAll(event.message);
        },
        (message) => this.#takeAll(message),
      );
    };
    return models;
  }

  /** Keep a signature read off an answer, forgetting the oldest beyond MAX_READ (answers no reply took). */
  #hold(id: string, signature: string): void {
    this.#read.set(id, signature);
    if (this.#read.size > MAX_READ) this.#read.delete(this.#read.keys().next().value!);
  }

  #take(call: ToolCall): void {
    const signature = this.#read.get(call.id);
    if (signature === undefined) return;
    call.thoughtSignature ??= signature;
    this.#read.delete(call.id);
  }

  #takeAll(message: AssistantMessage): void {
    for (const block of message.content) if (block.type === "toolCall") this.#take(block);
  }

  /**
   * A pass-through for an answer's bytes that holds each tool call's signature as its event goes by. Only events that
   * carry tool calls are parsed (the wire parses every event anyway); the rest, nearly all of an answer, are skipped.
   */
  #reader(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    // The start of a line the network split.
    let partial = "";
    // Each tool call's id and signature, by its index in the answer: a chunk may carry either without the other.
    const calls = new Map<number, { id?: string; signature?: string }>();
    const read = (line: string) => {
      if (!line.startsWith("data:") || !line.includes('"tool_calls"')) return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(line.slice("data:".length));
      } catch {
        return;
      }
      const choice = isObject(chunk) && Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      const deltas = isObject(choice) && isObject(choice.delta) ? choice.delta.tool_calls : undefined;
      if (!Array.isArray(deltas)) return;
      deltas.forEach((delta: unknown, position) => {
        if (!isObject(delta)) return;
        const index = typeof delta.index === "number" ? delta.index : position;
        const call = calls.get(index) ?? {};
        // The newest id, as the wire names the call by the last one it was sent; the first signature.
        const next = { id: text(delta.id) ?? call.id, signature: call.signature ?? signatureOf(delta) };
        if (next.id === call.id && next.signature === call.signature) return;
        calls.set(index, next);
        if (!next.id || !next.signature) return;
        // Held once both halves are in, and again under a new id (the old one then names no call).
        if (call.id && call.id !== next.id) this.#read.delete(call.id);
        this.#hold(next.id, next.signature);
      });
    };
    return new TransformStream({
      transform(bytes, controller) {
        const lines = decoder.decode(bytes, { stream: true }).split("\n");
        if (lines.length > 1) {
          read(partial + lines[0]);
          for (const line of lines.slice(1, -1)) read(line);
          partial = "";
        }
        partial += lines.at(-1)!;
        controller.enqueue(bytes);
      },
      flush() {
        read(partial + decoder.decode());
      },
    });
  }
}

/** AI Gateway's name for Google AI Studio, and the provider of the Gemini models it lists. */
const GEMINI: ProviderId = "google-ai-studio";
/** The path of a chat request to Gemini through AI Gateway (`…/<gateway>/google-ai-studio/v1beta/openai/chat/completions`). */
const GEMINI_CHAT = new RegExp(`/${GEMINI}/.*chat/completions$`);
/** The signature Google accepts on a tool call no Gemini model signed, from its thought-signature docs. */
export const UNSIGNED = "skip_thought_signature_validator";
/** How many unclaimed signatures a chat keeps (an answer whose reply never came, say a cut-off one). */
const MAX_READ = 256;

/** A wire tool call's signature. */
function signatureOf(call: Json): string | undefined {
  const google = isObject(call.extra_content) ? call.extra_content.google : undefined;
  return isObject(google) ? text(google.thought_signature) : undefined;
}

/**
 * The signatures `model` gave the tool calls in `context`, by tool call id. Only its own, by pi-ai's rule for whose
 * reasoning a model may see (transformMessages' `isSameModel`): Gemini rejects another model's signature.
 */
function signaturesOf(context: Context, model: Model<Api>): Map<string, string> {
  const signatures = new Map<string, string>();
  for (const message of context.messages) {
    if (message.role !== "assistant" || message.provider !== model.provider || message.api !== model.api || message.model !== model.id) continue;
    for (const block of message.content) if (block.type === "toolCall" && block.thoughtSignature) signatures.set(block.id, block.thoughtSignature);
  }
  return signatures;
}

/**
 * Sign the tool calls of a chat-completions request: each with its own signature where `signatures` has it. Gemini
 * signs only the first call of a step that calls several at once, so a step with no signature at all gets UNSIGNED on
 * its first call. (The wire sends no `extra_content` of its own to keep.)
 */
export function sign(payload: unknown, signatures: ReadonlyMap<string, string>): void {
  const messages = isObject(payload) && Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    const calls = message.tool_calls.filter(isObject);
    let signed = false;
    for (const call of calls) {
      const signature = signatures.get(String(call.id));
      if (!signature) continue;
      call.extra_content = { google: { thought_signature: signature } };
      signed = true;
    }
    if (calls.length && !signed) calls[0].extra_content = { google: { thought_signature: UNSIGNED } };
  }
}

/** A failed answer, with Google's one-item error array (`[{ error }]`) turned into the `{ error }` the wire reads. */
async function readableError(response: Response): Promise<Response> {
  const body = await response.text();
  let first: unknown;
  try {
    const parsed: unknown = JSON.parse(body);
    first = Array.isArray(parsed) ? parsed[0] : undefined;
  } catch {
    // Not JSON: the wire shows it as it is.
  }
  return new Response(isObject(first) && isObject(first.error) ? JSON.stringify(first) : body, response);
}
