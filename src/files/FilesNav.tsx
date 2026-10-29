import { memo, useCallback, useMemo, useState } from "react";
import { freePath, MAX_FILE_BYTES, UPLOADS, uploadBatches, uploadPath } from "../../shared/uploads.ts";
import { errorMessage, formatBytes, listSome } from "../../shared/util.ts";
import { api, type FileInfo } from "../api.ts";
import { fromInput, type Picked } from "./pick.ts";

/** Where an upload is: a line for the sidebar, and whether it is still going. */
export interface UploadStatus {
  text: string;
  busy: boolean;
  error?: boolean;
}

/** Upload picked files in as many requests as the Worker needs, saying how far along it is. */
export function useUploads(onUploaded: () => void): { status: UploadStatus | null; upload: (picked: Picked[]) => Promise<void> } {
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const upload = useCallback(
    async (picked: Picked[]) => {
      const files: Picked[] = [];
      const large: string[] = [];
      // Named here, over the whole pick: the Worker numbers clashing names only within one request.
      const taken = new Set<string>();
      for (const { file, path } of picked) {
        if (file.size > MAX_FILE_BYTES) {
          large.push(path);
          continue;
        }
        const target = freePath(uploadPath(path) ?? `${UPLOADS}/upload`, taken);
        taken.add(target);
        files.push({ file, path: target.slice(UPLOADS.length + 1) });
      }
      const skipped = large.length ? ` Skipped ${listSome(large, 3)}: over ${formatBytes(MAX_FILE_BYTES)}.` : "";
      if (files.length === 0) {
        setStatus(picked.length ? { text: skipped.trim(), busy: false, error: true } : null);
        return;
      }
      let done = 0;
      try {
        for (const batch of uploadBatches(files, (item) => item.file.size)) {
          setStatus({ text: `Uploading ${done + 1}–${done + batch.length} of ${files.length}…`, busy: true });
          await api.upload(batch);
          done += batch.length;
        }
        setStatus({ text: `Uploaded ${files.length === 1 ? files[0].path : `${files.length} files`}.${skipped}`, busy: false, error: !!skipped });
      } catch (e) {
        setStatus({ text: `Uploaded ${done} of ${files.length}: ${errorMessage(e)}${skipped}`, busy: false, error: true });
      } finally {
        // Once at the end: listing after every request would list a growing folder again and again.
        onUploaded();
      }
    },
    [onUploaded],
  );
  return { status, upload };
}

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: FileInfo[];
  count: number;
}

function tree(files: readonly FileInfo[]): Folder {
  const root: Folder = { name: "", path: "", folders: new Map(), files: [], count: 0 };
  for (const file of files) {
    const segments = file.path.split("/");
    let folder = root;
    folder.count++;
    for (const name of segments.slice(0, -1)) {
      let next = folder.folders.get(name);
      if (!next) folder.folders.set(name, (next = { name, path: folder.path ? `${folder.path}/${name}` : name, folders: new Map(), files: [], count: 0 }));
      folder = next;
      folder.count++;
    }
    folder.files.push(file);
  }
  return root;
}

function FolderView({ folder, depth }: { folder: Folder; depth: number }) {
  return (
    <>
      {[...folder.folders.values()].map((sub) => (
        // Top-level folders (uploads/, out/) start open; folders inside them start closed.
        <details key={sub.path} className="file-folder" open={depth === 0}>
          <summary title={sub.path}>
            {sub.name}/ <small>{sub.count}</small>
          </summary>
          <FolderView folder={sub} depth={depth + 1} />
        </details>
      ))}
      {folder.files.map((file) => (
        <span key={file.path} title={`${file.path} · ${formatBytes(file.size)}`}>
          {file.path.split("/").pop()}
        </span>
      ))}
    </>
  );
}

/** The sidebar's files: a folder tree, the two pickers, and how the last upload went. Re-renders only when one of those changes, not on every drag over the app. */
export const FilesNav = memo(function FilesNav({ files, status, upload }: { files: readonly FileInfo[]; status: UploadStatus | null; upload: (picked: Picked[]) => Promise<void> }) {
  const root = useMemo(() => tree(files), [files]);
  const pick = (input: HTMLInputElement) => {
    const picked = fromInput(input.files);
    // Cleared, so picking the same files again (after changing them) uploads them again.
    input.value = "";
    if (picked.length) void upload(picked);
  };
  return (
    <nav className="files">
      <FolderView folder={root} depth={0} />
      <div className="upload-actions">
        <label className="upload" title="Pick one or more files">
          Upload files
          <input type="file" multiple hidden disabled={status?.busy} onChange={(e) => pick(e.target)} />
        </label>
        <label className="upload" title="Pick a folder; its layout is kept under uploads/">
          Upload a folder
          <input type="file" hidden disabled={status?.busy} ref={(input) => input?.setAttribute("webkitdirectory", "")} onChange={(e) => pick(e.target)} />
        </label>
      </div>
      <small className={status?.error ? "upload-status error" : "upload-status"}>
        {status ? (
          <>
            {status.busy && <span className="spinner" />} {status.text}
          </>
        ) : (
          "Or drop files and folders anywhere."
        )}
      </small>
    </nav>
  );
});
