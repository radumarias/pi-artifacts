import type { ClassifierModel, Usage } from "@earendil-works/pi-ai";
import { classify } from "@earendil-works/pi-ai/api/cloudflare-workers-ai-system-one";
import { CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { clip, errorMessage } from "../../shared/util.ts";
import { viaAIBinding, type ModelRunner } from "../ai-binding.ts";
import type { CheckReport } from "./check.ts";

/**
 * A second pair of eyes on a page check: a vision classifier on Workers AI (TypeSafe's Jev by default, CHECK_LOOK_MODEL)
 * looks at the check's screenshot and says whether the page shows its content, or renders blank, shows an error, is
 * stuck loading or is laid out broken. The check's own rules see the console, the calls and the text; this catches what
 * only shows in the picture: text no one can see, a chart that drew nothing, a layout that fell apart.
 *
 * A classifier answers a choice question without writing text, with a probability for each answer: fast (well under a
 * second) and charged for input only. A sure "blank" or "error" is an error, so the page is not published; anything
 * less sure, and the other verdicts, are warnings. A model can be wrong, so a draft it stopped once is never stopped
 * again by it: checked again unchanged, after the agent looked at the screenshot itself, the finding is only a warning.
 * When the look fails or takes too long, the check goes on as it would without it.
 */

/** What the page looks like, as the classifier answers. */
export type LookVerdict = "content" | "blank" | "error" | "loading" | "broken";

/** Each answer, as the classifier reads it. */
const VERDICTS: Record<LookVerdict, string> = {
  content: "The page shows its content as meant: headings with text, numbers, tables, charts or maps with data drawn, readable and laid out in place.",
  blank: "Blank or nearly blank: an empty or single-colour screen, or only a title, header or empty frame with nothing in it.",
  error: "An error shows instead of content: an error message, a stack trace, or undefined, NaN, null or [object Object] where values should be.",
  loading: "Stuck loading: spinners, skeleton placeholders or 'Loading…' where the content should be.",
  broken: "Broken: parts overlap or are cut off, unstyled raw HTML, a chart or map with empty axes or no data drawn, text unreadable against its background.",
};

/** How each verdict reads in the report: "The screenshot looks blank". */
const SEEN: Record<Exclude<LookVerdict, "content">, string> = {
  blank: "blank",
  error: "like it shows an error instead of content",
  loading: "stuck loading",
  broken: "broken (overlapping, cut off, unstyled or with an empty chart)",
};

const INSTRUCTIONS =
  "The image is a screenshot of a web page (a dashboard or report an assistant built) in a headless browser, once its scripts ran and its data " +
  "arrived. The state has the page's visible text, as the browser read it. Say what the screenshot shows. Text that is in the visible text but " +
  "not in the picture is hidden or unreadable.";

/** A verdict this sure stops the page; one less sure, or of the others, is a warning; below WARN_AT, nothing. */
const ERROR_AT = 0.8;
const WARN_AT = 0.5;
/** How long the look may take: a check that passed waits for it. */
export const LOOK_MS = 6_000;
/** How much of the page's visible text the classifier reads with the picture. */
const MAX_TEXT = 1_500;
/** The drafts a look stopped, remembered so it never stops one twice: the newest this many. */
const MAX_FLAGGED = 50;

/** What a look found, as the report keeps it. */
export interface PageLook {
  /** The classifier's name, as people read it: "Jev". */
  by: string;
  verdict: LookVerdict;
  /** How sure of it the classifier is, 0 to 1. */
  probability: number;
}

/** One look at a screenshot: what the classifier answered, and what the call cost. */
export type Look = (screenshot: string, text: string, signal: AbortSignal) => Promise<{ look: PageLook; usage?: Usage }>;

/** The look of a System One classifier on Workers AI, through the AI binding. */
export function classifierLook(ai: ModelRunner, model: ClassifierModel<"cloudflare-workers-ai-system-one">): Look {
  // The binding needs no key; pi-ai only wants one to send.
  const options = { apiKey: "ai-binding", fetch: viaAIBinding(ai), maxRetries: 0 };
  return async (screenshot, text, signal) => {
    const result = await classify(
      model,
      {
        state: { visibleText: clip(text, MAX_TEXT) || "(none)" },
        images: [{ type: "image", data: screenshot, mimeType: "image/jpeg" }],
        questions: { shows: { type: "choice", instructions: INSTRUCTIONS, criteria: VERDICTS } },
      },
      { ...options, signal },
    );
    if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `stopped: ${result.stopReason}`);
    const answer = result.answers.shows;
    const verdict = answer?.type === "choice" && Object.hasOwn(VERDICTS, answer.choice) ? (answer.choice as LookVerdict) : undefined;
    if (!verdict || answer?.type !== "choice") throw new Error(`no verdict in its answer: ${JSON.stringify(answer)}`);
    return {
      look: { by: model.name, verdict, probability: answer.probabilities[verdict] ?? answer.confidence },
      ...(result.usage && { usage: result.usage }),
    };
  };
}

/**
 * A chat's looks by the classifier CHECK_LOOK_MODEL names: a System One model on Workers AI that sees images, by its
 * Workers AI id (`typesafe/jev`). Undefined for an empty setting, and, saying so in the log, for one that names no such model.
 */
export function pageLooks(spec: string | undefined, ai: ModelRunner): PageLooks | undefined {
  const id = spec?.trim();
  if (!id) return undefined;
  const classifiers = CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS as Record<string, ClassifierModel<"cloudflare-workers-ai-system-one">>;
  const model = Object.hasOwn(classifiers, id) ? classifiers[id] : undefined;
  if (!model?.input.includes("image")) {
    console.warn(`CHECK_LOOK_MODEL: ${id} is not a System One model on Workers AI that sees images; checks go on without a look.`);
    return undefined;
  }
  return new PageLooks(classifierLook(ai, model));
}

/** A chat's looks at its checks' screenshots, and the drafts they stopped. */
export class PageLooks {
  readonly #look: Look;
  readonly #timeoutMs: number;
  readonly #flagged = new Set<string>();

  constructor(look: Look, timeoutMs = LOOK_MS) {
    this.#look = look;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * `report`, the check of draft `draftId`, with what a look at its screenshot found: none for a check that has no
   * screenshot or found errors already (the page is not published either way, and the agent sees the screenshot), or
   * when the look fails, which the log says.
   */
  async review(draftId: string, report: CheckReport, signal?: AbortSignal): Promise<CheckReport> {
    if (!report.screenshot || report.errors.length) return report;
    signal?.throwIfAborted();
    let found: Awaited<ReturnType<Look>>;
    try {
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      found = await this.#look(report.screenshot, report.text, signal ? AbortSignal.any([signal, timeout]) : timeout);
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn("page look:", errorMessage(error));
      return report;
    }
    const { look, usage } = found;
    const reviewed: CheckReport = { ...report, look, ...(usage && { usage }) };
    if (look.verdict === "content" || look.probability < WARN_AT) return reviewed;
    const sure = `${look.by}, ${Math.round(look.probability * 100)}% sure`;
    const seen = `The screenshot looks ${SEEN[look.verdict]} (${sure})`;
    // An error the page shows for a call that failed outside it (a sign-in, an outage) is the page doing its job.
    const stops = (look.verdict === "blank" || (look.verdict === "error" && !report.failedOutside)) && look.probability >= ERROR_AT;
    if (stops && !this.#flagged.has(draftId)) {
      this.#remember(draftId);
      const fix =
        "Look at the screenshot: fix what makes it so (hidden or same-colour text, a chart that drew nothing, content that never rendered). " +
        `If the page does show what it should, check this draft again unchanged: ${look.by}'s finding is then only a warning.`;
      return { ...reviewed, errors: [`${seen}. ${fix}`] };
    }
    return { ...reviewed, warnings: [...report.warnings, `${seen}: look at the screenshot to be sure.`] };
  }

  #remember(draftId: string): void {
    this.#flagged.add(draftId);
    if (this.#flagged.size > MAX_FLAGGED) this.#flagged.delete(this.#flagged.values().next().value!);
  }
}
