import { useEffect, useRef, useState } from "react";
import { baseName } from "../../shared/attachments.ts";
import { errorMessage, plural } from "../../shared/util.ts";
import { api, type FileInfo } from "../api.ts";
import { isPicked, type Picks } from "./picks.ts";

/** Asks before some of the user's files go for good, listing them (a folder with how many files it holds). */
export function DeleteFiles({
  doomed,
  files,
  onClose,
  onDeleted,
}: {
  doomed: Picks;
  files: readonly FileInfo[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => dialog.current?.showModal(), []);

  const picks = [...doomed];
  const folders = picks.filter(([, kind]) => kind === "folder").map(([path]) => path);
  const picked = picks.filter(([, kind]) => kind === "file").map(([path]) => path);
  // From the sidebar's listing, which may be cut short: the Worker deletes everything under a folder.
  const going = files.filter((file) => isPicked(doomed, file.path));
  const inFolder = (folder: string) => going.filter((file) => file.path.startsWith(`${folder}/`)).length;
  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteFiles(picked, folders);
      onDeleted();
      dialog.current?.close();
    } catch (e) {
      setError(errorMessage(e));
      setDeleting(false);
    }
  };

  const [only] = picks.length === 1 ? picks : [];
  const one = going.length === 1;
  return (
    // Escape and Cancel close it; not while the files are being deleted.
    <dialog ref={dialog} className="confirm-dialog" onClose={onClose} onCancel={(e) => deleting && e.preventDefault()}>
      <h2>{only ? `Delete ${only[1] === "folder" ? "the folder " : ""}${baseName(only[0])}?` : `Delete ${plural(going.length, "file")}?`}</h2>
      <ul className="confirm-list">
        {folders.map((folder) => (
          <li key={folder}>
            {folder}/ <small>· {plural(inFolder(folder), "file")}</small>
          </li>
        ))}
        {picked.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
      <p>
        {one ? "It is" : "They are"} deleted from your files for good, and none of your chats can use {one ? "it" : "them"} any more. This cannot be
        undone.
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="confirm-actions">
        <button type="button" disabled={deleting} onClick={() => dialog.current?.close()}>
          Cancel
        </button>
        <button type="button" className="danger" disabled={deleting} onClick={() => void remove()}>
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </dialog>
  );
}
