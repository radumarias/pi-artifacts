import { useEffect, useRef, useState } from "react";
import type { ChatDeletion } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";

interface Props {
  chatId: string;
  onClose: () => void;
  onDeleted: () => void;
}

/** Asks the owner before a chat goes, showing what goes with it: its artifacts, the people it is shared with and, if they choose, its files. */
export function DeleteChat({ chatId, onClose, onDeleted }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<ChatDeletion | null>(null);
  const [withFiles, setWithFiles] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    api.chatDeletion(chatId).then(setPlan, (e) => setError(errorMessage(e)));
  }, [chatId]);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteChat(chatId, withFiles);
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
      setDeleting(false);
    }
  };

  const people = plan?.members ?? 0;
  return (
    // Escape and Cancel close it; not while the chat is being deleted.
    <dialog ref={dialog} className="confirm-dialog" onClose={onClose} onCancel={(e) => deleting && e.preventDefault()}>
      <h2>Delete this chat?</h2>
      {plan ? (
        <>
          <p>
            <strong>{plan.title || "This chat"}</strong> and its whole conversation are deleted for good. This cannot be undone.
          </p>
          {people > 0 && <p>{people === 1 ? "The person you shared it with loses" : `The ${people} people you shared it with lose`} it at once.</p>}
          {plan.artifacts.length > 0 && (
            <>
              <p>{plan.artifacts.length === 1 ? "Its artifact is" : `Its ${plan.artifacts.length} artifacts are`} deleted too, and their links stop working:</p>
              <ul className="confirm-list">
                {plan.artifacts.map((artifact) => (
                  <li key={artifact.id}>{artifact.title}</li>
                ))}
              </ul>
            </>
          )}
          {plan.files.length > 0 && (
            <>
              <label className="confirm-check">
                <input type="checkbox" checked={withFiles} disabled={deleting} onChange={(e) => setWithFiles(e.target.checked)} />
                Also delete {plan.files.length === 1 ? "the file" : `the ${plan.files.length} files`} attached to it or saved in it
              </label>
              <ul className="confirm-list">
                {plan.files.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
              <small>
                {plan.files.length === 1
                  ? "It is in your files, where your other chats can use it"
                  : "They are in your files, where your other chats can use them"}{" "}
                too.
              </small>
            </>
          )}
        </>
      ) : (
        !error && <p>Finding what it holds…</p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="confirm-actions">
        <button type="button" disabled={deleting} onClick={() => dialog.current?.close()}>
          Cancel
        </button>
        <button type="button" className="danger" disabled={!plan || deleting} onClick={() => void remove()}>
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </dialog>
  );
}
