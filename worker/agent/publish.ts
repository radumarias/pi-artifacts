import { CHECK_TOOL, DRAFTS_TOOL, manifestOf, WRITE_TOOL, type ArtifactManifest, type ArtifactMeta, type ArtifactSummary } from "../../shared/protocol.ts";
import { errorMessage, formatBytes, plural } from "../../shared/util.ts";
import { BrowserUnavailable, CheckTimedOut } from "../artifacts/browser.ts";
import { timedOutReport, type CheckInput, type CheckReport } from "../artifacts/check.ts";
import { checkManifest, MAX_HTML_BYTES } from "../artifacts/manifest.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { ArtifactStore } from "../storage/artifacts.ts";
import { draftId, passed, type ChatDrafts, type Draft, type DraftCheck, type DraftPage, type DraftSummary } from "../storage/drafts.ts";

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
  /** The artifacts published in this chat, newest first. */
  chatArtifacts(): Promise<ArtifactSummary[]>;
  /** The pages written in this chat and not published yet: in the owner's folder, encrypted with their key. */
  drafts: () => Promise<ChatDrafts>;
  /** Whether a page may be published unchecked when there is no browser to check it in: local development only. */
  publishUnchecked: boolean;
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

/** A page to publish: by its draft's id (the agent's way), or as html with what it declares (local development's). */
export type PublishInput = PublishTarget & ({ draftId: string } | { html: string; mcp?: McpDeclaration });

/** The manifest a page declares, checked against the chat's servers, and the page's size. Throws with what to fix. */
export async function validPage(scope: PublishScope, html: string, mcp: McpDeclaration | undefined, what: string): Promise<ArtifactManifest> {
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error("The page is over 2 MB; summarise the data instead of inlining it.");
  const manifest: ArtifactManifest = mcp?.length ? { mcp: { servers: mcp } } : {};
  const problems = await checkManifest(scope.hub, manifest);
  if (problems.length) throw new Error(`${what} Fix the mcp declaration:\n${problems.join("\n")}`);
  return manifest;
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

/**
 * `html` with `edits` applied in order: each `old` must occur exactly once in the page as the edits before left it, so
 * an edit never lands somewhere the model did not mean. Throws naming every edit that does not apply.
 */
export function applyEdits(html: string, edits: readonly { old: string; new: string }[]): string {
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

export interface PageEdit {
  old: string;
  new: string;
}

/**
 * A page to save as a draft: a new one as html, a draft changed by `edits`, or the latest version of this chat's
 * artifact `artifactId` changed by `edits`; with what it declares and the artifact it is a version of.
 */
export type WriteInput = ({ html: string } | { draftId: string; edits: readonly PageEdit[] } | { edits: readonly PageEdit[]; artifactId: string }) & {
  mcp?: McpDeclaration;
  artifactId?: string;
};

/**
 * Save a page as a draft of the chat, unchecked: what artifact_check and artifact_publish then take by its id. A page
 * made by edits keeps what its draft or version declared, and a draft the artifact it was for, unless the input says
 * otherwise. Saving a page that is already a draft keeps how its check went. The caller checks an artifactId is this chat's.
 */
export async function writeDraft(scope: PublishScope, input: WriteInput): Promise<Draft> {
  const drafts = await scope.drafts();
  let { mcp, artifactId } = input;
  let html: string;
  if ("html" in input) html = input.html;
  else if ("draftId" in input) {
    const draft = await drafts.get(input.draftId);
    if (!draft) throw new Error(`No draft "${input.draftId}" in this chat. List them with ${DRAFTS_TOOL}.`);
    html = applyEdits(draft.html, input.edits);
    mcp ??= draft.manifest.mcp?.servers;
    artifactId ??= draft.artifactId;
  } else {
    const meta = await scope.artifacts.readMeta(input.artifactId);
    const latest = meta && (await scope.artifacts.readHtml(meta.id, meta.latest));
    if (!meta || latest === null) throw new Error(`No artifact ${input.artifactId} to edit.`);
    html = applyEdits(latest, input.edits);
    mcp ??= manifestOf(meta, meta.latest)?.mcp?.servers;
  }
  const manifest = await validPage(scope, html, mcp, "Not saved.");
  return drafts.save({ id: await draftId(html, manifest), html, manifest, artifactId }, null);
}

/** How many checks in a row may find errors before the agent stops fixing and asks the user. */
export const MAX_FAILED_CHECKS = 5;

/**
 * The checks and publishes that found errors since the last that passed or the user's last message: a model that
 * cannot fix a page would otherwise go on rewriting it for as long as the run lasts.
 */
export class FailedChecks {
  #count = 0;
  /** The draft the last check found errors in, while no check has passed since. */
  #draft: string | undefined;

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
   * The draft the last check found errors in, when the one before a pass: it is fixed by edits to it, not by writing
   * the whole page again. Undefined once a check passed or the user wrote.
   */
  get broken(): string | undefined {
    return this.#draft;
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

/** What came of a publish: the version, else the check's report or `unchecked` on why there is none, and the draft kept. */
export interface PublishOutcome {
  meta?: ArtifactMeta;
  /** The draft the page was saved as, when it was not published. */
  draft?: Draft;
  /** The check run here, if the page had not passed one already. */
  report?: CheckReport;
  /** Why no browser checked the page, when none did. */
  unchecked?: string;
  /** Set when the page was published as a new version of this chat's artifact by its title, without an artifact_id. */
  byTitle?: boolean;
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
 * The artifact a publish goes to: the one it names; a new one with newArtifact; else the one the page was checked as a
 * version of (`checkedFor`); else this chat's by its title (artifactByTitle); else a new one.
 */
async function artifactFor(scope: PublishScope, target: PublishTarget, checkedFor?: string): Promise<{ id?: string; byTitle?: boolean }> {
  if (target.artifactId !== undefined) return { id: target.artifactId };
  if (target.newArtifact) return {};
  if (checkedFor !== undefined) return { id: checkedFor };
  const same = artifactByTitle(await scope.chatArtifacts(), target.title);
  return same ? { id: same.id, byTitle: true } : {};
}

/**
 * The page a publish names, and its draft if it has one: by draftId one that passed its check, or that no check has
 * found errors in yet (publishChecked checks that one first).
 */
async function pageToPublish(scope: PublishScope, drafts: ChatDrafts, input: PublishInput): Promise<{ page: DraftPage; prior?: DraftSummary | Draft }> {
  if ("draftId" in input) {
    const draft = await drafts.get(input.draftId);
    if (!draft) throw new Error(`No draft "${input.draftId}" in this chat: it was published, or dropped as one of the oldest. List them with ${DRAFTS_TOOL}.`);
    if (draft.errors)
      throw new Error(
        `Not published: draft "${input.draftId}" has ${plural(draft.errors, "error")} from its check. Fix them with ${WRITE_TOOL}, ` +
          `passing draft_id "${input.draftId}" and edits, then ${CHECK_TOOL} the new draft.`,
      );
    // The chat's servers may have changed since the page was written.
    await validPage(scope, draft.html, draft.manifest.mcp?.servers, "Not published.");
    return { page: draft, prior: draft };
  }
  const manifest = await validPage(scope, input.html, input.mcp, "Not published.");
  const id = await draftId(input.html, manifest);
  return { page: { id, html: input.html, manifest, artifactId: input.artifactId }, prior: await drafts.summary(id) };
}

/**
 * Publish a page, but only one without errors: one whose draft passed a check as it is now, or that passes one here.
 * A page that does not is kept as a draft and makes no version. Without a browser to check in, the page is not
 * published either, except in local development (PublishScope.publishUnchecked), and `unchecked` says why. A published
 * page's draft goes: its version holds it now.
 */
export async function publishChecked(
  scope: PublishScope,
  input: PublishInput,
  signal?: AbortSignal,
  /** Called before the page is checked here (not when it passed a check already); may throw to refuse the check. */
  beforeCheck?: () => void,
): Promise<PublishOutcome> {
  const drafts = await scope.drafts();
  const { page, prior } = await pageToPublish(scope, drafts, input);
  const publish = async (outcome: Omit<PublishOutcome, "meta" | "byTitle" | "draft">): Promise<PublishOutcome> => {
    const target = await artifactFor(scope, input, prior?.artifactId);
    const meta = await scope.artifacts.publishVersion({
      id: target.id,
      ownerUid: scope.uid,
      chatId: scope.chatId,
      title: input.title,
      html: page.html,
      manifest: page.manifest,
      message: input.message,
    });
    await scope.onPublished({ id: meta.id, title: meta.title, latest: meta.latest, updatedAt: meta.updatedAt });
    // Published already: a draft left behind is only clutter, never a reason to fail.
    if (prior) await drafts.remove(page.id).catch((error: unknown) => console.error("draft:", errorMessage(error)));
    return { ...outcome, meta, byTitle: target.byTitle };
  };
  if (prior && passed(prior)) return publish({});
  beforeCheck?.();
  const checked = await checkInBrowser(scope, { html: page.html, manifest: page.manifest }, signal);
  if (checked.report ? !checked.report.errors.length : scope.publishUnchecked) {
    try {
      return await publish(checked);
    } catch (error) {
      // Keep the page and how its check went, so publishing it again (by its id, as the draft) needs no second check.
      await drafts.save(page, draftCheck(checked.report)).catch((e: unknown) => console.error("draft:", errorMessage(e)));
      throw error;
    }
  }
  return { ...checked, draft: await drafts.save(page, draftCheck(checked.report)) };
}
