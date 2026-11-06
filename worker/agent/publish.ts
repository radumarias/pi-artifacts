import type { Usage } from "@earendil-works/pi-ai";
import { CHECK_TOOL, DRAFTS_TOOL, manifestOf, WRITE_TOOL, type ArtifactManifest, type ArtifactMeta, type ArtifactSummary } from "../../shared/protocol.ts";
import { collapseSkillFiles, inlinedSkillFiles, inlineSkillFiles, skillRefs, type InlinedPage, type SkillFileInfo } from "../../shared/skill-files.ts";
import { errorMessage, formatBytes, plural } from "../../shared/util.ts";
import { BrowserUnavailable, CheckTimedOut } from "../artifacts/browser.ts";
import { timedOutReport, type CheckInput, type CheckReport } from "../artifacts/check.ts";
import { reviewLook, type Look, type Reviewed } from "../artifacts/look.ts";
import { checkManifest, MAX_HTML_BYTES } from "../artifacts/manifest.ts";
import { withReview, type PageReview, type PageReviewer } from "../artifacts/review.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { ArtifactStore } from "../storage/artifacts.ts";
import { draftId, passed, type ChatDrafts, type Draft, type DraftCheck, type DraftSummary, type SkillSets } from "../storage/drafts.ts";

/** What publishing a page needs from the chat it is published in (and the tools, ChatScope, more). */
export interface PublishScope {
  uid: string;
  chatId: string;
  hub: McpHub;
  artifacts: ArtifactStore;
  onPublished(artifact: Omit<ArtifactSummary, "chatId">): Promise<void>;
  /**
   * Render a page in a headless browser and report on it (worker/artifacts/check.ts), for at most CHECK_MS and until
   * `signal` aborts. Throws BrowserUnavailable without a browser, CheckTimedOut when the page held it too long.
   */
  checkPage(input: CheckInput, signal?: AbortSignal): Promise<CheckReport>;
  /** A vision classifier's look at each check's screenshot (worker/artifacts/look.ts); unset, the checks go without. */
  look?: Look;
  /**
   * A small model's code review of a page, beside its first check (worker/artifacts/review.ts); unset, or resolving to
   * none (no REVIEW_MODEL the deployment can run), pages go unreviewed.
   */
  review?: () => Promise<PageReviewer | undefined>;
  /** The artifacts published in this chat, newest first. */
  chatArtifacts(): Promise<ArtifactSummary[]>;
  /** The pages written in this chat and not published yet: in the owner's folder, encrypted with their key. */
  drafts: () => Promise<ChatDrafts>;
  /** Whether a page may be published unchecked when there is no browser to check it in: local development only. */
  publishUnchecked: boolean;
  /** The files of those of the owner's skills named that are on and have any, by name: what a page may name (shared/skill-files.ts). */
  skillSets(names: readonly string[]): Promise<Map<string, { set: string; files: SkillFileInfo[] }>>;
  /** The bytes of one file of a set of a skill's files (SkillFiles), or null when the set has no such file, or is gone. */
  readSkillFile(skill: string, set: string, path: string): Promise<Uint8Array | null>;
}

/** Which artifact a publish goes to and what the version says (see artifactFor). */
export interface PublishTarget {
  title: string;
  artifactId?: string;
  /** A separate artifact even when this chat has one by this title. */
  newArtifact?: boolean;
  message?: string;
}

type McpDeclaration = NonNullable<ArtifactManifest["mcp"]>["servers"];

/** A draft to publish, by its id, and where it goes. */
export type PublishInput = PublishTarget & { draftId: string };

/** The manifest a page declares, checked against the chat's servers, and the page's size. Throws with what to fix. */
export async function validPage(scope: PublishScope, html: string, mcp: McpDeclaration | undefined, what: string): Promise<ArtifactManifest> {
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error("The page is over 2 MB; summarise the data instead of inlining it.");
  const manifest: ArtifactManifest = mcp?.length ? { mcp: { servers: mcp } } : {};
  const problems = await checkManifest(scope.hub, manifest);
  if (problems.length) throw new Error(`${what} Fix the mcp declaration:\n${problems.join("\n")}`);
  return manifest;
}

/**
 * The sets of skill files a page names files of (SkillSets): each file must be one of a skill of the owner's that is on,
 * and the page with them under the size limit. Throws, starting with `what`, naming what it cannot find.
 */
async function pinSkillFiles(scope: PublishScope, html: string, what: string): Promise<SkillSets> {
  let refs;
  try {
    refs = skillRefs(html);
  } catch (error) {
    throw new Error(`${what} ${errorMessage(error)}`);
  }
  if (!refs.length) return {};
  const found = await scope.skillSets([...new Set(refs.map((ref) => ref.skill))]);
  const sets: SkillSets = {};
  const missing: string[] = [];
  let bytes = new TextEncoder().encode(html).byteLength;
  for (const ref of refs) {
    const skill = found.get(ref.skill);
    const file = skill?.files.find((f) => f.path === ref.path);
    if (!skill || !file) {
      missing.push(`skill:${ref.skill}/${ref.path}`);
      continue;
    }
    sets[ref.skill] = skill.set;
    bytes += file.size;
  }
  if (missing.length)
    throw new Error(`${what} No such skill file: ${missing.join(", ")}. A skill lists its files when activated; only your skills that are on count.`);
  if (bytes > MAX_HTML_BYTES) throw new Error(`${what} With the skill files it names, the page is over ${formatBytes(MAX_HTML_BYTES)}.`);
  return sets;
}

/**
 * The page as it runs: with the skill files it names read from the sets the draft was saved with (pinSkillFiles) and put
 * in their place, and which line of the draft each of its lines is. A page that names none comes back as it is. Throws,
 * starting with `what`, when a set is gone or the page with the files is over the size limit.
 */
async function pageToRun(scope: PublishScope, draft: Draft, what: string): Promise<InlinedPage> {
  let page: InlinedPage;
  try {
    page = await inlineSkillFiles(draft.html, async ({ skill, path }) => {
      const set = draft.skillSets?.[skill];
      return set ? scope.readSkillFile(skill, set, path) : null;
    });
  } catch (error) {
    throw new Error(
      `${what} ${errorMessage(error)} The skill was imported again or deleted since this draft was saved: save it again with ${WRITE_TOOL}, ` +
        `draft_id "${draft.id}" and no edits.`,
    );
  }
  if (page.html !== draft.html && new TextEncoder().encode(page.html).byteLength > MAX_HTML_BYTES)
    throw new Error(`${what} With the skill files it names, the page is over ${formatBytes(MAX_HTML_BYTES)}.`);
  return page;
}

/**
 * A published version's page as the agent reads and edits it: with the skill files publishing put in it turned back
 * into the references it was written with, but for those no skill of the owner's that is on has any more, which stay
 * inlined so that the page can still be edited and published.
 */
export async function readPageSource(scope: Pick<PublishScope, "artifacts" | "skillSets">, id: string, version: number): Promise<string | null> {
  const html = await scope.artifacts.readHtml(id, version);
  if (html === null) return null;
  const inlined = inlinedSkillFiles(html);
  if (!inlined.length) return html;
  const found = await scope.skillSets([...new Set(inlined.map((ref) => ref.skill))]);
  return collapseSkillFiles(html, ({ skill, path }) => found.get(skill)?.files.some((file) => file.path === path) === true);
}

/** Check a page in the headless browser: its report (one error, if it ran out of time), or why no browser could check it. */
export async function checkInBrowser(scope: PublishScope, input: CheckInput, signal?: AbortSignal): Promise<{ report?: CheckReport; unchecked?: string }> {
  try {
    return { report: await scope.checkPage(input, signal) };
  } catch (error) {
    if (error instanceof CheckTimedOut) return { report: timedOutReport(error.message, input.viewport) };
    if (!(error instanceof BrowserUnavailable)) throw error;
    return { unchecked: error.message };
  }
}

export interface PageEdit {
  old: string;
  new: string;
}

/**
 * `html` with `edits` applied in order: each `old` must occur exactly once in the page as the edits before left it, so
 * an edit never lands somewhere the model did not mean. Throws naming every edit that does not apply.
 */
export function applyEdits(html: string, edits: readonly PageEdit[]): string {
  const problems: string[] = [];
  for (const [i, edit] of edits.entries()) {
    const at = edit.old ? html.indexOf(edit.old) : -1;
    if (at < 0) problems.push(`edit ${i + 1}: its old text is not in the page${edit.old ? "" : " (it is empty)"}`);
    else if (html.indexOf(edit.old, at + 1) >= 0) problems.push(`edit ${i + 1}: its old text occurs more than once; add the text around it`);
    else html = html.slice(0, at) + edit.new + html.slice(at + edit.old.length);
  }
  if (problems.length)
    throw new Error(`Not saved: ${problems.join("; ")}. Copy old text exactly from the page (${DRAFTS_TOOL} with a draft_id, or artifact_read, shows it).`);
  return html;
}

/**
 * A page to save as a draft (artifact_write's arguments): a new one as `html`; or the draft `draftId`, or else version
 * `version` (the latest by default) of `artifact`, changed by `edits`. `artifact` is this chat's artifact the page is a
 * version of; the caller checked it is this chat's.
 */
export interface WriteInput {
  html?: string;
  draftId?: string;
  edits?: readonly PageEdit[];
  mcp?: McpDeclaration;
  artifact?: ArtifactMeta;
  version?: number;
}

/** A draft of the chat by its id; else throws, starting with `what`. */
export async function draftNamed(drafts: ChatDrafts, id: string, what = ""): Promise<Draft> {
  const draft = await drafts.get(id);
  if (!draft)
    throw new Error(`${what && `${what} `}No draft "${id}" in this chat: it was published, or dropped as one of the oldest. List them with ${DRAFTS_TOOL}.`);
  return draft;
}

/**
 * Save a page as a draft of the chat, unchecked: what checkDraft and publishDraft then take by its id. A page made by
 * edits keeps what its draft or version declared, and a draft the artifact it was for, unless the input says otherwise.
 * Saving a page that is already a draft keeps how its check went.
 */
export async function writeDraft(scope: PublishScope, input: WriteInput): Promise<Draft & { bytes: number }> {
  const { draftId: from, edits = [], artifact, version } = input;
  if (input.html !== undefined && (from !== undefined || edits.length))
    throw new Error("Pass a new page as html, or edits with the draft_id or artifact_id they change: not both.");
  if (version !== undefined && (input.html !== undefined || from !== undefined))
    throw new Error("version picks the artifact's page that edits change: pass it with artifact_id alone.");
  const drafts = await scope.drafts();
  let { html, mcp } = input;
  let artifactId = artifact?.id;
  let reviewed: true | undefined;
  if (html === undefined) {
    if (from !== undefined) {
      const draft = await draftNamed(drafts, from, "Not saved.");
      html = applyEdits(draft.html, edits);
      mcp ??= draft.manifest.mcp?.servers;
      artifactId ??= draft.artifactId;
      reviewed = draft.reviewed;
    } else if (artifact) {
      const at = version ?? artifact.latest;
      const published = await readPageSource(scope, artifact.id, at);
      if (published === null) throw new Error(`Not saved: artifact ${artifact.id} has versions 1 to ${artifact.latest}.`);
      html = applyEdits(published, edits);
      mcp ??= manifestOf(artifact, at)?.mcp?.servers;
    } else throw new Error("Pass a new page as html, or edits with the draft_id or artifact_id they change.");
  }
  const manifest = await validPage(scope, html, mcp, "Not saved.");
  const skillSets = await pinSkillFiles(scope, html, "Not saved.");
  const id = await draftId(html, manifest, skillSets);
  return drafts.save({ id, html, manifest, artifactId, ...(Object.keys(skillSets).length && { skillSets }), ...(reviewed && { reviewed }) }, null);
}

/** What checking a draft came to: the draft, and the check's report, or why no browser checked it; what the look cost. */
export interface CheckedDraft {
  draft: Draft;
  report?: CheckReport;
  unchecked?: string;
  usage?: Usage;
  /** Set when this check's look at the screenshot stopped the draft: what it saw. */
  lookStopped?: string;
  /** Set when this check reviewed the page's code: the findings are in the report too (withReview). */
  review?: PageReview;
}

/**
 * Check a draft in the headless browser, with a look at its screenshot (scope.look), and keep with it what the check
 * found. A draft not reviewed yet is reviewed beside the check (scope.review), which takes no longer than the slower of
 * the two; its findings join the report, and the draft is reviewed from then on, also when the review failed.
 */
export async function checkDraft(
  scope: PublishScope,
  id: string,
  options: Pick<CheckInput, "tests" | "viewport">,
  signal?: AbortSignal,
): Promise<CheckedDraft> {
  const drafts = await scope.drafts();
  const draft = await draftNamed(drafts, id, "Not checked.");
  const { html, pageLine } = await pageToRun(scope, draft, "Not checked.");
  // Stops the review when the check fails: it is no longer waited for, and a review costs.
  const stop = new AbortController();
  const both = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  // The page as written, without the skill files it names: those are the skill's, not the page's code.
  const reviewing = draft.reviewed ? undefined : scope.review?.().then((review) => review?.(draft.html, both));
  // The look follows the browser check while the review runs: the check takes as long as the slower of the two.
  const looking = checkInBrowser(scope, { html, manifest: draft.manifest, ...options, ...(html !== draft.html && { pageLine }) }, signal).then(
    async ({ report, unchecked }): Promise<Partial<Reviewed> & { unchecked?: string }> =>
      report && scope.look ? await reviewLook(scope.look, report, { stoppedBefore: draft.lookStopped, signal }) : { report, unchecked },
  );
  const [looked, review] = await Promise.all([looking, reviewing]).catch((error: unknown) => {
    stop.abort();
    throw error;
  });
  // A page no browser checked gets its review with its first check that runs.
  const used = looked.report && review;
  const report = used ? withReview(looked.report!, used) : looked.report;
  const check = draftCheck(report);
  const stopped = looked.stopped ?? draft.lookStopped;
  if (check && stopped) check.lookStopped = stopped;
  if (check) await drafts.recordCheck(id, used ? { ...check, reviewed: true } : check);
  return {
    draft: { ...draft, ...check, ...(used && { reviewed: true as const }) },
    report,
    unchecked: looked.unchecked,
    usage: looked.usage,
    lookStopped: looked.stopped,
    review: used || undefined,
  };
}

/** How many checks in a row may find errors before the agent stops fixing and asks the user. */
export const MAX_FAILED_CHECKS = 5;

/**
 * The checks that found errors since the last that passed or the user's last message: a model that
 * cannot fix a page would otherwise go on rewriting it for as long as the run lasts.
 */
export class FailedChecks {
  #count = 0;
  /** The draft the last check found errors in, while no check has passed since. */
  #draft: string | undefined;
  /** The broken draft a whole new page was refused for already. */
  #refused: string | undefined;

  /** Throws once MAX_FAILED_CHECKS failed in a row, before another page is written or checked. */
  allow(what = "Not checked"): void {
    if (this.#count < MAX_FAILED_CHECKS) return;
    const draft = this.#draft;
    throw new Error(
      `${what}: ${MAX_FAILED_CHECKS} checks in a row found errors. Stop fixing and tell the user what still fails and what you tried` +
        `${draft ? ` (the last page is draft "${draft}")` : ""}, and ask how to go on. Their next message lets you check again.`,
    );
  }

  /**
   * The draft the last check found errors in, the first time a whole new page is written after it (until a check
   * passes or the user writes): it is fixed by edits to it, not by writing the page again. Once only, since a new page
   * can also be one the user asked for besides the broken one.
   */
  refuseRewrite(): string | undefined {
    const draft = this.#draft === this.#refused ? undefined : this.#draft;
    this.#refused = this.#draft;
    return draft;
  }

  /**
   * Counts a check's outcome, with the draft it found errors in (none when no browser could check it); returns what to
   * add to a failed check's result when that was the last one allowed.
   */
  record(failed: boolean, broken?: string): string {
    this.#count = failed ? this.#count + 1 : 0;
    if (!failed) this.#draft = undefined;
    else if (broken) this.#draft = broken;
    return this.#count >= MAX_FAILED_CHECKS
      ? ` That is ${MAX_FAILED_CHECKS} failed checks in a row: do not check again. Tell the user what still fails and what you tried, and ask how to go on.`
      : "";
  }

  /** The user wrote: they may have said how to go on. */
  reset(): void {
    this.#count = 0;
    this.#draft = undefined;
  }
}

/** What a check found, as a draft keeps it. */
export const draftCheck = (report: CheckReport | undefined): DraftCheck | null =>
  report ? { errors: report.errors.length, warnings: report.warnings.length } : null;

/** One draft in a listing: its id, when, what it is for and how its check went. */
export function draftLine(draft: Draft | DraftSummary): string {
  const check = draft.errors === null ? "not checked" : passed(draft) ? "passed its check" : plural(draft.errors, "error");
  const warnings = draft.warnings ? `, ${plural(draft.warnings, "warning")}` : "";
  const size = "bytes" in draft ? `, ${formatBytes(draft.bytes)}` : "";
  return `${draft.id}  ${new Date(draft.savedAt).toISOString()}  ${draft.artifactId ? `for artifact ${draft.artifactId}` : "no artifact named"}  ${check}${warnings}${size}`;
}

/** What came of a publish: the version, and whether it went to this chat's artifact by its title or went unchecked. */
export interface Published {
  meta: ArtifactMeta;
  /** Set when the page was published as a new version of this chat's artifact by its title, without an artifact_id. */
  byTitle?: boolean;
  /** Set when no browser checked the page: local development only (PublishScope.publishUnchecked). */
  unchecked?: boolean;
}

/** A title as publishes compare it: case and runs of spaces do not count. */
const titleKey = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The artifact of this chat that a publish titled `title` without an artifact_id revises: the first with that title in
 * `artifacts`, which come newest first. A model that fixes a page and publishes it again often leaves the id out, which
 * would otherwise make another artifact of the same page, each stuck at version 1. Undefined: the publish makes a new one.
 */
export function artifactByTitle(artifacts: readonly ArtifactSummary[], title: string): ArtifactSummary | undefined {
  const key = titleKey(title);
  return artifacts.find((artifact) => titleKey(artifact.title) === key);
}

/**
 * The artifact a publish goes to: the one it names; a new one with newArtifact; else the one the draft was written as a
 * version of (`writtenFor`); else this chat's by its title (artifactByTitle); else a new one.
 */
async function artifactFor(scope: PublishScope, target: PublishTarget, writtenFor?: string): Promise<{ id?: string; byTitle?: boolean }> {
  if (target.artifactId !== undefined) return { id: target.artifactId };
  if (target.newArtifact) return {};
  if (writtenFor !== undefined) return { id: writtenFor };
  const same = artifactByTitle(await scope.chatArtifacts(), target.title);
  return same ? { id: same.id, byTitle: true } : {};
}

/**
 * Publish a draft as a version, but only one that passed its check: also in local development
 * (PublishScope.publishUnchecked), one no browser checked, which is checked here first when a browser can, so a page
 * with errors is never published. A published draft goes: its version holds it now.
 */
export async function publishDraft(scope: PublishScope, input: PublishInput, signal?: AbortSignal): Promise<Published> {
  const drafts = await scope.drafts();
  let draft = await draftNamed(drafts, input.draftId, "Not published.");
  if (draft.errors === null && scope.publishUnchecked) draft = (await checkDraft(scope, draft.id, {}, signal)).draft;
  const unchecked = draft.errors === null;
  if (draft.errors)
    throw new Error(
      `Not published: the check found ${plural(draft.errors, "error")} in draft "${draft.id}". Fix them with ${WRITE_TOOL}, ` +
        `draft_id "${draft.id}" and edits, then ${CHECK_TOOL} the new draft.`,
    );
  if (unchecked && !scope.publishUnchecked) throw new Error(`Not published: draft "${draft.id}" has not passed a check. Check it with ${CHECK_TOOL} first.`);
  // The chat's servers may have changed since the page was written.
  await validPage(scope, draft.html, draft.manifest.mcp?.servers, "Not published.");
  // The version holds the skill files the check ran with: it never changes when the skill does.
  const { html } = await pageToRun(scope, draft, "Not published.");
  const target = await artifactFor(scope, input, draft.artifactId);
  const meta = await scope.artifacts.publishVersion({
    id: target.id,
    ownerUid: scope.uid,
    chatId: scope.chatId,
    title: input.title,
    html,
    manifest: draft.manifest,
    message: input.message,
  });
  await scope.onPublished({ id: meta.id, title: meta.title, latest: meta.latest, updatedAt: meta.updatedAt });
  // Published already: a draft left behind is only clutter, never a reason to fail.
  await drafts.remove(draft.id).catch((error: unknown) => console.error("draft:", errorMessage(error)));
  return { meta, byTitle: target.byTitle, ...(unchecked && { unchecked }) };
}
