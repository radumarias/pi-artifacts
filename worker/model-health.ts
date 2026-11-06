import { clampThinkingLevel, type Api, type Model, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { modelKey } from "../shared/models.ts";
import { abortable, clip, errorMessage } from "../shared/util.ts";
import { tapStream } from "./streams.ts";

/**
 * Which models answer. A provider lists its models whether or not its account can pay for a call (OpenAI's list comes
 * back on a key with no credits left, as does a provider's on unified billing with none), so a listed model can still
 * fail every call. Auto must not pick one: the deployment's Auto models are tried with a tiny call whenever the
 * providers are asked for their lists (worker/models.ts), and any model whose real call fails for a reason that will
 * not pass on its own is marked as it fails. A mark holds until the next try; Auto leaves marked models out
 * (worker/agent/route.ts autoCandidates), and the picker says why.
 */

/** Why a model failed when last called, and when (ms since the epoch). */
export interface ModelFailure {
  error: string;
  at: number;
}

/** Failing models, by the picker's id. */
export type ModelFailures = Record<string, ModelFailure>;

/** How much of an error a mark keeps. */
const MAX_FAILURE_CHARS = 300;

/**
 * A mark of `error`, now: cut short, with anything that looks like a key or an account's id left out, as every user of
 * the deployment reads it in the picker.
 */
export function failureOf(error: string, at = Date.now()): ModelFailure {
  return { error: clip(error.replace(/\b(?:sk|key|org|proj|acct)[-_][\w*-]{4,}/gi, "…"), MAX_FAILURE_CHARS), at };
}

/**
 * Whether an error says the model cannot be called at all, for now: no key, or one refused; no credits, quota or
 * payment; no such model, or no access to it. Not a rate limit, an overloaded or failing server, a timeout, or a request
 * the model refused for what it held (too long, a bad tool, an earlier item it no longer has): those pass, or are the
 * conversation's, not the model's. Only words providers use for the account or the model, so a conversation's own
 * error never marks a model for every chat.
 */
export function cannotCall(error: string): boolean {
  return CANNOT_CALL.test(error) && !PASSES.test(error);
}

// A status only where the error leads with it or names it as one: a number elsewhere (messages.401 in a request the
// model refused) is the conversation's.
const CANNOT_CALL =
  /(?:^|\b(?:status|code)\s*:?\s*)40[12]\b|insufficient[_ ](?:quota|balance|funds|credits?)|exceeded your current quota|billing|payment[_ ]required|credit balance|(?:no|out of) credits|invalid[_ ]api[_ ]key|incorrect api key|api key not valid|unauthori[sz]ed|model_not_found|does not exist or you do not have access|deactivated|suspended/i;

/**
 * A limit that passes, though its words name quota or billing: Gemini's per-minute limit ("You exceeded your current
 * quota, please check your plan and billing details … Please retry in 30s"), OpenAI's free tier's rate limit (with a
 * billing link).
 */
const PASSES = /rate[_ -]?limit|retry in|try again/i;

/** How long a try may take: a model that does not answer by then is left as it was. */
const TRY_MS = 20_000;
/** Enough for any model to start an answer: a try is paid for, so it asks for next to nothing. */
const TRY_TOKENS = 32;

/**
 * Try each of `targets` with a tiny call, all at once: those whose call fails for a reason `cannotCall` names, with why.
 * A model that answers, times out or fails for another reason is not marked.
 */
export async function tryModels(models: Models, targets: readonly Model<Api>[], timeoutMs = TRY_MS): Promise<ModelFailures> {
  const signal = AbortSignal.timeout(timeoutMs);
  const ask = async (model: Model<Api>): Promise<string> => {
    try {
      const reasoning = model.reasoning ? (clampThinkingLevel(model, "minimal") as Exclude<ModelThinkingLevel, "off">) : undefined;
      const context = { messages: [{ role: "user" as const, content: "Reply with OK.", timestamp: Date.now() }] };
      const reply = await abortable(
        models.completeSimple(model, context, { maxTokens: TRY_TOKENS, signal, ...(reasoning && { reasoning }) }),
        signal,
      );
      return reply.stopReason === "error" ? (reply.errorMessage ?? "") : "";
    } catch (error) {
      return signal.aborted ? "" : errorMessage(error);
    }
  };
  const errors = await Promise.all(targets.map(ask));
  const at = Date.now();
  return Object.fromEntries(
    targets.flatMap((model, i) => (cannotCall(errors[i]) ? [[modelKey(model.provider, model.id), failureOf(errors[i], at)]] : [])),
  );
}

/**
 * `models`, calling `report` with the picker's id of a model and why, once per call, when a call to it fails for a
 * reason `cannotCall` names.
 */
export function withFailuresReported(models: Models, report: (id: string, error: string) => void): Models {
  const streamSimple = models.streamSimple.bind(models);
  // completeSimple goes through streamSimple too.
  models.streamSimple = (model, context, options) => {
    let reported = false;
    const check = (stopReason: string, error: string | undefined) => {
      if (reported || stopReason !== "error" || !error || !cannotCall(error)) return;
      reported = true;
      report(modelKey(model.provider, model.id), error);
    };
    return tapStream(
      streamSimple(model, context, options),
      (event) => {
        if (event.type === "error") check(event.reason, event.error.errorMessage);
      },
      (message) => check(message.stopReason, message.errorMessage),
    );
  };
  return models;
}
