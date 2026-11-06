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
export const MAX_FAILURE_CHARS = 300;

/**
 * Whether an error says the model cannot be called at all, for now: no key, or one refused; no credits, quota or
 * payment; no such model, or no access to it. Not a rate limit, an overloaded or failing server, a timeout, or a request
 * the model refused for what it held (too long, a bad tool): those pass, or are the conversation's, not the model's.
 */
export function cannotCall(error: string): boolean {
  return CANNOT_CALL.test(error);
}

const CANNOT_CALL =
  /\b(?:401|402|403|404)\b|insufficient|quota|balance|billing|credits?\b|payment|unauthori[sz]ed|forbidden|permission|not[ _]found|does not exist|no access|access denied|api[ _]key|deactivated|suspended/i;

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
  const tries = await Promise.all(
    targets.map(async (model): Promise<[string, string] | undefined> => {
      try {
        const reply = await abortable(
          models.completeSimple(
            model,
            {
              messages: [
                {
                  role: "user",
                  content: "Reply with OK.",
                  timestamp: Date.now(),
                },
              ],
            },
            {
              maxTokens: TRY_TOKENS,
              signal,
              ...(model.reasoning && {
                reasoning: clampThinkingLevel(model, "minimal") as Exclude<ModelThinkingLevel, "off">,
              }),
            },
          ),
          signal,
        );
        const error = reply.stopReason === "error" ? (reply.errorMessage ?? "") : "";
        return error && cannotCall(error) ? [modelKey(model.provider, model.id), error] : undefined;
      } catch (error) {
        const message = errorMessage(error);
        return !signal.aborted && cannotCall(message) ? [modelKey(model.provider, model.id), message] : undefined;
      }
    }),
  );
  const at = Date.now();
  return Object.fromEntries(tries.flatMap((failed) => (failed ? [[failed[0], { error: clip(failed[1], MAX_FAILURE_CHARS), at }]] : [])));
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
