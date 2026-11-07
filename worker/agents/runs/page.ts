// A run's page step: the run's report in the page's findings block (an edit of its latest version), or a rebuilt
// page's checked draft, published in code through the same check and publish every page goes through, in the chat the
// page belongs to. A page that fails its check is not published: the run records "page not updated" and still sends
// its other deliveries. Each version a run publishes carries the run's mark, so a run that goes on publishes once.

import { canonicalJson } from "../../../shared/canonical.ts";
import type { ArtifactManifest, ArtifactMeta } from "../../../shared/protocol.ts";
import type { RunDelivery } from "../../../shared/runs.ts";
import { errorMessage, listSome, plural } from "../../../shared/util.ts";
import { checkDraft, publishDraft, readPageSource, writeDraft, type PublishScope } from "../../agent/publish.ts";
import { MAX_VERSION_MESSAGE } from "../../storage/artifacts.ts";
import { passed, type Draft } from "../../storage/drafts.ts";
import { findingsEdit } from "./report.ts";

/** What a version a run published says it is: the agent, the run's due time and the delivery's key. */
export const runMark = (agentId: string, dueAt: number, key: string): string => `[run ${agentId}/${dueAt}/${key}]`;

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
 * A rebuilt page: of the drafts the rebuild's own session saved (`written`, oldest first), the newest that is of this
 * page and passed its check, published as its next version. Its MCP declaration must be the seed's, which holds only
 * the page's read-only tools (a snapshot never writes as the owner, whatever the report's data asked for): a draft of
 * another page, of another session, or declaring anything else is never published here.
 */
export async function publishRebuilt(
  scope: PublishScope,
  meta: ArtifactMeta,
  seed: Pick<Draft, "id" | "manifest">,
  written: readonly string[],
  message: string,
  mark: string,
  dropped: readonly string[] = [],
): Promise<RunDelivery> {
  try {
    const drafts = await scope.drafts();
    const declared = canonicalJson(seed.manifest.mcp ?? null);
    for (const id of [...written].reverse()) {
      if (id === seed.id) continue;
      const draft = await drafts.get(id);
      if (!draft || draft.artifactId !== meta.id || !(passed(draft) || (draft.errors === null && scope.publishUnchecked))) continue;
      if (canonicalJson(draft.manifest.mcp ?? null) !== declared)
        return notUpdated(meta, "the rebuilt page declares other servers or tools than its read-only ones");
      const delivery = await publishMarked(scope, meta, draft.id, message, mark);
      return delivery.status === "sent" ? { ...delivery, detail: `${delivery.detail}${withoutWrites(dropped)}` } : delivery;
    }
    return notUpdated(meta, "no draft of it passed its check");
  } catch (error) {
    return notUpdated(meta, errorMessage(error));
  }
}

/**
 * A page's MCP declaration with only its read-only tools (`readOnly` says which): what a snapshot of it may call; and
 * the tools left out (`server.tool`), which change data, so the snapshot's controls that used them no longer work.
 */
export async function readOnlyDeclaration(
  manifest: ArtifactManifest | undefined,
  readOnly: (server: string, tool: string) => Promise<boolean>,
): Promise<{ servers: NonNullable<ArtifactManifest["mcp"]>["servers"]; dropped: string[] }> {
  const dropped: string[] = [];
  const servers = await Promise.all(
    (manifest?.mcp?.servers ?? []).map(async (entry) => {
      const kept = await Promise.all(entry.tools.map(async (tool) => ((await readOnly(entry.server, tool)) ? tool : null)));
      entry.tools.forEach((tool, index) => kept[index] === null && dropped.push(`${entry.server}.${tool}`));
      return { server: entry.server, tools: kept.filter((tool): tool is string => tool !== null) };
    }),
  );
  return { servers: servers.filter((entry) => entry.tools.length), dropped };
}

/** How a delivery names the write tools a snapshot was published without. */
function withoutWrites(dropped: readonly string[]): string {
  return dropped.length ? ` as a snapshot without ${listSome(dropped, 5)}, which ${dropped.length === 1 ? "writes" : "write"}` : "";
}

async function publishMarked(scope: PublishScope, meta: ArtifactMeta, draftId: string, message: string, mark: string): Promise<RunDelivery> {
  // The store keeps a message's first line, cut: the mark goes on what fits, so publishedAlready still finds it.
  const head = message.replace(/\s+/g, " ").trim().slice(0, MAX_VERSION_MESSAGE - mark.length - 1);
  const done = await publishDraft(scope, { draftId, title: meta.title, artifactId: meta.id, message: `${head} ${mark}` });
  return published(meta, done.meta.latest);
}
