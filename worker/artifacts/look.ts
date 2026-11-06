import type { ClassifierModel, Usage } from "@earendil-works/pi-ai";
import { classify } from "@earendil-works/pi-ai/api/cloudflare-workers-ai-system-one";
import { clip, deadline, errorMessage } from "../../shared/util.ts";
import { bindingClassifierOptions, systemOneModel, type ModelRunner } from "../agent/workers-ai.ts";
import type { CheckReport } from "./check.ts";

/**
 * A second pair of eyes on a page check: a vision classifier on Workers AI (TypeSafe's Jev by default, CHECK_LOOK_MODEL)
 * looks at the check's screenshot and says whether the page shows its content, or renders blank, shows an error, is
 * stuck loading or is laid out broken. The check's own rules see the console, the calls and the text; this catches what
 * only shows in the picture: text no one can see, a chart that drew nothing, a layout that fell apart.
 *
 * A classifier answers a choice question without writing text, with a probability for each answer: fast (well under a
 * second) and charged for input only. A sure "blank" or "error" is an error, so the page is not published; anything
 * less sure, and the other verdicts, are warnings. A model can be wrong, so a draft it stopped once (its check keeps
 * that, worker/storage/drafts.ts) is not looked at again: checked again unchanged, after the agent looked at the
 * screenshot itself, the finding is only a warning. When the look fails or takes too long, the check goes on as it
 * would without it.
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
const LOOK_MS = 6_000;
/** How much of the page's visible text the classifier reads with the picture. */
const MAX_TEXT = 1_500;

/** What a look found, as the report keeps it. */
export interface PageLook {
  /** The classifier's name, as people read it: "Jev". */
  by: string;
  verdict: LookVerdict;
  /** How sure of it the classifier is, 0 to 1. */
  probability: number;
}

/** One look at a screenshot: what the classifier answered, and what the call cost (on a billed call that failed, LookFailed has it). */
export type Look = (screenshot: string, text: string, signal: AbortSignal) => Promise<{ look: PageLook; usage?: Usage }>;

/** A look that failed, with what the call cost when it was billed all the same. */
export class LookFailed extends Error {
  constructor(
    message: string,
    readonly usage?: Usage,
  ) {
    super(message);
  }
}

/** The look of a System One classifier on Workers AI, through the AI binding. */
export function classifierLook(ai: ModelRunner, model: ClassifierModel<"cloudflare-workers-ai-system-one">): Look {
  const options = { ...bindingClassifierOptions(ai), maxRetries: 0 };
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
    // A request whose answer could not be read was still billed: its usage goes with the error.
    if (result.stopReason !== "stop") throw new LookFailed(result.errorMessage ?? `stopped: ${result.stopReason}`, result.usage);
    const answer = result.answers.shows;
    if (answer?.type !== "choice" || !Object.hasOwn(VERDICTS, answer.choice))
      throw new LookFailed(`no verdict in its answer: ${JSON.stringify(answer)}`, result.usage);
    const verdict = answer.choice as LookVerdict;
    return { look: { by: model.name, verdict, probability: answer.probabilities[verdict] ?? answer.confidence }, usage: result.usage };
  };
}

/**
 * The look CHECK_LOOK_MODEL names: a System One classifier on Workers AI that sees images, by its Workers AI id
 * (`typesafe/jev`). Undefined for an empty setting, and, saying so in the log, for one that names no such model.
 */
export function lookFrom(spec: string | undefined, ai: ModelRunner): Look | undefined {
  const id = spec?.trim();
  if (!id) return undefined;
  const model = systemOneModel(id);
  if (!model?.input.includes("image")) {
    console.warn(`CHECK_LOOK_MODEL: ${id} is not a System One model on Workers AI that sees images; checks go on without a look.`);
    return undefined;
  }
  return classifierLook(ai, model);
}

/** A check with what a look at its screenshot found: what the look cost, and, when it stopped the page, why. */
export interface Reviewed {
  report: CheckReport;
  usage?: Usage;
  /** Set when the look stopped the page: what it saw, for the draft's check to keep (DraftCheck.lookStopped). */
  stopped?: string;
}

export interface ReviewOptions {
  /** What the look saw when it stopped this draft before: it is not asked again, and that is a warning now. */
  stoppedBefore?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * `report`, a check, with what `look` found in its screenshot: nothing for a check that has no screenshot or found
 * errors already (the page is not published either way, and the agent sees the screenshot), or when the look fails,
 * which the log says.
 */
export async function reviewLook(look: Look, report: CheckReport, { stoppedBefore, signal, timeoutMs = LOOK_MS }: ReviewOptions = {}): Promise<Reviewed> {
  if (!report.screenshot || report.errors.length) return { report };
  if (stoppedBefore)
    return { report: { ...report, warnings: [...report.warnings, `${stoppedBefore}, on its check before: look at the screenshot to be sure.`] } };
  // Ends the call once it is no longer waited for: out of time, or the check was stopped.
  const done = new AbortController();
  const asked = look(report.screenshot, report.text, done.signal);
  let spent: Usage | undefined;
  const found = await deadline(asked, timeoutMs, () => new Error(`no answer in ${timeoutMs / 1000} s`), signal)
    .catch((error: unknown) => {
      if (signal?.aborted) throw error;
      if (error instanceof LookFailed) spent = error.usage;
      console.warn("page look:", errorMessage(error));
    })
    .finally(() => done.abort());
  if (!found) return { report, ...(spent && { usage: spent }) };
  const { look: seen, usage } = found;
  // An answer below even odds says nothing, also of the page's content.
  if (seen.probability < WARN_AT) return { report, usage };
  const reviewed: CheckReport = { ...report, look: seen };
  if (seen.verdict === "content") return { report: reviewed, usage };
  const line = `The screenshot looks ${SEEN[seen.verdict]} (${seen.by}, ${Math.round(seen.probability * 100)}% sure)`;
  // An error the page shows for a call that failed outside it (a sign-in, an outage) is the page doing its job.
  const stops = (seen.verdict === "blank" || (seen.verdict === "error" && !report.failedOutside)) && seen.probability >= ERROR_AT;
  if (!stops) return { report: { ...reviewed, warnings: [...report.warnings, `${line}: look at the screenshot to be sure.`] }, usage };
  const fix =
    "Look at the screenshot: fix what makes it so (hidden or same-colour text, a chart that drew nothing, content that never rendered). " +
    `If the page does show what it should, check this draft again unchanged: ${seen.by}'s finding is then only a warning.`;
  return { report: { ...reviewed, errors: [`${line}. ${fix}`] }, usage, stopped: line };
}
