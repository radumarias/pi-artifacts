import { useEffect, useRef, useState } from "react";
import { baseName } from "../../shared/attachments.ts";
import { errorMessage } from "../../shared/util.ts";
import { api, type FileInfo } from "../api.ts";

/** Files and folders to delete, each folder with everything under it. */
export interface Doomed {
  files: readonly string[];
  folders: readonly string[];
}

/** Whether `path` (a file's or a folder's) goes with `doomed`: picked itself, or under a picked folder. */
export const isDoomed = (doomed: Doomed, path: string) =>
  doomed.files.includes(path) || doomed.folders.some((folder) => path === folder || path.startsWith(`${folder}/`));

/** Asks before some of the user's files go for good, listing them (a folder with how many files it holds). */
export function DeleteFiles({
  doomed,
  files,
  onClose,
  onDeleted,
}: {
  doomed: Doomed;
  files: readonly FileInfo[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => dialog.current?.showModal(), []);

  // From the sidebar's listing, which may be cut short: the Worker deletes everything under a folder.
  const count = files.filter((file) => isDoomed(doomed, file.path)).length;
  const inFolder = (folder: string) => files.filter((file) => file.path.startsWith(`${folder}/`)).length;
  const only = doomed.folders.length + doomed.files.length === 1 ? (doomed.folders[0] ?? doomed.files[0]) : undefined;
  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteFiles(doomed.files, doomed.folders);
      onDeleted();
      dialog.current?.close();
    } catch (e) {
      setError(errorMessage(e));
      setDeleting(false);
    }
  };

  return (
    // Escape and Cancel close it; not while the files are being deleted.
    <dialog ref={dialog} className="confirm-dialog" onClose={onClose} onCancel={(e) => deleting && e.preventDefault()}>
      <h2>
        {only ? `Delete ${doomed.folders.length ? "the folder " : ""}${baseName(only)}?` : `Delete ${count === 1 ? "1 file" : `${count} files`}?`}
      </h2>
      <ul className="confirm-list">
        {doomed.folders.map((folder) => (
          <li key={folder}>
            {folder}/ <small>· {inFolder(folder) === 1 ? "1 file" : `${inFolder(folder)} files`}</small>
          </li>
        ))}
        {doomed.files.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
      <p>
        {count === 1 ? "It is" : "They are"} deleted from your files for good, and none of your chats can use {count === 1 ? "it" : "them"} any more.
        This cannot be undone.
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
