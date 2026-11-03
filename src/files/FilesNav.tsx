import { createContext, memo, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { baseName } from "../../shared/attachments.ts";
import { MAX_FILE_BYTES, MAX_LISTED, previewType, underUploads, uploadBatches, uploadTargets, ZIP_ROUTE, zipRefusal } from "../../shared/uploads.ts";
import { errorMessage, formatBytes, listSome } from "../../shared/util.ts";
import { api, type FileInfo } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { useStoredState } from "../layout.tsx";
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
  // One upload at a time: a drop during an upload (the pickers are disabled, drops are not) waits its turn.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const run = useCallback(
    async (all: Picked[]) => {
      // As many files as UserFiles lists: past that, neither the sidebar nor the agent would see them.
      const picked = all.slice(0, MAX_LISTED);
      const fitting = picked.filter(({ file }) => file.size <= MAX_FILE_BYTES);
      const large = picked.filter(({ file }) => file.size > MAX_FILE_BYTES).map(({ path }) => path);
      // Named here, over the whole pick: the Worker numbers clashing names only within one request.
      const targets = uploadTargets(fitting.map(({ path }) => path));
      const files = fitting.map(({ file }, i) => ({ file, path: underUploads(targets[i]) }));
      const skipped =
        (large.length ? ` Skipped ${listSome(large, 3)}: over ${formatBytes(MAX_FILE_BYTES)}.` : "") +
        (all.length > picked.length ? ` Left out files past the first ${MAX_LISTED.toLocaleString("en")}; upload the rest separately.` : "");
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
  const upload = useCallback((picked: Picked[]) => (queue.current = queue.current.catch(() => {}).then(() => run(picked))), [run]);
  return { status, upload };
}

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  /** The files matching the search, the only ones listed. */
  files: FileInfo[];
  /** All its files, matching or not: what its zip and its pick hold. */
  count: number;
  bytes: number;
  /** How many of them match the search (all without one); a folder with none is not shown. */
  matches: number;
}

const newFolder = (name: string, path: string): Folder => ({ name, path, folders: new Map(), files: [], count: 0, bytes: 0, matches: 0 });

/** The folder tree of `files`, listing those whose path holds `search` (lower case; all when empty). */
function tree(files: readonly FileInfo[], search: string): Folder {
  const root = newFolder("", "");
  for (const file of files) {
    const match = !search || file.path.toLowerCase().includes(search);
    const segments = file.path.split("/");
    let folder = root;
    const add = () => {
      folder.count++;
      folder.bytes += file.size;
      if (match) folder.matches++;
    };
    add();
    for (const name of segments.slice(0, -1)) {
      let next = folder.folders.get(name);
      if (!next) folder.folders.set(name, (next = newFolder(name, folder.path ? `${folder.path}/${name}` : name)));
      folder = next;
      add();
    }
    if (match) folder.files.push(file);
  }
  return root;
}

const DownloadIcon = () => (
  <Icon size={15} box={16} stroke={1.6}>
    <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
  </Icon>
);

type Kind = "file" | "folder";

/** What is picked for download, while the panel is in select mode. */
interface Selection {
  picked: ReadonlyMap<string, Kind>;
  toggle(path: string, kind: Kind): void;
}

/** Null outside select mode: the tree then shows no checkboxes. */
const SelectionContext = createContext<Selection | null>(null);

/** Whether a folder above `path` is picked, which picks `path` too. */
function inPickedFolder(picked: ReadonlyMap<string, Kind>, path: string): boolean {
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    if (picked.get(path.slice(0, slash)) === "folder") return true;
  }
  return false;
}

/** A file's or folder's checkbox in select mode; checked and fixed when a folder above it is picked. */
function Pick({ path, kind }: { path: string; kind: Kind }) {
  const selection = useContext(SelectionContext);
  if (!selection) return null;
  const inside = inPickedFolder(selection.picked, path);
  return (
    <input
      type="checkbox"
      className="file-pick"
      checked={inside || selection.picked.has(path)}
      disabled={inside}
      onChange={() => selection.toggle(path, kind)}
      aria-label={`Pick ${baseName(path)}`}
    />
  );
}

/**
 * A folder's subfolders and files. Re-renders only when its folder changes (tree() runs again only when the files or
 * the search do); a selection change re-renders just the checkboxes. While searching, `expand` opens every folder, so the matches show.
 */
const FolderView = memo(function FolderView({ folder, depth, expand }: { folder: Folder; depth: number; expand: boolean }) {
  return (
    <>
      {[...folder.folders.values()].map((sub) => {
        if (!sub.matches) return null;
        // From the sidebar's listing, which may be cut short; the Worker checks again.
        const refusal = zipRefusal(sub.count, sub.bytes);
        return (
          // Top-level folders (uploads/, out/) start open; folders inside them start closed.
          <details key={sub.path} className="file-folder" open={depth === 0 || expand}>
            <summary title={sub.path}>
              <Pick path={sub.path} kind="folder" />
              {sub.name}/ <small>{sub.count}</small>
              {/* Without an href when the folder is too big to zip, so it says why and does nothing; without preventDefault its click would open or close the folder. */}
              <a
                className="file-action"
                href={refusal ? undefined : api.folderZipUrl(sub.path)}
                download={`${sub.name}.zip`}
                title={refusal ?? `Download ${sub.name} as a zip`}
                aria-disabled={!!refusal}
                onClick={refusal ? (event) => event.preventDefault() : undefined}
              >
                <DownloadIcon />
              </a>
            </summary>
            <FolderView folder={sub} depth={depth + 1} expand={expand} />
          </details>
        );
      })}
      {folder.files.map((file) => {
        const name = baseName(file.path);
        const title = `${file.path} · ${formatBytes(file.size)}`;
        return (
          <div key={file.path} className="file-row">
            <Pick path={file.path} kind="file" />
            {previewType(file.path) ? (
              // An image opens in a new tab to look at; the Worker serves it so nothing in it can run.
              <a className="file-name" href={api.fileUrl(file.path)} target="_blank" rel="noopener" title={`${title} · open in a new tab`}>
                {name}
              </a>
            ) : (
              <span className="file-name" title={title}>
                {name}
              </span>
            )}
            <a className="file-action" href={api.fileUrl(file.path)} download={name} title={`Download ${name}`}>
              <DownloadIcon />
            </a>
          </div>
        );
      })}
    </>
  );
});

/** The frame a picked set's zip downloads into: the page stays, and an error the Worker answers lands there to be read. */
const DOWNLOAD_FRAME = "files-download";

/**
 * Select mode's bar: how much is picked and its download, as one zip posted into a hidden frame (a form, since a long
 * pick would not fit a URL); one file alone downloads as itself.
 */
function SelectionBar({
  files,
  picked,
  error,
  onSubmit,
  onDone,
}: {
  files: readonly FileInfo[];
  picked: ReadonlyMap<string, Kind>;
  error: string | null;
  onSubmit: () => void;
  onDone: () => void;
}) {
  // What the zip would hold, from the sidebar's listing (the Worker checks again).
  const refusal = useMemo(() => {
    const held = files.filter((file) => picked.has(file.path) || inPickedFolder(picked, file.path));
    return zipRefusal(
      held.length,
      held.reduce((sum, file) => sum + file.size, 0),
    );
  }, [files, picked]);
  // One file downloads as it does from the tree; anything else, one folder too, goes through the form and its checks.
  const [only] = picked.size === 1 ? [...picked].filter(([, kind]) => kind === "file") : [];
  return (
    <div className="files-selection">
      <span>{picked.size ? `${picked.size} picked` : "Pick files and folders"}</span>
      {only ? (
        <a className="button" href={api.fileUrl(only[0])} download={baseName(only[0])}>
          Download
        </a>
      ) : (
        <button type="submit" form="files-zip" disabled={!picked.size || !!refusal} title={refusal ?? "Download them as one zip"} onClick={onSubmit}>
          Download
        </button>
      )}
      <button type="button" onClick={onDone}>
        Done
      </button>
      {error && <small className="upload-status error">{error}</small>}
      <form id="files-zip" method="post" action={ZIP_ROUTE} target={DOWNLOAD_FRAME} hidden>
        {[...picked].map(([path, kind]) => (
          <input key={path} type="hidden" name={kind} value={path} />
        ))}
      </form>
    </div>
  );
}

/**
 * The hidden frame the picked set's zip downloads into. It lives on document.body, outside React: removed before the
 * Worker answers (the panel closed or the sidebar collapsed right after Download), it would take the download with it.
 * A saved zip loads nothing here; an error page does, and says why, to the FilesNav mounted at the time.
 */
let downloadFrame: HTMLIFrameElement | undefined;
let reportZipError: ((error: string) => void) | undefined;

function ensureDownloadFrame(): void {
  if (downloadFrame) return;
  const frame = document.createElement("iframe");
  frame.name = DOWNLOAD_FRAME;
  frame.title = "Downloads";
  frame.hidden = true;
  frame.addEventListener("load", () => {
    try {
      const text = frame.contentDocument?.body?.textContent;
      if (text) reportZipError?.((JSON.parse(text) as { error?: string }).error ?? text);
    } catch {
      // Not readable or not JSON: nothing to say.
    }
  });
  document.body.append(frame);
  downloadFrame = frame;
}

const Chevron = () => (
  <Icon size={14} box={16} stroke={1.8}>
    <path d="M4 10l4-4 4 4" />
  </Icon>
);

/**
 * The sidebar's files, in a panel at its bottom that opens and closes (remembered in this browser): a folder tree,
 * the two pickers, and how the last upload went. Re-renders only when one of those changes, not on every drag over the app.
 */
export const FilesNav = memo(function FilesNav({ files, status, upload }: { files: readonly FileInfo[]; status: UploadStatus | null; upload: (picked: Picked[]) => Promise<void> }) {
  const [open, setOpen] = useStoredState("layout.filesOpen", true, (value) => typeof value === "boolean");
  const [query, setQuery] = useState("");
  // Filtering and drawing up to MAX_LISTED rows can lag behind typing; the box keeps up, the tree follows.
  const search = useDeferredValue(query).trim().toLowerCase();
  const root = useMemo(() => tree(files, search), [files, search]);
  const [picked, setPicked] = useState<ReadonlyMap<string, Kind> | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  useEffect(() => {
    reportZipError = setZipError;
    return () => {
      if (reportZipError === setZipError) reportZipError = undefined;
    };
  }, []);
  const selection = useMemo<Selection | null>(
    () =>
      picked && {
        picked,
        toggle: (path, kind) =>
          setPicked((before) => {
            const next = new Map(before);
            if (next.delete(path)) return next;
            // A picked folder holds what is under it; picks inside it go.
            if (kind === "folder") for (const key of next.keys()) if (key.startsWith(`${path}/`)) next.delete(key);
            return next.set(path, kind);
          }),
      },
    [picked],
  );
  const pick = (input: HTMLInputElement) => {
    const picked = fromInput(input.files);
    // Cleared, so picking the same files again (after changing them) uploads them again.
    input.value = "";
    if (picked.length) void upload(picked);
  };
  return (
    <section className={open ? "files-panel open" : "files-panel"}>
      <button type="button" className="files-panel-head" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Hide your files" : "Show your files"}>
        Files <small>{files.length.toLocaleString("en")}</small>
        {/* Closed, the panel still shows that an upload is going. */}
        {!open && status?.busy && <span className="spinner" />}
        <Chevron />
      </button>
      {open && (
        <>
          <div className="files-tools">
            <input type="search" placeholder="Search files" aria-label="Search files" value={query} onChange={(e) => setQuery(e.target.value)} />
            {!picked && (
              <button
                type="button"
                onClick={() => {
                  setPicked(new Map());
                  setZipError(null);
                }}
                title="Pick files and folders to download together"
              >
                Select
              </button>
            )}
          </div>
          {picked && (
            <SelectionBar
              files={files}
              picked={picked}
              error={zipError}
              onSubmit={() => {
                ensureDownloadFrame();
                setZipError(null);
              }}
              onDone={() => setPicked(null)}
            />
          )}
          <nav className="files">
            <SelectionContext.Provider value={selection}>
              <FolderView folder={root} depth={0} expand={!!search} />
            </SelectionContext.Provider>
            {search && !root.matches && <small className="files-empty">No files match.</small>}
          </nav>
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
        </>
      )}
    </section>
  );
});
