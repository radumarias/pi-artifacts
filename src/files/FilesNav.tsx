import { createContext, memo, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { baseName } from "../../shared/attachments.ts";
import { MAX_FILE_BYTES, MAX_LISTED, underUploads, uploadBatches, uploadTargets, ZIP_ROUTE, zipRefusal } from "../../shared/uploads.ts";
import { errorMessage, formatBytes, listSome } from "../../shared/util.ts";
import { api, type FileInfo } from "../api.ts";
import { UnreadDot } from "../chat/ChatList.tsx";
import { Icon, TrashIcon } from "../Icon.tsx";
import { isBoolean, opensElsewhere, SectionHead, useStoredState } from "../layout.tsx";
import { DeleteFiles, isDoomed, type Doomed } from "./DeleteFiles.tsx";
import { fromInput, type Picked } from "./pick.ts";
import { fileMatcher, SEARCH_HELP } from "./search.ts";

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

/** The folder tree of `files`, listing those whose path `matches`. */
function tree(files: readonly FileInfo[], matches: (path: string) => boolean): Folder {
  const root = newFolder("", "");
  for (const file of files) {
    const match = matches(file.path);
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

export const DownloadIcon = () => (
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

/** The file open in the preview, and how a click on a name opens one. */
interface Opening {
  open: string | null;
  onOpen: (path: string) => void;
}

const OpeningContext = createContext<Opening>({ open: null, onOpen: () => {} });

/** Asks the user to confirm deleting some files and folders (DeleteFiles). */
const DeletingContext = createContext<(doomed: Doomed) => void>(() => {});

/** A file's or folder's delete button, which asks first. In a folder's summary, its click must not open or close the folder. */
function DeleteButton({ path, kind }: { path: string; kind: Kind }) {
  const ask = useContext(DeletingContext);
  const name = baseName(path) + (kind === "folder" ? "/" : "");
  return (
    <button
      type="button"
      className="file-action file-delete"
      title={`Delete ${name}`}
      aria-label={`Delete ${name}`}
      onClick={(event) => {
        event.preventDefault();
        ask(kind === "folder" ? { files: [], folders: [path] } : { files: [path], folders: [] });
      }}
    >
      <TrashIcon stroke={2.4} />
    </button>
  );
}

/**
 * A file's name, which opens it in the preview beside the chat; with a modifier key, or from the context menu,
 * it opens in a tab of its own, as the browser shows it (a file the preview reads as text then downloads).
 */
function FileName({ path, title }: { path: string; title: string }) {
  const { open, onOpen } = useContext(OpeningContext);
  return (
    <a
      className={open === path ? "file-name active" : "file-name"}
      href={api.fileViewUrl(path)}
      title={`${title} · preview`}
      aria-current={open === path ? "true" : undefined}
      onClick={(event) => {
        if (opensElsewhere(event)) return;
        event.preventDefault();
        onOpen(path);
      }}
    >
      {baseName(path)}
    </a>
  );
}

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
              <span className="file-actions">
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
                <DeleteButton path={sub.path} kind="folder" />
              </span>
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
            <FileName path={file.path} title={title} />
            <a className="file-action" href={api.fileUrl(file.path)} download={name} title={`Download ${name}`}>
              <DownloadIcon />
            </a>
            <DeleteButton path={file.path} kind="file" />
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
  onDelete,
  onDone,
}: {
  files: readonly FileInfo[];
  picked: ReadonlyMap<string, Kind>;
  error: string | null;
  onSubmit: () => void;
  onDelete: () => void;
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
  const count = picked.size ? `${picked.size} picked` : "Pick files and folders";
  return (
    <div className="files-selection">
      <span title={count}>{count}</span>
      {/* Icons, as on each row: the bar has no room for two more words beside the count and Done. */}
      {only ? (
        <a className="button selection-icon" href={api.fileUrl(only[0])} download={baseName(only[0])} title={`Download ${baseName(only[0])}`}>
          <DownloadIcon />
        </a>
      ) : (
        <button
          type="submit"
          form="files-zip"
          className="selection-icon"
          disabled={!picked.size || !!refusal}
          title={refusal ?? "Download them as one zip"}
          aria-label="Download the picked files as one zip"
          onClick={onSubmit}
        >
          <DownloadIcon />
        </button>
      )}
      <button
        type="button"
        className="selection-icon files-delete"
        disabled={!picked.size}
        title="Delete them, after you confirm"
        aria-label="Delete the picked files"
        onClick={onDelete}
      >
        <TrashIcon stroke={2.4} />
      </button>
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

/**
 * The sidebar's files, in a panel at its bottom that opens and closes (remembered in this browser): a folder tree,
 * the two pickers, and how the last upload went. Re-renders only when one of those changes, not on every drag over the app.
 */
export const FilesNav = memo(function FilesNav({
  files,
  status,
  upload,
  openFile,
  onOpenFile,
  onDeleted,
}: {
  files: readonly FileInfo[];
  status: UploadStatus | null;
  upload: (picked: Picked[]) => Promise<void>;
  /** The file showing in the preview, marked in the tree. */
  openFile: string | null;
  onOpenFile: (path: string) => void;
  /** Some files were deleted: those `gone` says. */
  onDeleted: (gone: (path: string) => boolean) => void;
}) {
  const [open, setOpen] = useStoredState("layout.filesOpen", false, isBoolean);
  // The last status the user saw with the panel open: one that went wrong while it was closed is marked on its head.
  const [seen, setSeen] = useState<UploadStatus | null>(null);
  useEffect(() => {
    if (open) setSeen(status);
  }, [open, status]);
  const [query, setQuery] = useState("");
  // Filtering and drawing up to MAX_LISTED rows can lag behind typing; the box keeps up, the tree follows.
  const search = useDeferredValue(query).trim();
  const root = useMemo(() => tree(files, fileMatcher(search)), [files, search]);
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
  const opening = useMemo<Opening>(() => ({ open: openFile, onOpen: onOpenFile }), [openFile, onOpenFile]);
  // What the delete dialog asks about, while it is open.
  const [doomed, setDoomed] = useState<Doomed | null>(null);
  const deleted = (gone: Doomed) => {
    // Picks that went are no longer picked; the rest stay.
    setPicked((before) => before && new Map([...before].filter(([path]) => !isDoomed(gone, path))));
    onDeleted((path) => isDoomed(gone, path));
  };
  const pick = (input: HTMLInputElement) => {
    const picked = fromInput(input.files);
    // Cleared, so picking the same files again (after changing them) uploads them again.
    input.value = "";
    if (picked.length) void upload(picked);
  };
  return (
    <section className={open ? "files-panel open" : "files-panel"}>
      <SectionHead name="Files" count={files.length} open={open} onToggle={setOpen} upward>
        {/* Closed, the panel still shows that an upload is going, or that one went wrong. */}
        {!open && status?.busy && <span className="spinner" />}
        {!open && status?.error && status !== seen && <UnreadDot label="An upload went wrong; open Files to see why" />}
      </SectionHead>
      {open && (
        <>
          <div className="files-tools">
            <input
              type="search"
              placeholder="Search files"
              aria-label="Search files"
              title={SEARCH_HELP}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
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
              onDelete={() => {
                const all = [...picked];
                setDoomed({
                  files: all.filter(([, kind]) => kind === "file").map(([path]) => path),
                  folders: all.filter(([, kind]) => kind === "folder").map(([path]) => path),
                });
              }}
              onDone={() => setPicked(null)}
            />
          )}
          <nav className="files">
            <OpeningContext.Provider value={opening}>
              <SelectionContext.Provider value={selection}>
                <DeletingContext.Provider value={setDoomed}>
                  <FolderView folder={root} depth={0} expand={!!search} />
                </DeletingContext.Provider>
              </SelectionContext.Provider>
            </OpeningContext.Provider>
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
          {doomed && <DeleteFiles doomed={doomed} files={files} onClose={() => setDoomed(null)} onDeleted={() => deleted(doomed)} />}
        </>
      )}
    </section>
  );
});
