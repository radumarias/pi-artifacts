import type { ArtifactManifest, ArtifactMeta, ArtifactSummary } from "../../shared/protocol.ts";
import { errorMessage, formatBytes, plural } from "../../shared/util.ts";
import { BrowserUnavailable } from "../artifacts/browser.ts";
import type { CheckInput, CheckReport } from "../artifacts/check.ts";
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
  /** Render a page in a headless browser and report on it (worker/artifacts/check.ts). Throws BrowserUnavailable without one. */
  checkPage(input: CheckInput): Promise<CheckReport>;
  /** The artifacts published in this chat, newest first. */
  chatArtifacts(): Promise<ArtifactSummary[]>;
  /** The pages checked or tried in this chat and not published yet: in the owner's folder, encrypted with their key. */
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

/** A page to publish: as html with what it declares, or by the id of its draft that passed a check (`checkId`). */
export type PublishInput = PublishTarget & ({ html: string; mcp?: McpDeclaration } | { checkId: string });

/** The manifest a page declares, checked against the chat's servers, and the page's size. Throws with what to fix. */
export async function validPage(scope: PublishScope, html: string, mcp: McpDeclaration | undefined, what: string): Promise<ArtifactManifest> {
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error("The page is over 2 MB; summarise the data instead of inlining it.");
  const manifest: ArtifactManifest = mcp?.length ? { mcp: { servers: mcp } } : {};
  const problems = await checkManifest(scope.hub, manifest);
  if (problems.length) throw new Error(`${what} Fix the mcp declaration:\n${problems.join("\n")}`);
  return manifest;
}

/** Check a page in the headless browser: its report, or why no browser could check it. */
export async function checkInBrowser(scope: PublishScope, input: CheckInput): Promise<{ report?: CheckReport; unchecked?: string }> {
  try {
    return { report: await scope.checkPage(input) };
  } catch (error) {
    if (!(error instanceof BrowserUnavailable)) throw error;
    return { unchecked: error.message };
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

/** The page a publish names, and its draft if it has one: by checkId only a draft that passed. */
async function pageToPublish(scope: PublishScope, drafts: ChatDrafts, input: PublishInput): Promise<{ page: DraftPage; prior?: DraftSummary | Draft }> {
  if ("checkId" in input) {
    const draft = await drafts.get(input.checkId);
    if (!draft)
      throw new Error(`No draft "${input.checkId}" in this chat: it was published, or dropped as one of the oldest. Send the page as html, with its mcp.`);
    if (!passed(draft)) throw new Error(`Draft "${input.checkId}" has not passed a check (${draftLine(draft)}). Fix it, and check it again.`);
    // The chat's servers may have changed since the check.
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
export async function publishChecked(scope: PublishScope, input: PublishInput): Promise<PublishOutcome> {
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
  const checked = await checkInBrowser(scope, { html: page.html, manifest: page.manifest });
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
