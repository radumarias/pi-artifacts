// A run's page step: the run's report in the page's findings block (an edit of its latest version), or a rebuilt
// page's checked draft, published in code through the same check and publish every page goes through, in the chat the
// page belongs to. A page that fails its check is not published: the run records "page not updated" and still sends
// its other deliveries. Each version a run publishes carries the run's mark, so a run that goes on publishes once.

import { canonicalJson } from "../../../shared/canonical.ts";
import type { ArtifactMeta } from "../../../shared/protocol.ts";
import type { RunDelivery } from "../../../shared/runs.ts";
import { errorMessage, plural } from "../../../shared/util.ts";
import { checkDraft, publishDraft, readPageSource, writeDraft, type PublishScope } from "../../agent/publish.ts";
import { MAX_VERSION_MESSAGE } from "../../storage/artifacts.ts";
import { passed, type Draft, type DraftSummary } from "../../storage/drafts.ts";
import { findingsEdit } from "./report.ts";

/** What a version a run published says it is: the run's due time and the delivery's key. */
export const runMark = (dueAt: number, key: string): string => `[run ${dueAt}/${key}]`;

const notUpdated = (meta: ArtifactMeta, why: string): RunDelivery => ({ kind: "page", to: meta.title, status: "failed", detail: `page not updated: ${why}` });

const published = (meta: ArtifactMeta, version: number): RunDelivery => ({
  kind: "page",
  to: meta.title,
  status: "sent",
  detail: `${meta.title} v${version} published`,
  version,
});

/** The version of `meta` this delivery published already (its message ends with `mark`), when one did: check it first. */
export function publishedAlready(meta: ArtifactMeta, mark: string): RunDelivery | null {
  const version = meta.versions.find((one) => one.message?.endsWith(mark));
  return version ? published(meta, version.version) : null;
}

/** Put `report` in the findings block of `meta`'s latest version, check it, and publish it as a new version. */
export async function publishFindings(
  scope: PublishScope,
  meta: ArtifactMeta,
  report: string,
  message: string,
  mark: string,
  at = new Date(),
): Promise<RunDelivery> {
  try {
    const html = await readPageSource(scope, meta.id, meta.latest);
    if (html === null) return notUpdated(meta, "its latest version cannot be read");
    const edit = findingsEdit(html, report, at);
    if ("error" in edit) return notUpdated(meta, edit.error);
    const draft = await writeDraft(scope, { artifact: meta, edits: [edit] });
    const checked = await checkDraft(scope, draft.id, { review: false });
    if (checked.draft.errors) return notUpdated(meta, `its check found ${plural(checked.draft.errors, "error")}`);
    if (checked.draft.errors === null && !scope.publishUnchecked)
      return notUpdated(meta, `no browser could check it (${checked.unchecked ?? "none to check it in"})`);
    return await publishMarked(scope, meta, draft.id, message, mark);
  } catch (error) {
    return notUpdated(meta, errorMessage(error));
  }
}

/**
 * A rebuilt page: the newest draft of `meta`'s page saved since `since` (the run's due time) that passed its check,
 * other than `seed` (the page as it was, which the model was given to change), published as its next version. A draft
 * of another page, or of none, or one declaring other MCP servers or tools than the seed, is never published here.
 */
export async function publishRebuilt(
  scope: PublishScope,
  meta: ArtifactMeta,
  seed: Pick<Draft, "id" | "manifest">,
  since: number,
  message: string,
  mark: string,
): Promise<RunDelivery> {
  try {
    const drafts = await scope.drafts();
    const checked = (one: DraftSummary) => passed(one) || (one.errors === null && scope.publishUnchecked);
    const found = (await drafts.list()).find((one) => one.artifactId === meta.id && one.id !== seed.id && one.savedAt >= since && checked(one));
    const draft = found && (await drafts.get(found.id));
    if (!draft) return notUpdated(meta, "no draft of it passed its check");
    // A run reads as its owner with nobody watching: its snapshot may change what the page shows, never what it may
    // call (a server or write tool the report's data asked for would run as the owner when they next open it).
    if (canonicalJson(draft.manifest.mcp ?? null) !== canonicalJson(seed.manifest.mcp ?? null))
      return notUpdated(meta, "the rebuilt page declares other servers or tools than the page did");
    return await publishMarked(scope, meta, draft.id, message, mark);
  } catch (error) {
    return notUpdated(meta, errorMessage(error));
  }
}

async function publishMarked(scope: PublishScope, meta: ArtifactMeta, draftId: string, message: string, mark: string): Promise<RunDelivery> {
  // The store keeps a message's first line, cut: the mark goes on what fits, so publishedAlready still finds it.
  const head = message.replace(/\s+/g, " ").trim().slice(0, MAX_VERSION_MESSAGE - mark.length - 1);
  const done = await publishDraft(scope, { draftId, title: meta.title, artifactId: meta.id, message: `${head} ${mark}` });
  return published(meta, done.meta.latest);
}
