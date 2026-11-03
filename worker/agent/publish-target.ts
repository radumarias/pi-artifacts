import type { ArtifactSummary } from "../../shared/protocol.ts";

/** A title as publishes compare it: case and runs of spaces do not count. */
const titleKey = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The artifact of this chat that a publish titled `title` without an artifact_id revises: the newest one with that
 * title. A model that fixes a page and publishes it again often leaves the id out, which would otherwise make another
 * artifact of the same page, each stuck at version 1. Undefined: the publish makes a new artifact.
 */
export function artifactByTitle(artifacts: readonly ArtifactSummary[], title: string): ArtifactSummary | undefined {
  const key = titleKey(title);
  return artifacts.filter((artifact) => titleKey(artifact.title) === key).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
