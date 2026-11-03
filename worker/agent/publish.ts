import { canonicalJson } from "../../shared/canonical.ts";
import type { ArtifactManifest, ArtifactMeta, ArtifactSummary } from "../../shared/protocol.ts";
import { errorMessage, sha256Hex } from "../../shared/util.ts";
import { BrowserUnavailable } from "../artifacts/browser.ts";
import type { CheckInput, CheckReport } from "../artifacts/check.ts";
import { checkManifest, MAX_HTML_BYTES } from "../artifacts/manifest.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { ArtifactStore } from "../storage/artifacts.ts";
import { passed, type ChatDrafts, type Draft } from "../storage/drafts.ts";

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

export interface PublishInput {
  title: string;
  html: string;
  artifactId?: string;
  /** A separate artifact even when this chat has one by this title (see artifactFor). */
  newArtifact?: boolean;
  mcp?: NonNullable<ArtifactManifest["mcp"]>["servers"];
  message?: string;
}

/** The manifest a page declares, checked against the chat's servers, and the page's size. Throws with what to fix. */
export async function validPage(scope: PublishScope, html: string, mcp: PublishInput["mcp"], what: string): Promise<ArtifactManifest> {
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error("The page is over 2 MB; summarise the data instead of inlining it.");
  const manifest: ArtifactManifest = mcp?.length ? { mcp: { servers: mcp } } : {};
  const problems = await checkManifest(scope.hub, manifest);
  if (problems.length) throw new Error(`${what} Fix the mcp declaration:\n${problems.join("\n")}`);
  return manifest;
}

/** Store a new version with its checked manifest and index it for the user. */
async function publishArtifact(scope: PublishScope, input: PublishInput, manifest: ArtifactManifest): Promise<ArtifactMeta> {
  const meta = await scope.artifacts.publishVersion({
    id: input.artifactId,
    ownerUid: scope.uid,
    chatId: scope.chatId,
    title: input.title,
    html: input.html,
    manifest,
    message: input.message,
  });
  await scope.onPublished({ id: meta.id, title: meta.title, latest: meta.latest, updatedAt: meta.updatedAt });
  return meta;
}

/** The id a page is saved as a draft by: the start of a SHA-256 of its manifest and the page. */
export async function draftId(html: string, manifest: ArtifactManifest): Promise<string> {
  return (await sha256Hex(`${canonicalJson(manifest)}\u0000${html}`)).slice(0, 16);
}

/**
 * Save a page as this chat's newest draft, with what its check found (`report`; null when no browser checked it).
 * Saved again, it keeps the artifact it was for, and a pass, unless told otherwise.
 */
export async function saveDraft(
  drafts: ChatDrafts,
  id: string,
  page: Pick<Draft, "html" | "manifest" | "artifactId">,
  report: CheckReport | null,
  before: Draft | null,
): Promise<Draft> {
  const draft: Draft = {
    ...page,
    id,
    artifactId: page.artifactId ?? before?.artifactId,
    savedAt: Date.now(),
    errors: report ? report.errors.length : (before?.errors ?? null),
    warnings: report ? report.warnings.length : (before?.warnings ?? 0),
  };
  await drafts.save(draft);
  return draft;
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
async function artifactFor(scope: PublishScope, input: PublishInput, checkedFor?: string): Promise<{ id?: string; byTitle?: boolean }> {
  if (input.artifactId !== undefined) return { id: input.artifactId };
  if (input.newArtifact) return {};
  if (checkedFor !== undefined) return { id: checkedFor };
  const same = artifactByTitle(await scope.chatArtifacts(), input.title);
  return same ? { id: same.id, byTitle: true } : {};
}

/**
 * Publish a page, but only one without errors: one whose draft passed a check as it is now, or that passes one here.
 * A page that does not is kept as a draft and makes no version. Without a browser to check in, the page is not
 * published either, except in local development (PublishScope.publishUnchecked), and `unchecked` says why. A published
 * page's draft goes: its version holds it now.
 */
export async function publishChecked(scope: PublishScope, input: PublishInput): Promise<PublishOutcome> {
  const manifest = await validPage(scope, input.html, input.mcp, "Not published.");
  const [id, drafts] = await Promise.all([draftId(input.html, manifest), scope.drafts()]);
  const saved = await drafts.get(id);
  const publish = async (outcome: Omit<PublishOutcome, "meta" | "byTitle" | "draft">): Promise<PublishOutcome> => {
    const target = await artifactFor(scope, input, saved?.artifactId);
    const meta = await publishArtifact(scope, { ...input, artifactId: target.id }, manifest);
    // Published already: a draft left behind is only clutter, never a reason to fail.
    await drafts.remove(id).catch((error: unknown) => console.error("draft:", errorMessage(error)));
    return { ...outcome, meta, byTitle: target.byTitle };
  };
  if (saved && passed(saved)) return publish({});
  const page = { html: input.html, manifest, artifactId: input.artifactId };
  let report: CheckReport;
  try {
    report = await scope.checkPage({ html: input.html, manifest });
  } catch (error) {
    if (!(error instanceof BrowserUnavailable)) throw error;
    if (scope.publishUnchecked) return publish({ unchecked: error.message });
    return { unchecked: error.message, draft: await saveDraft(drafts, id, page, null, saved) };
  }
  if (report.errors.length) return { report, draft: await saveDraft(drafts, id, page, report, saved) };
  return publish({ report });
}
