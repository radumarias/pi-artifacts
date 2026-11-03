import type { Mention, MentionInput } from "../../shared/mentions.ts";
import type { ArtifactMeta } from "../../shared/protocol.ts";
import { normalisePath, PathError } from "../storage/paths.ts";

/** What resolving a message's mentions needs from its chat. */
export interface MentionScope {
  /** The chat's owner: the agent acts as them, with their files and artifacts. */
  ownerUid: string;
  chatId: string;
  /** Whether the message's author is the owner. Others may name only this chat's artifacts. */
  byOwner: boolean;
  readMeta(id: string): Promise<ArtifactMeta | null>;
}

/**
 * The mentions the message may make, as its transcript records them, and the
 * line the model gets after the text with exact paths and artifact ids. A
 * file is taken by its path, which the agent's tools check when they open it;
 * an artifact must be the owner's, and for anyone else, this chat's: an
 * artifact elsewhere is the owner's to bring in. Anything else is dropped.
 */
export async function resolveMentions(inputs: readonly MentionInput[], scope: MentionScope): Promise<{ mentions: Mention[]; note: string }> {
  const resolved = await Promise.all(
    inputs.map(async (input): Promise<{ mention: Mention; said: string } | null> => {
      if (input.kind === "file") {
        const path = storedPath(input.path);
        return path ? { mention: { kind: "file", path }, said: `the file ${path}` } : null;
      }
      const meta = await scope.readMeta(input.id);
      if (!meta || meta.ownerUid !== scope.ownerUid) return null;
      const here = meta.chatId === scope.chatId;
      if (!here && !scope.byOwner) return null;
      const where = here ? "published in this chat" : "published in another chat; read it with artifact_read, and publish changes as a new artifact";
      return {
        mention: { kind: "artifact", id: meta.id, title: meta.title },
        said: `the artifact "${meta.title}" (artifact_id ${meta.id}, version ${meta.latest}, ${where})`,
      };
    }),
  );
  const kept = resolved.filter((r) => r !== null);
  const note = kept.length ? `[Mentioned with @: ${kept.map((r) => r.said).join("; ")}.]` : "";
  return { mentions: kept.map((r) => r.mention), note };
}

function storedPath(path: string): string | undefined {
  try {
    return normalisePath(path);
  } catch (error) {
    if (error instanceof PathError) return undefined;
    throw error;
  }
}
