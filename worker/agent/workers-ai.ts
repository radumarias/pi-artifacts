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
    return Response.json({ success: true, result });
  };
  // The binding needs no key; pi-ai only wants one to send.
  return { apiKey: "ai-binding", fetch };
}
