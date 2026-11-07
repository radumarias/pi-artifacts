/** A field the model guessed: the Assumed pill, and Looks right to confirm it as it is. */
export function AssumedBadge({ onConfirm }: { onConfirm: () => void }) {
  return (
    <span className="agent-assumed">
      <span className="pill assumed">Assumed</span>
      <button type="button" className="link-button" onClick={onConfirm}>
        Looks right
      </button>
    </span>
  );
}
