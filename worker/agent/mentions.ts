import type { Mention, MentionInput } from "../../shared/mentions.ts";
import { isOwnedBy, type ArtifactMeta, type Person } from "../../shared/protocol.ts";
import { literalPath } from "../storage/paths.ts";

/** What resolving a message's mentions needs from its chat. */
export interface MentionScope {
  /** The chat's owner: the agent acts as them, with their files and artifacts. */
  ownerUid: string;
  chatId: string;
  /** Whether the message's author is the owner. Others may name only this chat's artifacts. */
  byOwner: boolean;
  readMeta(id: string): Promise<ArtifactMeta | null>;
  /** Whether someone other than the owner may name this file of the owner's: without it, they may name none. */
  mayName?(path: string): Promise<boolean>;
  /** The person with this uid, while they are in the chat: only they can be tagged. */
  person?(uid: string): Person | null;
}

/**
 * Whether someone may name one of the owner's artifacts with "@" in this chat: the owner any of theirs, anyone else
 * only this chat's, since the owner's other chats are theirs. The one rule for what the picker offers and what a
 * message may name.
 */
export function mentionable(artifact: Pick<ArtifactMeta, "chatId">, chatId: string, byOwner: boolean): boolean {
  return byOwner || artifact.chatId === chatId;
}

/**
 * The mentions the message may make, as its transcript records them; the line
 * the model gets after the text, with exact paths and artifact ids; and the
 * artifacts from the owner's other chats it names, which the agent may then
 * read here (ChatScope.broughtIn). A file is taken by its path, which the
 * agent's tools check when they open it (someone else's only as mayName
 * allows); an artifact must be the owner's and mentionable; a person must be in
 * the chat, and is recorded by the name it shows (the text already says it to
 * the model). Anything else is dropped.
 */
export async function resolveMentions(
  inputs: readonly MentionInput[],
  scope: MentionScope,
): Promise<{ mentions: Mention[]; note: string; broughtIn: string[] }> {
  const resolved = await Promise.all(
    inputs.map(async (input): Promise<{ mention: Mention; said?: string; elsewhere?: boolean } | null> => {
      if (input.kind === "person") {
        const person = scope.person?.(input.uid);
        return person ? { mention: { kind: "person", uid: person.uid, name: person.name } } : null;
      }
      if (input.kind === "file") {
        const path = literalPath(input.path);
        if (!path || !(scope.byOwner || (await scope.mayName?.(path)))) return null;
        return { mention: { kind: "file", path }, said: `the file ${path}` };
      }
      // One artifact that cannot be read is dropped like a missing one, not a reason to refuse the whole message.
      const meta = await scope.readMeta(input.id).catch((error: unknown) => {
        console.error("mention:", input.id, error instanceof Error ? error.message : error);
        return null;
      });
      if (!meta || meta.ownerUid !== scope.ownerUid || !mentionable(meta, scope.chatId, scope.byOwner)) return null;
      const here = isOwnedBy(meta, scope.ownerUid, scope.chatId);
      return {
        mention: { kind: "artifact", id: meta.id, title: meta.title },
        said: `the artifact "${meta.title}" (artifact_id ${meta.id}, version ${meta.latest}, ${here ? "published in this chat" : "from another chat"})`,
        elsewhere: !here,
      };
    }),
  );
  const kept = resolved.filter((r) => r !== null);
  const said = kept.flatMap((r) => (r.said ? [r.said] : []));
  return {
    mentions: kept.map((r) => r.mention),
    note: said.length ? `[Mentioned with @: ${said.join("; ")}.]` : "",
    broughtIn: kept.flatMap((r) => (r.elsewhere && r.mention.kind === "artifact" ? [r.mention.id] : [])),
  };
}
