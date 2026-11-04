import type { Api, AssistantMessage, Context, Model, Models, ToolCall } from "@earendil-works/pi-ai";
import type { GatewayFetcher } from "./gateway-models.ts";
import { tapStream } from "./models.ts";

/**
 * Gemini's thought signatures. A Gemini model that reasons signs each step that calls tools, and refuses with HTTP 400
 * a request whose earlier tool calls come back without their signatures: so every chat with it failed right after its
 * first tool call. Through Gemini's OpenAI-compatible API (the one the app reaches it by) the signature rides on the tool
 * call as `extra_content.google.thought_signature`, which pi-ai's chat-completions wire neither keeps nor sends back.
 *
 * ThoughtSignatures does both. Around the AI binding, it reads the signatures off Gemini's streamed answers; around the
 * models, it puts each on its tool call in the reply (pi-ai's `thoughtSignature`, kept with the transcript), and puts
 * them back on the tool calls of every later request to the same model. A step with none (made by another model, or
 * cut off) gets the placeholder Google documents for tool calls no Gemini model signed.
 *
 * It also makes Gemini's errors readable: Google sends them as a one-item array, `[{ error: { message } }]`, which the
 * wire does not read, so a refusal showed only as "HTTP 400".
 */
export class ThoughtSignatures {
  /** Signatures read off answers, by tool call id, until the reply takes them. */
  readonly #read = new Map<string, string>();

  /**
   * `ai` (the AI binding, whose `fetch` reaches AI Gateway's provider paths), reading the signatures off Gemini's
   * answers and lifting its errors to where they are read.
   */
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

  /** A pass-through for an answer's bytes that holds each tool call's signature as its event goes by. */
  #reader(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    let rest = "";
    // A tool call's id and signature, by its index in the answer: a chunk may carry either without the other.
    const ids = new Map<number, string>();
    const signatures = new Map<number, string>();
    const read = (line: string) => {
      if (!line.startsWith("data:")) return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(line.slice("data:".length));
      } catch {
        return;
      }
      const choice = isObject(chunk) && Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      const calls = isObject(choice) && isObject(choice.delta) ? choice.delta.tool_calls : undefined;
      if (!Array.isArray(calls)) return;
      calls.forEach((call: unknown, position) => {
        if (!isObject(call)) return;
        const index = typeof call.index === "number" ? call.index : position;
        if (typeof call.id === "string" && call.id) ids.set(index, call.id);
        const signature = signatureOf(call);
        if (signature) signatures.set(index, signature);
        const [id, held] = [ids.get(index), signatures.get(index)];
        if (id && held) this.#hold(id, held);
      });
    };
    return new TransformStream({
      transform(bytes, controller) {
        const lines = (rest + decoder.decode(bytes, { stream: true })).split("\n");
        rest = lines.pop()!;
        for (const line of lines) read(line.trim());
        controller.enqueue(bytes);
      },
      flush() {
        read((rest + decoder.decode()).trim());
      },
    });
  }
}

/** AI Gateway's name for Google AI Studio, and the provider of the Gemini models it lists. */
const GEMINI = "google-ai-studio";
/** The path of a chat request to Gemini through AI Gateway (`…/<gateway>/google-ai-studio/v1beta/openai/chat/completions`). */
const GEMINI_CHAT = new RegExp(`/${GEMINI}/.*chat/completions$`);
/** The signature Google accepts on a tool call no Gemini model signed, from its thought-signature docs. */
export const UNSIGNED = "skip_thought_signature_validator";
/** How many unclaimed signatures a chat keeps (an answer whose reply never came, say a cut-off one). */
const MAX_READ = 256;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A wire tool call's signature. */
function signatureOf(call: Json): string | undefined {
  const google = isObject(call.extra_content) ? call.extra_content.google : undefined;
  const signature = isObject(google) ? google.thought_signature : undefined;
  return typeof signature === "string" && signature ? signature : undefined;
}

/** Put `signature` on a wire tool call. */
function setSignature(call: Json, signature: string): void {
  const extra = isObject(call.extra_content) ? call.extra_content : {};
  call.extra_content = { ...extra, google: { ...(isObject(extra.google) ? extra.google : {}), thought_signature: signature } };
}

/**
 * The signatures `model` gave the tool calls in `context`, by tool call id. Only its own: pi-ai drops another model's
 * reasoning, and Gemini rejects another model's signature.
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
 * its first call.
 */
export function sign(payload: unknown, signatures: ReadonlyMap<string, string>): void {
  const messages = isObject(payload) && Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    const calls = message.tool_calls.filter(isObject);
    for (const call of calls) {
      const signature = typeof call.id === "string" ? signatures.get(call.id) : undefined;
      if (signature) setSignature(call, signature);
    }
    if (calls.length && !calls.some((call) => signatureOf(call))) setSignature(calls[0], UNSIGNED);
  }
}

/** A failed answer, with Google's one-item error array (`[{ error }]`) turned into the `{ error }` the wire reads. */
async function readableError(response: Response): Promise<Response> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, response);
  }
  const first: unknown = Array.isArray(body) ? body[0] : undefined;
  return new Response(isObject(first) && isObject(first.error) ? JSON.stringify(first) : text, response);
}
