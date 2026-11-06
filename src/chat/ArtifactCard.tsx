import type { PublishedDetails } from "../../shared/protocol.ts";

/** A card for an artifact version published in the chat: opens its preview. */
export function ArtifactCard({ artifact, onOpen }: { artifact: PublishedDetails; onOpen: (artifact: PublishedDetails) => void }) {
  return (
    <button type="button" className="artifact-card" onClick={() => onOpen(artifact)}>
      <span className="artifact-card-icon">▦</span>
      <span>
        <strong>{artifact.title}</strong>
        <small>Artifact · version {artifact.version} · open preview</small>
      </span>
    </button>
  );
}
