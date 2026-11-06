import type { ClassifierModel, ClassifierOptions } from "@earendil-works/pi-ai";
import { CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { abortable, isObject } from "../../shared/util.ts";

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
    const answer = await abortable(ai.run(model, input, { signal }), signal);
    // A Response or a stream would go to pi-ai as `{}`: its JSON is read instead.
    const body = answer instanceof Response ? await answer.json() : answer instanceof ReadableStream ? await new Response(answer).json() : answer;
    return Response.json(restEnvelope(body));
  };
  // The binding needs no key; pi-ai only wants one to send.
  return { apiKey: "ai-binding", fetch };
}

/**
 * The binding's answer in the REST API's envelope, which pi-ai reads (its run record, `state`, its errors): a Workers AI
 * model's output comes alone, but a third-party one's (Jev's) can come already enveloped. An answer pi-ai would find no
 * output in fails here, naming its shape (its keys, never its values), so the reason shown says what came back.
 */
export function restEnvelope(answer: unknown): object {
  const envelope = isObject(answer) && "success" in answer ? answer : { success: true, result: answer };
  const { success, result } = envelope;
  if (success !== false && !(isObject(result) && ("answers" in result || "state" in result))) {
    throw new Error(`Workers AI answered with no classifier output: ${shapeOf(answer)}`);
  }
  return envelope;
}

/** How deep an answer's shape is shown. */
const SHAPE_DEPTH = 3;

/** An answer's shape, for an error: its keys, nested, and the kind of each leaf: `{success: boolean, result: {id: string}}`. */
function shapeOf(value: unknown, depth = 0): string {
  if (Array.isArray(value)) return "array";
  if (!isObject(value)) return value === null ? "null" : typeof value;
  if (depth >= SHAPE_DEPTH) return "{…}";
  const keys = Object.keys(value);
  const shown = keys.slice(0, 8).map((key) => `${key}: ${shapeOf(value[key], depth + 1)}`);
  return `{${shown.join(", ")}${keys.length > shown.length ? ", …" : ""}}`;
}
