import { useEffect, useRef, useState } from "react";
import { baseName } from "../../shared/attachments.ts";
import { MAX_LISTED } from "../../shared/uploads.ts";
import { errorMessage, plural } from "../../shared/util.ts";
import { api, type FileInfo } from "../api.ts";
import { inPickedFolder, isPicked, type Picks } from "./picks.ts";

/** Asks before some of the user's files go for good, listing them (a folder with how many files it holds). */
export function DeleteFiles({
  doomed,
  files,
  onClose,
  onDeleted,
  onFailed,
}: {
  doomed: Picks;
  files: readonly FileInfo[];
  onClose: () => void;
  onDeleted: () => void;
  /** The delete failed, maybe after some of the files went. */
  onFailed: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => dialog.current?.showModal(), []);

  // A pick inside a picked folder goes with it: listed once, as the folder.
  const picks = [...doomed].filter(([path]) => !inPickedFolder(doomed, path));
  const folders = picks.filter(([, kind]) => kind === "folder").map(([path]) => path);
  const picked = picks.filter(([, kind]) => kind === "file").map(([path]) => path);
  // From the sidebar's listing, which may be cut short: the Worker deletes everything under a folder.
  const going = files.filter((file) => isPicked(doomed, file.path));
  // A full listing may lack some of a folder's files, so its count is a floor.
  const more = files.length >= MAX_LISTED && folders.length > 0 ? " or more" : "";
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
      onFailed();
    }
  };

  const [only] = picks.length === 1 ? picks : [];
  const one = going.length === 1;
  return (
    // Escape and Cancel close it; not while the files are being deleted.
    <dialog ref={dialog} className="confirm-dialog" onClose={onClose} onCancel={(e) => deleting && e.preventDefault()}>
      <h2>{only ? `Delete ${only[1] === "folder" ? "the folder " : ""}${baseName(only[0])}?` : `Delete ${plural(going.length, "file")}${more}?`}</h2>
      <ul className="confirm-list">
        {folders.map((folder) => (
          <li key={folder}>
            {folder}/{" "}
            <small>
              · {plural(inFolder(folder), "file")}
              {more}
            </small>
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
