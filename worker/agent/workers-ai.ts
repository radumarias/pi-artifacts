import type { ClassifierModel, ClassifierOptions } from "@earendil-works/pi-ai";
import { CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { abortable } from "../../shared/util.ts";

/**
 * System One classifiers on Workers AI (TypeSafe's Jev, Cloudflare's Clef), asked with pi-ai's `classify` through the AI
 * binding: on Cloudflare's own network, with no provider key.
 */

/** What runs a Workers AI model: the AI binding. */
export interface ModelRunner {
  run(model: string, input: object, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** The System One classifier on Workers AI with the id `name` (`typesafe/jev`); undefined for none. */
export function systemOneModel(name: string): ClassifierModel<"cloudflare-workers-ai-system-one"> | undefined {
  const classifiers = CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS as Record<string, ClassifierModel<"cloudflare-workers-ai-system-one">>;
  return Object.hasOwn(classifiers, name) ? classifiers[name] : undefined;
}

/**
 * The options that have pi-ai's Workers AI `classify` run through the binding: pi-ai posts `{ model, input }` to Workers
 * AI's REST API; the binding runs it instead, and its answer goes back in the REST API's envelope. The binding is handed
 * the call's signal, so a call out of time stops; `abortable` covers a binding that does not stop on it.
 */
export function bindingClassifierOptions(ai: ModelRunner): Pick<ClassifierOptions, "apiKey" | "fetch"> {
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const { model, input } = JSON.parse(String(init?.body)) as { model: string; input: object };
    const signal = init?.signal ?? undefined;
    const result = await abortable(ai.run(model, input, { signal }), signal);
    return Response.json({ success: true, result: classifierOutput(await settled(result)) });
  };
  // The binding needs no key; pi-ai only wants one to send.
  return { apiKey: "ai-binding", fetch };
}

/** How deep a binding's answer may nest its output in `result` layers. */
const MAX_LAYERS = 4;

/**
 * The output a classifier's answer holds, as pi-ai reads it (`{ answers, usage }`): the binding hands back a Workers AI
 * model's output alone, but a third-party one's (Jev's) can come in the REST API's envelope (`{ success, result }`), its
 * run record (`{ state: "Completed", result }`), or both. An answer with no output in it fails, naming its shape (its
 * keys, never its values), so the reason shown says what came back.
 */
export function classifierOutput(answer: unknown): unknown {
  let value = answer;
  for (let layer = 0; layer < MAX_LAYERS && isRecord(value); layer++) {
    if ("answers" in value) return value;
    if (value.success === false) throw new Error(`Workers AI error: ${JSON.stringify(value.errors ?? value).slice(0, 300)}`);
    if ("state" in value && value.state !== "Completed") throw new Error(`Workers AI run did not complete (state: ${String(value.state)})`);
    value = value.result;
  }
  throw new Error(`Workers AI answered with no classifier output: ${shapeOf(answer)}`);
}

/** The binding's answer as a value: one it gives as a Response, a stream or JSON text is read. */
async function settled(answer: unknown): Promise<unknown> {
  if (answer instanceof Response) return answer.json();
  if (answer instanceof ReadableStream) return new Response(answer).json();
  if (typeof answer === "string") {
    try {
      return JSON.parse(answer);
    } catch {
      return answer;
    }
  }
  return answer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An answer's shape, for an error: its keys, nested, and the kind of each leaf: `{success: boolean, result: {id: string}}`. */
function shapeOf(value: unknown, depth = 0): string {
  if (Array.isArray(value)) return "array";
  if (!isRecord(value)) return value === null ? "null" : typeof value;
  if (depth >= MAX_LAYERS) return "{…}";
  const keys = Object.keys(value).slice(0, 8);
  return `{${keys.map((key) => `${key}: ${shapeOf(value[key], depth + 1)}`).join(", ")}${Object.keys(value).length > keys.length ? ", …" : ""}}`;
}
